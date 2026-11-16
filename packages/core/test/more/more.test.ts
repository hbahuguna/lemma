import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  Orchestrator,
  PHASE_ORDER,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateError,
  StateStore,
  normalizeTarget,
  planChecks,
  runMore,
  scoreConfidence,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-more-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function basicHandlers(executed: string[]) {
  return {
    test_planning: (ctx: any) => {
      // first run: plan 5 but cap to 2 (deferred derived from run's own plan)
      if (!Array.isArray(ctx.state.checks) || ctx.state.checks.length === 0) {
        const planned = Array.from({ length: 5 }, (_, i) => ({
          id: `c${i + 1}`,
          title: `Check ${i + 1}`,
          domain: "functional",
          persona: "functional",
          kind: "static",
          intent: "i",
          expected: "e",
          base_weight: 1,
          weight: 1,
          status: CheckStatus.PLANNED,
          actual: "",
          evidence: [],
          finding_ids: [],
          skip_reason: "",
          started_at: null,
          completed_at: null,
          metadata: {},
        }));
        ctx.state.inventory = { available: true };
        ctx.state.personas = [{ id: "functional", checks: planned.map((c) => c.id) }];
        ctx.state.options = {
          ...(ctx.state.options ?? {}),
          maxChecks: ctx.budget.maxChecks,
          ownership: { c1: ["functional"], c2: ["functional"], c3: ["functional"], c4: ["functional"], c5: ["functional"] },
          selected_personas: ["functional"],
          planned_check_ids: planned.map((c) => c.id),
        };
        ctx.state.checks = planned.slice(0, ctx.budget.maxChecks);
      }
    },
    execution: async (ctx: any) => {
      for (const c of ctx.state.checks) {
        if (c.status === CheckStatus.PASSED) continue; // no re-run if already succeeded
        if (c.status === CheckStatus.PLANNED || c.status === CheckStatus.RUNNING) {
          executed.push(c.id);
          c.status = CheckStatus.PASSED;
          c.actual = `ok:${c.id}`;
          c.completed_at = "2026-11-16T00:00:01Z";
        }
      }
    },
    evidence_collection: (ctx: any) => {
      ctx.phase.summary = "evidence ok";
    },
    confidence_scoring: (ctx: any) => {
      ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, { halted: false });
    },
  } as any;
}

