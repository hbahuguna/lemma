import { z } from "zod";
import { IsoTimestampSchema, JsonObjectSchema } from "./common.js";

// ---- quota ----
export const QUOTA_PLAN_SCHEMA_VERSION = "lemma.quota-plan/v1" as const;
export const QuotaLimitSchema = z
  .object({
    soft: z.number().nullable().optional(),
    hard: z.number().nullable().optional(),
  })
  .passthrough();
export const QuotaPlanSchema = z
  .object({
    schema_version: z.union([z.literal(QUOTA_PLAN_SCHEMA_VERSION), z.literal("quality-harness.quota-plan/v1")]).optional(),
    id: z.string().optional(),
    version: z.string().optional(),
    period: z.literal("monthly").optional(),
    limits: z.record(QuotaLimitSchema).optional(),
  })
  .passthrough();
export type QuotaPlan = z.infer<typeof QuotaPlanSchema>;

// ---- price book ----
export const PRICE_BOOK_SCHEMA_VERSION = "lemma.price-book/v1" as const;
export const PriceBookSchema = z
  .object({
    schema_version: z.union([z.literal(PRICE_BOOK_SCHEMA_VERSION), z.literal("quality-harness.price-book/v1")]).optional(),
    version: z.string().optional(),
    currency: z.string().optional(),
  })
  .catchall(z.unknown());
export type PriceBook = z.infer<typeof PriceBookSchema>;

// ---- entitlement ----
export const ENTITLEMENT_SCHEMA_VERSION = "lemma.entitlement/v1" as const;
export const EntitlementSchema = z
  .object({
    schema_version: z.union([z.literal(ENTITLEMENT_SCHEMA_VERSION), z.literal("quality-harness.entitlement/v1")]),
    workspace_id: z.string().optional(),
    plan: JsonObjectSchema.optional(),
    issued_at: IsoTimestampSchema.optional(),
    expires_at: IsoTimestampSchema.nullable().optional(),
  })
  .passthrough();
export type Entitlement = z.infer<typeof EntitlementSchema>;

// ---- queue job ----
export const QUEUE_JOB_SCHEMA_VERSION = "lemma.queue-job/v1" as const;
export const QueueJobSchema = z
  .object({
    schema_version: z.union([z.literal(QUEUE_JOB_SCHEMA_VERSION), z.literal("quality-harness.queue/v1"), z.string()]).optional(),
    job_id: z.string().optional(),
    id: z.string().optional(),
    workspace_id: z.string().optional(),
    status: z.string().optional(),
    run_id: z.string().optional(),
    created_at: IsoTimestampSchema.optional(),
    updated_at: IsoTimestampSchema.optional(),
  })
  .passthrough();
export type QueueJob = z.infer<typeof QueueJobSchema>;

// ---- billing record ----
export const BILLING_RECORD_SCHEMA_VERSION = "lemma.billing/v1" as const;
export const BillingRecordSchema = z
  .object({
    schema_version: z.union([z.literal(BILLING_RECORD_SCHEMA_VERSION), z.literal("quality-harness.billing/v1"), z.string()]),
    workspace_id: z.string().optional(),
    period: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type BillingRecord = z.infer<typeof BillingRecordSchema>;

// ---- retention policy ----
export const RETENTION_POLICY_SCHEMA_VERSION = "lemma.retention/v1" as const;
export const RetentionPolicySchema = z
  .object({
    schema_version: z.union([z.literal(RETENTION_POLICY_SCHEMA_VERSION), z.literal("quality-harness.retention/v1")]),
    workspace_id: z.string().optional(),
    retention_days: z.number().int().positive().optional(),
    grace_period_days: z.number().int().nonnegative().optional(),
    plan_id: z.string().nullable().optional(),
    default: z.boolean().optional(),
  })
  .passthrough();
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;
