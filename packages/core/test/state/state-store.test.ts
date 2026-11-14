import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CorruptStateError, StateError, StateStore } from "../../src/index.js";

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

describe("LEM-011 StateStore: progress, events, history, retention, kill file", () => {
  it("manages .lemma paths and uses shared atomic primitives for progress save/load", async () => {
    const root = await makeTempDir("lemma-store-");
    const store = new StateStore(root);
    expect(store.lemmaDir).toBe(path.join(root, ".lemma"));
    expect(store.progressPath.endsWith(path.join(".lemma", "progress.json"))).toBe(true);
    expect(store.eventsPath.endsWith(path.join(".lemma", "events.jsonl"))).toBe(true);
    expect(store.historyPath.endsWith(path.join(".lemma", "history.json"))).toBe(true);
    expect(store.killPath.endsWith(path.join(".lemma", "KILL"))).toBe(true);
    expect(store.evidenceRoot.endsWith(path.join(".lemma", "evidence"))).toBe(true);

    await expect(store.loadProgress()).rejects.toBeInstanceOf(StateError);

    const state = { run_id: "run-1", status: "running", started_at: "2026-11-14T00:00:00Z" };
    await store.saveProgress(state);
    expect(await store.exists()).toBe(true);
    const loaded = await store.loadProgress<typeof state & { updated_at?: string }>();
    expect(loaded.run_id).toBe("run-1");
    expect(loaded.status).toBe("running");
    expect(typeof loaded.updated_at).toBe("string");

    // corrupt progress raises typed error without clobbering stored file
    await fsp.writeFile(store.progressPath, "{not-json", "utf8");
    await expect(store.loadProgress()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await fsp.readFile(store.progressPath, "utf8")).toBe("{not-json");
  });

  it("appendEvent writes JSONL with timestamps and never crashes state operations", async () => {
    const root = await makeTempDir("lemma-events-");
    const store = new StateStore(root);
    await store.appendEvent({ type: "a", value: 1 });
    await store.appendEvent({ type: "b", timestamp: "2026-11-14T00:00:00Z" });
    const raw = await fsp.readFile(store.eventsPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const e1 = JSON.parse(lines[0] ?? "{}") as { type: string; value: number; timestamp: string };
    const e2 = JSON.parse(lines[1] ?? "{}") as { type: string; timestamp: string };
    expect(e1.type).toBe("a");
    expect(typeof e1.timestamp).toBe("string");
    expect(e2.timestamp).toBe("2026-11-14T00:00:00Z");

    // logging failure must not crash state operations
    const badStore = new StateStore(root);
    // make events path a directory to force append failure
    await fsp.rm(badStore.eventsPath, { force: true });
    await fsp.mkdir(badStore.eventsPath, { recursive: true });
    await expect(badStore.appendEvent({ type: "should-not-throw" })).resolves.toBeUndefined();
    await expect(badStore.saveProgress({ run_id: "run-ok", status: "running" })).resolves.toBeUndefined();
    expect(await badStore.exists()).toBe(true);
  });

  it("records versioned history, sorts deterministically, and upserts by run id", async () => {
    const root = await makeTempDir("lemma-history-");
    const store = new StateStore(root);
    const h0 = await store.loadHistory();
    expect(h0.schema_version).toBe("lemma.history/v1");
    expect(h0.runs).toEqual([]);

    await store.recordRun({ run_id: "r1", status: "completed", started_at: "2026-11-14T01:00:00Z", completed_at: "2026-11-14T01:10:00Z", confidence: { score: 80 } });
    await store.recordRun({ run_id: "r2", status: "halted", started_at: "2026-11-14T02:00:00Z", completed_at: "2026-11-14T02:05:00Z", confidence: { score: 10 } });
    await store.recordRun({ run_id: "r1", status: "completed", started_at: "2026-11-14T01:00:00Z", completed_at: "2026-11-14T01:20:00Z", confidence: { score: 90 } }, { decision: { decision: "ship" } });

    const history = await store.loadHistory();
    expect(history.runs.map((r) => r.run_id)).toEqual(["r2", "r1"]); // sorted by latest timestamp desc
    expect(history.runs.filter((r) => r.run_id === "r1")).toHaveLength(1);
    const r1 = history.runs.find((r) => r.run_id === "r1");
    expect(r1?.score).toBe(90);
    expect(r1?.decision).toBe("ship");
  });

  it("prune supports keepRuns/olderThanDays/dryRun, protects required runs, and safely removes evidence", async () => {
    const root = await makeTempDir("lemma-prune-");
    const store = new StateStore(root);

    const mk = async (id: string, status: string, completed: string) => {
      const evidencePath = path.posix.join(".lemma", "evidence", id);
      await fsp.mkdir(path.join(root, evidencePath), { recursive: true });
      await fsp.writeFile(path.join(root, evidencePath, "artifact.txt"), id);
      await store.recordRun({ run_id: id, status, completed_at: completed, started_at: completed, evidence_dir: evidencePath });
    };

    await mk("old-completed", "completed", "2026-10-01T00:00:00Z");
    await mk("old-halted", "halted", "2026-10-02T00:00:00Z");
    await mk("mid", "failed", "2026-11-01T00:00:00Z");
    await mk("latest", "completed", "2026-11-14T00:00:00Z");

    const dry = await store.prune({ keepRuns: 2, dryRun: true, now: "2026-11-14T12:00:00Z" });
    expect(dry.dryRun).toBe(true);
    // protected: latest (index 0), latest completed, halted
    expect(dry.retained).toContain("latest");
    expect(dry.retained).toContain("old-halted");
    // dry run must not delete evidence dirs
    expect(fsSync.existsSync(path.join(root, ".lemma", "evidence", "mid"))).toBe(true);

    const pruned = await store.prune({ olderThanDays: 10, now: "2026-11-14T12:00:00Z" });
    expect(pruned.removed.length).toBeGreaterThanOrEqual(1);
    // protected runs remain
    const after = await store.loadHistory();
    const ids = after.runs.map((r) => r.run_id);
    expect(ids).toContain("latest");
    expect(ids).toContain("old-halted");
    // removed run evidence deleted, retained evidence remains
    for (const id of pruned.removed) {
      expect(fsSync.existsSync(path.join(root, ".lemma", "evidence", id))).toBe(false);
    }
    for (const id of pruned.retained) {
      expect(fsSync.existsSync(path.join(root, ".lemma", "evidence", id))).toBe(true);
    }

    await expect(store.prune({ keepRuns: -1 })).rejects.toBeInstanceOf(StateError);
  });

  it("kill-file store semantics support request/read/clear and cross-process observation", async () => {
    const root = await makeTempDir("lemma-kill-");
    const store = new StateStore(root);
    expect(await store.killRequest()).toBeNull();

    await store.requestKill("stop now");
    const reason = await store.killRequest();
    expect(reason).toContain("stop now");
    const payload = JSON.parse(await fsp.readFile(store.killPath, "utf8")) as { reason: string; requested_at: string };
    expect(payload.reason).toBe("stop now");
    expect(typeof payload.requested_at).toBe("string");

    await store.clearKill();
    expect(await store.killRequest()).toBeNull();

    // cross-process kill request observable (atomic write)
    const script = "const fs=require('fs');const p=require('path');setTimeout(()=>{const d=process.env.D;const k=p.join(d,'KILL');const t=p.join(d,'.KILL.tmp');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(t,JSON.stringify({reason:'external',requested_at:new Date().toISOString()}));fs.renameSync(t,k);process.exit(0);},50);";
    const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, D: store.lemmaDir }, stdio: "ignore" });
    const deadline = Date.now() + 10000;
    let observed: string | null = null;
    while (Date.now() < deadline) {
      observed = await store.killRequest();
      if (observed) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await Promise.race([once(child, "close"), new Promise((r) => setTimeout(r, 2000))]);
    expect(observed).toContain("external");
  }, 20000);
});
