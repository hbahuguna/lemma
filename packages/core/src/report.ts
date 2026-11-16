import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { now } from "./determinism.js";
import {
  CheckStatus,
  Severity,
  severityRank,
  type Check,
  type Finding,
  type RunStateDomain,
} from "./models.js";
import type { Workflow } from "./workflows.js";

export const REPORT_SCHEMA = "quality-harness.report/v1" as const;

interface CoverageBucket {
  planned: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  error: number;
  blockers: number;
}

export function coverage(state: Pick<RunStateDomain, "checks" | "blockers">): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const s of Object.values(CheckStatus)) counts[s] = 0;
  const blockersByCheck: Record<string, number> = {};
  const blockersByPersona: Record<string, number> = {};
  for (const blocker of state.blockers) {
    blockersByCheck[blocker.check_id] = (blockersByCheck[blocker.check_id] ?? 0) + 1;
    blockersByPersona[blocker.persona] = (blockersByPersona[blocker.persona] ?? 0) + 1;
  }
  const byDomain: Record<string, CoverageBucket> = {};
  for (const check of state.checks) {
    counts[check.status] = (counts[check.status] ?? 0) + 1;
    const bucket = (byDomain[check.domain] ??= {
      planned: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      error: 0,
      blockers: 0,
    });
    bucket.planned += 1;
    bucket.blockers += blockersByCheck[check.id] ?? 0;
    if (check.status === CheckStatus.PASSED) bucket.passed += 1;
    else if (check.status === CheckStatus.FAILED) bucket.failed += 1;
    else if (check.status === CheckStatus.BLOCKED) bucket.blocked += 1;
    else if (check.status === CheckStatus.SKIPPED) bucket.skipped += 1;
    else if (check.status === CheckStatus.ERROR) bucket.error += 1;
  }
  const total = state.checks.length;
  const executed = (counts[CheckStatus.PASSED] ?? 0) + (counts[CheckStatus.FAILED] ?? 0);
  const coveredBlockers = state.blockers.filter((b) => b.covered_elsewhere).length;
  return {
    total_checks: total,
    executed,
    passed: counts[CheckStatus.PASSED] ?? 0,
    failed: counts[CheckStatus.FAILED] ?? 0,
    blocked: counts[CheckStatus.BLOCKED] ?? 0,
    skipped: counts[CheckStatus.SKIPPED] ?? 0,
    error: counts[CheckStatus.ERROR] ?? 0,
    planned_not_run: counts[CheckStatus.PLANNED] ?? 0,
    blockers: state.blockers.length,
    blockers_covered_elsewhere: coveredBlockers,
    blockers_uncovered: state.blockers.length - coveredBlockers,
    blockers_by_persona: blockersByPersona,
    executed_pct: total ? Math.round((executed / total) * 1000) / 10 : 0.0,
    by_domain: byDomain,
  };
}

export function decisionForState(state: Pick<RunStateDomain, "status" | "confidence">): { decision: string; rationale: string } {
  const gate = state.confidence?.gate ?? {};
  const status = typeof gate.status === "string" ? gate.status : "warn";
  if (state.status === "halted") {
    return {
      decision: "hold",
      rationale: "Execution was halted by the kill switch; the evidence set is intentionally incomplete.",
    };
  }
  if (state.status === "failed") {
    return { decision: "hold", rationale: "The harness run failed before producing a complete evidence set." };
  }
  if (status === "pass") {
    return {
      decision: "ship",
      rationale: "Executed checks support a release decision within the stated scope; gaps remain visible in the report.",
    };
  }
  if (status === "fail") {
    return { decision: "hold", rationale: "Critical/high risk or low confidence blocks an advisory release decision." };
  }
  return {
    decision: "review",
    rationale: "Evidence is useful but incomplete or accompanied by high-severity findings; review before shipping.",
  };
}

