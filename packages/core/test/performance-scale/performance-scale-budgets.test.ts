import { mkdtemp, rm } from "node:fs/promises";
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
  Severity,
  Strength,
  buildReport,
  isValidReport,
  normalizeConfidence,
  normalizeTarget,
  scoreConfidence,
  validateReport,
  type Check,
  type Finding,
  type Phase,
  type RunStateDomain,
} from "../../src/index.js";
import { StateStore } from "../../src/index.js";
import type { Workflow } from "../../src/workflows.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-perf-scale-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const workflow = RELEASE_CONFIDENCE as unknown as Workflow;

function makeCheck(i: number): Check {
  const passed = i % 5 !== 0;
  return {
    id: `check-${i}`,
    title: `Check ${i}`,
    domain: i % 3 === 0 ? "security" : i % 3 === 1 ? "functional" : "reliability",
    persona: "functional",
    kind: "static",
    intent: "scale budget",
    expected: "ok",
    base_weight: 1,
    weight: 1 + (i % 3) * 0.25,
    status: passed ? CheckStatus.PASSED : CheckStatus.FAILED,
    actual: passed ? "ok" : "failed",
    evidence: passed ? [`.lemma/evidence/run-scale/check-${i}.txt`] : [],
    finding_ids: passed ? [] : [`finding-${i}`],
    skip_reason: "",
    metadata: {},
    started_at: "2026-11-16T00:00:00Z",
    completed_at: "2026-11-16T00:00:00Z",
  };
}

function makeFinding(i: number): Finding {
  const sev = i % 20 === 0 ? Severity.HIGH : i % 7 === 0 ? Severity.MEDIUM : Severity.LOW;
  return {
    id: `finding-${i}`,
    title: `Finding ${i}`,
    severity: sev,
    domain: "security",
    persona: "functional",
    strength: Strength.SOURCE_PROVEN,
    consequence: "scale test finding",
    location: `file-${i}.ts`,
    reproduction: "n/a",
    evidence: [`.lemma/evidence/run-scale/f-${i}.json`],
    remediation: "fix",
    verification: "retest",
    check_id: `check-${i}`,
    created_at: "2026-11-16T00:00:00Z",
    tags: ["scale"],
    fingerprint: `fp-${i}`,
    suppressed: false,
    suppression_owner: "",
    suppression_reason: "",
    suppression_ticket: "",
    suppression_expires_at: "",
  };
}

function phases(): Phase[] {
  return [
    { name: "risk_analysis", title: "Risk Analysis", status: "completed", summary: "", details: {}, started_at: "2026-11-16T00:00:00Z", completed_at: "2026-11-16T00:00:00Z" },
    { name: "test_planning", title: "Test Planning", status: "completed", summary: "", details: {}, started_at: "2026-11-16T00:00:00Z", completed_at: "2026-11-16T00:00:00Z" },
    { name: "execution", title: "Execution", status: "completed", summary: "", details: {}, started_at: "2026-11-16T00:00:00Z", completed_at: "2026-11-16T00:00:00Z" },
    { name: "evidence_collection", title: "Evidence Collection", status: "completed", summary: "", details: {}, started_at: "2026-11-16T00:00:00Z", completed_at: "2026-11-16T00:00:00Z" },
    { name: "confidence_scoring", title: "Confidence Scoring", status: "completed", summary: "", details: {}, started_at: "2026-11-16T00:00:00Z", completed_at: "2026-11-16T00:00:00Z" },
  ];
}

