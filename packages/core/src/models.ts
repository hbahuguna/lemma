import { newId, now } from "./determinism.js";

// --------------------------------------------------------------------------- enums/constants

export const MODEL_SCHEMA_VERSION = "1.0" as const;
export const DOMAIN_SCHEMA_VERSION = MODEL_SCHEMA_VERSION;

export const RunStatus = {
  RUNNING: "running",
  COMPLETED: "completed",
  HALTED: "halted",
  FAILED: "failed",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const DomainPhaseName = {
  RISK_ANALYSIS: "risk_analysis",
  TEST_PLANNING: "test_planning",
  EXECUTION: "execution",
  EVIDENCE_COLLECTION: "evidence_collection",
  CONFIDENCE_SCORING: "confidence_scoring",
} as const;
export type DomainPhaseName = (typeof DomainPhaseName)[keyof typeof DomainPhaseName];

export const PhaseStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  HALTED: "halted",
  FAILED: "failed",
} as const;
export type PhaseStatus = (typeof PhaseStatus)[keyof typeof PhaseStatus];

export const CheckStatus = {
  PLANNED: "planned",
  RUNNING: "running",
  PASSED: "passed",
  FAILED: "failed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
  ERROR: "error",
} as const;
export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

export const Severity = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const Strength = {
  OBSERVED: "observed",
  SOURCE_PROVEN: "source_proven",
  SUSPECTED: "suspected",
} as const;
export type Strength = (typeof Strength)[keyof typeof Strength];

export const SEVERITY_RANK: Record<string, number> = {
  [Severity.CRITICAL]: 5,
  [Severity.HIGH]: 4,
  [Severity.MEDIUM]: 3,
  [Severity.LOW]: 2,
  [Severity.INFO]: 1,
};

export function severityRank(value: unknown): number {
  if (typeof value === "string") return SEVERITY_RANK[value] ?? 0;
  return 0;
}

export function clampSeverity(value: unknown): Severity {
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === Severity.CRITICAL || v === Severity.HIGH || v === Severity.MEDIUM || v === Severity.LOW || v === Severity.INFO) {
      return v;
    }
  }
  return Severity.MEDIUM;
}

// --------------------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 ? true : fallback === true ? false : value === 0 ? false : fallback;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function asAnyArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...(value as unknown[])] : [];
}

// --------------------------------------------------------------------------- Target

export interface Target {
  raw: string;
  kind: string; // "url" | "directory" | "file"
  resolved: string;
  source?: string | null;
}

export function normalizeTarget(data: unknown): Target {
  const d = isRecord(data) ? data : {};
  const out: Target = {
    raw: asString(d.raw),
    kind: asString(d.kind, "directory"),
    resolved: asString(d.resolved),
  };
  if ("source" in d) out.source = (d.source === null || typeof d.source === "string") ? d.source : null;
  else out.source = null;
  // preserve known? no, Target in assay is dataclass with fixed fields; keep stable
  return out;
}

export function targetToDict(target: Target): Record<string, unknown> {
  return {
    raw: target.raw,
    kind: target.kind,
    resolved: target.resolved,
    source: target.source ?? null,
  };
}

// --------------------------------------------------------------------------- Risk

export interface Risk {
  id: string;
  title: string;
  priority: string;
  domain: string;
  consequence: string;
  evidence: string[];
  weight_multiplier: number;
  source: string;
  status: string;
}

export function normalizeRisk(data: unknown): Risk {
  const d = isRecord(data) ? data : {};
  return {
    id: asString(d.id),
    title: asString(d.title),
    priority: asString(d.priority, "medium"),
    domain: asString(d.domain, "functional"),
    consequence: asString(d.consequence),
    evidence: asStringArray(d.evidence),
    weight_multiplier: asNumber(d.weight_multiplier, 1.0),
    source: asString(d.source, "analysis"),
    status: asString(d.status, "open"),
  };
}

// --------------------------------------------------------------------------- Finding

export interface Finding {
  id: string;
  title: string;
  severity: string;
  domain: string;
  persona: string;
  strength: string;
  consequence: string;
  location: string;
  reproduction: string;
  evidence: string[];
  remediation: string;
  verification: string;
  check_id: string;
  created_at: string;
  tags: string[];
  fingerprint: string;
  suppressed: boolean;
  suppression_owner: string;
  suppression_reason: string;
  suppression_ticket: string;
  suppression_expires_at: string;
}