function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const ra = -severityRank(a.severity);
    const rb = -severityRank(b.severity);
    if (ra !== rb) return ra - rb;
    const ca = String(a.created_at ?? "");
    const cb = String(b.created_at ?? "");
    if (ca !== cb) return ca.localeCompare(cb);
    return String(a.id).localeCompare(String(b.id));
  });
}

function sortByRecordedAtId<T extends { recorded_at?: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = String(a.recorded_at ?? "");
    const rb = String(b.recorded_at ?? "");
    if (ra !== rb) return ra.localeCompare(rb);
    return String(a.id).localeCompare(String(b.id));
  });
}

export function buildReport(
  state: RunStateDomain,
  workflow: Pick<Workflow, "id" | "name" | "version" | "phases">,
  evidenceSummary: Record<string, unknown>,
  generatedAt?: string,
): Record<string, unknown> {
  const findings = sortFindings(state.findings);
  const invalidFindings = sortByRecordedAtId(state.invalid_findings);
  const blockers = sortByRecordedAtId(state.blockers);
  const contractFailures: Record<string, number> = {};
  for (const [persona, count] of Object.entries(state.contract_failures ?? {})) {
    contractFailures[persona] = Number(count) || 0;
  }

  const options = state.options && typeof state.options === "object" ? state.options : {};
  const policyInfo = (options.policy && typeof options.policy === "object" ? options.policy : {}) as Record<string, unknown>;
  const policyId = typeof policyInfo.id === "string" ? policyInfo.id : "advisory-v1";
  const policyVersion = typeof policyInfo.version === "string" ? policyInfo.version : "1.0";

  const trendRaw = (options.trend && typeof options.trend === "object" ? options.trend : {}) as Record<string, unknown>;
  const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const trend = {
    baseline: typeof trendRaw.baseline === "boolean" ? trendRaw.baseline : true,
    previous_run_id: typeof trendRaw.previous_run_id === "string" ? trendRaw.previous_run_id : null,
    new: asStringArray(trendRaw.new),
    resolved: asStringArray(trendRaw.resolved),
    persistent: asStringArray(trendRaw.persistent),
    score_delta: Number(trendRaw.score_delta ?? 0.0),
    coverage_delta: Number(trendRaw.coverage_delta ?? 0.0),
  };

  const meteringInfo = (options.metering && typeof options.metering === "object" ? options.metering : {}) as Record<string, unknown>;
  const eventTypesRaw = (meteringInfo.event_types && typeof meteringInfo.event_types === "object" ? meteringInfo.event_types : {}) as Record<string, unknown>;
  const runEventTypesRaw = (meteringInfo.run_event_types && typeof meteringInfo.run_event_types === "object"
    ? meteringInfo.run_event_types
    : meteringInfo.event_types && typeof meteringInfo.event_types === "object"
      ? meteringInfo.event_types
      : {}) as Record<string, unknown>;
  const eventCount = Number(meteringInfo.event_count ?? 0);
  const metering = {
    schema_version: typeof meteringInfo.schema_version === "string" ? meteringInfo.schema_version : "quality-harness.metering/v1",
    sink: typeof meteringInfo.sink === "string" ? meteringInfo.sink : ".harness/metering/events.jsonl",
    workspace: typeof meteringInfo.workspace === "string" ? meteringInfo.workspace : "local",
    event_count: eventCount,
    event_types: Object.fromEntries(Object.entries(eventTypesRaw).map(([k, v]) => [String(k), Number(v) || 0])),
    run_event_count: Number(meteringInfo.run_event_count ?? eventCount),
    run_event_types: Object.fromEntries(Object.entries(runEventTypesRaw).map(([k, v]) => [String(k), Number(v) || 0])),
  };

  const personas = state.personas.map((persona) => {
    const entry = (persona && typeof persona === "object" ? { ...(persona as Record<string, unknown>) } : {}) as Record<string, unknown>;
    const personaId = typeof entry.id === "string" ? entry.id : "";
    entry.contract_failures = contractFailures[personaId] ?? 0;
    entry.contract_failure_streak = Number(state.contract_failure_streaks?.[personaId] ?? 0);
    entry.degraded = (state.degraded_personas ?? []).includes(personaId);
    return entry;
  });

  const checks = state.checks.map((check: Check) => ({
    id: check.id,
    title: check.title,
    domain: check.domain,
    persona: check.persona,
    kind: check.kind,
    intent: check.intent,
    expected: check.expected,
    status: check.status,
    weight: check.weight,
    actual: check.actual,
    evidence: [...(check.evidence ?? [])],
    finding_ids: [...(check.finding_ids ?? [])],
    skip_reason: check.skip_reason ?? "",
    metadata: { ...(check.metadata ?? {}) },
  }));

  const decision = decisionForState(state);
  const limitations = [...(state.confidence?.limitations ?? [])];
  for (const check of state.checks) {
    const note = check.metadata?.limitation;
    const noteStr = typeof note === "string" ? note : note == null ? "" : JSON.stringify(note);
    if (noteStr && !limitations.includes(noteStr)) limitations.push(noteStr);
  }
  if (state.checks.some((c) => c.id === "browser.accessibility")) {
    const note = "Automated accessibility checks do not establish WCAG conformance; human review is still required.";
    if (!limitations.includes(note)) limitations.push(note);
  }
  if (state.checks.some((c) => c.id === "browser.security")) {
    const note = "Security checks are bounded and non-destructive; they are not a penetration test or a certification.";
    if (!limitations.includes(note)) limitations.push(note);
  }
  if (invalidFindings.length > 0) {
    const note = `${invalidFindings.length} finding(s) violated a persona output contract and were quarantined; they are excluded from scoring and kill-switch evaluation.`;
    if (!limitations.includes(note)) limitations.push(note);
  }
  for (const persona of state.degraded_personas ?? []) {
    const note = `Persona '${persona}' produced three consecutive schema-invalid findings and is marked degraded.`;
    if (!limitations.includes(note)) limitations.push(note);
  }

  const severityCounts: Record<string, number> = {};
  for (const sev of Object.values(Severity)) severityCounts[sev] = 0;
  for (const finding of findings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
  }

  const confidence = state.confidence;
  const executionMode = (state as any).mode ?? (state.options as any)?.execution_mode ?? "test";
  return {
    schema_version: REPORT_SCHEMA,
    generated_at: generatedAt ?? now(),
    run_id: state.run_id,
    execution_mode: executionMode,
    mode: executionMode,
    determinism: {
      seed: state.seed ?? null,
      clock_mode: state.clock_mode ?? "real",
      entropy: state.seed != null ? "seeded" : "uuid4",
    },
    status: state.status,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      phases: workflow.phases.map((p) => p.name),
    },
    target: {
      raw: state.target.raw,
      kind: state.target.kind,
      resolved: state.target.resolved,
      source: state.target.source ?? "",
    },
    intent: state.intent ?? "",
    policy: { id: policyId, version: policyVersion },
    metering,
    decision,
    trend,
    confidence: {
      score: confidence.score,
      band: confidence.band,
      coverage: confidence.coverage,
      rationale: confidence.rationale,
      limitations: [...(confidence.limitations ?? [])],
      penalties: { ...(confidence.penalties ?? {}) },
      domain_scores: { ...(confidence.domain_scores ?? {}) },
      breakdown: { ...(confidence.breakdown ?? {}) },
      gate: { ...(confidence.gate ?? {}) },
    },
    findings: findings.map((f) => ({ ...f })),
    finding_counts: severityCounts,
    invalid_findings: invalidFindings.map((f) => ({ ...f })),
    blockers: blockers.map((b) => ({ ...b })),
    contract_failures: {
      total: Object.values(contractFailures).reduce((a, b) => a + b, 0),
      by_persona: contractFailures,
      degraded_personas: [...(state.degraded_personas ?? [])],
    },
    checks,
    coverage: coverage(state),
    risks: state.risks.map((r) => ({ ...r })),
    personas,
    inventory: { ...(state.inventory ?? {}) },
    phases: state.phases.map((p) => ({ ...p })),
    kill_switch: { ...state.kill_switch },
    halted_reason: state.halted_reason ? state.halted_reason : null,
    limitations,
    evidence: {
      directory: state.evidence_dir ?? "",
      summary: { ...evidenceSummary },
    },
    started_at: state.started_at,
    completed_at: state.completed_at ?? state.started_at,
    options: { ...options },
    error: state.error ?? "",
  };
}

