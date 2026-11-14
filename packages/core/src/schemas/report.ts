import { z } from "zod";
import { IsoTimestampSchema, JsonObjectSchema } from "./common.js";

export const LEMMA_REPORT_SCHEMA_VERSION = "lemma.report/v1" as const;
export const ASSAY_REPORT_SCHEMA_VERSION = "quality-harness.report/v1" as const;

export const ReportSchemaVersionSchema = z.union([
  z.literal(LEMMA_REPORT_SCHEMA_VERSION),
  z.literal(ASSAY_REPORT_SCHEMA_VERSION),
]);

export const DeterminismSchema = z
  .object({
    seed: z.number().int().nullable(),
    clock_mode: z.string(),
    entropy: z.string(),
  })
  .passthrough();

export const WorkflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    phases: z.array(z.string()),
  })
  .passthrough();

export const TargetSchema = z
  .object({
    kind: z.string(),
    raw: z.string(),
    resolved: z.string(),
    source: z.string(),
  })
  .passthrough();

export const PolicyRefSchema = z
  .object({
    id: z.string(),
    version: z.string(),
  })
  .passthrough();

export const MeteringSummarySchema = z
  .object({
    schema_version: z.string(),
    sink: z.string(),
    workspace: z.string(),
    event_count: z.number().int(),
    event_types: z.record(z.number().int()),
    run_event_count: z.number().int().optional(),
    run_event_types: z.record(z.number().int()).optional(),
  })
  .passthrough();

export const DecisionSchema = z
  .object({
    decision: z.string(),
    rationale: z.string(),
  })
  .passthrough();

export const TrendSchema = z
  .object({
    baseline: z.boolean(),
    previous_run_id: z.string().nullable(),
    new: z.array(z.string()),
    resolved: z.array(z.string()),
    persistent: z.array(z.string()),
    score_delta: z.number(),
    coverage_delta: z.number(),
  })
  .passthrough();

export const ConfidenceSchema = z
  .object({
    score: z.number(),
    band: z.string(),
    coverage: z.number(),
    rationale: z.string(),
    limitations: z.array(z.string()),
    penalties: z.record(z.unknown()),
    domain_scores: z.record(z.unknown()),
    breakdown: z.record(z.unknown()),
    gate: z.record(z.unknown()),
  })
  .passthrough();

export const FindingSchema = z
  .object({
    id: z.string().optional(),
    check_id: z.string().optional(),
    severity: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const BlockerSchema = z.object({}).passthrough();
export const CheckResultSchema = z.object({}).passthrough();
export const PersonaResultSchema = z.object({}).passthrough();
export const PhaseResultSchema = z.object({}).passthrough();
export const RiskSchema = z.object({}).passthrough();

export const KillSwitchSchema = z
  .object({
    armed: z.boolean(),
    triggered: z.boolean(),
    threshold: z.string(),
    reason: z.string(),
    finding_id: z.string(),
    manual: z.boolean(),
    triggered_at: z.string().nullable(),
  })
  .passthrough();

export const EvidenceRefSchema = z
  .object({
    directory: z.string(),
    summary: JsonObjectSchema,
  })
  .passthrough();

export const ContractFailuresSchema = z
  .object({
    total: z.number().int(),
    by_persona: z.record(z.number().int()),
    degraded_personas: z.array(z.string()),
  })
  .passthrough();

export const ReportV1Schema = z
  .object({
    schema_version: ReportSchemaVersionSchema,
    generated_at: IsoTimestampSchema,
    run_id: z.string().min(1),
    determinism: DeterminismSchema,
    status: z.string(),
    workflow: WorkflowSchema,
    target: TargetSchema,
    intent: z.string(),
    policy: PolicyRefSchema,
    metering: MeteringSummarySchema,
    decision: DecisionSchema,
    trend: TrendSchema,
    confidence: ConfidenceSchema,
    findings: z.array(FindingSchema),
    finding_counts: z.record(z.number().int()),
    invalid_findings: z.array(z.unknown()),
    blockers: z.array(BlockerSchema),
    contract_failures: ContractFailuresSchema,
    checks: z.array(CheckResultSchema),
    coverage: z.record(z.unknown()),
    risks: z.array(RiskSchema),
    personas: z.array(PersonaResultSchema),
    inventory: JsonObjectSchema,
    phases: z.array(PhaseResultSchema),
    kill_switch: KillSwitchSchema,
    halted_reason: z.string().nullable(),
    limitations: z.array(z.string()),
    evidence: EvidenceRefSchema,
    started_at: IsoTimestampSchema,
    completed_at: IsoTimestampSchema,
    options: JsonObjectSchema,
    error: z.string(),
  })
  .passthrough();

export type ReportV1 = z.infer<typeof ReportV1Schema>;

export function normalizeAssayReport(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const report = { ...(input as Record<string, unknown>) };
  if (report.schema_version === ASSAY_REPORT_SCHEMA_VERSION) {
    report.schema_version = LEMMA_REPORT_SCHEMA_VERSION;
  }
  return report;
}

export function parseReportV1(input: unknown): ReportV1 {
  return ReportV1Schema.parse(normalizeAssayReport(input));
}
