import { z } from "zod";

export const PERSONA_CONTRACT_SCHEMA_VERSION = "lemma.persona-contract/v1" as const;

export const PersonaFindingSchema = z.object({}).passthrough();
export const PersonaBlockerSchema = z.object({}).passthrough();

export const PersonaContractSchema = z
  .object({
    schema_version: z.literal(PERSONA_CONTRACT_SCHEMA_VERSION).optional(),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    owns: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    refusal: z.string().optional(),
    required_sections: z.array(z.string()).optional(),
  })
  .passthrough();

export const PersonaOutputSchema = z
  .object({
    findings: z.array(PersonaFindingSchema).default([]),
    blockers: z.array(PersonaBlockerSchema).default([]),
  })
  .passthrough();

export type PersonaContract = z.infer<typeof PersonaContractSchema>;
export type PersonaOutput = z.infer<typeof PersonaOutputSchema>;
