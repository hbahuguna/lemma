import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore, runForever, startDashboard } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-forever-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-182 continuous testing workflow (forever)", () => {
  it("enforces cycle cap and wall-clock cap with per-cycle evidence and durable checkpoints", async () => {
    await withTempDir(async (root) => {
      const res = await runForever({
        root,
        target: { kind: "dir", path: root },
        maxCycles: 2,
        checkpointEvery: 1,
        clock: "frozen",
        frozenNow: "2026-11-17T00:00:00Z",
        seed: 1,
        runId: "forever-cap",
        executeCycle: async ({ cycle }) => ({ findings: [{ fingerprint: `fp-${cycle}`, title: `f${cycle}` }], notes: [`cycle-${cycle}`] }),
      });
      expect(res.run_id).toBe("forever-cap");
      expect(res.stop_reason).toBe("max_cycles");
      expect(res.cycles_completed).toBe(2);
      expect(res.mission.cycles).toHaveLength(2);
      for (let i = 1; i <= 2; i++) {
        await fs.access(path.join(root, ".lemma", "forever", "forever-cap", String(i), "cycle.json"));
        await fs.access(path.join(root, ".lemma", "forever", "forever-cap", String(i), "findings.json"));
      }
      const checkpoint = path.join(root, ".lemma", "forever", "forever-cap", "checkpoint.json");
      await fs.access(checkpoint);
      expect(res.checkpoint_paths).toContain(checkpoint);

      // wall-clock cap (real clock path)
      let calls = 0;
      const capped = await runForever({
        root,
        target: root,
        maxCycles: 5,
        wallClockMs: 0,
        runId: "forever-wall",
        executeCycle: async () => { calls++; return { findings: [] }; },
      });
      expect(capped.stop_reason).toBe("wall_clock_cap");
      expect(capped.cycles_completed).toBe(0);
      expect(calls).toBe(0);
    });
  });

  it("expands coverage only after two confirmations of same fingerprint; unconfirmed findings recorded but never trigger expansion", async () => {
    await withTempDir(async (root) => {
      const res = await runForever({
        root,
        target: root,
        maxCycles: 3,
        clock: "frozen",
        frozenNow: "2026-11-17T00:00:00Z",
        seed: 2,
        runId: "forever-expand",
        executeCycle: async ({ cycle }) => {
          if (cycle === 1) return { findings: [{ fingerprint: "same-fp" }, { fingerprint: "once" }], expanded_coverage: ["area-should-not-expand-yet"] };
          if (cycle === 2) return { findings: [{ fingerprint: "same-fp" }], expanded_coverage: ["area-confirmed"] };
          return { findings: [], expanded_coverage: ["area-no-new-confirm"] };
        },
      });
      expect(res.mission.cycles[0].expansion_triggered).toBe(false);
      expect(res.mission.cycles[0].expanded_coverage).toEqual([]);
      expect(res.mission.cycles[0].unconfirmed_findings).toContain("same-fp");
      expect(res.mission.cycles[0].unconfirmed_findings).toContain("once");

      expect(res.mission.cycles[1].expansion_triggered).toBe(true);
      expect(res.mission.cycles[1].expanded_coverage).toEqual(["area-confirmed"]);
      expect(res.mission.cycles[1].confirmed_findings).toContain("same-fp");

      // "once" never confirmed => never triggers expansion and remains unconfirmed
      expect(res.mission.unconfirmed_fingerprints).toContain("once");
      expect(res.mission.expanded_coverage).toContain("area-confirmed");
      expect(res.mission.expanded_coverage).not.toContain("area-should-not-expand-yet");
      expect(res.mission.cycles[2].expansion_triggered).toBe(false);
    });
  });

  it("resumes from last checkpoint and refuses on registry fingerprint mismatch", async () => {
    await withTempDir(async (root) => {
      let seen: number[] = [];
      const first = await runForever({
        root,
        target: root,
        maxCycles: 1,
        clock: "frozen",
        frozenNow: "2026-11-17T00:00:00Z",
        seed: 3,
        runId: "forever-resume",
        registryFingerprint: "fp-a",
        executeCycle: async ({ cycle }) => { seen.push(cycle); return { findings: [{ fingerprint: "x" }] }; },
      });
      expect(first.cycles_completed).toBe(1);

      const resumed = await runForever({
        root,
        target: root,
        maxCycles: 3,
        clock: "frozen",
        frozenNow: "2026-11-17T00:00:00Z",
        seed: 3,
        runId: "forever-resume",
        resume: true,
        registryFingerprint: "fp-a",
        executeCycle: async ({ cycle }) => { seen.push(cycle); return { findings: [{ fingerprint: "x" }] }; },
      });
      expect(resumed.resumed_from_cycle).toBe(1);
      expect(resumed.cycles_completed).toBe(3);
      expect(seen).toEqual([1, 2, 3]);

      await expect(runForever({
        root,
        target: root,
        maxCycles: 4,
        runId: "forever-resume",
        resume: true,
        registryFingerprint: "fp-b",
        executeCycle: async () => ({ findings: [] }),
      })).rejects.toThrow(/fingerprint/i);
    });
  });

  it("is deterministic (same seed + frozen clock + same root => byte-identical checkpoints modulo documented volatile fields) and surfaces live mission report in dashboard", async () => {
    await withTempDir(async (rootA) => {
      await withTempDir(async (rootB) => {
        const run = async (root: string) => runForever({
          root,
          target: { repo: "same-target" },
          maxCycles: 2,
          clock: "frozen",
          frozenNow: "2026-11-17T00:00:00Z",
          seed: 42,
          runId: "forever-det",
          registryFingerprint: "same-fp",
          executeCycle: async ({ cycle }) => ({ findings: cycle === 1 ? [{ fingerprint: "fp1" }] : [{ fingerprint: "fp1" }], expanded_coverage: cycle === 2 ? ["cov"] : [] }),
        });
        const a = await run(rootA);
        const b = await run(rootB);
        const ca = JSON.parse(await fs.readFile(path.join(rootA, ".lemma", "forever", "forever-det", "checkpoint.json"), "utf8"));
        const cb = JSON.parse(await fs.readFile(path.join(rootB, ".lemma", "forever", "forever-det", "checkpoint.json"), "utf8"));
        const strip = (x: any) => {
          const c = JSON.parse(JSON.stringify(x));
          // documented volatile: filesystem/root-derived absolute paths may differ across roots; normalize to relative evidence/checkpoint paths already stored
          delete c.created_at; delete c.updated_at;
          if (Array.isArray(c.cycles)) c.cycles = c.cycles.map((cy: any) => { const y = { ...cy }; delete y.started_at; delete y.completed_at; return y; });
          return c;
        };
        expect(strip(ca)).toEqual(strip(cb));
        expect(a.mission.confirmed_fingerprints).toEqual(["fp1"]);
        expect(a.mission.expanded_coverage).toEqual(["cov"]);

        // dashboard surfacing
        const store = new StateStore(rootA);
        await store.ensure();
        const dash = await startDashboard({ stateStore: store, host: "127.0.0.1", port: 0 } as any);
        try {
          const apiUrl = new URL("/api/live", dash.url).toString();
          const res = await fetch(`${apiUrl}?token=${encodeURIComponent(dash.token)}`);
          expect(res.ok).toBe(true);
          const body: any = await res.json();
          expect(body.forever_mission?.run_id).toBe("forever-det");
          expect(body.forever_mission?.schema_version).toBe("lemma.forever_mission/v1");
        } finally {
          await dash.close();
        }
      });
    });
  });
});
