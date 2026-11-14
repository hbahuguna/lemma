import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  FORMULA_VERSION,
  Severity,
  Strength,
  createDefaultPolicy,
  normalizeCheck,
  normalizeFinding,
  policyFromDict,
  scoreConfidence,
} from "../../src/index.js";

function check(overrides: Record<string, unknown>) {
  return normalizeCheck({
    id: "c1",
    title: "check",
    domain: "functional",
    persona: "p",
    kind: "static",
    intent: "i",
    expected: "e",
    base_weight: 1,
    status: CheckStatus.PASSED,
    weight: 1,
    ...overrides,
  });
}

function finding(overrides: Record<string, unknown>) {
  return normalizeFinding({
    id: "f1",
    title: "finding",
    severity: Severity.MEDIUM,
    domain: "functional",
    persona: "p",
    strength: Strength.SOURCE_PROVEN,
    consequence: "c",
    check_id: "c1",
    ...overrides,
  });
}

describe("LEM-018 weighted-coverage-v1 scoring", () => {
  it("returns no-confidence fail result when no checks are planned", () => {
    const c = scoreConfidence([], [], { limitations: ["x"] });
    expect(c.score).toBe(0);
    expect(c.band).toBe("none");
    expect(c.coverage).toBe(0);
    expect(c.breakdown.formula).toBe(FORMULA_VERSION);
    expect(c.gate.status).toBe("fail");
    expect(c.limitations).toContain("No checks were planned or executed.");
  });

  it("computes weighted coverage/quality, scope, penalties, caps, band and breakdown", () => {
    const checks = [
      check({ id: "a", status: CheckStatus.PASSED, weight: 2, kind: "static", domain: "security" }),
      check({ id: "b", status: CheckStatus.FAILED, weight: 1, kind: "browser", domain: "functional", finding_ids: ["f1"] }),
      check({ id: "c", status: CheckStatus.BLOCKED, weight: 1, kind: "browser", domain: "functional" }),
    ];
    // executed=3/4 weight, quality=(2/3)*100=66.666, scope both=1, coverage_factor=0.25+0.75*0.75=0.8125, base=54.166..
    // critical penalty 45 => 9.166, critical cap applies (score <= 30) so score remains 9.2
    const findings = [finding({ id: "f1", severity: Severity.CRITICAL, check_id: "b", fingerprint: "fp1" })];
    const c = scoreConfidence(checks, findings);
    expect(c.band).toBe("low");
    expect(c.score).toBe(9.2);
    expect(c.coverage).toBe(75);
    expect(c.breakdown.scope_mode).toBe("both");
    expect(c.breakdown.formula).toBe(FORMULA_VERSION);
    expect(c.penalties.severity_total).toBe(45);
    expect(c.penalties.caps).toEqual([]);
    expect((c.domain_scores.security as { score: number }).score).toBe(100);
    expect((c.domain_scores.functional as { coverage: number }).coverage).toBe(50);
    expect(c.limitations.some((l) => l.includes("blocked, skipped, or errored"))).toBe(true);
  });

  it("dedupes findings by fingerprint, halves suspected penalties, ignores suppressed, and applies caps/gate", () => {
    const checks = [check({ id: "a", status: CheckStatus.PASSED, weight: 1, kind: "static" })];
    const findings = [
      finding({ id: "f1", severity: Severity.HIGH, fingerprint: "same", strength: Strength.SUSPECTED }),
      finding({ id: "f2", severity: Severity.HIGH, fingerprint: "same", strength: Strength.SOURCE_PROVEN }), // deduped
      finding({ id: "f3", severity: Severity.MEDIUM, fingerprint: "supp", suppressed: true }),
      finding({ id: "f4", severity: Severity.HIGH, fingerprint: "h2", strength: Strength.SOURCE_PROVEN }),
    ];
    // base: quality 100, coverage 1, source scope 0.9, factor 1 => 90. penalties: high suspected 10 + high 20 = 30 => 60
    // two highs unique (same + h2) => cap 65 not triggered (score 60 <= 65)
    const c = scoreConfidence(checks, findings);
    expect(c.score).toBe(60);
    expect((c.penalties.by_severity as Record<string, number>)[Severity.HIGH]).toBe(2);
    expect((c.penalties.by_severity as Record<string, number>)[Severity.MEDIUM]).toBeUndefined();
    expect(c.gate.status).toBe("warn"); // high present
    expect(c.rationale).toContain("confidence 60.0/100 (guarded)");

    const halted = scoreConfidence(checks, [finding({ id: "h", severity: Severity.INFO, fingerprint: "i" })], { halted: true, killReason: "manual" });
    expect(halted.score).toBe(25);
    expect(halted.limitations.some((l) => l.includes("kill switch: manual"))).toBe(true);

    const failedNoFinding = scoreConfidence([check({ id: "x", status: CheckStatus.FAILED, finding_ids: [] })], []);
    expect(failedNoFinding.limitations.some((l) => l.includes("failed without a recorded finding"))).toBe(true);
  });

  it("supports policy defaults/validation and gate outcomes", () => {
    const policy = createDefaultPolicy();
    expect(policy.id).toBe("advisory-v1");
    expect(policy.gate.pass_score).toBe(80);

    expect(() => policyFromDict({ schema_version: "nope" })).toThrow(/schema_version/);
    expect(() => policyFromDict({ gate: { pass_score: 50, warn_score: 60, fail_on_critical: true, fail_on_high: false, coverage_warn: 0.8, coverage_fail: 0.7 } })).toThrow(/warn_score/);

    const checks = [check({ id: "a", status: CheckStatus.PASSED, kind: "static", weight: 1 })];
    const pass = scoreConfidence(checks, []);
    expect(pass.score).toBe(90); // 100 * 1 * 0.9
    expect(pass.band).toBe("high");
    expect(pass.gate.status).toBe("pass");

    const strict = policyFromDict({
      ...createDefaultPolicy(),
      schema_version: "quality-harness.policy/v1",
      gate: { pass_score: 95, warn_score: 80, fail_on_critical: true, fail_on_high: true, coverage_warn: 0.8, coverage_fail: 0.7 },
    });
    const warn = scoreConfidence(checks, [finding({ severity: Severity.HIGH, fingerprint: "h" })], { policy: strict });
    expect(warn.gate.status).toBe("fail"); // fail_on_high
  });
});