describe("LEM-165 continue deferred checks (runMore)", () => {
  it("derives deferred checks from run maxChecks cut line and extends same run id", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const executed: string[] = [];
      const handlers = basicHandlers(executed);
      const orch = new Orchestrator({ store, handlers });
      const run = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        intent: "more",
        workflow: RELEASE_CONFIDENCE,
        maxChecks: 2,
      });
      expect(run.run_id).toBeTruthy();
      expect(run.checks.map((c) => c.id)).toEqual(["c1", "c2"]);
      expect(run.options.maxChecks).toBe(2);

      const continued = await runMore({ runId: run.run_id, stateStore: store, options: { handlers } as any } as any);
      expect(continued.run_id).toBe(run.run_id);
      // deferred set derived from own plan/cut line -> remaining checks executed
      expect(continued.checks.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
      expect(continued.checks.every((c) => c.status === CheckStatus.PASSED)).toBe(true);
      // no re-run of succeeded checks
      expect(executed).toEqual(["c1", "c2", "c3", "c4", "c5"]);
      expect(continued.status === RunStatus.COMPLETED || continued.status === RunStatus.HALTED || continued.status === RunStatus.FAILED).toBe(true);
    });
  });

  it("refuses with typed StateError when no deferred checks remain (no fabricated work)", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const handlers = {
        test_planning: (ctx: any) => {
          ctx.state.inventory = { available: true };
          ctx.state.personas = [{ id: "functional", checks: ["c1"] }];
          ctx.state.options = { ...(ctx.state.options ?? {}), maxChecks: 5, ownership: { c1: ["functional"] }, planned_check_ids: ["c1"] };
          ctx.state.checks = [{
            id: "c1", title: "C1", domain: "functional", persona: "functional", kind: "static", intent: "i", expected: "e",
            base_weight: 1, weight: 1, status: CheckStatus.PLANNED, actual: "", evidence: [], finding_ids: [], skip_reason: "", started_at: null, completed_at: null, metadata: {},
          }];
        },
        execution: (ctx: any) => { for (const c of ctx.state.checks) { c.status = CheckStatus.PASSED; c.actual = "ok"; } },
        evidence_collection: (ctx: any) => { ctx.phase.summary = "ok"; },
        confidence_scoring: (ctx: any) => { ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, { halted: false }); },
      } as any;
      const orch = new Orchestrator({ store, handlers });
      const run = await orch.run({ target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }), intent: "more", workflow: RELEASE_CONFIDENCE, maxChecks: 5 });
      await expect(runMore({ runId: run.run_id, stateStore: store, options: { handlers } as any } as any)).rejects.toBeInstanceOf(StateError);
      await expect(runMore({ runId: run.run_id, stateStore: store, options: { handlers } as any } as any)).rejects.toSatisfy((e: any) => /deferred|no.*fabricat|exhaust/i.test(String(e?.message || e)));
    });
  });

  it("refuses with typed StateError on registry fingerprint mismatch (LEM-021)", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const executed: string[] = [];
      const handlers = basicHandlers(executed);
      const orch = new Orchestrator({ store, handlers });
      const run = await orch.run({ target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }), intent: "more", workflow: RELEASE_CONFIDENCE, maxChecks: 2 });
      await expect(runMore({ runId: run.run_id, stateStore: store, options: { registryFingerprint: "definitely-different-fingerprint", handlers } as any } as any)).rejects.toBeInstanceOf(StateError);
      await expect(runMore({ runId: run.run_id, stateStore: store, options: { registryFingerprint: "definitely-different-fingerprint", handlers } as any } as any)).rejects.toSatisfy((e: any) => /fingerprint|registry/i.test(String(e?.message || e)));
    });
  });

  it("preserves evidence linkage and continues same run with evidence store", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const executed: string[] = [];
      const handlers = {
        ...basicHandlers(executed),
        execution: async (ctx: any) => {
          const ev = new EvidenceStore(dir, ctx.state.run_id);
          await ev.init();
          for (const c of ctx.state.checks) {
            if (c.status === CheckStatus.PASSED) continue;
            if (c.status === CheckStatus.PLANNED || c.status === CheckStatus.RUNNING) {
              executed.push(c.id);
              c.status = CheckStatus.PASSED;
              c.actual = `ok:${c.id}`;
              const p = await ev.saveText(`${c.id}.txt`, `evidence:${c.id}`, "text", c.id, c.id);
              c.evidence = [p];
              c.completed_at = "2026-11-16T00:00:01Z";
            }
          }
        },
      } as any;
      const orch = new Orchestrator({ store, handlers });
      const run = await orch.run({ target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }), intent: "more", workflow: RELEASE_CONFIDENCE, maxChecks: 2 });
      const continued = await runMore({ runId: run.run_id, stateStore: store, options: { handlers } as any } as any);
      expect(continued.run_id).toBe(run.run_id);
      expect(continued.checks.some((c) => c.id === "c3" && c.status === CheckStatus.PASSED)).toBe(true);
      const ev = new EvidenceStore(dir, continued.run_id);
      await ev.init();
      const summary = ev.summary();
      expect(summary.directory).toContain(continued.run_id);
    });
  });

  it("is deterministic for same seed + frozen clock + same run (extended artifacts stable)", async () => {
    await withTempDir(async (dir1) => {
      await withTempDir(async (dir2) => {
        const mk = async (dir: string) => {
          const store = new StateStore(dir);
          const executed: string[] = [];
          const handlers = basicHandlers(executed);
          const orch = new Orchestrator({ store, handlers });
          const run = await orch.run({
            target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
            intent: "more",
            workflow: RELEASE_CONFIDENCE,
            maxChecks: 2,
            seed: 42,
            clockMode: "frozen",
            frozenClock: "2026-11-16T00:00:00Z",
          });
          const continued = await runMore({ runId: run.run_id, stateStore: store, options: { handlers } as any } as any);
          return { continued, executed };
        };
        const a = await mk(dir1);
        const b = await mk(dir2);
        expect(a.continued.checks.map((c) => [c.id, c.status, c.actual])).toEqual(b.continued.checks.map((c) => [c.id, c.status, c.actual]));
        expect(a.executed).toEqual(b.executed);
        expect(a.continued.updated_at).toBe(b.continued.updated_at);
      });
    });
  });
});
