import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  DomainPhaseName,
  HarnessError,
  Orchestrator,
  PHASE_ORDER,
  PhaseStatus,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateStore,
  normalizeTarget,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-orch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readEvents(store: StateStore): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(store.eventsPath, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("LEM-015 five-phase orchestrator and budget", () => {
  it("runs phases in fixed workflow order with state transitions and persistence", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const seen: string[] = [];
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: (ctx) => {
            seen.push(ctx.phase.name);
            ctx.state.risks = [
              {
                id: "r1",
                title: "risk",
                priority: "high",
                domain: "security",
                consequence: "c",
                evidence: [],
                weight_multiplier: 1,
                source: "analysis",
                status: "open",
              },
            ];
          },
          test_planning: (ctx) => {
            seen.push(ctx.phase.name);
            expect(ctx.budget.maxChecks).toBe(2);
            ctx.state.checks = [
              {
                id: "a",
                title: "A",
                domain: "d",
                persona: "p",
                kind: "static",
                intent: "i",
                expected: "e",
                base_weight: 1,
                status: CheckStatus.PLANNED,
                weight: 1,
                actual: "",
                evidence: [],
                finding_ids: [],
                skip_reason: "",
                started_at: null,
                completed_at: null,
                metadata: {},
              },
              {
                id: "b",
                title: "B",
                domain: "d",
                persona: "p",
                kind: "static",
                intent: "i",
                expected: "e",
                base_weight: 1,
                status: CheckStatus.PLANNED,
                weight: 1,
                actual: "",
                evidence: [],
                finding_ids: [],
                skip_reason: "",
                started_at: null,
                completed_at: null,
                metadata: {},
              },
            ];
          },
          execution: (ctx) => {
            seen.push(ctx.phase.name);
            ctx.state.checks = ctx.state.checks.map((c) => ({ ...c, status: CheckStatus.PASSED }));
          },
          evidence_collection: (ctx) => {
            seen.push(ctx.phase.name);
            ctx.phase.summary = "evidence collected";
          },
          confidence_scoring: (ctx) => {
            seen.push(ctx.phase.name);
            ctx.state.confidence = { ...ctx.state.confidence, score: 100, band: "high" };
          },
        },
      });

      const result = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
        maxChecks: 2,
      });

      expect(seen).toEqual([...PHASE_ORDER]);
      expect(result.status).toBe(RunStatus.COMPLETED);
      expect(result.workflow_id).toBe("release-confidence");
      expect(result.workflow_version).toBe(RELEASE_CONFIDENCE.version);
      expect(result.current_phase).toBe(DomainPhaseName.CONFIDENCE_SCORING);
      expect(result.phases.map((p) => p.name)).toEqual([...PHASE_ORDER]);
      expect(result.phases.every((p) => p.status === PhaseStatus.COMPLETED)).toBe(true);
      expect(result.checks).toHaveLength(2);
      expect(result.options.maxChecks).toBe(2);

      const loaded = await store.loadProgress<Record<string, unknown>>();
      expect(loaded.status).toBe(RunStatus.COMPLETED);
      const history = await store.loadHistory();
      expect(history.runs[0]?.run_id).toBe(result.run_id);
      expect(history.runs[0]?.status).toBe(RunStatus.COMPLETED);
      const events = await readEvents(store);
      expect(events.some((e) => e.event === "run_started")).toBe(true);
      expect(events.some((e) => e.event === "phase_completed" && e.phase === "execution")).toBe(true);
      expect(events.some((e) => e.event === "run_finished")).toBe(true);
    });
  });

  it("enforces budget/options validation and passes maxChecks to handlers", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({ store });
      await expect(
        orch.run({ target: { raw: ".", kind: "directory", resolved: "/r" }, maxChecks: 0 }),
      ).rejects.toThrow(/maxChecks/);
      await expect(
        orch.run({ target: { raw: ".", kind: "directory", resolved: "/r" }, maxChecks: -1 }),
      ).rejects.toThrow(/maxChecks/);
      await expect(
        orch.run({ target: { raw: ".", kind: "directory", resolved: "/r" }, maxChecks: 1.5 }),
      ).rejects.toThrow(HarnessError);

      let seenBudget = -1;
      const orch2 = new Orchestrator({
        store: new StateStore(dir),
        handlers: {
          test_planning: (ctx) => {
            seenBudget = ctx.budget.maxChecks;
          },
        },
      });
      await orch2.run({ target: { raw: ".", kind: "directory", resolved: "/r" }, maxChecks: 3 });
      expect(seenBudget).toBe(3);
    });
  });

  it("halts on kill request, skips remaining phases/checks, persists halted state, and does not auto-resume", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      let executionRan = false;
      let evidenceRan = false;
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: async (ctx) => {
            ctx.state.checks = [
              {
                id: "c1",
                title: "C1",
                domain: "d",
                persona: "p",
                kind: "static",
                intent: "i",
                expected: "e",
                base_weight: 1,
                status: CheckStatus.PLANNED,
                weight: 1,
                actual: "",
                evidence: [],
                finding_ids: [],
                skip_reason: "",
                started_at: null,
                completed_at: null,
                metadata: {},
              },
              {
                id: "c2",
                title: "C2",
                domain: "d",
                persona: "p",
                kind: "static",
                intent: "i",
                expected: "e",
                base_weight: 1,
                status: CheckStatus.RUNNING,
                weight: 1,
                actual: "",
                evidence: [],
                finding_ids: [],
                skip_reason: "",
                started_at: null,
                completed_at: null,
                metadata: {},
              },
            ];
            await ctx.store.requestKill("manual stop");
          },
          execution: () => {
            executionRan = true;
          },
          evidence_collection: () => {
            evidenceRan = true;
          },
          confidence_scoring: () => {},
        },
      });

      const result = await orch.run({ target: { raw: ".", kind: "directory", resolved: "/r" }, maxChecks: 5 });
      expect(result.status).toBe(RunStatus.HALTED);
      expect(result.kill_switch.triggered).toBe(true);
      expect(result.halted_reason.length).toBeGreaterThan(0);
      expect(executionRan).toBe(false);
      expect(evidenceRan).toBe(false);
      const planning = result.phases.find((p) => p.name === DomainPhaseName.TEST_PLANNING);
      expect(planning).toBeDefined();
      expect([PhaseStatus.COMPLETED, PhaseStatus.HALTED]).toContain(planning!.status);
      expect(result.phases.find((p) => p.name === DomainPhaseName.EXECUTION)?.status).toBe(PhaseStatus.SKIPPED);
      expect(result.phases.find((p) => p.name === DomainPhaseName.EVIDENCE_COLLECTION)?.status).toBe(
        PhaseStatus.SKIPPED,
      );
      expect(result.phases.find((p) => p.name === DomainPhaseName.CONFIDENCE_SCORING)?.status).toBe(
        PhaseStatus.SKIPPED,
      );
      expect(result.checks.every((c) => c.status === CheckStatus.SKIPPED)).toBe(true);
      const history = await store.loadHistory();
      expect(history.runs[0]?.status).toBe(RunStatus.HALTED);

      // does not auto-resume: starting a new run creates a new run_id and records separately
      const result2 = await orch.run({ target: { raw: ".", kind: "directory", resolved: "/r" }, maxChecks: 5 });
      expect(result2.run_id).not.toBe(result.run_id);
      const history2 = await store.loadHistory();
      expect(history2.runs.filter((r) => r.status === RunStatus.HALTED).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("supports injectable handlers and records failed runs on handler error", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: () => {
            throw new Error("boom");
          },
        },
      });
      await expect(orch.run({ target: { raw: ".", kind: "directory", resolved: "/r" } })).rejects.toThrow("boom");
      const progress = await store.loadProgress<Record<string, unknown>>();
      expect(progress.status).toBe(RunStatus.FAILED);
      expect(progress.error).toBe("boom");
      const history = await store.loadHistory();
      expect(history.runs[0]?.status).toBe(RunStatus.FAILED);
    });
  });
});
