import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  Orchestrator,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateError,
  StateStore,
  normalizeTarget,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-halted-resume-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });

function haltedState(runId = "run-halted"): Record<string, unknown> {
  return {
    schema_version: "1.0",
    run_id: runId,
    workflow_id: RELEASE_CONFIDENCE.id,
    workflow_version: RELEASE_CONFIDENCE.version,
    target: { raw: ".", kind: "directory", resolved: "/repo", source: null },
    intent: "ship",
    status: RunStatus.HALTED,
    current_phase: "execution",
    phases: [
      { name: "risk_analysis", title: "Risk Analysis", status: "completed", summary: "", details: {}, started_at: "t", completed_at: "t" },
      { name: "test_planning", title: "Test Planning", status: "completed", summary: "", details: {}, started_at: "t", completed_at: "t" },
      { name: "execution", title: "Execution", status: "halted", summary: "", details: {}, started_at: "t", completed_at: "t" },
      { name: "evidence_collection", title: "Evidence Collection", status: "skipped", summary: "halted", details: {}, started_at: "t", completed_at: "t" },
      { name: "confidence_scoring", title: "Confidence Scoring", status: "skipped", summary: "halted", details: {}, started_at: "t", completed_at: "t" },
    ],
    risks: [],
    checks: [],
    findings: [],
    invalid_findings: [],
    blockers: [],
    contract_failures: {},
    contract_failure_streaks: {},
    degraded_personas: [],
    confidence: { score: 0, band: "low", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "fail", reasons: [], policy: "advisory-v1" } },
    kill_switch: { armed: true, threshold: "critical", triggered: true, reason: "manual stop", triggered_at: "t", finding_id: "", manual: true },
    inventory: {},
    personas: [],
    options: { maxChecks: 10 },
    evidence_dir: ".lemma/evidence/run-halted",
    started_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-14T00:00:00Z",
    completed_at: "2026-11-14T00:00:01Z",
    halted_reason: "manual stop",
    error: "",
    seed: null,
    clock_mode: "real",
  };
}

describe("LEM-129 no path resumes a halted run", () => {
  it("rejects Orchestrator.resume() for halted runs without mutating progress", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      await store.saveProgress(haltedState());
      const before = await readFile(store.progressPath, "utf8");

      const orch = new Orchestrator({ store });
      await expect(
        orch.resume({ target, workflow: RELEASE_CONFIDENCE, maxChecks: 10 }),
      ).rejects.toSatisfy((err: unknown) =>
        err instanceof StateError &&
        /halted/i.test(String(err)) &&
        /new run/i.test(String(err)),
      );

      expect(await readFile(store.progressPath, "utf8")).toBe(before);
      const loaded = await store.loadProgress<{ status: string; run_id: string }>();
      expect(loaded.status).toBe(RunStatus.HALTED);
      expect(loaded.run_id).toBe("run-halted");
    });
  });

  it("rejects Orchestrator.run({ resume: true }) for halted runs without mutating progress", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      await store.saveProgress(haltedState("run-halted-2"));
      const before = await readFile(store.progressPath, "utf8");

      const orch = new Orchestrator({ store });
      await expect(
        orch.run({ target, workflow: RELEASE_CONFIDENCE, maxChecks: 10, resume: true }),
      ).rejects.toSatisfy((err: unknown) => err instanceof StateError && /halted/i.test(String(err)));

      expect(await readFile(store.progressPath, "utf8")).toBe(before);
      const loaded = await store.loadProgress<{ status: string; run_id: string }>();
      expect(loaded.status).toBe(RunStatus.HALTED);
      expect(loaded.run_id).toBe("run-halted-2");
    });
  });

  it("starting a new non-resume run creates a distinct run and does not continue halted state", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      await store.saveProgress(haltedState("run-halted-old"));

      const orch = new Orchestrator({ store });
      const fresh = await orch.run({ target, workflow: RELEASE_CONFIDENCE, maxChecks: 5, resume: false });

      expect(fresh.run_id).not.toBe("run-halted-old");
      expect(fresh.status).not.toBe(RunStatus.HALTED);
      expect(fresh.halted_reason).toBe("");

      const progress = await store.loadProgress<{ run_id: string; status: string }>();
      expect(progress.run_id).toBe(fresh.run_id);
      expect(progress.run_id).not.toBe("run-halted-old");

      const history = await store.loadHistory();
      expect(history.runs.some((r) => r.run_id === fresh.run_id)).toBe(true);
    });
  });
});