export function createFinding(input: Partial<Finding> & Pick<Finding, "id" | "title">): Finding {
  return normalizeFinding({
    severity: Severity.MEDIUM,
    domain: "functional",
    persona: "functional",
    strength: Strength.SUSPECTED,
    consequence: "",
    location: "",
    reproduction: "",
    evidence: [],
    remediation: "",
    verification: "",
    check_id: "",
    tags: [],
    fingerprint: "",
    suppressed: false,
    suppression_owner: "",
    suppression_reason: "",
    suppression_ticket: "",
    suppression_expires_at: "",
    ...input,
    created_at: input.created_at ?? now(),
  });
}

export function normalizeFinding(data: unknown): Finding {
  const d = isRecord(data) ? data : {};
  return {
    id: asString(d.id),
    title: asString(d.title),
    severity: asString(d.severity, Severity.MEDIUM),
    domain: asString(d.domain, "functional"),
    persona: asString(d.persona, "functional"),
    strength: asString(d.strength, Strength.SUSPECTED),
    consequence: asString(d.consequence),
    location: asString(d.location),
    reproduction: asString(d.reproduction),
    evidence: asStringArray(d.evidence),
    remediation: asString(d.remediation),
    verification: asString(d.verification),
    check_id: asString(d.check_id),
    created_at: asString(d.created_at, now()),
    tags: asStringArray(d.tags),
    fingerprint: asString(d.fingerprint),
    suppressed: asBool(d.suppressed, false),
    suppression_owner: asString(d.suppression_owner),
    suppression_reason: asString(d.suppression_reason),
    suppression_ticket: asString(d.suppression_ticket),
    suppression_expires_at: asString(d.suppression_expires_at),
  };
}

// --------------------------------------------------------------------------- InvalidFinding

export interface InvalidFinding {
  id: string;
  persona: string;
  check_id: string;
  errors: string[];
  payload: unknown;
  contract: string;
  recorded_at: string;
}

export function normalizeInvalidFinding(data: unknown): InvalidFinding {
  const d = isRecord(data) ? data : {};
  return {
    id: asString(d.id),
    persona: asString(d.persona),
    check_id: asString(d.check_id),
    errors: asStringArray(d.errors),
    payload: "payload" in d ? d.payload : {},
    contract: asString(d.contract, "persona_output_schema"),
    recorded_at: asString(d.recorded_at, now()),
  };
}

// --------------------------------------------------------------------------- Blocker

export interface Blocker {
  id: string;
  persona: string;
  check_id: string;
  attempted_action: string;
  boundary: string;
  unblock_evidence: string[];
  covered_elsewhere: boolean;
  covered_by: string[];
  recorded_at: string;
}

export function normalizeBlocker(data: unknown): Blocker {
  const d = isRecord(data) ? data : {};
  return {
    id: asString(d.id),
    persona: asString(d.persona),
    check_id: asString(d.check_id),
    attempted_action: asString(d.attempted_action),
    boundary: asString(d.boundary),
    unblock_evidence: asStringArray(d.unblock_evidence),
    covered_elsewhere: asBool(d.covered_elsewhere, false),
    covered_by: asStringArray(d.covered_by),
    recorded_at: asString(d.recorded_at, now()),
  };
}

// --------------------------------------------------------------------------- Check

export interface Check {
  id: string;
  title: string;
  domain: string;
  persona: string;
  kind: string;
  intent: string;
  expected: string;
  base_weight: number;
  status: string;
  weight: number;
  actual: string;
  evidence: string[];
  finding_ids: string[];
  skip_reason: string;
  started_at?: string | null;
  completed_at?: string | null;
  metadata: Record<string, unknown>;
}

export function normalizeCheck(data: unknown): Check {
  const d = isRecord(data) ? data : {};
  const baseWeight = asNumber(d.base_weight, 1.0);
  const weight = "weight" in d ? asNumber(d.weight, baseWeight) : baseWeight;
  return {
    id: asString(d.id),
    title: asString(d.title),
    domain: asString(d.domain, "functional"),
    persona: asString(d.persona, "functional"),
    kind: asString(d.kind, "static"),
    intent: asString(d.intent),
    expected: asString(d.expected),
    base_weight: baseWeight,
    status: asString(d.status, CheckStatus.PLANNED),
    weight,
    actual: asString(d.actual),
    evidence: asStringArray(d.evidence),
    finding_ids: asStringArray(d.finding_ids),
    skip_reason: asString(d.skip_reason),
    started_at: (d.started_at === null || typeof d.started_at === "string") ? d.started_at : null,
    completed_at: (d.completed_at === null || typeof d.completed_at === "string") ? d.completed_at : null,
    metadata: asRecord(d.metadata),
  };
}

