import { z } from "zod";
import { IsoTimestampSchema, JsonObjectSchema } from "./common.js";

export const METERING_SCHEMA_VERSION = "lemma.metering/v1" as const;

export const MeteringEventTypeSchema = z.enum([
  "run_started",
  "check_executed",
  "browser_minute_consumed",
  "evidence_byte_stored",
  "export_generated",
]);

export const MeteringEnvelopeSchema = z
  .object({
    schema_version: z.union([z.literal(METERING_SCHEMA_VERSION), z.literal("quality-harness.metering/v1")]),
    event_id: z.string().min(1),
    event_type: MeteringEventTypeSchema,
    idempotency_key: z.string().min(1),
    workspace: z.string().min(1),
    run: z.string().min(1),
    quantity: z.number().nonnegative(),
    unit: z.string().min(1),
    timestamp: IsoTimestampSchema,
    source: z.string().min(1),
    metadata: JsonObjectSchema.optional(),
  })
  .passthrough();

export const EventBase = MeteringEnvelopeSchema;

export const RunStartedEventSchema = EventBase.extend({
  event_type: z.literal("run_started"),
}).passthrough();
export const CheckExecutedEventSchema = EventBase.extend({
  event_type: z.literal("check_executed"),
}).passthrough();
export const BrowserMinuteConsumedEventSchema = EventBase.extend({
  event_type: z.literal("browser_minute_consumed"),
}).passthrough();
export const EvidenceByteStoredEventSchema = EventBase.extend({
  event_type: z.literal("evidence_byte_stored"),
}).passthrough();
export const ExportGeneratedEventSchema = EventBase.extend({
  event_type: z.literal("export_generated"),
}).passthrough();

export const MeteringEventSchema = z.discriminatedUnion("event_type", [
  RunStartedEventSchema,
  CheckExecutedEventSchema,
  BrowserMinuteConsumedEventSchema,
  EvidenceByteStoredEventSchema,
  ExportGeneratedEventSchema,
]);

export type MeteringEnvelope = z.infer<typeof MeteringEnvelopeSchema>;
export type MeteringEvent = z.infer<typeof MeteringEventSchema>;