export function defaultReportSchemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../schemas/report/report.v1.schema.json"),
    path.resolve(here, "../../schemas/report/report.v1.schema.json"),
    path.resolve(process.cwd(), "schemas/report/report.v1.schema.json"),
    path.resolve(process.cwd(), "../schemas/report/report.v1.schema.json"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, "utf8");
      return c;
    } catch {
      // continue
    }
  }
  return candidates[0]!;
}

export function reportSchema(schemaPath?: string): Record<string, unknown> {
  const p = schemaPath ?? defaultReportSchemaPath();
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

export function reportSchemaPath(schemaPath?: string): string {
  return schemaPath ?? defaultReportSchemaPath();
}

function jsonTypeOk(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => jsonTypeOk(value, item));
  if (expected === "null") return value === null;
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "string") return typeof value === "string";
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return true;
}

export function validateReport(report: unknown, schema?: Record<string, unknown>): string[] {
  const s = schema ?? reportSchema();
  const errors: string[] = [];

  const visit = (instance: unknown, subschema: Record<string, unknown>, pth: string): void => {
    if (Object.prototype.hasOwnProperty.call(subschema, "const") && instance !== subschema.const) {
      errors.push(`${pth || "<root>"}: expected constant ${String(subschema.const)}`);
    }
    if (Object.prototype.hasOwnProperty.call(subschema, "enum")) {
      const allowed = subschema.enum;
      if (Array.isArray(allowed) && !allowed.includes(instance)) {
        errors.push(`${pth || "<root>"}: expected one of ${JSON.stringify(allowed)}`);
      }
    }
    const expectedType = subschema.type;
    if (expectedType !== undefined && !jsonTypeOk(instance, expectedType)) {
      const typeDesc = Array.isArray(expectedType) ? expectedType.join("|") : typeof expectedType === "string" ? expectedType : JSON.stringify(expectedType);
      errors.push(`${pth || "<root>"}: expected type ${typeDesc}, got ${instance === null ? "null" : Array.isArray(instance) ? "array" : typeof instance}`);
      return;
    }
    if (typeof instance === "object" && instance !== null && !Array.isArray(instance)) {
      const obj = instance as Record<string, unknown>;
      const required = subschema.required;
      if (Array.isArray(required)) {
        for (const field of required) {
          if (!(String(field) in obj)) errors.push(`${pth || "<root>"}: missing required field ${String(field)}`);
        }
      }
      const properties = (subschema.properties && typeof subschema.properties === "object" ? subschema.properties : {}) as Record<string, unknown>;
      for (const [field, value] of Object.entries(obj)) {
        const propSchema = properties[field];
        if (propSchema && typeof propSchema === "object") {
          visit(value, propSchema as Record<string, unknown>, pth ? `${pth}/${field}` : field);
        }
      }
    } else if (Array.isArray(instance) && subschema.items && typeof subschema.items === "object") {
      for (let i = 0; i < instance.length; i++) {
        visit(instance[i], subschema.items as Record<string, unknown>, `${pth}[${i}]`);
      }
    }
  };

  visit(report, s, "");
  return errors;
}

export function isValidReport(report: unknown, schema?: Record<string, unknown>): boolean {
  return validateReport(report, schema).length === 0;
}
