import { createHash } from "node:crypto";

import { StateError } from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const HEALTH_SCORE_SCHEMA_VERSION = "lemma.pro.health_score/v1" as const;

export const HEALTH_SCORE_FORMULA = {
  id: "lemma.pro.health.v1",
  version: "1",
  description:
    "Deterministic formula (v1): base=100; subtract severity penalties per finding (critical=25, high=15, medium=8, low=3, info=1); subtract check penalties (failed/blocked/error=10, skipped=5 as coverage-gap pressure) with per-check cap contribution and no positive inflation; clamp to [0,100] and round to nearest integer. Breakdowns computed per dimension/domain, per check family, per persona.",
} as const;

const SEVERITY_PENALTY: Record<string, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
  info: 1,
};

const EVIDENCE_LEVEL_RANK: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3 };
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export interface HealthScoreBreakdownBucket {
  score: number;
  penalty: number;
  findings: number;
  checks: number;
  [key: string]: unknown;
}

export interface SeverityRankedFinding {
  id: string;
  check_id?: string;
  title?: string;
  severity: string;
  evidence_level: string;
  confidence: number | null;
  rank: number;
  rank_key: {
    severity_rank: number;
    evidence_level_rank: number;
    confidence: number | null;
  };
  [key: string]: unknown;
}

export interface HealthScore {
  schema_version: typeof HEALTH_SCORE_SCHEMA_VERSION;
  score: number;
  formula: typeof HEALTH_SCORE_FORMULA;
  breakdown: {
    dimensions: Record<string, HealthScoreBreakdownBucket>;
    check_families: Record<string, HealthScoreBreakdownBucket>;
    personas: Record<string, HealthScoreBreakdownBucket>;
  };
  severity_ranked_findings: SeverityRankedFinding[];
  deterministic: true;
  report_fingerprint?: string;
  [key: string]: unknown;
}

export interface ComputeHealthScoreParams {
  report: any;
  license?: ProLicenseContext | null;
}

function assertLicensed(license: ProLicenseContext | null | undefined): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError("overall health score");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function severityRank(sev: unknown): number {
  const s = asString(sev, "medium").toLowerCase();
  return SEVERITY_RANK[s] ?? 2;
}

function evidenceLevelRank(level: unknown): number {
  const l = asString(level, "E0");
  return EVIDENCE_LEVEL_RANK[l] ?? 0;
}

