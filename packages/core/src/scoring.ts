import { promises as fs } from "node:fs";

import { PolicyError } from "./errors.js";
import { CheckStatus, Severity, normalizeConfidence, type Check, type Confidence, type Finding } from "./models.js";

export const FORMULA_VERSION = "weighted-coverage-v1" as const;

export const DOMAIN_WEIGHTS: Record<string, number> = {
  security: 1.5,
  data_integrity: 1.3,
  functional: 1.3,
  accessibility: 1.2,
  reliability: 1.2,
  performance: 1.0,
  content: 0.8,
};

export const SEVERITY_PENALTY: Record<string, number> = {
  [Severity.CRITICAL]: 45.0,
  [Severity.HIGH]: 20.0,
  [Severity.MEDIUM]: 8.0,
  [Severity.LOW]: 2.0,
  [Severity.INFO]: 0.0,
};

export const SCOPE_FACTOR: Record<string, number> = { both: 1.0, source: 0.9, live: 0.9, none: 0.75 };

export const DEFAULT_POLICY_ID = "advisory-v1";
export const DEFAULT_POLICY_VERSION = "1.0";

export interface ScoringPolicyGate {
  pass_score: number;
  warn_score: number;
  fail_on_critical: boolean;
  fail_on_high: boolean;
  coverage_warn: number;
  coverage_fail: number;
  [key: string]: unknown;
}

export interface ScoringPolicy {
  id: string;
  version: string;
  domain_weights: Record<string, number>;
  severity_penalties: Record<string, number>;
  scope_factors: Record<string, number>;
  penalty_cap: number;
  caps: { critical: number; two_high: number; halted: number; [key: string]: number };
  gate: ScoringPolicyGate;
}

export function createDefaultPolicy(): ScoringPolicy {
  return {
    id: DEFAULT_POLICY_ID,
    version: DEFAULT_POLICY_VERSION,
    domain_weights: { ...DOMAIN_WEIGHTS },
    severity_penalties: { ...SEVERITY_PENALTY },
    scope_factors: { ...SCOPE_FACTOR },
    penalty_cap: 70.0,
    caps: { critical: 30.0, two_high: 65.0, halted: 25.0 },
    gate: {
      pass_score: 80.0,
      warn_score: 60.0,
      fail_on_critical: true,
      fail_on_high: false,
      coverage_warn: 0.8,
      coverage_fail: 0.7,
    },
  };
}

export const DEFAULT_POLICY: ScoringPolicy = createDefaultPolicy();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new PolicyError(message);
  }
  return value;
}

