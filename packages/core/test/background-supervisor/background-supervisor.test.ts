import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore, startBackgroundSupervisor, type BackgroundCheck } from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
const prevEnv = process.env.LEMMA_BACKGROUND;

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.LEMMA_BACKGROUND;
  else process.env.LEMMA_BACKGROUND = prevEnv;
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor timeout");
}

async function readJsonl(filePath: string): Promise<any[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function snapshotDir(dir: string): Promise<Array<{ path: string; bytes: string }>> {
  const out: Array<{ path: string; bytes: string }> = [];
  async function walk(d: string): Promise<void> {
    let entries: any[] = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const b = await fs.readFile(p);
        out.push({ path: p, bytes: b.toString("base64") });
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

describe("LEM-150 background supervisor", () => {
  it("is a no-op and exits cleanly when disabled by default or env LEMMA_BACKGROUND=off", async () => {
    const root = await mkdtemp("lemma-bg-disabled-");
    tempDirs.push(root);

    const h1 = startBackgroundSupervisor({ root, settings: { background: { enabled: false } } });
    expect(h1.status().enabled).toBe(false);
    expect(h1.status().running).toBe(false);
    await h1.stop();

    process.env.LEMMA_BACKGROUND = "off";
    const h2 = startBackgroundSupervisor({ root, settings: { background: { enabled: true } } });
    expect(h2.status().enabled).toBe(false);
    expect(h2.status().running).toBe(false);
    await h2.stop();

    // no background artifacts required beyond possible clean no-op
    const bgEvents = path.join(root, ".lemma", "background", "events.jsonl");
    const events = await readJsonl(bgEvents);
    expect(events.length).toBe(0);
  });

  it("writes only under .lemma/background and does not perturb foreground state/evidence", async () => {
    const root = await mkdtemp("lemma-bg-isolation-");
    tempDirs.push(root);
    const fg = new StateStore(root);
    await fg.ensure();
    await fg.saveProgress({ run_id: "fg-run", status: "running", updated_at: "2026-11-16T00:00:00Z" });
    await fg.saveHistory({ schema_version: "quality-harness.history/v1", runs: [{ run_id: "fg-run", status: "completed", recorded_at: "2026-11-16T00:00:00Z" }] as any });
    await fg.appendEvent({ event: "foreground_event", run_id: "fg-run" });
    const fgEvidenceDir = path.join(root, ".lemma", "evidence", "fg-run");
    await fs.mkdir(fgEvidenceDir, { recursive: true });
    await fs.writeFile(path.join(fgEvidenceDir, "artifact.txt"), "foreground", "utf8");

    const before = {
      progress: await fs.readFile(fg.progressPath, "utf8"),
      history: await fs.readFile(fg.historyPath, "utf8"),
      events: await fs.readFile(fg.eventsPath, "utf8"),
      evidence: await snapshotDir(fg.evidenceRoot),
    };

    let ran = 0;
    const check: BackgroundCheck = {
      id: "background.static.quick",
      kind: "static",
      async run(ctx) {
        ran += 1;
        await fs.writeFile(path.join(ctx.evidenceDir, "bg.txt"), "bg", "utf8");
        return { id: "background.static.quick", kind: "static", status: "passed", summary: "ok", evidence_refs: [path.join(ctx.evidenceDir, "bg.txt")] };
      },
    };

    const h = startBackgroundSupervisor({
      root,
      settings: { background: { enabled: true, intervalMs: 50 } },
      checks: [check],
      maxConcurrent: 1,
    });

    await waitFor(() => ran >= 1, 3000);
    await h.pause();
    await h.stop();

    const after = {
      progress: await fs.readFile(fg.progressPath, "utf8"),
      history: await fs.readFile(fg.historyPath, "utf8"),
      events: await fs.readFile(fg.eventsPath, "utf8"),
      evidence: await snapshotDir(fg.evidenceRoot),
    };

    expect(after).toEqual(before);

    // background artifacts exist only under .lemma/background
    const bgDir = path.join(root, ".lemma", "background");
    const bgStat = await fs.stat(bgDir);
    expect(bgStat.isDirectory()).toBe(true);
    const bgEvents = await readJsonl(path.join(bgDir, "events.jsonl"));
    expect(bgEvents.length).toBeGreaterThan(0);
  });

  it("enforces concurrency limit, emits pause/resume/stop events, and records bounded runs", async () => {
    const root = await mkdtemp("lemma-bg-concurrency-");
    tempDirs.push(root);
    let active = 0;
    let maxSeen = 0;
    let completions = 0;
    const check: BackgroundCheck = {
      id: "background.quick.slow",
      kind: "quick",
      async run() {
        active += 1;
        maxSeen = Math.max(maxSeen, active);
        await new Promise((r) => setTimeout(r, 80));
        active -= 1;
        completions += 1;
        return { id: "background.quick.slow", kind: "quick", status: "passed", summary: "slow ok" };
      },
    };

    const h = startBackgroundSupervisor({
      root,
      settings: { background: { enabled: true, intervalMs: 30 } },
      checks: [check, check, check],
      maxConcurrent: 1,
      budget: { maxChecksPerTick: 3, checkTimeoutMs: 2000 },
    });

    await waitFor(() => completions >= 2, 4000);
    expect(maxSeen).toBeLessThanOrEqual(1);

    await h.pause();
    expect(h.status().paused).toBe(true);
    const pausedAtCompletions = completions;
    await new Promise((r) => setTimeout(r, 120));
    expect(completions).toBe(pausedAtCompletions);

    await h.resume();
    expect(h.status().paused).toBe(false);
    await waitFor(() => completions > pausedAtCompletions, 3000);
    await h.stop();
    expect(h.status().stopped).toBe(true);

    const events = await readJsonl(path.join(root, ".lemma", "background", "events.jsonl"));
    const names = events.map((e) => e.event);
    expect(names).toContain("background_started");
    expect(names).toContain("background_paused");
    expect(names).toContain("background_resumed");
    expect(names).toContain("background_stopped");
    expect(names).toContain("background_check_completed");
  });

  it("honors global and background-specific kill files within one interval", async () => {
    const root1 = await mkdtemp("lemma-bg-kill-global-");
    tempDirs.push(root1);
    const fg = new StateStore(root1);
    let ranGlobal = 0;
    const h1 = startBackgroundSupervisor({
      root: root1,
      settings: { background: { enabled: true, intervalMs: 40 } },
      checks: [{ id: "background.static.g", kind: "static", async run() { ranGlobal++; return { id: "background.static.g", kind: "static", status: "passed", summary: "ok" }; } }],
    });
    await waitFor(() => ranGlobal >= 1, 3000);
    await fg.requestKill("global stop");
    await waitFor(() => h1.status().stopped === true, 3000);
    const events1 = await readJsonl(path.join(root1, ".lemma", "background", "events.jsonl"));
    expect(events1.map((e) => e.event)).toContain("background_kill_observed");

    const root2 = await mkdtemp("lemma-bg-kill-bg-");
    tempDirs.push(root2);
    const bgStore = new StateStore(root2, { stateDirName: path.join(".lemma", "background") });
    let ranBg = 0;
    const h2 = startBackgroundSupervisor({
      root: root2,
      settings: { background: { enabled: true, intervalMs: 40 } },
      checks: [{ id: "background.static.b", kind: "static", async run() { ranBg++; return { id: "background.static.b", kind: "static", status: "passed", summary: "ok" }; } }],
    });
    await waitFor(() => ranBg >= 1, 3000);
    await bgStore.requestKill("background stop");
    await waitFor(() => h2.status().stopped === true, 3000);
    const events2 = await readJsonl(path.join(root2, ".lemma", "background", "events.jsonl"));
    expect(events2.map((e) => e.event)).toContain("background_kill_observed");
  });

  it("is bounded/non-starving and records background summary without touching foreground report state", async () => {
    const root = await mkdtemp("lemma-bg-bounded-");
    tempDirs.push(root);
    let calls = 0;
    const h = startBackgroundSupervisor({
      root,
      settings: { background: { enabled: true, intervalMs: 25 } },
      checks: [{
        id: "background.quick.tick",
        kind: "quick",
        async run() {
          calls += 1;
          return { id: "background.quick.tick", kind: "quick", status: "passed", summary: "tick" };
        },
      }],
      budget: { checkTimeoutMs: 100, maxChecksPerTick: 1 },
    });
    await waitFor(() => calls >= 3, 3000);
    const st = h.status();
    expect(st.completed_ticks).toBeGreaterThanOrEqual(1);
    await h.stop();

    const summaryPath = path.join(root, ".lemma", "background", "summary.json");
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    expect(Array.isArray(summary.runs)).toBe(true);
    expect(summary.runs.length).toBeGreaterThan(0);
    // foreground state not created
    await expect(fs.access(path.join(root, ".lemma", "progress.json"))).rejects.toBeTruthy();
  });
});
