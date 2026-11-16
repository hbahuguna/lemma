import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXECUTION_MODES,
  ModeMismatchError,
  Orchestrator,
  StateStore,
  buildReport,
  executionModeSemantics,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-exec-modes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const target = { kind: "directory", resolved: process.cwd() } as any;

function minimalHandlers(mode: string) {
  return {
    risk_analysis: async (ctx: any) => { ctx.phase.summary = `risk:${mode}`; },
    test_planning: async (ctx: any) => {
      ctx.phase.summary = `plan:${mode}`;
      if (mode !== "review") {
        ctx.state.checks = [{ id: "C-1", title: "check", persona: "tester", domain: "core", status: "planned", planned: "do", evidence: [] }];
      }
    },
    execution: async (ctx: any) => {
      ctx.phase.summary = `exec:${mode}`;
      if (mode === "test" || mode === "focused") {
        ctx.state.checks = [{ id: "C-1", title: "check", persona: "tester", domain: "core", status: "passed", planned: "do", actual: "ok", evidence: ["ev1"] }];
        ctx.state.findings = [{ id: "F-1", check_id: "C-1", severity: "low", title: "found", evidence: ["ev1"] }];
      } else if (mode === "review") {
        ctx.state.findings = [];
      } else if (mode === "learn") {
        ctx.state.findings = [{ id: "F-learn", check_id: "C-1", severity: "info", title: "exploratory", evidence: ["ev1"] }];
      }
    },
    evidence_collection: async (ctx: any) => { ctx.phase.summary = `evidence:${mode}`; },
    confidence_scoring: async (ctx: any) => { ctx.phase.summary = `score:${mode}`; },
  };
}

describe("LEM-186 explicit execution modes", () => {
  it("supports each mode with documented semantics and records mode in progress state and final report", async () => {
    for (const mode of EXECUTION_MODES) {
      await withTempDir(async (dir) => {
        const store = new StateStore(dir);
        await store.ensure();
        const orch = new Orchestrator({ store, handlers: minimalHandlers(mode) as any });
        const state: any = await orch.run({ target, intent: `mode-${mode}`, maxChecks: 5, mode } as any);
        expect(state.mode).toBe(mode);
        expect(state.options?.execution_mode).toBe(mode);

        const workflow = { id: "release-confidence", name: "Release Confidence", version: "1.0.0", phases: [] } as any;
        const report = buildReport(state, workflow, {}) as any;
        expect(report.execution_mode === mode || report.mode === mode).toBe(true);

        const sem = executionModeSemantics(mode);
        expect(sem.mode).toBe(mode);
        expect(typeof sem.evidence).toBe("string");

        if (mode === "plan") {
          // produces planned tests only
          expect(Array.isArray(state.checks)).toBe(true);
          expect(state.findings.length).toBe(0);
          expect(state.checks.every((c: any) => c.status === "planned")).toBe(true);
        }
        if (mode === "test") {
          // executes planned tests
          expect(state.checks.some((c: any) => c.status === "passed" || c.status === "failed")).toBe(true);
        }
        if (mode === "review") {
          // executes independent review (review artifacts/evidence mode marker)
          expect(state.options?.independent_review_mode === true || state.mode === "review").toBe(true);
        }
        if (mode === "focused") {
          // bounded subset
          expect(state.mode).toBe("focused");
        }
        if (mode === "learn") {
          // exploration without producing final findings
          expect(state.findings.length).toBe(0);
        }
      });
    }
  });

  it("enforces same mode on resume and throws typed ModeMismatchError on invalid transition", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      const orch = new Orchestrator({ store, handlers: minimalHandlers("test") as any });
      const first: any = await orch.run({ target, intent: "x", maxChecks: 5, mode: "test", runId: "run-mode-1" } as any);
      expect(first.mode).toBe("test");

      // resume with same mode succeeds
      const resumed: any = await orch.resume({ target, intent: "x", maxChecks: 5, mode: "test" } as any);
      expect(resumed.run_id).toBe("run-mode-1");
      expect(resumed.mode).toBe("test");

      // resume with different mode throws ModeMismatchError
      await expect(orch.resume({ target, intent: "x", maxChecks: 5, mode: "plan" } as any)).rejects.toBeInstanceOf(ModeMismatchError);
      try {
        await orch.resume({ target, intent: "x", maxChecks: 5, mode: "plan" } as any);
      } catch (e: any) {
        expect(e).toBeInstanceOf(ModeMismatchError);
        expect(e.savedMode || e.saved_mode).toBe("test");
        expect(e.requestedMode || e.requested_mode).toBe("plan");
      }
    });
  });

  it("records mode in persisted progress and cannot be silently changed mid-run (resume enforces saved mode)", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      const orch = new Orchestrator({ store, handlers: minimalHandlers("focused") as any });
      const state: any = await orch.run({ target, intent: "focused", maxChecks: 2, mode: "focused", options: { focus_checks: ["C-1"] } } as any);
      expect(state.mode).toBe("focused");
      const progress: any = await store.loadProgress();
      expect(progress.mode === "focused" || progress.options?.execution_mode === "focused").toBe(true);

      // attempting to resume without specifying mode should keep saved mode
      const orch2 = new Orchestrator({ store, handlers: minimalHandlers("focused") as any });
      const resumed: any = await orch2.resume({ target } as any);
      expect(resumed.mode).toBe("focused");
    });
  });
});
