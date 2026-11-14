import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  DomainPhaseName,
  EvidenceStore,
  Orchestrator,
  PhaseStatus,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateError,
  StateStore,
  normalizeTarget,
  registryFingerprint,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-resume-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

describe("LEM-021 resume, crash safety, and registry fingerprint", () => {
  it("records registry fingerprint and resumes unchanged without mutating completed run identity", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({ store });
      const state = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
      });
      expect(state.options.registry_fingerprint).toBe(registryFingerprint(null));
      expect(state.options.plugin_registry_fingerprint).toBe(state.options.registry_fingerprint);

      const beforeProgress = await readFile(store.progressPath, "utf8");
      const resumed = await orch.resume({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        workflow: RELEASE_CONFIDENCE,
      });
      expect(resumed.run_id).toBe(state.run_id);
      expect(resumed.status).toBe(RunStatus.COMPLETED);
      expect(resumed.options.registry_fingerprint).toBe(state.options.registry_fingerprint);
      // completed run can be resumed idempotently; progress remains valid completed state
      const afterProgress = JSON.parse(await readFile(store.progressPath, "utf8")) as Record<string, unknown>;
      expect(afterProgress.run_id).toBe(state.run_id);
      expect(beforeProgress).toContain(state.run_id);
    });
  });

  it("resumes after simulated crash, rerunning only unfinished checks and preserving completed evidence/findings", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();
      const runId = "run-crash-1";
      const evidence = new EvidenceStore(dir, runId);
      await evidence.init();
      const completedEvidencePath = await evidence.saveText(
        "static-a",
        "ok",
        "text",
        "completed artifact",
        "check.completed",
      );
      await evidence.checkpoint();

      const crashedState = {
        schema_version: "1.0",
        run_id: runId,
        workflow_id: "release-confidence",
        workflow_version: RELEASE_CONFIDENCE.version,
        target: { raw: ".", kind: "directory", resolved: "/repo", source: null },
        intent: "ship",
        status: RunStatus.FAILED,
        current_phase: DomainPhaseName.EXECUTION,
        phases: [
          { name: "risk_analysis", title: "Risk Analysis", status: PhaseStatus.COMPLETED, summary: "", details: {}, started_at: "t", completed_at: "t" },
          { name: "test_planning", title: "Test Planning", status: PhaseStatus.COMPLETED, summary: "", details: {}, started_at: "t", completed_at: "t" },
          { name: "execution", title: "Execution", status: PhaseStatus.RUNNING, summary: "", details: {}, started_at: "t", completed_at: null },
          { name: "evidence_collection", title: "Evidence Collection", status: PhaseStatus.PENDING, summary: "", details: {}, started_at: null, completed_at: null },
          { name: "confidence_scoring", title: "Confidence Scoring", status: PhaseStatus.PENDING, summary: "", details: {}, started_at: null, completed_at: null },
        ],
        risks: [],
        checks: [
          {
            id: "check.completed",
            title: "Completed",
            domain: "functional",
            persona: "p",
            kind: "static",
            intent: "i",
            expected: "e",
            base_weight: 1,
            weight: 1,
            status: CheckStatus.PASSED,
            actual: "done",
            evidence: [completedEvidencePath],
            finding_ids: ["f.completed"],
            skip_reason: "",
            started_at: "t",
            completed_at: "t",
            metadata: {},
          },
          {
            id: "check.error",
            title: "Errored",
            domain: "functional",
            persona: "p",
            kind: "static",
            intent: "i",
            expected: "e",
            base_weight: 1,
            weight: 1,
            status: CheckStatus.ERROR,
            actual: "boom",
            evidence: [],
            finding_ids: ["f.error"],
            skip_reason: "",
            started_at: "t",
            completed_at: "t",
            metadata: {},
          },
          {
            id: "check.running",
            title: "Running",
            domain: "functional",
            persona: "p",
            kind: "static",
            intent: "i",
            expected: "e",
            base_weight: 1,
            weight: 1,
            status: CheckStatus.RUNNING,
            actual: "",
            evidence: [],
            finding_ids: [],
            skip_reason: "",
            started_at: "t",
            completed_at: null,
            metadata: {},
          },
          {
            id: "check.planned",
            title: "Planned",
            domain: "functional",
            persona: "p",
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
          },
        ],
        findings: [
          {
            id: "f.completed",
            title: "keep",
            severity: "low",
            domain: "functional",
            persona: "p",
            strength: "heuristic",
            consequence: "c",
            location: "",
            reproduction: "",
            evidence: [],
            remediation: "",
            verification: "",
            check_id: "check.completed",
            created_at: "t",
            tags: [],
            fingerprint: "fp-completed",
            suppressed: false,
            suppression_owner: "",
            suppression_reason: "",
            suppression_ticket: "",
            suppression_expires_at: "",
          },
          {
            id: "f.error",
            title: "drop-rerun",
            severity: "medium",
            domain: "functional",
            persona: "p",
            strength: "heuristic",
            consequence: "c",
            location: "",
            reproduction: "",
            evidence: [],
            remediation: "",
            verification: "",
            check_id: "check.error",
            created_at: "t",
            tags: [],
            fingerprint: "fp-error",
            suppressed: false,
            suppression_owner: "",
            suppression_reason: "",
            suppression_ticket: "",
            suppression_expires_at: "",
          },
        ],
        invalid_findings: [],
        blockers: [
          {
            id: "b.completed",
            persona: "p",
            check_id: "check.completed",
            attempted_action: "",
            boundary: "x",
            unblock_evidence: [],
            covered_elsewhere: false,
            covered_by: [],
            recorded_at: "t",
          },
          {
            id: "b.error",
            persona: "p",
            check_id: "check.error",
            attempted_action: "",
            boundary: "x",
            unblock_evidence: [],
            covered_elsewhere: false,
            covered_by: [],
            recorded_at: "t",
          },
        ],
        contract_failures: {},
        contract_failure_streaks: {},
        degraded_personas: [],
        confidence: { score: 0, band: "unscored", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: {} },
        kill_switch: { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
        inventory: {},
        personas: [],
        options: { maxChecks: 10, registry_fingerprint: registryFingerprint(null), plugin_registry_fingerprint: registryFingerprint(null) },
        evidence_dir: `.lemma/evidence/${runId}`,
        started_at: "t",
        updated_at: "t",
        completed_at: null,
        halted_reason: "",
        error: "simulated crash",
        seed: null,
        clock_mode: "real",
      };
      await store.saveProgress(crashedState);

      const seenReruns: string[] = [];
      const orch = new Orchestrator({
        store,
        handlers: {
          execution: (ctx) => {
            // only unfinished checks should remain in rerunnable/planned form after resume prep
            for (const check of ctx.state.checks) {
              if (check.status === CheckStatus.PLANNED || check.status === CheckStatus.RUNNING || check.status === CheckStatus.ERROR) {
                seenReruns.push(check.id);
                check.status = CheckStatus.PASSED;
                check.actual = "reran";
              }
            }
          },
        },
      });

      const resumed = await orch.resume({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        workflow: RELEASE_CONFIDENCE,
      });

      expect(resumed.status).toBe(RunStatus.COMPLETED);
      expect(new Set(seenReruns)).toEqual(new Set(["check.error", "check.running", "check.planned"]));
      const completed = resumed.checks.find((c) => c.id === "check.completed");
      expect(completed?.status).toBe(CheckStatus.PASSED);
      expect(completed?.evidence).toEqual([completedEvidencePath]);
      expect(resumed.findings.some((f) => f.id === "f.completed" && f.check_id === "check.completed")).toBe(true);
      expect(resumed.findings.some((f) => f.id === "f.error")).toBe(false);
      expect(resumed.blockers.some((b) => b.id === "b.completed")).toBe(true);
      expect(resumed.blockers.some((b) => b.id === "b.error")).toBe(false);
      expect(resumed.error).toBe("");

      const manifest = await readJson<Record<string, unknown>>(evidence.manifestPath);
      const entries = (manifest.evidence as Array<Record<string, unknown>>) ?? [];
      expect(entries.some((e) => e.path === completedEvidencePath && e.check_id === "check.completed")).toBe(true);
    });
  });

  it("rejects target mismatch and registry fingerprint change without mutating saved state/evidence", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({ store });
      const state = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo-a" }),
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
      });
      const evidence = new EvidenceStore(dir, state.run_id);
      await evidence.init();
      const artifact = await evidence.saveText("note", "hello", "text", "x", "check.completed");
      await evidence.checkpoint();
      const progressBefore = await readFile(store.progressPath, "utf8");
      const manifestBefore = await readFile(evidence.manifestPath, "utf8");

      await expect(
        orch.resume({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo-b" }),
          workflow: RELEASE_CONFIDENCE,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof StateError && /Resume target does not match/.test(String(err)));

      await expect(
        orch.resume({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo-a" }),
          workflow: RELEASE_CONFIDENCE,
          registryFingerprint: "different-registry-fingerprint",
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof StateError && /Plugin registry changed/.test(String(err)));

      expect(await readFile(store.progressPath, "utf8")).toBe(progressBefore);
      expect(await readFile(evidence.manifestPath, "utf8")).toBe(manifestBefore);
      const manifest = JSON.parse(await readFile(evidence.manifestPath, "utf8")) as { evidence: Array<{ path: string }> };
      expect(manifest.evidence.some((e) => e.path === artifact)).toBe(true);
    });
  });
});
