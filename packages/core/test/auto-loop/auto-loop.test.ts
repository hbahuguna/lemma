import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runAutoLoop, StateError } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-auto-loop-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-166 bounded auto test-fix-retest loop", () => {
  it("respects cycle cap and halts cleanly with halted status", async () => {
    await withTempDir(async (root) => {
      const res = await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 2,
        approveMutation: async () => ({ approved: true }),
        executeCycle: async ({ cycle, writeEvidence }) => {
          await writeEvidence("step.json", { cycle });
          return { findings_count: cycle, new_findings_count: 1, progress_made: true };
        },
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
        seed: 1,
      });
      expect(res.status).toBe("halted");
      expect(res.stop_reason).toBe("max_cycles");
      expect(res.cycles_completed).toBe(2);
      expect(res.cycles).toHaveLength(2);
      expect(res.run_id).toBe(res.same_run_id);
      for (const c of res.cycles) {
        const st = await fs.stat(path.join(root, ".lemma", "auto", res.run_id, String(c.cycle)));
        expect(st.isDirectory()).toBe(true);
      }
    });
  });

  it("halts on wall-clock cap cleanly", async () => {
    await withTempDir(async (root) => {
      let calls = 0;
      const res = await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 5,
        stopOn: { wallClockMs: 0 },
        approveMutation: async () => ({ approved: true }),
        executeCycle: async () => {
          calls++;
          return { findings_count: 1, new_findings_count: 1, progress_made: true };
        },
        clock: "real",
      });
      expect(res.status).toBe("halted");
      expect(res.stop_reason).toBe("wall_clock_budget");
      expect(res.cycles_completed).toBe(0);
      expect(calls).toBe(0);
    });
  });

  it("halts on no-progress", async () => {
    await withTempDir(async (root) => {
      const res = await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 5,
        approveMutation: async () => ({ approved: true }),
        executeCycle: async () => ({ findings_count: 1, new_findings_count: 0, progress_made: false }),
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
      });
      expect(res.status).toBe("halted");
      expect(["no_progress", "no_new_findings"]).toContain(res.stop_reason);
      expect(res.cycles_completed).toBe(1);
    });
  });

  it("gates every mutation via approveMutation; decline stops loop and records typed result (no silent mutation)", async () => {
    await withTempDir(async (root) => {
      const approvals: string[] = [];
      const res = await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 5,
        approveMutation: async (proposal) => {
          approvals.push(proposal.description);
          return { approved: false, reason: "nope" };
        },
        executeCycle: async ({ requestMutation, writeEvidence }) => {
          await writeEvidence("plan.json", { planned: true });
          await requestMutation({ description: "edit file", files: ["a.txt"] });
          return { findings_count: 1, new_findings_count: 1, progress_made: true };
        },
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
      });
      expect(approvals).toEqual(["edit file"]);
      expect(res.status).toBe("halted");
      expect(res.stop_reason).toBe("mutation_declined");
      expect(res.declined_mutation).toBeTruthy();
      expect(res.declined_mutation?.decision).toMatchObject({ approved: false });
      expect(res.declined_mutation?.proposal.description).toBe("edit file");
      expect(res.cycles_completed).toBe(0);
      const cycleDir = path.join(root, ".lemma", "auto", res.run_id, "1");
      const files = await fs.readdir(cycleDir).catch(() => [] as string[]);
      expect(files.some((f) => f.startsWith("applied-"))).toBe(false);
    });
  });

  it("resumes from last completed cycle", async () => {
    await withTempDir(async (root) => {
      let seen: number[] = [];
      const first = await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 1,
        approveMutation: async () => ({ approved: true }),
        executeCycle: async ({ cycle }) => {
          seen.push(cycle);
          return { findings_count: cycle, new_findings_count: 1, progress_made: true };
        },
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
        seed: 7,
        runId: "auto-fixed-run",
      });
      expect(first.cycles_completed).toBe(1);
      const second = await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 3,
        approveMutation: async () => ({ approved: true }),
        executeCycle: async ({ cycle }) => {
          seen.push(cycle);
          return { findings_count: cycle, new_findings_count: 1, progress_made: true };
        },
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
        seed: 7,
        runId: "auto-fixed-run",
        resume: true,
      });
      expect(second.run_id).toBe("auto-fixed-run");
      expect(second.resumed_from_cycle).toBe(1);
      expect(second.cycles_completed).toBe(3);
      expect(seen).toEqual([1, 2, 3]);
    });
  });

  it("refuses resume on registry fingerprint mismatch (LEM-021)", async () => {
    await withTempDir(async (root) => {
      await runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 1,
        approveMutation: async () => ({ approved: true }),
        executeCycle: async () => ({ findings_count: 1, new_findings_count: 1, progress_made: true }),
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
        runId: "auto-fp",
        registryFingerprint: "fp-a",
      });
      await expect(runAutoLoop({
        root,
        target: { kind: "directory", resolved: root },
        maxCycles: 2,
        approveMutation: async () => ({ approved: true }),
        executeCycle: async () => ({ findings_count: 1, new_findings_count: 1, progress_made: true }),
        clock: "frozen",
        frozenNow: "2026-11-16T00:00:00Z",
        runId: "auto-fp",
        resume: true,
        registryFingerprint: "fp-b",
      })).rejects.toBeInstanceOf(StateError);
    });
  });

  it("is deterministic with stub executor, frozen clock, and same seed/run inputs", async () => {
    await withTempDir(async (rootA) => {
      await withTempDir(async (rootB) => {
        const mk = async (root: string) => runAutoLoop({
          root,
          target: { kind: "directory", resolved: "/repo" },
          maxCycles: 3,
          approveMutation: async () => ({ approved: true }),
          executeCycle: async ({ cycle, writeEvidence }) => {
            await writeEvidence("trace.json", { cycle, token: "SECRET_SHOULD_REDACT" });
            return { findings_count: 3 - cycle, new_findings_count: cycle === 3 ? 0 : 1, progress_made: cycle !== 3 };
          },
          clock: "frozen",
          frozenNow: "2026-11-16T00:00:00Z",
          seed: 42,
          runId: "auto-det",
          registryFingerprint: "same-fp",
        });
        const a = await mk(rootA);
        const b = await mk(rootB);
        expect(a.status).toBe(b.status);
        expect(a.stop_reason).toBe(b.stop_reason);
        expect(a.cycles.map((c) => ({ cycle: c.cycle, status: c.status, findings_count: c.findings_count, new_findings_count: c.new_findings_count, progress_made: c.progress_made })))
          .toEqual(b.cycles.map((c) => ({ cycle: c.cycle, status: c.status, findings_count: c.findings_count, new_findings_count: c.new_findings_count, progress_made: c.progress_made })));
        const tracePath = a.cycles[0].evidence.files.find((f) => f.endsWith("trace.json"))!;
        const trace = JSON.parse(await fs.readFile(tracePath, "utf8"));
        expect(JSON.stringify(trace)).not.toContain("SECRET_SHOULD_REDACT");
      });
    });
  });
});
