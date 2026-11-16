import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initConfidenceWorkspace, runEvalDesign, runEvalExecute } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-eval-design-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

describe("LEM-184 AI evaluation design and review workflows", () => {
  it("runEvalDesign produces documented checklist and schema-valid design; refuses when checklist fails review and records refusal", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const workspace = path.join(root, ".confidence");

      const approved = await runEvalDesign({
        workspace,
        risks: [{ id: "r1" }],
        claims: [{ id: "c1" }],
        evalId: "eval-approved",
        recordedAt: "2026-11-17T00:00:00Z",
      } as any);
      expect(approved.schema_version).toBe("lemma.confidence.eval_design/v1");
      expect(approved.status).toBe("approved");
      expect(approved.reviewed).toBe(true);
      expect(approved.refusal).toBeNull();
      for (const k of ["populations", "cases", "repetitions", "oracles", "dependence", "blockers"]) {
        expect(approved.checklist[k]).toMatchObject({ reviewed: true, ok: true });
        expect(typeof approved.checklist[k].notes).toBe("string");
      }
      expect(await exists(path.join(workspace, "evals", "eval-approved", "design.json"))).toBe(true);
      expect(await exists(path.join(workspace, "evals", "eval-approved", "design-checklist.json"))).toBe(true);

      const refused = await runEvalDesign({
        workspace,
        risks: [],
        claims: [],
        evalId: "eval-refused",
        recordedAt: "2026-11-17T00:00:00Z",
        checklist: {
          populations: { reviewed: true, ok: true, notes: "ok" },
          cases: { reviewed: true, ok: false, notes: "missing representative cases" },
          repetitions: { reviewed: false, ok: false, notes: "not reviewed" },
          oracles: { reviewed: true, ok: true, notes: "ok" },
          dependence: { reviewed: true, ok: true, notes: "ok" },
          blockers: { reviewed: true, ok: true, notes: "ok" },
        },
      } as any);
      expect(refused.status).toBe("refused");
      expect(refused.refusal?.refused).toBe(true);
      expect(refused.refusal?.failed_items).toEqual(["cases", "repetitions"]);
      expect(refused.refusal?.reason).toMatch(/checklist/i);
    });
  });

  it("runEvalExecute refuses unreviewed/failed designs with recorded refusal (not silent skip)", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const workspace = path.join(root, ".confidence");
      const design = await runEvalDesign({
        workspace,
        evalId: "eval-noexec",
        recordedAt: "2026-11-17T00:00:00Z",
        checklist: { cases: { reviewed: true, ok: false, notes: "bad" } },
      } as any);
      let called = 0;
      const run = await runEvalExecute({
        design,
        runModelEval: async () => { called++; return { cases: [] }; },
        recordedAt: "2026-11-17T00:00:00Z",
      } as any);
      expect(called).toBe(0);
      expect(run.status).toBe("refused");
      expect(run.refusal?.refused).toBe(true);
      expect(run.model_eval).toBeNull();
      expect(run.analysis).toBeNull();
      expect(await exists(path.join(workspace, "evals", "eval-noexec", "refusal.json"))).toBe(true);
      expect(await exists(path.join(workspace, "evals", "eval-noexec", "run.json"))).toBe(true);
    });
  });

  it("executes via LEM-163 runModelEval wiring, persists results under .confidence/evals/<eval_id>/, and reports analysis without claiming statistical significance", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const workspace = path.join(root, ".confidence");
      const design = await runEvalDesign({ workspace, evalId: "eval-run", recordedAt: "2026-11-17T00:00:00Z" } as any);

      const calls: any[] = [];
      const modelEvalResult = {
        schema_version: "lemma.pro.model_eval_result/v1",
        run_id: "eval-run",
        cases: [
          { id: "c1", outcome: "PASS", baseline_outcome: "PASS", note: "ok" },
          { id: "c2", outcome: "FAIL", baseline_outcome: "PASS", note: "regressed" },
          { id: "c3", outcome: "UNEVALUATED", baseline_outcome: null, note: "blocked: no endpoint configured" },
        ],
        summary: { PASS: 1, FAIL: 1, REGRESSION: 0, IMPROVEMENT: 0, UNCHANGED: 0, UNEVALUATED: 1, total: 3 },
      };

      const run = await runEvalExecute({
        design,
        modelConfig: { stub: true },
        recordedAt: "2026-11-17T00:00:00Z",
        runModelEval: async (opts: any) => {
          calls.push(opts);
          return modelEvalResult;
        },
      } as any);

      // execution wiring to LEM-163 runModelEval
      expect(calls.length).toBe(1);
      expect(calls[0].runId).toBe("eval-run");
      expect(calls[0].projectRoot).toBe(workspace);

      expect(run.schema_version).toBe("lemma.confidence.eval_run/v1");
      expect(run.status).toBe("completed");
      expect(run.design_reviewed).toBe(true);

      // workspace persistence
      const evalDir = path.join(workspace, "evals", "eval-run");
      expect(await exists(path.join(evalDir, "design.json"))).toBe(true);
      expect(await exists(path.join(evalDir, "run.json"))).toBe(true);
      expect(await exists(path.join(evalDir, "model-eval.json"))).toBe(true);
      expect(await exists(path.join(evalDir, "analysis.json"))).toBe(true);
      const savedRun = JSON.parse(await fs.readFile(path.join(evalDir, "run.json"), "utf8"));
      expect(savedRun.paths.model_eval_path).toBe(".confidence/evals/eval-run/model-eval.json");

      // analysis reporting
      expect(run.analysis).toBeTruthy();
      expect(run.analysis?.per_outcome_counts.PASS).toBeGreaterThanOrEqual(1);
      expect(run.analysis?.per_outcome_counts.FAIL).toBeGreaterThanOrEqual(1);
      expect(run.analysis?.per_outcome_counts.UNEVALUATED).toBeGreaterThanOrEqual(1);
      expect(run.analysis?.per_case_transitions).toEqual([
        { id: "c1", from: "PASS", to: "PASS", blocked: false },
        { id: "c2", from: "PASS", to: "FAIL", blocked: false },
        { id: "c3", from: null, to: "UNEVALUATED", blocked: true },
      ]);
      expect(run.analysis?.blocked_cases).toContain("c3");
      expect(run.analysis?.statistical_significance_claimed).toBe(false);
      expect(run.analysis?.note).toMatch(/No statistical significance/i);
    });
  });
});