export function policyFromDict(data: unknown): ScoringPolicy {
  if (!isRecord(data)) throw new PolicyError("Policy must be a JSON object.");
  const allowed = new Set([
    "schema_version",
    "id",
    "version",
    "domain_weights",
    "severity_penalties",
    "scope_factors",
    "penalty_cap",
    "caps",
    "gate",
  ]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) throw new PolicyError(`Unknown policy field(s): ${key}.`);
  }
  const schema = data.schema_version ?? "quality-harness.policy/v1";
  if (schema !== "quality-harness.policy/v1") {
    throw new PolicyError("Policy schema_version must be 'quality-harness.policy/v1'.");
  }
  const policyId = data.id ?? DEFAULT_POLICY_ID;
  const version = data.version ?? DEFAULT_POLICY_VERSION;
  if (typeof policyId !== "string" || !policyId.trim()) throw new PolicyError("Policy id must be a non-empty string.");
  if (typeof version !== "string" || !version.trim()) throw new PolicyError("Policy version must be a non-empty string.");

  const domainWeights = (data.domain_weights ?? { ...DOMAIN_WEIGHTS }) as unknown;
  const severityPenalties = (data.severity_penalties ?? { ...SEVERITY_PENALTY }) as unknown;
  const scopeFactors = (data.scope_factors ?? { ...SCOPE_FACTOR }) as unknown;
  const penaltyCap = data.penalty_cap ?? 70.0;
  const caps = (data.caps ?? { critical: 30.0, two_high: 65.0, halted: 25.0 }) as unknown;
  const gate = (data.gate ?? {
    pass_score: 80.0,
    warn_score: 60.0,
    fail_on_critical: true,
    fail_on_high: false,
    coverage_warn: 0.8,
    coverage_fail: 0.7,
  }) as unknown;

  if (!isRecord(domainWeights) || Object.keys(domainWeights).length === 0) {
    throw new PolicyError("domain_weights must be a non-empty object.");
  }
  for (const [name, value] of Object.entries(domainWeights)) {
    if (!name) throw new PolicyError("domain_weights keys must be non-empty strings.");
    const n = assertNumber(value, "domain_weights values must be numbers greater than 0 and at most 10.");
    if (n <= 0 || n > 10) throw new PolicyError("domain_weights values must be numbers greater than 0 and at most 10.");
  }
  if (!isRecord(severityPenalties) || Object.keys(severityPenalties).length === 0) {
    throw new PolicyError("severity_penalties must be a non-empty object.");
  }
  for (const [name, value] of Object.entries(severityPenalties)) {
    if (!(name in SEVERITY_PENALTY)) throw new PolicyError(`Unknown severity penalty key: ${name}.`);
    const n = assertNumber(value, "severity_penalties values must be numbers from 0 to 100.");
    if (n < 0 || n > 100) throw new PolicyError("severity_penalties values must be numbers from 0 to 100.");
  }
  if (!isRecord(scopeFactors)) throw new PolicyError("scope_factors must be an object.");
  for (const key of ["both", "source", "live", "none"]) {
    if (!(key in scopeFactors)) throw new PolicyError(`scope_factors must include '${key}'.`);
  }
  for (const [key, value] of Object.entries(scopeFactors)) {
    if (!["both", "source", "live", "none"].includes(key)) throw new PolicyError(`Unknown scope factor key: ${key}.`);
    const n = assertNumber(value, "scope_factors values must be numbers from 0 to 1.");
    if (n < 0 || n > 1) throw new PolicyError("scope_factors values must be numbers from 0 to 1.");
  }
  const capNum = assertNumber(penaltyCap, "penalty_cap must be a number from 0 to 100.");
  if (capNum < 0 || capNum > 100) throw new PolicyError("penalty_cap must be a number from 0 to 100.");
  if (!isRecord(caps)) throw new PolicyError("caps must be an object.");
  for (const key of ["critical", "two_high", "halted"]) {
    if (!(key in caps)) throw new PolicyError(`caps must include '${key}'.`);
  }
  for (const [key, value] of Object.entries(caps)) {
    if (!["critical", "two_high", "halted"].includes(key)) throw new PolicyError(`Unknown cap key: ${key}.`);
    const n = assertNumber(value, "cap values must be numbers from 0 to 100.");
    if (n < 0 || n > 100) throw new PolicyError("cap values must be numbers from 0 to 100.");
  }
  if (Number(caps.critical) > Number(caps.two_high)) throw new PolicyError("critical cap must not exceed the two-high cap.");
  if (!isRecord(gate)) throw new PolicyError("gate must be an object.");
  const requiredGate = new Set(["pass_score", "warn_score", "fail_on_critical", "fail_on_high", "coverage_warn", "coverage_fail"]);
  for (const k of requiredGate) if (!(k in gate)) throw new PolicyError("gate is missing required keys.");
  for (const k of Object.keys(gate)) if (!requiredGate.has(k)) throw new PolicyError("gate contains unknown keys.");
  const passScore = assertNumber(gate.pass_score, "gate.pass_score must be a number from 0 to 100.");
  const warnScore = assertNumber(gate.warn_score, "gate.warn_score must be a number from 0 to 100.");
  if (passScore < 0 || passScore > 100) throw new PolicyError("gate.pass_score must be a number from 0 to 100.");
  if (warnScore < 0 || warnScore > 100) throw new PolicyError("gate.warn_score must be a number from 0 to 100.");
  if (passScore < warnScore) throw new PolicyError("gate.pass_score must be at least gate.warn_score.");
  if (typeof gate.fail_on_critical !== "boolean") throw new PolicyError("gate.fail_on_critical must be a boolean.");
  if (typeof gate.fail_on_high !== "boolean") throw new PolicyError("gate.fail_on_high must be a boolean.");
  const covWarn = assertNumber(gate.coverage_warn, "gate.coverage_warn must be a number from 0 to 1.");
  const covFail = assertNumber(gate.coverage_fail, "gate.coverage_fail must be a number from 0 to 1.");
  if (covWarn < 0 || covWarn > 1) throw new PolicyError("gate.coverage_warn must be a number from 0 to 1.");
  if (covFail < 0 || covFail > 1) throw new PolicyError("gate.coverage_fail must be a number from 0 to 1.");
  if (covFail > covWarn) throw new PolicyError("gate.coverage_fail must not exceed gate.coverage_warn.");

  return {
    id: policyId,
    version,
    domain_weights: Object.fromEntries(Object.entries(domainWeights).map(([k, v]) => [k, Number(v)])),
    severity_penalties: Object.fromEntries(Object.entries(severityPenalties).map(([k, v]) => [k, Number(v)])),
    scope_factors: Object.fromEntries(Object.entries(scopeFactors).map(([k, v]) => [k, Number(v)])),
    penalty_cap: capNum,
    caps: {
      critical: Number(caps.critical),
      two_high: Number(caps.two_high),
      halted: Number(caps.halted),
    },
    gate: {
      pass_score: passScore,
      warn_score: warnScore,
      fail_on_critical: gate.fail_on_critical,
      fail_on_high: gate.fail_on_high,
      coverage_warn: covWarn,
      coverage_fail: covFail,
    },
  };
}

