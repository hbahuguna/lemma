import { z } from "zod";
import { IsoTimestampSchema, JsonObjectSchema } from "./common.js";

export const PROGRESS_SCHEMA_VERSION = "lemma.progress/v1" as const;
export const HISTORY_SCHEMA_VERSION = "lemma.history/v1" as const;

export const CheckStateSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    evidence: z.array(z.string()).optional(),
  })
  .passthrough();

export const PhaseStateSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    status: z.string(),
    checks: z.array(CheckStateSchema).optional(),
  })
  .passthrough();

export const RunStateSchema = z
  .object({
    schema_version: z.string().optional(),
    run_id: z.string(),
    status: z.string(),
    target: JsonObjectSchema.optional(),
    phases: z.array(PhaseStateSchema).optional(),
    started_at: IsoTimestampSchema.optional(),
    completed_at: IsoTimestampSchema.nullable().optional(),
    updated_at: IsoTimestampSchema.optional(),
    workflow_id: z.string().optional(),
    workflow_version: z.string().optional(),
    evidence_dir: z.string().optional(),
    findings: z.array(z.unknown()).optional(),
    confidence: z.unknown().optional(),
  })
  .passthrough();

export const HistoryEntrySchema = z
  .object({
    run_id: z.string(),
    status: z.string(),
    decision: z.string().optional(),
    score: z.number().optional(),
    started_at: IsoTimestampSchema.nullable().optional(),
    completed_at: IsoTimestampSchema.nullable().optional(),
    recorded_at: IsoTimestampSchema.optional(),
  })
  .passthrough();

export const HistorySchema = z
  .object({
    schema_version: z.union([z.literal(HISTORY_SCHEMA_VERSION), z.literal("quality-harness.history/v1")]).optional(),
    runs: z.array(HistoryEntrySchema),
  })
  .passthrough();

export const ProgressSchema = z
  .object({
    schema_version: z.literal(PROGRESS_SCHEMA_VERSION).optional(),
    state: RunStateSchema.optional(),
  })
  .passthrough();

export type RunState = z.infer<typeof RunStateSchema>;
export type History = z.infer<typeof HistorySchema>;
export type Progress = z.infer<typeof ProgressSchema>;
