import { z } from "zod";
import { IsoTimestampSchema } from "./common.js";

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = "lemma.evidence-manifest/v1" as const;

export const EvidenceEntrySchema = z
  .object({
    path: z.string(),
    kind: z.string(),
    description: z.string().optional(),
    check_id: z.string().optional(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    content_type: z.string().optional(),
    created_at: IsoTimestampSchema.optional(),
  })
  .passthrough();

export const EvidenceManifestSchema = z
  .object({
    schema_version: z.union([
      z.literal(EVIDENCE_MANIFEST_SCHEMA_VERSION),
      z.literal("1.0"),
      z.string(),
    ]),
    run_id: z.string(),
    created_at: IsoTimestampSchema.optional(),
    finalized_at: IsoTimestampSchema.nullable().optional(),
    evidence: z.array(EvidenceEntrySchema),
    signature: z.string().optional(),
    signature_algorithm: z.string().optional(),
    signed_at: IsoTimestampSchema.optional(),
  })
  .passthrough();

export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;
