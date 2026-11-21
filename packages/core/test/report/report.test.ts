import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  REPORT_SCHEMA,
  RunStatus,
  Severity,
  Strength,
  buildReport,
  isValidReport,
  normalizeConfidence,
  reportSchema,
  validateReport,
  type Blocker,
  type Check,
  type Finding,
  type InvalidFinding,
  type Phase,
  type RunStateDomain,
} from "../../src/index.js";
import type { Workflow } from "../../src/workflows.js";

function workflow(): Workflow {
  return {
    id: "software",
    name: "Software",
    version: "1.0",
    description: "",
    phases: [
      { name: "risk_analysis", title: "Risk Analysis", required: true },
      { name: "test_planning", title: "Test Planning", required: true },
      { name: "execution", title: "Execution", required: true },
      { name: "evidence_collection", title: "Evidence Collection", required: true },
      { name: "confidence_scoring", title: "Confidence Scoring", required: true },
    ],
  } as unknown as Workflow;
}

function baseState(overrides: Partial<RunStateDomain> = {}): RunStateDomain {
  const confidence = normalizeConfidence({
    score: 72.5,
    band: "medium",
    coverage: 80.0,
    rationale: "ok",
    limitations: ["base limitation"],
    penalties: { severity: 10 },
    domain_scores: { functional: 70 },
    breakdown: { coverage: 80 },
    gate: { status: "warn", reasons: ["x"], policy: "advisory-v1" },
  });
  const phases: Phase[] = [
    { name: "risk_analysis", title: "risk_analysis", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
    { name: "test_planning", title: "test_planning", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
    { name: "execution", title: "execution", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
    { name: "evidence_collection", title: "evidence_collection", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
    { name: "confidence_scoring", title: "confidence_scoring", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
  ];
  const checks: Check[] = [
    {
      id: "a",
      title: "A",
      domain: "functional",
      persona: "functional",
      kind: "static",
      intent: "i",
      expected: "e",
      base_weight: 1,
      weight: 1,
      status: CheckStatus.PASSED,
      actual: "ok",
      evidence: ["e1"],
      finding_ids: [],
      skip_reason: "",
      metadata: {},
      started_at: null,
      completed_at: null,
    },
    {
      id: "b",
      title: "B",
      domain: "security",
      persona: "security",
      kind: "static",
      intent: "i",
      expected: "e",
      base_weight: 1,
      weight: 1,
      status: CheckStatus.BLOCKED,
      actual: "",
      evidence: [],
      finding_ids: [],
      skip_reason: "blocked",
      metadata: { limitation: "needs runtime" },
      started_at: null,
      completed_at: null,
    },
  ];
  const findings: Finding[] = [
    {
      id: "f-low",
      title: "low",
      severity: Severity.LOW,
      domain: "functional",
      persona: "functional",
      strength: "heuristic",
      consequence: "c",
      location: "",
      reproduction: "",
      evidence: [],
      remediation: "",
      verification: "",
      check_id: "a",
      created_at: "2026-01-01T00:01:00Z",
      tags: [],
      fingerprint: "fp-low",
      suppressed: false,
      suppression_owner: "",
      suppression_reason: "",
      suppression_ticket: "",
      suppression_expires_at: "",
    },
    {
      id: "f-high",
      title: "high",
      severity: Severity.HIGH,
      domain: "security",
      persona: "security",
      strength: Strength.SOURCE_PROVEN,
      consequence: "c",
      location: "",
      reproduction: "",
      evidence: [],
      remediation: "",
      verification: "",
      check_id: "a",
      created_at: "2026-01-01T00:00:30Z",
      tags: [],
      fingerprint: "fp-high",
      suppressed: false,
      suppression_owner: "",
      suppression_reason: "",
      suppression_ticket: "",
      suppression_expires_at: "",
    },
  ];
  const invalid_findings: InvalidFinding[] = [
    { id: "inv-b", persona: "x", check_id: "a", errors: [], payload: {}, contract: "persona_output_schema", recorded_at: "2026-01-01T00:02:00Z" },
    { id: "inv-a", persona: "x", check_id: "a", errors: [], payload: {}, contract: "persona_output_schema", recorded_at: "2026-01-01T00:01:00Z" },
  ];
  const blockers: Blocker[] = [
    { id: "blk-b", persona: "security", check_id: "b", attempted_action: "", boundary: "runtime", unblock_evidence: [], covered_elsewhere: false, covered_by: [], recorded_at: "2026-01-01T00:02:00Z" },
    { id: "blk-a", persona: "security", check_id: "b", attempted_action: "", boundary: "runtime", unblock_evidence: [], covered_elsewhere: true, covered_by: [], recorded_at: "2026-01-01T00:01:00Z" },
  ];

  const state: RunStateDomain = {
    schema_version: "1.0",
    run_id: "run-1",
    workflow_id: "software",
    workflow_version: "1.0",
    target: { raw: "t", kind: "repo", resolved: "/tmp/t", source: "" },
    intent: "ship",
    status: RunStatus.COMPLETED,
    current_phase: "confidence_scoring",
    phases,
    risks: [],
    checks,
    findings,
    invalid_findings,
    blockers,
    contract_failures: { security: 3 },
    contract_failure_streaks: { security: 3 },
    degraded_personas: ["security"],
    confidence,
    kill_switch: { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
    inventory: { files: 1 },
    personas: [{ id: "security", kind: "builtin", name: "Security", version: "1", domains: ["security"] }],
    options: {},
    evidence_dir: "/tmp/evidence",
    started_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:10:00Z",
    completed_at: "2026-01-01T00:10:00Z",
    halted_reason: "",
    error: "",
    seed: 7,
    clock_mode: "injected",
  };
  return { ...state, ...overrides };
}

describe("LEM-020 report builder and schema validation", () => {
  it("builds quality-harness.report/v1 with assay-compatible structure and semantics", () => {
    const state = baseState({ options: { policy: { id: "advisory-v1", version: "1.0" }, metering: { event_count: 5, event_types: { run_started: 1 }, sink: ".harness/metering/events.jsonl", workspace: "local", schema_version: "quality-harness.metering/v1" }, trend: { baseline: true, previous_run_id: null, new: [], resolved: [], persistent: [], score_delta: 0, coverage_delta: 0 } } });
    const report = buildReport(state, workflow(), { artifacts: 2, manifest: "ok" }, "2026-01-01T00:10:00Z");
    expect(report.schema_version).toBe(REPORT_SCHEMA);
    expect(report.test_plan).toMatchObject({
      schema_version: "lemma.test_plan/v1",
      title: expect.stringContaining("Comprehensive"),
      summary: expect.objectContaining({ total: expect.any(Number), coverage_gaps: expect.any(Number) }),
    });
    expect(Array.isArray((report.test_plan as { scenarios?: unknown[] }).scenarios)).toBe(true);
    expect(report.generated_at).toBe("2026-01-01T00:10:00Z");
    expect(report.determinism).toEqual({ seed: 7, clock_mode: "injected", entropy: "seeded" });
    expect(report.workflow).toEqual({ id: "software", name: "Software", version: "1.0", phases: ["risk_analysis", "test_planning", "execution", "evidence_collection", "confidence_scoring"] });
    expect(report.policy).toEqual({ id: "advisory-v1", version: "1.0" });
    expect(report.decision).toEqual({ decision: "review", rationale: "Evidence is useful but incomplete or accompanied by high-severity findings; review before shipping." });
    expect((report.findings as Array<{ id: string }>).map((f) => f.id)).toEqual(["f-high", "f-low"]);
    expect((report.blockers as Array<{ id: string }>).map((b) => b.id)).toEqual(["blk-a", "blk-b"]);
    expect((report.invalid_findings as Array<{ id: string }>).map((f) => f.id)).toEqual(["inv-a", "inv-b"]);
    expect(report.finding_counts).toEqual({ critical: 0, high: 1, medium: 0, low: 1, info: 0 });
    expect(report.contract_failures).toEqual({ total: 3, by_persona: { security: 3 }, degraded_personas: ["security"] });
    expect(report.coverage).toMatchObject({ total_checks: 2, executed: 1, passed: 1, blocked: 1, blockers: 2, blockers_covered_elsewhere: 1, blockers_uncovered: 1, executed_pct: 50 });
    expect((report.coverage as { by_domain: Record<string, unknown> }).by_domain.security).toMatchObject({ planned: 1, blocked: 1, blockers: 2 });
    expect(report.evidence).toEqual({ directory: "/tmp/evidence", summary: { artifacts: 2, manifest: "ok" } });
    expect(report.limitations).toContain("base limitation");
    expect(report.limitations).toContain("needs runtime");
    expect(report.limitations).toContain("2 finding(s) violated a persona output contract and were quarantined; they are excluded from scoring and kill-switch evaluation.");
    expect(report.limitations).toContain("Persona 'security' produced three consecutive schema-invalid findings and is marked degraded.");
    expect(report.halted_reason).toBeNull();
    expect(report.error).toBe("");
  });

  it("decides hold for halted/failed and ship for passing gate", () => {
    const halted = buildReport(baseState({ status: RunStatus.HALTED, halted_reason: "kill" }), workflow(), {}, "2026-01-01T00:10:00Z");
    expect(halted.decision).toEqual({ decision: "hold", rationale: "Execution was halted by the kill switch; the evidence set is intentionally incomplete." });
    expect(halted.halted_reason).toBe("kill");

    const failed = buildReport(baseState({ status: RunStatus.FAILED }), workflow(), {}, "2026-01-01T00:10:00Z");
    expect(failed.decision).toEqual({ decision: "hold", rationale: "The harness run failed before producing a complete evidence set." });

    const passConf = normalizeConfidence({ score: 90, band: "high", coverage: 100, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "pass", reasons: [], policy: "advisory-v1" } });
    const ship = buildReport(baseState({ confidence: passConf }), workflow(), {}, "2026-01-01T00:10:00Z");
    expect(ship.decision).toEqual({ decision: "ship", rationale: "Executed checks support a release decision within the stated scope; gaps remain visible in the report." });
  });

  it("validates reports against published schema (accepts valid/additive, rejects missing/retyped)", () => {
    const report = buildReport(baseState(), workflow(), { ok: true }, "2026-01-01T00:10:00Z");
    expect(validateReport(report)).toEqual([]);
    expect(isValidReport(report)).toBe(true);

    const additive = structuredClone(report);
    (additive as { future_field?: unknown }).future_field = { nested: true };
    ((additive as { confidence: Record<string, unknown> }).confidence).future_nested = 1;
    expect(validateReport(additive)).toEqual([]);
    expect(isValidReport(additive)).toBe(true);

    const missing = structuredClone(report);
    delete (missing as { run_id?: string }).run_id;
    expect(isValidReport(missing)).toBe(false);
    expect(validateReport(missing).length).toBeGreaterThan(0);

    const retyped = structuredClone(report);
    ((retyped as { confidence: Record<string, unknown> }).confidence).score = "high";
    expect(isValidReport(retyped)).toBe(false);

    const schema = reportSchema() as { properties?: { schema_version?: { enum?: string[] } } };
    expect(schema).toBeTruthy();
    expect(schema.properties?.schema_version?.enum).toContain(REPORT_SCHEMA);
  });
});
