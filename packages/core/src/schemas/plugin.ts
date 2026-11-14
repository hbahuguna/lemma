import { z } from "zod";

export const PLUGIN_DEFINITION_SCHEMA_VERSION = "lemma.check-plugin/v1" as const;

export const PluginDefinitionSchema = z
  .object({
    schema_version: z.union([
      z.literal(PLUGIN_DEFINITION_SCHEMA_VERSION),
      z.literal("quality-harness.check-plugin/v1"),
      z.string(),
    ]),
    id: z.string().min(1),
    name: z.string().optional(),
    version: z.string().optional(),
    kind: z.string().optional(),
    description: z.string().optional(),
    signature: z.string().optional(),
  })
  .passthrough();

export type PluginDefinition = z.infer<typeof PluginDefinitionSchema>;
