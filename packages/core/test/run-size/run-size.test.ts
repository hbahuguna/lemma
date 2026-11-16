import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_SIZE,
  Orchestrator,
  RUN_SIZE_PERSPECTIVES,
  RunSizeMismatchError,
  StateStore,
  applyRunSizeToPlan,
  buildReport,
  buildRunSizeCoverageNotes,
  perspectiveCountForSize,
  runSizeCutLine,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-run-size-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const target = { kind: "directory", resolved: process.cwd() } as any;
const workflow = { id: "release-confidence", name: "Release Confidence", version: "1.0.0", phases: [] } as any;

function minimalHandlers() {
  return {
    risk_analysis: async (ctx: any) => { ctx.phase.summary = "risk"; },
    test_planning: async (ctx: any) => {
      ctx.phase.summary = "plan";
      ctx.state.checks = [
        { id: "C-1", title: "c1", persona: "p1", domain: "core", status: "planned", evidence: [] },
        { id: "C-2", title: "c2", persona: "p2", domain: "core", status: "planned", evidence: [] },
      ];
    },
    execution: async (ctx: any) => { ctx.phase.summary = "exec"; },
    evidence_collection: async (ctx: any) => { ctx.phase.summary = "evidence"; },
    confidence_scoring: async (ctx: any) => { ctx.phase.summary = "score"; },
  };
}

describe("LEM-187 run-size scaling", () => {
  it("records and enforces perspective counts per size and surfaces in report", async () => {
    for (const [size, expected] of Object.entries(RUN_SIZE_PERSPECTIVES) as Array<[any, number]>) {
      await withTempDir(async (dir) => {
        const store = new StateStore(dir);
        await store.ensure();
        const orch = new Orchestrator({ store, handlers: minimalHandlers() as any });
        const state: any = await orch.run({ target, intent: "x", maxChecks: 5, runSize: size } as any);
        expect(state.run_size).toBe(size);
        expect(state.perspectives_count).toBe(expected);
        expect(perspectiveCountForSize(size)).toBe(expected);
        expect(state.options?.run_size).toBe(size);
        expect(state.options?.perspectives_count).toBe(expected);

        const report = buildReport(state, workflow, {}) as any;
        expect(report.run_size).toBe(size);
        expect(report.perspectives_count).toBe(expected);
      });
    }
  });

  it("documents cut lines and emits explicit out-of-scope coverage notes (no silent skips)", async () => {
    for (const size of ["quick", "medium", "large"] as const) {
      const cut = runSizeCutLine(size);
      expect(cut.perspectives).toBe(RUN_SIZE_PERSPECTIVES[size]);
      expect(cut.in_scope.length).toBeGreaterThan(0);
      expect(cut.out_of_scope.length).toBeGreaterThan(0);
      expect(typeof cut.evidence_expectation).toBe("string");

      const notes = buildRunSizeCoverageNotes(size);
      expect(notes.length).toBe(cut.out_of_scope.length);
      for (const family of cut.out_of_scope) {
        expect(notes.some((n) => n.includes(`run size '${size}'`) && n.includes(family))).toBe(true);
      }

      await withTempDir(async (dir) => {
        const store = new StateStore(dir);
        await store.ensure();
        const orch = new Orchestrator({ store, handlers: minimalHandlers() as any });
        const state: any = await orch.run({ target, intent: "x", maxChecks: 5, runSize: size } as any);
        expect(Array.isArray(state.coverage_notes)).toBe(true);
        expect(state.coverage_notes.length).toBeGreaterThan(0);
        // explicit coverage notes, not silent skips
        for (const note of notes) expect(state.coverage_notes).toContain(note);

        const report = buildReport(state, workflow, {}) as any;
        expect(Array.isArray(report.coverage_notes)).toBe(true);
        for (const note of notes) expect(report.coverage_notes).toContain(note);
      });
    }
  });

  it("supports size-aware planning with perspective enforcement and explicit coverage notes", () => {
    const plan = { checks: [{ id: "A" }, { id: "B" }], perspectives: ["p1", "p2", "p3", "p4", "p5"] };
    const sized = applyRunSizeToPlan(plan, "quick", { out_of_scope_families: ["non_critical_integrations"] });
    expect(sized.run_size).toBe("quick");
    expect(sized.perspectives_count).toBe(2);
    expect(sized.perspectives.length).toBe(2);
    expect(sized.coverage_notes.some((n) => n.includes("non_critical_integrations"))).toBe(true);

    const large = applyRunSizeToPlan({ checks: [] }, "large");
    expect(large.perspectives_count).toBe(6);
    expect(large.coverage_notes.length).toBeGreaterThan(0);
  });

  it("enforces same run size on resume and throws typed RunSizeMismatchError on change", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      const orch = new Orchestrator({ store, handlers: minimalHandlers() as any });
      const first: any = await orch.run({ target, intent: "x", maxChecks: 5, runSize: "quick", runId: "run-size-1" } as any);
      expect(first.run_size).toBe("quick");
      expect(first.perspectives_count).toBe(2);

      const resumed: any = await orch.resume({ target, intent: "x", maxChecks: 5, runSize: "quick" } as any);
      expect(resumed.run_id).toBe("run-size-1");
      expect(resumed.run_size).toBe("quick");

      await expect(orch.resume({ target, intent: "x", maxChecks: 5, runSize: "large" } as any)).rejects.toBeInstanceOf(RunSizeMismatchError);
      try {
        await orch.resume({ target, intent: "x", maxChecks: 5, runSize: "large" } as any);
      } catch (e: any) {
        expect(e).toBeInstanceOf(RunSizeMismatchError);
        expect(e.savedSize || e.saved_size).toBe("quick");
        expect(e.requestedSize || e.requested_size).toBe("large");
      }
    });
  });

  it("defaults size for compatibility and records it in progress/report", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      const orch = new Orchestrator({ store, handlers: minimalHandlers() as any });
      const state: any = await orch.run({ target, intent: "x", maxChecks: 5 } as any);
      expect(state.run_size).toBe(DEFAULT_RUN_SIZE);
      expect(state.perspectives_count).toBe(RUN_SIZE_PERSPECTIVES[DEFAULT_RUN_SIZE as keyof typeof RUN_SIZE_PERSPECTIVES]);
      const progress: any = await store.loadProgress();
      expect(progress.run_size === DEFAULT_RUN_SIZE || progress.options?.run_size === DEFAULT_RUN_SIZE).toBe(true);
      const report = buildReport(state, workflow, {}) as any;
      expect(report.run_size).toBe(DEFAULT_RUN_SIZE);
    });
  });
});
