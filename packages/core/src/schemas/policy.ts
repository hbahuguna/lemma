import { z } from "zod";

export const POLICY_SCHEMA_VERSION = "lemma.policy/v1" as const;

export const PolicySchema = z
  .object({
    schema_version: z.union([
      z.literal(POLICY_SCHEMA_VERSION),
      z.literal("quality-harness.policy/v1"),
    ]),
    id: z.string().optional(),
    version: z.string().optional(),
    gates: z.record(z.unknown()).optional(),
    weights: z.record(z.number()).optional(),
  })
  .passthrough();

export type Policy = z.infer<typeof PolicySchema>;