export async function loadPolicy(filePath: string): Promise<ScoringPolicy> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return policyFromDict(JSON.parse(raw) as unknown);
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    throw new PolicyError(`Could not load policy ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function policyToDict(policy: ScoringPolicy): Record<string, unknown> {
  return {
    schema_version: "quality-harness.policy/v1",
    id: policy.id,
    version: policy.version,
    domain_weights: { ...policy.domain_weights },
    severity_penalties: { ...policy.severity_penalties },
    scope_factors: { ...policy.scope_factors },
    penalty_cap: policy.penalty_cap,
    caps: { ...policy.caps },
    gate: { ...policy.gate },
  };
}

function findingFingerprint(finding: Pick<Finding, "fingerprint" | "domain" | "title" | "location">): string {
  if (finding.fingerprint) return finding.fingerprint;
  return `${finding.domain}|${String(finding.title).trim().toLowerCase()}|${finding.location ?? ""}`;
}

function scopeMode(checks: readonly Pick<Check, "kind">[]): string {
  const kinds = new Set(checks.map((c) => c.kind));
  if (kinds.has("static") && kinds.has("browser")) return "both";
  if (kinds.has("static")) return "source";
  if (kinds.has("browser")) return "live";
  return "none";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isScoringPolicy(value: unknown): value is ScoringPolicy {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    isRecord(value.domain_weights) &&
    isRecord(value.severity_penalties) &&
    isRecord(value.scope_factors) &&
    typeof value.penalty_cap === "number" &&
    isRecord(value.caps) &&
    isRecord(value.gate)
  );
}

export function scoreConfidence(
  checks: readonly Check[],
  findings: readonly Finding[],
  options: {
    limitations?: readonly string[];
    halted?: boolean;
    killReason?: string;
    policy?: ScoringPolicy | Record<string, unknown>;
  } = {},
): Confidence {
  const limitations = [...(options.limitations ?? [])];
  let policy: ScoringPolicy;
  if (options.policy === undefined) policy = createDefaultPolicy();
  else if (isScoringPolicy(options.policy)) policy = options.policy;
  else if (isRecord(options.policy)) policy = policyFromDict(options.policy);
  else throw new PolicyError("policy must be a Policy or policy dictionary.");

  const halted = Boolean(options.halted);
  const killReason = options.killReason ?? "";

  if (checks.length === 0) {
    return normalizeConfidence({
      score: 0.0,
      band: "none",
      coverage: 0.0,
      rationale: "No checks were planned, so no release confidence can be claimed.",
      limitations: [...limitations, "No checks were planned or executed.", "A confidence score is not a probability of zero defects."],
      breakdown: { formula: FORMULA_VERSION, planned_checks: 0 },
      gate: { status: "fail", reasons: ["No checks were planned."], policy: policy.id },
    });
  }

  const weightOf = (c: Check) => Math.max(Number(c.weight) || 0, 0.0001);
  const totalWeight = checks.reduce((s, c) => s + weightOf(c), 0);
  const executed = checks.filter((c) => c.status === CheckStatus.PASSED || c.status === CheckStatus.FAILED);
  const executedWeight = executed.reduce((s, c) => s + weightOf(c), 0);
  const passed = executed.filter((c) => c.status === CheckStatus.PASSED);
  const passedWeight = passed.reduce((s, c) => s + weightOf(c), 0);
  const coverageRatio = totalWeight ? executedWeight / totalWeight : 0.0;
  const quality = executedWeight ? (passedWeight / executedWeight) * 100.0 : 0.0;

  const scope = scopeMode(checks);
  const scopeFactor = policy.scope_factors[scope] ?? 0.75;
  const coverageFactor = 0.25 + 0.75 * coverageRatio;
  const base = quality * coverageFactor * scopeFactor;

  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const fp = findingFingerprint(finding);
    if (!unique.has(fp)) unique.set(fp, finding);
  }
  const uniqueFindings = [...unique.values()];

  const findingsBySeverity: Record<string, number> = {};
  let penalty = 0.0;
  for (const finding of uniqueFindings) {
    if (finding.suppressed) continue;
    const severity = String(finding.severity);
    findingsBySeverity[severity] = (findingsBySeverity[severity] ?? 0) + 1;
    let points = policy.severity_penalties[severity] ?? 0.0;
    if (finding.strength === "suspected") points *= 0.5;
    penalty += points;
  }
  penalty = Math.min(penalty, policy.penalty_cap);

  let score = base - penalty;
  const capsApplied: Array<{ reason: string; cap: number }> = [];
  const criticalCount = findingsBySeverity[Severity.CRITICAL] ?? 0;
  const highCount = findingsBySeverity[Severity.HIGH] ?? 0;
  const criticalCap = policy.caps.critical ?? 30.0;
  const twoHighCap = policy.caps.two_high ?? 65.0;
  const haltedCap = policy.caps.halted ?? 25.0;
  if (criticalCount > 0) {
    if (score > criticalCap) capsApplied.push({ reason: "critical finding", cap: criticalCap });
    score = Math.min(score, criticalCap);
  }
  if (highCount >= 2 && score > twoHighCap) {
    capsApplied.push({ reason: "two or more high findings", cap: twoHighCap });
    score = Math.min(score, twoHighCap);
  }
  if (halted && score > haltedCap) {
    capsApplied.push({ reason: "kill switch halted execution", cap: haltedCap });
    score = Math.min(score, haltedCap);
  }
  score = round1(Math.max(0.0, Math.min(100.0, score)));

  const domains: Record<string, Record<string, unknown>> = {};
  for (const check of checks) {
    const bucket = (domains[check.domain] ??= {
      weight: 0.0,
      executed_weight: 0.0,
      passed_weight: 0.0,
      checks: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
    }) as Record<string, number | undefined>;
    const w = Number(check.weight) || 0;
    bucket.weight = (bucket.weight ?? 0) + w;
    bucket.checks = (bucket.checks ?? 0) + 1;
    if (check.status === CheckStatus.PASSED) {
      bucket.executed_weight = (bucket.executed_weight ?? 0) + w;
      bucket.passed_weight = (bucket.passed_weight ?? 0) + w;
      bucket.passed = (bucket.passed ?? 0) + 1;
    } else if (check.status === CheckStatus.FAILED) {
      bucket.executed_weight = (bucket.executed_weight ?? 0) + w;
      bucket.failed = (bucket.failed ?? 0) + 1;
    } else {
      bucket.blocked = (bucket.blocked ?? 0) + 1;
    }
  }
  for (const bucket of Object.values(domains)) {
    const executedWeightD = Number(bucket.executed_weight ?? 0);
    const passedWeightD = Number(bucket.passed_weight ?? 0);
    const weightD = Number(bucket.weight ?? 0);
    bucket.score = executedWeightD ? round1((passedWeightD / executedWeightD) * 100.0) : 0.0;
    bucket.coverage = weightD ? round1((executedWeightD / weightD) * 100.0) : 0.0;
  }

  const blocked = checks.filter((c) =>
    c.status === CheckStatus.BLOCKED || c.status === CheckStatus.SKIPPED || c.status === CheckStatus.ERROR,
  );
  for (const check of checks) {
    if (check.status === CheckStatus.FAILED && (!check.finding_ids || check.finding_ids.length === 0)) {
      limitations.push(`Check '${check.id}' failed without a recorded finding; treat its result as unexplained.`);
    }
  }
  if (blocked.length > 0) {
    limitations.push(`${blocked.length} planned check(s) were blocked, skipped, or errored and count as coverage gaps, not passes.`);
  }
  if (scope === "source") {
    limitations.push("Static-only evidence: rendered behavior was not exercised.");
  } else if (scope === "live") {
    limitations.push("Live-only evidence: source and deployment configuration were not inspected.");
  }
  if (halted) {
    limitations.push(`Execution was halted by the kill switch: ${killReason || "critical finding"}.`);
  }
  limitations.push("Confidence is scoped engineering judgment, not a probability of zero defects.");

  let band = "high";
  if (score >= 85) band = "high";
  else if (score >= 70) band = "moderate";
  else if (score >= 50) band = "guarded";
  else band = "low";
  if (score <= 0.0) band = "none";

  const gateReasons: string[] = [];
  const gate = policy.gate;
  if (gate.fail_on_critical && criticalCount > 0) {
    gateReasons.push("One or more critical findings are present.");
  }
  if (gate.fail_on_high && highCount > 0) {
    gateReasons.push(`${highCount} high-severity finding(s) remain open.`);
  }
  if (!gate.fail_on_high && highCount > 0) {
    gateReasons.push(`${highCount} high-severity finding(s) remain open.`);
  }
  if (coverageRatio < gate.coverage_fail) {
    gateReasons.push(`Executed coverage is below ${Math.round(gate.coverage_fail * 100)}% of planned weight.`);
  }
  if (score < gate.warn_score) {
    gateReasons.push(`Confidence is below the advisory release floor of ${gate.warn_score}.`);
  }
  let gateStatus: "pass" | "warn" | "fail";
  if (criticalCount > 0 || score < gate.warn_score || coverageRatio < gate.coverage_fail || (gate.fail_on_high && highCount > 0)) {
    gateStatus = "fail";
  } else if (score < gate.pass_score || highCount > 0 || coverageRatio < gate.coverage_warn) {
    gateStatus = "warn";
  } else {
    gateStatus = "pass";
  }
  if (gateReasons.length === 0) gateReasons.push("No advisory release blockers were detected in the executed scope.");

  const rationale = (
    `Executed ${executedWeight.toFixed(1)} of ${totalWeight.toFixed(1)} planned weight (${(coverageRatio * 100.0).toFixed(0)}% coverage); ` +
    `quality among executed checks was ${quality.toFixed(0)}%; scope factor ${scopeFactor.toFixed(2)}. ` +
    `Severity penalty was ${penalty.toFixed(1)} points. Final confidence ${score.toFixed(1)}/100 (${band}).`
  );

  return normalizeConfidence({
    score,
    band,
    coverage: round1(coverageRatio * 100.0),
    rationale,
    limitations,
    penalties: {
      severity_total: round1(penalty),
      by_severity: findingsBySeverity,
      caps: capsApplied,
    },
    domain_scores: domains,
    breakdown: {
      formula: FORMULA_VERSION,
      planned_checks: checks.length,
      executed_checks: executed.length,
      passed_checks: passed.length,
      failed_checks: executed.length - passed.length,
      blocked_checks: blocked.length,
      total_weight: round3(totalWeight),
      executed_weight: round3(executedWeight),
      passed_weight: round3(passedWeight),
      coverage_ratio: round4(coverageRatio),
      quality: round1(quality),
      coverage_factor: round4(coverageFactor),
      scope_mode: scope,
      scope_factor: scopeFactor,
      base_score: round1(base),
      severity_penalty: round1(penalty),
      score,
      band,
      halted,
      policy_id: policy.id,
      policy_version: policy.version,
    },
    gate: { status: gateStatus, reasons: gateReasons, policy: policy.id },
  });
}
