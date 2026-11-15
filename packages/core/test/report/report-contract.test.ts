import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  type Check,
  type Finding,
  type RunStateDomain,
} from "../../src/index.js";
import type { Workflow } from "../../src/workflows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record");
  return v;
}

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
    band: "guarded",
    coverage: 80.0,
    rationale: "ok",
    limitations: ["base limitation"],
    penalties: { severity_total: 10, by_severity: { high: 1 }, caps: [] },
    domain_scores: { functional: { score: 70, coverage: 80 } },
    breakdown: { coverage: 80 },
    gate: { status: "warn", reasons: ["review required"], policy: "advisory-v1" },
  });
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
      finding_ids: ["f-high"],
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
      kind: "browser",
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
  const state: RunStateDomain = {
    schema_version: "1.0",
    run_id: "run-1",
    workflow_id: "software",
    workflow_version: "1.0",
    target: { raw: "t", kind: "repo", resolved: "/tmp/t", source: "" },
    intent: "ship",
    status: RunStatus.COMPLETED,
    current_phase: "confidence_scoring",
    phases: [
      { name: "risk_analysis", title: "risk_analysis", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
      { name: "test_planning", title: "test_planning", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
      { name: "execution", title: "execution", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
      { name: "evidence_collection", title: "evidence_collection", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
      { name: "confidence_scoring", title: "confidence_scoring", status: "completed", summary: "", details: {}, started_at: null, completed_at: null },
    ],
    risks: [],
    checks,
    findings,
    invalid_findings: [
      { id: "inv-b", persona: "x", check_id: "a", errors: [], payload: {}, contract: "persona_output_schema", recorded_at: "2026-01-01T00:02:00Z" },
      { id: "inv-a", persona: "x", check_id: "a", errors: [], payload: {}, contract: "persona_output_schema", recorded_at: "2026-01-01T00:01:00Z" },
    ],
    blockers: [
      { id: "blk-b", persona: "security", check_id: "b", attempted_action: "", boundary: "runtime", unblock_evidence: [], covered_elsewhere: false, covered_by: [], recorded_at: "2026-01-01T00:02:00Z" },
      { id: "blk-a", persona: "security", check_id: "b", attempted_action: "", boundary: "runtime", unblock_evidence: [], covered_elsewhere: true, covered_by: [], recorded_at: "2026-01-01T00:01:00Z" },
    ],
    contract_failures: { security: 3 },
    contract_failure_streaks: { security: 3 },
    degraded_personas: ["security"],
    confidence,
    kill_switch: { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
    inventory: { files: 1 },
    personas: [{ id: "security", kind: "builtin", name: "Security", version: "1", domains: ["security"] }],
    options: {
      policy: { id: "advisory-v1", version: "1.0" },
      metering: {
        schema_version: "quality-harness.metering/v1",
        sink: ".lemma/metering/events.jsonl",
        workspace: "local",
        event_count: 5,
        event_types: { run_started: 1, check_executed: 4 },
        run_event_count: 3,
        run_event_types: { run_started: 1, check_executed: 2 },
      },
      trend: { baseline: true, previous_run_id: null, new: [], resolved: [], persistent: [], score_delta: 0, coverage_delta: 0 },
    },
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

describe("LEM-073 report-schema compatibility and contract tests", () => {
  it("published report schema file and index are present and aligned with builder contract", () => {
    const published = asRecord(readJson("schemas/report/report.v1.schema.json"));
    const index = asRecord(readJson("schemas/report/index.json"));
    const schema = asRecord(reportSchema());

    expect(index).toMatchObject({ schema_version: "lemma.report.schemas/v1", report: "report.v1.schema.json" });
    expect(String(published.$id)).toContain("/schemas/report/report.v1.schema.json");
    expect(typeof published.title).toBe("string");
    const required = Array.isArray(published.required) ? published.required : [];
    expect(required).toContain("schema_version");
    expect(required).toContain("decision");
    expect(required).toContain("confidence");
    expect(required).toContain("metering");
    expect(required).toContain("trend");
    expect(required).toContain("contract_failures");

    const props = asRecord(published.properties ?? {});
    const schemaVersionProp = asRecord(props.schema_version ?? {});
    const publishedEnum = Array.isArray(schemaVersionProp.enum) ? schemaVersionProp.enum : [];
    expect(publishedEnum).toContain(REPORT_SCHEMA);
    expect(publishedEnum).toContain("lemma.report/v1");
    expect(JSON.stringify(schema)).toContain(REPORT_SCHEMA);
  });

  it("validates built reports across key statuses and enforces additive compatibility", () => {
    const report = asRecord(buildReport(baseState(), workflow(), { ok: true }, "2026-01-01T00:10:00Z"));
    expect(report.schema_version).toBe(REPORT_SCHEMA);
    expect(validateReport(report)).toEqual([]);
    expect(isValidReport(report)).toBe(true);

    const metering = asRecord(report.metering);
    const trend = asRecord(report.trend);
    const contractFailures = asRecord(report.contract_failures);
    const decision = asRecord(report.decision);
    const confidence = asRecord(report.confidence);
    const coverage = asRecord(report.coverage);
    const findings = Array.isArray(report.findings) ? report.findings.map(asRecord) : [];
    const invalidFindings = Array.isArray(report.invalid_findings) ? report.invalid_findings.map(asRecord) : [];
    const blockers = Array.isArray(report.blockers) ? report.blockers.map(asRecord) : [];
    const limitations = Array.isArray(report.limitations) ? report.limitations : [];

    expect(report.policy).toEqual({ id: "advisory-v1", version: "1.0" });
    expect(metering.event_count).toBe(5);
    expect(metering.run_event_count).toBe(3);
    expect(metering.event_types).toEqual({ run_started: 1, check_executed: 4 });
    expect(metering.run_event_types).toEqual({ run_started: 1, check_executed: 2 });
    expect(trend).toMatchObject({ baseline: true, previous_run_id: null, score_delta: 0, coverage_delta: 0 });
    expect(contractFailures).toEqual({ total: 3, by_persona: { security: 3 }, degraded_personas: ["security"] });
    expect(decision.decision).toBe("review");
    expect(confidence.gate).toMatchObject({ status: "warn", policy: "advisory-v1" });
    expect(coverage).toMatchObject({ total_checks: 2, executed: 1, passed: 1, blocked: 1, executed_pct: 50 });
    expect(findings.map((f) => f.id)).toEqual(["f-high", "f-low"]);
    expect(invalidFindings.map((f) => f.id)).toEqual(["inv-a", "inv-b"]);
    expect(blockers.map((b) => b.id)).toEqual(["blk-a", "blk-b"]);
    expect(limitations).toContain("base limitation");
    expect(limitations).toContain("needs runtime");

    const additive = structuredClone(report);
    additive.future_field = { nested: true };
    asRecord(additive.confidence).future_nested = 1;
    asRecord(additive.metering).future_count = 7;
    expect(validateReport(additive)).toEqual([]);
    expect(isValidReport(additive)).toBe(true);

    const missing = structuredClone(report);
    delete missing.run_id;
    expect(isValidReport(missing)).toBe(false);
    expect(validateReport(missing).length).toBeGreaterThan(0);

    const retyped = structuredClone(report);
    asRecord(retyped.confidence).score = "high";
    expect(isValidReport(retyped)).toBe(false);

    const halted = asRecord(buildReport(baseState({ status: RunStatus.HALTED, halted_reason: "kill" }), workflow(), {}, "2026-01-01T00:10:00Z"));
    expect(asRecord(halted.decision).decision).toBe("hold");
    expect(halted.halted_reason).toBe("kill");
    expect(isValidReport(halted)).toBe(true);

    const failed = asRecord(buildReport(baseState({ status: RunStatus.FAILED }), workflow(), {}, "2026-01-01T00:10:00Z"));
    expect(asRecord(failed.decision).decision).toBe("hold");
    expect(isValidReport(failed)).toBe(true);

    const passConf = normalizeConfidence({ score: 90, band: "high", coverage: 100, rationale: "", limitations: [], penalties: { severity_total: 0, by_severity: {}, caps: [] }, domain_scores: {}, breakdown: {}, gate: { status: "pass", reasons: [], policy: "advisory-v1" } });
    const ship = asRecord(buildReport(baseState({ confidence: passConf }), workflow(), {}, "2026-01-01T00:10:00Z"));
    expect(asRecord(ship.decision).decision).toBe("ship");
    expect(isValidReport(ship)).toBe(true);
  });
});