function checkFamily(checkId: string): string {
  if (!checkId) return "unknown";
  const parts = checkId.split(/[.:/_-]/).filter(Boolean);
  return parts[0] || checkId;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function fingerprintReport(report: any): string {
  const h = createHash("sha256");
  const stable = {
    run_id: report?.run_id ?? null,
    status: report?.status ?? null,
    findings: Array.isArray(report?.findings)
      ? report.findings.map((f: any) => ({ id: f?.id, severity: f?.severity, check_id: f?.check_id, evidence_level: f?.evidence_level ?? f?.evidenceLevel, confidence: f?.confidence ?? null }))
      : [],
    checks: report?.checks && typeof report.checks === "object" ? report.checks : null,
    coverage: report?.coverage ?? null,
  };
  h.update(JSON.stringify(stable));
  return h.digest("hex");
}

export function rankFindings(findings: any[]): SeverityRankedFinding[] {
  const list = Array.isArray(findings) ? findings.filter(isRecord) : [];
  const sorted = [...list].sort((a, b) => {
    const sa = severityRank(a.severity);
    const sb = severityRank(b.severity);
    if (sa !== sb) return sa - sb;
    const ea = evidenceLevelRank(a.evidence_level ?? a.evidenceLevel ?? "E0");
    const eb = evidenceLevelRank(b.evidence_level ?? b.evidenceLevel ?? "E0");
    // stronger evidence first within same severity (higher rank = more confidence/support)
    if (ea !== eb) return eb - ea;
    const ca = asNumberOrNull(a.confidence);
    const cb = asNumberOrNull(b.confidence);
    // higher confidence first; nulls last
    if (ca == null && cb == null) {
      // stable deterministic tiebreaker
      return asString(a.id).localeCompare(asString(b.id));
    }
    if (ca == null) return 1;
    if (cb == null) return -1;
    if (ca !== cb) return cb - ca;
    return asString(a.id).localeCompare(asString(b.id));
  });
  return sorted.map((f, i) => {
    const confidence = asNumberOrNull(f.confidence);
    return {
      ...(f as any),
      id: asString(f.id),
      check_id: asString(f.check_id) || undefined,
      title: asString(f.title) || undefined,
      severity: asString(f.severity, "medium").toLowerCase(),
      evidence_level: asString(f.evidence_level ?? f.evidenceLevel, "E0"),
      confidence,
      rank: i + 1,
      rank_key: {
        severity_rank: severityRank(f.severity),
        evidence_level_rank: evidenceLevelRank(f.evidence_level ?? f.evidenceLevel ?? "E0"),
        confidence,
      },
    };
  });
}

function ensureBucket(map: Record<string, HealthScoreBreakdownBucket>, key: string): HealthScoreBreakdownBucket {
  if (!map[key]) map[key] = { score: 100, penalty: 0, findings: 0, checks: 0 };
  return map[key]!;
}

export function computeHealthScore(params: ComputeHealthScoreParams): HealthScore {
  assertLicensed(params.license);
  const report = params.report;
  if (!isRecord(report)) {
    throw new StateError("computeHealthScore requires a report object", { details: { reason: "invalid_report" } });
  }

  const findings = Array.isArray(report.findings) ? report.findings.filter(isRecord) : [];
  const checksObj = isRecord(report.checks) ? report.checks : {};
  const checkItems = Array.isArray((checksObj as any).items) ? (checksObj as any).items.filter(isRecord) : [];

  let penalty = 0;

  // Finding severity penalties
  for (const f of findings) {
    const sev = asString(f.severity, "medium").toLowerCase();
    penalty += SEVERITY_PENALTY[sev] ?? 8;
  }

  // Check penalties (coverage-gap pressure, no positive inflation). Avoid double-counting by capping per-check contribution.
  const representedCheckIds = new Set(findings.map((f) => asString((f as any).check_id)).filter(Boolean));
  for (const c of checkItems) {
    const status = asString((c as any).status, "").toLowerCase();
    const id = asString((c as any).id);
    let p = 0;
    if (status === "failed" || status === "blocked" || status === "error") p = representedCheckIds.has(id) ? 0 : 10;
    else if (status === "skipped") p = 5;
    penalty += p;
  }

  const score = clampScore(100 - penalty);

  const dimensions: Record<string, HealthScoreBreakdownBucket> = {};
  const families: Record<string, HealthScoreBreakdownBucket> = {};
  const personas: Record<string, HealthScoreBreakdownBucket> = {};

  // Dimension/domain breakdown from findings and checks
  for (const f of findings) {
    const dim = asString((f as any).domain ?? (f as any).dimension, "unknown") || "unknown";
    const b = ensureBucket(dimensions, dim);
    const p = SEVERITY_PENALTY[asString((f as any).severity, "medium").toLowerCase()] ?? 8;
    b.findings += 1;
    b.penalty += p;
    b.score = clampScore(100 - b.penalty);
  }
  for (const c of checkItems) {
    const dim = asString((c as any).domain ?? (c as any).dimension, "unknown") || "unknown";
    const b = ensureBucket(dimensions, dim);
    b.checks += 1;
  }

  // Check-family breakdown
  for (const f of findings) {
    const fam = checkFamily(asString((f as any).check_id));
    const b = ensureBucket(families, fam);
    const p = SEVERITY_PENALTY[asString((f as any).severity, "medium").toLowerCase()] ?? 8;
    b.findings += 1;
    b.penalty += p;
    b.score = clampScore(100 - b.penalty);
  }
  for (const c of checkItems) {
    const fam = checkFamily(asString((c as any).id));
    const b = ensureBucket(families, fam);
    b.checks += 1;
  }

  // Persona breakdown (owner/persona)
  for (const f of findings) {
    const persona = asString((f as any).persona ?? (f as any).owner ?? (f as any).actor, "unknown") || "unknown";
    const b = ensureBucket(personas, persona);
    const p = SEVERITY_PENALTY[asString((f as any).severity, "medium").toLowerCase()] ?? 8;
    b.findings += 1;
    b.penalty += p;
    b.score = clampScore(100 - b.penalty);
  }
  for (const c of checkItems) {
    const persona = asString((c as any).persona ?? (c as any).owner, "unknown") || "unknown";
    const b = ensureBucket(personas, persona);
    b.checks += 1;
  }

  // Ensure referenced personas/domains/families exist even if only checks present
  for (const v of Object.values(dimensions)) v.score = clampScore(100 - v.penalty);
  for (const v of Object.values(families)) v.score = clampScore(100 - v.penalty);
  for (const v of Object.values(personas)) v.score = clampScore(100 - v.penalty);

  const severity_ranked_findings = rankFindings(findings);

  const result: HealthScore = {
    schema_version: HEALTH_SCORE_SCHEMA_VERSION,
    score,
    formula: { ...HEALTH_SCORE_FORMULA },
    breakdown: { dimensions, check_families: families, personas },
    severity_ranked_findings,
    deterministic: true,
    report_fingerprint: fingerprintReport(report),
  };

  const errors = validateHealthScore(result);
  if (errors.length) {
    throw new StateError(`Health score failed schema validation: ${errors.join(", ")}`, { details: { errors } });
  }
  return result;
}

export function validateHealthScore(value: any): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["health_score must be an object"];
  if (value.schema_version !== HEALTH_SCORE_SCHEMA_VERSION) errors.push("schema_version");
  if (typeof value.score !== "number" || !Number.isInteger(value.score) || value.score < 0 || value.score > 100) errors.push("score");
  if (!isRecord(value.formula) || typeof value.formula.id !== "string" || typeof value.formula.version !== "string" || typeof value.formula.description !== "string") errors.push("formula");
  if (!isRecord(value.breakdown)) errors.push("breakdown");
  else {
    for (const k of ["dimensions", "check_families", "personas"]) {
      if (!isRecord((value.breakdown as any)[k])) errors.push(`breakdown.${k}`);
    }
  }
  if (!Array.isArray(value.severity_ranked_findings)) errors.push("severity_ranked_findings");
  else {
    for (const f of value.severity_ranked_findings) {
      if (!isRecord(f)) { errors.push("finding_invalid"); continue; }
      if (typeof f.id !== "string") errors.push("finding.id");
      if (typeof f.severity !== "string") errors.push("finding.severity");
      if (typeof f.evidence_level !== "string") errors.push("finding.evidence_level");
      if (!(f.confidence === null || typeof f.confidence === "number")) errors.push("finding.confidence");
      const rank = (f as any).rank;
      if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1) errors.push("finding.rank");
    }
  }
  return errors;
}