// --------------------------------------------------------------------------- Phase

export interface Phase {
  name: string;
  title: string;
  status: string;
  summary: string;
  started_at?: string | null;
  completed_at?: string | null;
  details: Record<string, unknown>;
}

export function normalizePhase(data: unknown): Phase {
  const d = isRecord(data) ? data : {};
  const name = asString(d.name);
  return {
    name,
    title: asString(d.title, name),
    status: asString(d.status, PhaseStatus.PENDING),
    summary: asString(d.summary),
    started_at: (d.started_at === null || typeof d.started_at === "string") ? d.started_at : null,
    completed_at: (d.completed_at === null || typeof d.completed_at === "string") ? d.completed_at : null,
    details: asRecord(d.details),
  };
}

// --------------------------------------------------------------------------- Confidence

export interface Confidence {
  score: number;
  band: string;
  coverage: number;
  rationale: string;
  limitations: string[];
  penalties: Record<string, number>;
  domain_scores: Record<string, unknown>;
  breakdown: Record<string, unknown>;
  gate: Record<string, unknown>;
}

export function normalizeConfidence(data: unknown): Confidence {
  const d = isRecord(data) ? data : {};
  const penaltiesRaw = isRecord(d.penalties) ? d.penalties : {};
  const penalties: Record<string, number> = {};
  for (const [k, v] of Object.entries(penaltiesRaw)) {
    penalties[k] = asNumber(v, 0);
  }
  return {
    score: asNumber(d.score, 0.0),
    band: asString(d.band, "unscored"),
    coverage: asNumber(d.coverage, 0.0),
    rationale: asString(d.rationale),
    limitations: asStringArray(d.limitations),
    penalties,
    domain_scores: asRecord(d.domain_scores),
    breakdown: asRecord(d.breakdown),
    gate: asRecord(d.gate),
  };
}

// --------------------------------------------------------------------------- KillSwitch

export interface KillSwitch {
  armed: boolean;
  threshold: string;
  triggered: boolean;
  reason: string;
  triggered_at?: string | null;
  finding_id: string;
  manual: boolean;
}

export function normalizeKillSwitch(data: unknown): KillSwitch {
  const d = isRecord(data) ? data : {};
  return {
    armed: "armed" in d ? asBool(d.armed, true) : true,
    threshold: asString(d.threshold, "critical"),
    triggered: asBool(d.triggered, false),
    reason: asString(d.reason),
    triggered_at: (d.triggered_at === null || typeof d.triggered_at === "string") ? d.triggered_at : null,
    finding_id: asString(d.finding_id),
    manual: asBool(d.manual, false),
  };
}

// --------------------------------------------------------------------------- RunState (domain)

export interface RunStateDomain {
  schema_version: string;
  run_id: string;
  workflow_id: string;
  workflow_version: string;
  target: Target;
  intent: string;
  status: string;
  current_phase: string;
  phases: Phase[];
  risks: Risk[];
  checks: Check[];
  findings: Finding[];
  invalid_findings: InvalidFinding[];
  blockers: Blocker[];
  contract_failures: Record<string, number>;
  contract_failure_streaks: Record<string, number>;
  degraded_personas: string[];
  confidence: Confidence;
  kill_switch: KillSwitch;
  inventory: Record<string, unknown>;
  personas: unknown[];
  options: Record<string, unknown>;
  evidence_dir: string;
  started_at: string;
  updated_at: string;
  completed_at?: string | null;
  halted_reason: string;
  error: string;
  seed?: number | null;
  clock_mode: string;
}

export function createRunState(input: {
  run_id?: string;
  workflow_id?: string;
  workflow_version?: string;
  target: unknown;
  intent?: string;
  [key: string]: unknown;
}): RunStateDomain {
  const { target, ...rest } = input;
  return normalizeRunState({
    run_id: input.run_id ?? newId("run"),
    workflow_id: input.workflow_id ?? "release-confidence",
    workflow_version: input.workflow_version ?? "",
    intent: input.intent ?? "",
    status: RunStatus.RUNNING,
    current_phase: DomainPhaseName.RISK_ANALYSIS,
    started_at: now(),
    updated_at: now(),
    ...rest,
    target,
  });
}

function asIntRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    out[String(k)] = Math.trunc(asNumber(v, 0));
  }
  return out;
}

export function normalizeRunState(data: unknown): RunStateDomain {
  const d = isRecord(data) ? data : {};
  const startedAt = asString(d.started_at, now());
  return {
    schema_version: asString(d.schema_version, MODEL_SCHEMA_VERSION),
    run_id: asString(d.run_id),
    workflow_id: asString(d.workflow_id, "release-confidence"),
    workflow_version: asString(d.workflow_version),
    target: normalizeTarget(d.target),
    intent: asString(d.intent),
    status: asString(d.status, RunStatus.RUNNING),
    current_phase: asString(d.current_phase, DomainPhaseName.RISK_ANALYSIS),
    phases: asAnyArray(d.phases).map(normalizePhase),
    risks: asAnyArray(d.risks).map(normalizeRisk),
    checks: asAnyArray(d.checks).map(normalizeCheck),
    findings: asAnyArray(d.findings).map(normalizeFinding),
    invalid_findings: asAnyArray(d.invalid_findings).map(normalizeInvalidFinding),
    blockers: asAnyArray(d.blockers).map(normalizeBlocker),
    contract_failures: asIntRecord(d.contract_failures),
    contract_failure_streaks: asIntRecord(d.contract_failure_streaks),
    degraded_personas: asStringArray(d.degraded_personas),
    confidence: normalizeConfidence(d.confidence),
    kill_switch: normalizeKillSwitch(d.kill_switch),
    inventory: asRecord(d.inventory),
    personas: asAnyArray(d.personas),
    options: asRecord(d.options),
    evidence_dir: asString(d.evidence_dir),
    started_at: startedAt,
    updated_at: asString(d.updated_at, startedAt),
    completed_at: (d.completed_at === null || typeof d.completed_at === "string") ? d.completed_at : null,
    halted_reason: asString(d.halted_reason),
    error: asString(d.error),
    seed: (d.seed === null || typeof d.seed === "number") ? d.seed : null,
    clock_mode: asString(d.clock_mode, "real"),
  };
}

// --------------------------------------------------------------------------- outcome drafts

export interface FindingDraft {
  title: string;
  severity: string;
  domain: string;
  strength: string;
  consequence: string;
  location: string;
  reproduction: string;
  evidence: string[];
  remediation: string;
  verification: string;
  tags: string[];
}

export interface BlockerDraft {
  attempted_action: string;
  boundary: string;
  unblock_evidence: string[];
  covered_elsewhere: boolean;
  covered_by: string[];
}

export interface CheckOutcomeInit {
  status?: string;
  actual?: string;
  evidence?: string[];
  findings?: FindingDraft[];
  blocker?: BlockerDraft | null;
  metadata?: Record<string, unknown>;
}

export class CheckOutcome {
  status: string;
  actual: string;
  evidence: string[];
  findings: FindingDraft[];
  blocker: BlockerDraft | null;
  metadata: Record<string, unknown>;

  constructor(init: CheckOutcomeInit = {}) {
    this.status = init.status ?? CheckStatus.PASSED;
    this.actual = init.actual ?? "";
    this.evidence = [...(init.evidence ?? [])];
    this.findings = [...(init.findings ?? [])];
    this.blocker = init.blocker ?? null;
    this.metadata = { ...(init.metadata ?? {}) };
  }

  addBlocker(
    attemptedAction: string,
    boundary: string,
    unblockEvidence: string[] = [],
    coveredElsewhere = false,
    coveredBy: string[] = [],
  ): void {
    this.blocker = {
      attempted_action: attemptedAction,
      boundary,
      unblock_evidence: [...unblockEvidence],
      covered_elsewhere: coveredElsewhere,
      covered_by: [...coveredBy],
    };
    this.findings = [];
    this.status = CheckStatus.BLOCKED;
  }

  addFinding(
    title: string,
    severity: string,
    domain: string,
    consequence: string,
    location = "",
    reproduction = "",
    strength: string = Strength.SOURCE_PROVEN,
    remediation = "",
    verification = "",
    tags: string[] = [],
  ): void {
    this.findings.push({
      title,
      severity,
      domain,
      strength,
      consequence,
      location,
      reproduction,
      evidence: [...this.evidence],
      remediation,
      verification,
      tags: [...tags],
    });
    this.status = CheckStatus.FAILED;
  }
}
