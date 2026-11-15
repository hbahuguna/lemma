import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { CheckStatus, Severity, type Check, type Confidence, type Finding } from "./models.js";
import { FORMULA_VERSION, scoreConfidence } from "./scoring.js";

export const CALIBRATION_SCHEMA = "quality-harness.calibration/v1" as const;

export interface CalibrationFixture {
  id?: string;
  label?: string;
  description?: string;
  expected_decision?: string;
  expected_gate?: string;
  checks?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  halted?: boolean;
  status?: string;
  intentional_disagreement?: boolean;
  human_note?: string;
  _path?: string;
  [key: string]: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function checkFromFixture(item: Record<string, unknown>): Check {
  const weight = asNumber(item.weight, 1.0);
  const id = asString(item.id, "check");
  return {
    id,
    title: asString(item.title, id),
    domain: asString(item.domain, "functional"),
    persona: asString(item.persona, "functional"),
    kind: asString(item.kind, "static"),
    intent: asString(item.intent, "calibration fixture"),
    expected: asString(item.expected, "calibration fixture"),
    status: asString(item.status, CheckStatus.PASSED),
    weight,
    base_weight: asNumber(item.base_weight, weight),
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
  };
}

function findingFromFixture(item: Record<string, unknown>): Finding {
  const severity = asString(item.severity, Severity.MEDIUM);
  return {
    id: asString(item.id, `finding-${severity}`),
    title: asString(item.title, "Calibration finding"),
    severity,
    domain: asString(item.domain, "functional"),
    persona: asString(item.persona, "functional"),
    strength: asString(item.strength, "observed"),
    consequence: asString(item.consequence, "A customer cannot complete the task."),
    location: asString(item.location, "src/app.py"),
    reproduction: asString(item.reproduction),
    evidence: [],
    remediation: asString(item.remediation),
    verification: asString(item.verification),
    check_id: asString(item.check_id),
    created_at: asString(item.created_at),
    tags: [],
    fingerprint: asString(item.fingerprint),
    suppressed: false,
    suppression_owner: "",
    suppression_reason: "",
    suppression_ticket: "",
    suppression_expires_at: "",
  };
}

export async function loadCalibrationFixtures(directory: string): Promise<CalibrationFixture[]> {
  let entries: string[];
  try {
    const stat = await (await import("node:fs/promises")).stat(directory);
    if (!stat.isDirectory()) {
      throw new Error(`Calibration fixture directory not found: ${directory}`);
    }
    entries = (await readdir(directory)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Calibration fixture directory not found")) throw err;
    throw new Error(`Calibration fixture directory not found: ${directory}`);
  }
  if (entries.length === 0) {
    throw new Error(`No calibration fixtures found in ${directory}`);
  }
  const fixtures: CalibrationFixture[] = [];
  for (const name of entries) {
    const p = path.join(directory, name);
    const raw = await readFile(p, "utf8");
    const data = JSON.parse(raw) as CalibrationFixture;
    if (data && typeof data === "object") {
      data._path = p;
      fixtures.push(data);
    }
  }
  return fixtures;
}

export function decisionFromConfidence(
  confidence: Pick<Confidence, "gate">,
  halted = false,
  status = "completed",
): string {
  if (status === "halted") return "hold";
  if (status === "failed") return "hold";
  if (halted) return "hold";
  const gate = confidence.gate;
  const gateStatus = typeof gate.status === "string" ? gate.status : "warn";
  if (gateStatus === "pass") return "ship";
  if (gateStatus === "fail") return "hold";
  return "review";
}

export async function runCalibration(directory: string): Promise<Record<string, unknown>> {
  const fixtures = await loadCalibrationFixtures(directory);
  const results: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = { ship: 0, review: 0, hold: 0 };
  const mismatches: string[] = [];
  const intentional: string[] = [];

  for (const fixture of fixtures) {
    const checks = (Array.isArray(fixture.checks) ? fixture.checks : []).map((item) =>
      checkFromFixture(item ?? {}),
    );
    const findings = (Array.isArray(fixture.findings) ? fixture.findings : []).map((item) =>
      findingFromFixture(item ?? {}),
    );
    const halted = Boolean(fixture.halted);
    const status = asString(fixture.status, "completed");
    const confidence = scoreConfidence(checks, findings, { halted });
    const actualDecision = decisionFromConfidence(confidence, halted, status);
    const expectedDecision = asString(fixture.expected_decision);
    const expectedGate = asString(fixture.expected_gate);
    const gate = confidence.gate;
    const gateStatus = typeof gate.status === "string" ? gate.status : "";
    const gateReasons = Array.isArray(gate.reasons)
      ? gate.reasons.filter((r): r is string => typeof r === "string")
      : [];
    const match = actualDecision === expectedDecision;
    const gateMatch = !expectedGate || gateStatus === expectedGate;
    const fixtureId = asString(fixture.id, asString(fixture._path));
    if (!match) mismatches.push(fixtureId);
    if (fixture.intentional_disagreement) intentional.push(fixtureId);
    counts[actualDecision] = (counts[actualDecision] ?? 0) + 1;
    results.push({
      id: fixture.id,
      label: fixture.label ?? "",
      description: fixture.description ?? "",
      expected_decision: expectedDecision,
      expected_gate: expectedGate,
      actual_decision: actualDecision,
      decision_match: match,
      gate_match: gateMatch,
      intentional_disagreement: Boolean(fixture.intentional_disagreement),
      human_note: fixture.human_note ?? "",
      score: confidence.score,
      band: confidence.band,
      gate: gateStatus,
      gate_reasons: gateReasons,
      coverage: confidence.coverage,
      breakdown: confidence.breakdown,
      penalties: confidence.penalties,
      domain_scores: confidence.domain_scores,
    });
  }

  return {
    schema_version: CALIBRATION_SCHEMA,
    formula: FORMULA_VERSION,
    fixture_count: fixtures.length,
    fixtures: results,
    summary: {
      expected_decisions: {
        ship: fixtures.filter((f) => f.expected_decision === "ship").length,
        review: fixtures.filter((f) => f.expected_decision === "review").length,
        hold: fixtures.filter((f) => f.expected_decision === "hold").length,
      },
      actual_decisions: counts,
      decision_matches: results.filter((r) => r.decision_match).length,
      decision_mismatches: mismatches.length,
      mismatched_fixtures: mismatches,
      intentional_disagreements: intentional,
    },
  };
}

export async function writeCalibrationReport(fixturesDir: string, output: string): Promise<Record<string, unknown>> {
  const report = await runCalibration(fixturesDir);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  return report;
}