describe("LEM-131 performance and scale budgets", () => {
  it("scores and builds a schema-valid report for large synthetic state (>=1000 checks, >=400 findings)", () => {
    const checkCount = 1200;
    const findingCount = 400;
    const checks: Check[] = Array.from({ length: checkCount }, (_, i) => makeCheck(i + 1));
    const findings: Finding[] = Array.from({ length: findingCount }, (_, i) => makeFinding((i + 1) * 5));

    const confidence = scoreConfidence(checks, findings, { halted: false });
    expect(confidence.score).toBeGreaterThanOrEqual(0);
    expect(confidence.score).toBeLessThanOrEqual(100);
    expect(confidence.coverage).toBeGreaterThan(0);
    expect(typeof confidence.band).toBe("string");

    const state: RunStateDomain = {
      schema_version: "1.0",
      run_id: "run-scale-1",
      workflow_id: RELEASE_CONFIDENCE.id,
      workflow_version: RELEASE_CONFIDENCE.version,
      target: { raw: ".", kind: "directory", resolved: "/repo", source: null } as RunStateDomain["target"],
      intent: "scale budget",
      status: RunStatus.COMPLETED,
      current_phase: "confidence_scoring",
      phases: phases(),
      risks: [],
      checks,
      findings,
      invalid_findings: [],
      blockers: [],
      contract_failures: {},
      contract_failure_streaks: {},
      degraded_personas: [],
      confidence: normalizeConfidence(confidence),
      kill_switch: { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
      inventory: {},
      personas: [],
      options: { maxChecks: checkCount },
      evidence_dir: ".lemma/evidence/run-scale-1",
      started_at: "2026-11-16T00:00:00Z",
      updated_at: "2026-11-16T00:00:10Z",
      completed_at: "2026-11-16T00:00:10Z",
      halted_reason: "",
      error: "",
      seed: null,
      clock_mode: "real",
    };

    const report = buildReport(
      state,
      workflow,
      { directory: ".lemma/evidence/run-scale-1", count: checks.length, by_kind: { text: checks.length }, total_bytes: 0, manifest: ".lemma/evidence/run-scale-1/manifest.json" },
      "2026-11-16T00:00:10Z",
    );

    expect(report.status).toBe(RunStatus.COMPLETED);
    expect(Array.isArray(report.checks)).toBe(true);
    expect((report.checks as unknown[]).length).toBe(checkCount);
    expect(Array.isArray(report.findings)).toBe(true);
    expect((report.findings as unknown[]).length).toBe(findingCount);
    expect((report.decision as { decision: string }).decision).toMatch(/ship|hold|review/);

    const errors = validateReport(report);
    if (errors.length > 0) {
      expect(errors).toEqual([]);
    }
    expect(isValidReport(report)).toBe(true);
  });

  it("records, finalizes, and verifies many evidence artifacts (>=250) correctly", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-evidence-scale");
      await store.init();
      const count = 300;
      for (let i = 0; i < count; i++) {
        await store.saveText(`artifact-${i}`, `payload-${i}`, "text", `desc ${i}`, `check-${i % 20}`);
      }
      await store.checkpoint();
      const manifest = await store.finalize({ run_id: "run-evidence-scale", status: "completed" });

      expect(Array.isArray(manifest.evidence)).toBe(true);
      expect(manifest.evidence.length).toBe(count);
      expect(manifest.summary.count).toBe(count);
      expect(typeof manifest.manifest_sha256).toBe("string");

      const verification = await store.verify();
      expect(verification.tampered).toBe(false);
      expect(verification.signature_valid).toBe(true);
      expect(verification.checked).toBe(count);
      expect(verification.missing).toEqual([]);
      expect(verification.mismatches).toEqual([]);
      expect(verification.alert.level).toBe("ok");
    });
  });

  it("enforces orchestrator maxChecks budget at synthetic planning scale", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const maxChecks = 25;
      const orch = new Orchestrator({
        store,
        handlers: {
          test_planning: (ctx) => {
            const planned: Check[] = Array.from({ length: 200 }, (_, i) => ({
              id: `c-${i + 1}`,
              title: `C ${i + 1}`,
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
            }));
            ctx.state.checks = planned.slice(0, ctx.budget.maxChecks);
          },
          execution: (ctx) => {
            ctx.state.checks = ctx.state.checks.map((c) => ({ ...c, status: CheckStatus.PASSED, actual: "ok" }));
          },
          evidence_collection: (ctx) => {
            ctx.phase.summary = "ok";
          },
          confidence_scoring: (ctx) => {
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, { halted: false });
          },
        },
      });

      const result = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        intent: "budget",
        workflow: RELEASE_CONFIDENCE,
        maxChecks,
      });

      expect(result.status).toBe(RunStatus.COMPLETED);
      expect(result.options.maxChecks).toBe(maxChecks);
      expect(result.checks.length).toBe(maxChecks);
      expect(result.checks.every((c) => c.status === CheckStatus.PASSED)).toBe(true);
      expect(result.phases.map((p) => p.name)).toEqual([...PHASE_ORDER]);
      expect(result.phases.every((p) => p.status === "completed")).toBe(true);
    });
  });
});
