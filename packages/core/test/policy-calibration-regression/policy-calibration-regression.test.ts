import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CALIBRATION_SCHEMA,
  CheckStatus,
  FORMULA_VERSION,
  PolicyError,
  Severity,
  Strength,
  decisionFromConfidence,
  loadCalibrationFixtures,
  loadPolicy,
  normalizeCheck,
  normalizeFinding,
  policyFromDict,
  runCalibration,
  scoreConfidence,
} from "../../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fixturesDir = path.join(repoRoot, "calibration", "fixtures");
const advisoryPolicyPath = path.join(repoRoot, "policies", "advisory-v1.json");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

describe("LEM-074 policy and calibration regression coverage", () => {
  it("keeps canonical advisory-v1 policy aligned with calibration baseline defaults", async () => {
    const raw = JSON.parse(await readFile(advisoryPolicyPath, "utf8")) as unknown;
    expect(isRecord(raw)).toBe(true);
    const policyDoc = raw as Record<string, unknown>;
    expect(policyDoc.schema_version).toBe("quality-harness.policy/v1");
    expect(policyDoc.id).toBe("advisory-v1");
    expect(policyDoc.version).toBe("1.0");

    const policy = await loadPolicy(advisoryPolicyPath);
    expect(policy.id).toBe("advisory-v1");
    expect(policy.version).toBe("1.0");
    expect(policy.penalty_cap).toBe(70);
    expect(policy.scope_factors).toMatchObject({ both: 1.0, source: 0.9, live: 0.9, none: 0.75 });
    expect(policy.caps).toMatchObject({ critical: 30, two_high: 65, halted: 25 });
    expect(policy.gate).toMatchObject({
      pass_score: 80,
      warn_score: 60,
      fail_on_critical: true,
      fail_on_high: false,
      coverage_warn: 0.8,
      coverage_fail: 0.7,
    });

    const check = normalizeCheck({
      id: "a",
      title: "a",
      domain: "functional",
      persona: "functional",
      kind: "static",
      intent: "test",
      expected: "test",
      base_weight: 1,
      weight: 1,
      status: CheckStatus.PASSED,
    });
    const confidence = scoreConfidence([check], [], { policy });
    expect(confidence.score).toBe(90);
    expect((confidence.gate as { policy: string }).policy).toBe("advisory-v1");
    expect((confidence.breakdown as { policy_id: string }).policy_id).toBe("advisory-v1");
  });

  it("regresses calibration fixtures to stable parity-critical outcomes under default policy", async () => {
    const fixtures = await loadCalibrationFixtures(fixturesDir);
    const report = await runCalibration(fixturesDir);

    expect(report.schema_version).toBe(CALIBRATION_SCHEMA);
    expect(report.formula).toBe(FORMULA_VERSION);
    expect(report.fixture_count).toBe(fixtures.length);
    expect(fixtures.length).toBeGreaterThanOrEqual(12);

    const summary = report.summary as {
      expected_decisions: Record<string, number>;
      decision_matches: number;
      decision_mismatches: number;
      mismatched_fixtures: string[];
      intentional_disagreements: string[];
    };
    expect(summary.expected_decisions).toEqual({
      ship: fixtures.filter((f) => f.expected_decision === "ship").length,
      review: fixtures.filter((f) => f.expected_decision === "review").length,
      hold: fixtures.filter((f) => f.expected_decision === "hold").length,
    });
    expect(Object.keys(summary.expected_decisions).sort()).toEqual(["hold", "review", "ship"]);

    const mismatched = [...summary.mismatched_fixtures].sort();
    const intentional = [...summary.intentional_disagreements].sort();
    expect(intentional).toEqual(["source-only"]);
    expect(mismatched).toEqual(intentional);
    expect(summary.decision_mismatches).toBe(mismatched.length);
    expect(summary.decision_matches + summary.decision_mismatches).toBe(report.fixture_count);

    const results = report.fixtures as Array<Record<string, unknown>>;
    const byId = new Map(results.map((r) => [String(r.id), r]));
    expect(byId.size).toBe(results.length);

    for (const result of results) {
      const id = String(result.id);
      const intentionalDisagreement = Boolean(result.intentional_disagreement);
      if (!intentionalDisagreement) {
        expect(result.decision_match, `unexpected regression for fixture ${id}`).toBe(true);
      } else {
        expect(intentional).toContain(id);
        expect(result.decision_match).toBe(false);
        expect(typeof result.human_note === "string" && result.human_note.trim().length > 0).toBe(true);
      }
      expect(typeof result.score).toBe("number");
      expect(typeof result.band).toBe("string");
      expect(typeof result.gate).toBe("string");
    }

    expect(byId.get("full-pass")?.actual_decision).toBe("ship");
    expect(byId.get("full-pass")?.gate).toBe("pass");
    expect(byId.get("critical-finding")?.actual_decision).toBe("hold");
    expect(byId.get("halted-run")?.actual_decision).toBe("hold");
    expect(byId.get("source-only")?.actual_decision).toBe("ship");
    expect(byId.get("source-only")?.expected_decision).toBe("review");
  });

  it("covers policy-calibration interaction without regressing default calibration", async () => {
    const fixtures = await loadCalibrationFixtures(fixturesDir);
    const fixture = fixtures.find((f) => f.id === "source-only");
    expect(fixture).toBeTruthy();
    if (!fixture) return;

    const checks = (Array.isArray(fixture.checks) ? fixture.checks : []).map((item) => {
      const c = isRecord(item) ? item : {};
      const weight = asNumber(c.weight, 1);
      return normalizeCheck({
        id: asString(c.id, "check"),
        title: asString(c.title, asString(c.id, "check")),
        domain: asString(c.domain, "functional"),
        persona: asString(c.persona, "functional"),
        kind: asString(c.kind, "static"),
        intent: "calibration fixture",
        expected: "calibration fixture",
        base_weight: asNumber(c.base_weight, weight),
        weight,
        status: asString(c.status, CheckStatus.PASSED),
      });
    });
    const findings = (Array.isArray(fixture.findings) ? fixture.findings : []).map((item) => {
      const f = isRecord(item) ? item : {};
      return normalizeFinding({
        id: asString(f.id, "finding"),
        title: asString(f.title, "Calibration finding"),
        severity: asString(f.severity, Severity.MEDIUM),
        domain: asString(f.domain, "functional"),
        persona: asString(f.persona, "functional"),
        strength: asString(f.strength, Strength.SOURCE_PROVEN),
        consequence: asString(f.consequence, ""),
        location: asString(f.location, ""),
        fingerprint: asString(f.fingerprint, ""),
        check_id: "",
      });
    });

    const defaultConfidence = scoreConfidence(checks, findings);
    expect(decisionFromConfidence(defaultConfidence)).toBe("ship");

    const strictPolicy = policyFromDict({
      schema_version: "quality-harness.policy/v1",
      id: "strict-regression",
      version: "1.0",
      gate: {
        pass_score: 95,
        warn_score: 60,
        fail_on_critical: true,
        fail_on_high: false,
        coverage_warn: 0.8,
        coverage_fail: 0.7,
      },
    });
    const strictConfidence = scoreConfidence(checks, findings, { policy: strictPolicy });
    expect(strictConfidence.score).toBe(defaultConfidence.score);
    expect(strictConfidence.gate.status).not.toBe("pass");
    expect(["review", "hold"]).toContain(decisionFromConfidence(strictConfidence));

    expect(() =>
      policyFromDict({
        schema_version: "quality-harness.policy/v1",
        id: "bad",
        version: "1",
        caps: { critical: 50, two_high: 40, halted: 25 },
      }),
    ).toThrow(PolicyError);

    const report = await runCalibration(fixturesDir);
    const summary = report.summary as { mismatched_fixtures: string[] };
    expect([...summary.mismatched_fixtures].sort()).toEqual(["source-only"]);
  });
});
