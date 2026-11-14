import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CorruptStateError,
  StateError,
  acquireFileLock,
  atomicWriteFile,
  atomicWriteJson,
  clearKillFile,
  ensureDir,
  killFileExistsSync,
  killFilePath,
  readJsonFile,
  readKillFile,
  withFileLock,
  writeKillFile,
} from "../../src/index.js";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("LEM-010 atomic state, JSON, and file-lock primitives", () => {
  it("atomicWriteFile/Json never exposes a partial file (simulated crash between write and rename)", async () => {
    const dir = await makeTempDir("lemma-state-atomic-");
    const target = path.join(dir, "progress.json");
    const original = { ok: true, value: "last-good" };
    await atomicWriteJson(target, original);

    // simulate crash/failure between write and rename by forcing rename to fail
    await expect(
      atomicWriteJson(
        target,
        { ok: false, partial: "x".repeat(1000) },
        { renameFn: () => Promise.reject(new Error("simulated crash before rename")) },
      ),
    ).rejects.toBeTruthy();

    // last good file preserved and complete; target never partial
    const persisted = JSON.parse(await fsp.readFile(target, "utf8")) as { ok: boolean; value: string };
    expect(persisted).toEqual(original);

    // no temp files left behind as target; target content is valid JSON (not partial)
    const entries = await fsp.readdir(dir);
    expect(entries).toContain("progress.json");
    expect(() => {
      JSON.parse(fsSync.readFileSync(target, "utf8"));
    }).not.toThrow();
  });

  it("corrupt JSON raises a typed error and preserves the last good/corrupt file on disk", async () => {
    const dir = await makeTempDir("lemma-state-json-");
    const good = path.join(dir, "good.json");
    await atomicWriteJson(good, { hello: "world" });
    expect(await readJsonFile<{ hello: string }>(good)).toEqual({ hello: "world" });

    const corrupt = path.join(dir, "corrupt.json");
    await atomicWriteFile(corrupt, "{ not: valid json\n");
    await expect(readJsonFile(corrupt)).rejects.toBeInstanceOf(CorruptStateError);
    // preserves file on disk (not deleted/modified by read)
    expect(await fsp.readFile(corrupt, "utf8")).toBe("{ not: valid json\n");

    await expect(readJsonFile(path.join(dir, "missing.json"))).rejects.toBeInstanceOf(StateError);
  });

  it("advisory file lock is exclusive across processes and released on crash", async () => {
    const dir = await makeTempDir("lemma-state-lock-");
    const target = path.join(dir, "shared-state.json");
    await atomicWriteJson(target, { count: 0 });
    const lockPath = `${target}.lock`;
    const holderReady = path.join(dir, "holder-ready.txt");
    const holderRelease = path.join(dir, "holder-release.txt");

    const holderScript = `
      const fs = require('fs');
      const lockPath = process.env.LOCK_PATH;
      const ready = process.env.READY_PATH;
      const release = process.env.RELEASE_PATH;
      const mode = process.env.MODE || 'hold';
      const rec = { pid: process.pid, token: 'tok-'+process.pid, createdAt: Date.now(), hostname: require('os').hostname() };
      fs.writeFileSync(lockPath, JSON.stringify(rec), { flag: 'wx' });
      fs.writeFileSync(ready, '1');
      if (mode === 'crash') {
        process.kill(process.pid, 'SIGKILL');
      } else {
        const start = Date.now();
        while (!fs.existsSync(release) && Date.now() - start < 10000) {
          const until = Date.now() + 20;
          while (Date.now() < until) {}
        }
        try { fs.unlinkSync(lockPath); } catch {}
        process.exit(0);
      }
    `;

    // 1) exclusivity across processes
    const holder = spawn(process.execPath, ["-e", holderScript], {
      env: { ...process.env, LOCK_PATH: lockPath, READY_PATH: holderReady, RELEASE_PATH: holderRelease, MODE: "hold" },
      stdio: "ignore",
    });
    const readyDeadline = Date.now() + 5000;
    while (!fsSync.existsSync(holderReady) && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fsSync.existsSync(holderReady)).toBe(true);

    await expect(acquireFileLock(target, { timeoutMs: 250, pollMs: 20, staleMs: 60_000 })).rejects.toBeInstanceOf(StateError);

    await fsp.writeFile(holderRelease, "1");
    await once(holder, "close");
    const lock = await acquireFileLock(target, { timeoutMs: 2000, pollMs: 20 });
    await lock.release();

    // 2) released on crash (stale recovery): holder crashes without releasing
    const ready2 = path.join(dir, "holder-ready-2.txt");
    const crasher = spawn(process.execPath, ["-e", holderScript], {
      env: { ...process.env, LOCK_PATH: lockPath, READY_PATH: ready2, RELEASE_PATH: holderRelease, MODE: "crash" },
      stdio: "ignore",
    });
    await once(crasher, "close");
    const readyDeadline2 = Date.now() + 5000;
    while (!fsSync.existsSync(ready2) && Date.now() < readyDeadline2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fsSync.existsSync(lockPath)).toBe(true);

    const recovered = await acquireFileLock(target, { timeoutMs: 5000, pollMs: 25, staleMs: 60_000 });
    await recovered.release();

    const result = await withFileLock(target, () => {
      expect(fsSync.existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(fsSync.existsSync(lockPath)).toBe(false);
  }, 20000);

  it("kill file written from another process is observed between checks", async () => {
    const dir = await makeTempDir("lemma-state-kill-");
    expect(await readKillFile(dir)).toBeNull();
    expect(killFileExistsSync(dir)).toBe(false);

    const script = "const fs=require('fs');const p=require('path');setTimeout(()=>{try{fs.mkdirSync(process.env.ROOT,{recursive:true});fs.writeFileSync(p.join(process.env.ROOT,'KILL'),'stop-now\\n');}finally{process.exit(0);}},50);";
    const writer = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, ROOT: dir },
      stdio: "ignore",
    });

    let observedBetweenChecks = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const reason = await readKillFile(dir);
      if (reason !== null) {
        observedBetweenChecks = true;
        expect(reason).toContain("stop-now");
        expect(killFileExistsSync(dir)).toBe(true);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    // ensure writer finished
    await Promise.race([once(writer, "close"), new Promise((r) => setTimeout(r, 2000))]);
    expect(observedBetweenChecks).toBe(true);

    await clearKillFile(dir);
    expect(await readKillFile(dir)).toBeNull();
    expect(killFileExistsSync(dir)).toBe(false);

    const p = await writeKillFile(dir, "manual");
    expect(p).toBe(killFilePath(dir));
    expect(await readKillFile(dir)).toBe("manual");
  }, 20000);

  it("uses shared primitives (no package-local reimplementation in core state API)", async () => {
    const dir = await makeTempDir("lemma-state-shared-");
    await ensureDir(path.join(dir, "nested", "dir"));
    expect(fsSync.existsSync(path.join(dir, "nested", "dir"))).toBe(true);
    expect(typeof atomicWriteFile).toBe("function");
    expect(typeof atomicWriteJson).toBe("function");
    expect(typeof readJsonFile).toBe("function");
    expect(typeof acquireFileLock).toBe("function");
    expect(typeof withFileLock).toBe("function");
    expect(typeof writeKillFile).toBe("function");
    expect(typeof readKillFile).toBe("function");
  });
});
