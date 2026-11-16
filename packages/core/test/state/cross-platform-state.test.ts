import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  StateError,
  acquireFileLock,
  atomicWriteFile,
  atomicWriteJson,
  clearKillFile,
  killFileExistsSync,
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

describe("LEM-127 cross-platform atomic writes and locks", () => {
  it("atomically replaces existing targets over repeated writes with complete readable content", async () => {
    const dir = await makeTempDir("lemma-xplat-atomic-");
    const target = path.join(dir, "nested", "state", "progress.json");

    for (let i = 0; i < 25; i++) {
      await atomicWriteJson(target, { i, payload: "x".repeat(128 + i) });
      const loaded = await readJsonFile<{ i: number; payload: string }>(target);
      expect(loaded.i).toBe(i);
      expect(loaded.payload.length).toBe(128 + i);
    }

    await atomicWriteFile(target, "{\"final\":true}\n");
    expect(await fsp.readFile(target, "utf8")).toBe("{\"final\":true}\n");

    const parent = path.dirname(target);
    const entries = await fsp.readdir(parent);
    // only the target file should remain (no leaked temp files)
    expect(entries).toEqual(["progress.json"]);
  });

  it("failed rename preserves existing content and cleans up temp artifacts", async () => {
    const dir = await makeTempDir("lemma-xplat-fail-");
    const target = path.join(dir, "data.json");
    await atomicWriteJson(target, { ok: true, version: 1 });

    await expect(
      atomicWriteJson(target, { ok: false, version: 2 }, {
        renameFn: async () => {
          throw new Error("simulated rename failure");
        },
      }),
    ).rejects.toBeInstanceOf(StateError);

    expect(await readJsonFile<{ ok: boolean; version: number }>(target)).toEqual({ ok: true, version: 1 });
    const entries = await fsp.readdir(dir);
    expect(entries).toContain("data.json");
    expect(entries.filter((e) => e.includes(".tmp")).length).toBe(0);
  });

  it("serializes access with withFileLock and enforces contention timeout", async () => {
    const dir = await makeTempDir("lemma-xplat-lock-");
    const target = path.join(dir, "resource.json");
    await atomicWriteJson(target, { count: 0 });

    const lock = await acquireFileLock(target, { timeoutMs: 2000, staleMs: 60_000 });
    try {
      await expect(
        withFileLock(target, async () => 1, { timeoutMs: 150, pollMs: 20, staleMs: 60_000 }),
      ).rejects.toBeInstanceOf(StateError);

      await expect(
        acquireFileLock(target, { timeoutMs: 150, pollMs: 20, staleMs: 60_000 }),
      ).rejects.toBeInstanceOf(StateError);
    } finally {
      await lock.release();
    }

    let observedHeld = false;
    const result = await withFileLock(target, async () => {
      const entries = await fsp.readdir(dir);
      observedHeld = entries.some((e) => e.endsWith(".lock"));
      return 7;
    }, { timeoutMs: 2000 });
    expect(result).toBe(7);
    expect(observedHeld).toBe(true);

    const entriesAfter = await fsp.readdir(dir);
    expect(entriesAfter.some((e) => e.endsWith(".lock"))).toBe(false);
  });

  it("recovers stale lock records (dead/crashed holder metadata) across processes", async () => {
    const dir = await makeTempDir("lemma-xplat-stale-");
    const target = path.join(dir, "shared.json");
    const lockPath = `${target}.lock`;
    const ready = path.join(dir, "ready.txt");

    // Simulate a crashed holder: child creates lock file then exits abruptly.
    const script = `
      const fs = require('fs');
      const rec = { pid: process.pid, token: 'crash-'+process.pid, createdAt: Date.now(), hostname: require('os').hostname() };
      fs.writeFileSync(process.env.LOCK_PATH, JSON.stringify(rec), { flag: 'wx' });
      fs.writeFileSync(process.env.READY_PATH, '1');
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, LOCK_PATH: lockPath, READY_PATH: ready },
      stdio: "ignore",
    });
    await once(child, "close");

    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(lockPath)).toBe(true);

    const recovered = await acquireFileLock(target, { timeoutMs: 5000, pollMs: 25, staleMs: 60_000 });
    await recovered.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 15000);

  it("supports kill-file roundtrip via shared primitives on nested paths", async () => {
    const dir = await makeTempDir("lemma-xplat-kill-");
    const nested = path.join(dir, "a", "b", ".lemma-like");
    expect(await readKillFile(nested)).toBeNull();
    expect(killFileExistsSync(nested)).toBe(false);

    const p = await writeKillFile(nested, "stop-now");
    expect(p).toBe(path.join(nested, "KILL"));
    expect(killFileExistsSync(nested)).toBe(true);
    expect(await readKillFile(nested)).toBe("stop-now");

    await clearKillFile(nested);
    expect(await readKillFile(nested)).toBeNull();
    expect(killFileExistsSync(nested)).toBe(false);
  });
});
