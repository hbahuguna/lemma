export * from "./common.js";
export * from "./report.js";
export * from "./state.js";
export * from "./evidence.js";
export * from "./persona.js";
export * from "./plugin.js";
export * from "./policy.js";
export * from "./metering.js";
export * from "./cloud.js";

import { zodToJsonSchema } from "zod-to-json-schema";
import { ReportV1Schema } from "./report.js";
import { RunStateSchema, HistorySchema, ProgressSchema } from "./state.js";
import { EvidenceManifestSchema } from "./evidence.js";
import { PersonaContractSchema, PersonaOutputSchema } from "./persona.js";
import { PluginDefinitionSchema } from "./plugin.js";
import { PolicySchema } from "./policy.js";
import {
  MeteringEnvelopeSchema,
  RunStartedEventSchema,
  CheckExecutedEventSchema,
  BrowserMinuteConsumedEventSchema,
  EvidenceByteStoredEventSchema,
  ExportGeneratedEventSchema,
} from "./metering.js";
import {
  QuotaPlanSchema,
  PriceBookSchema,
  EntitlementSchema,
  QueueJobSchema,
  BillingRecordSchema,
  RetentionPolicySchema,
} from "./cloud.js";

export function buildJsonSchemas(): Record<string, unknown> {
  const defs = (name: string, schema: Parameters<typeof zodToJsonSchema>[0]) =>
    zodToJsonSchema(schema, name);
  return {
    "schemas/release_brief/release_brief.v1.schema.json": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://lemma.dev/schemas/release_brief/release_brief.v1.schema.json",
      "title": "Lemma Release Brief v1",
      "description": "Deterministic stakeholder-facing release brief derived from a lemma report.",
      "type": "object",
      "additionalProperties": false,
      "required": [
            "schema_version",
            "run_id",
            "decision",
            "confidence",
            "coverage",
            "top_findings",
            "blockers",
            "coverage_gaps",
            "next_steps",
            "markdown",
            "html"
      ],
      "properties": {
            "schema_version": {
                  "const": "lemma.release_brief/v1"
            },
            "run_id": {
                  "type": [
                        "string",
                        "null"
                  ]
            },
            "decision": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                        "decision",
                        "rationale",
                        "context"
                  ],
                  "properties": {
                        "decision": {
                              "type": "string",
                              "enum": [
                                    "ship",
                                    "review",
                                    "hold",
                                    "unknown"
                              ]
                        },
                        "rationale": {
                              "type": "string"
                        },
                        "context": {
                              "type": "string"
                        }
                  }
            },
            "confidence": {
                  "type": "object",
                  "additionalProperties": true
            },
            "coverage": {
                  "type": "object",
                  "additionalProperties": true
            },
            "top_findings": {
                  "type": "array",
                  "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                              "id",
                              "title",
                              "severity",
                              "check_id"
                        ],
                        "properties": {
                              "id": {
                                    "type": "string"
                              },
                              "title": {
                                    "type": "string"
                              },
                              "severity": {
                                    "type": "string"
                              },
                              "check_id": {
                                    "type": "string"
                              }
                        }
                  }
            },
            "blockers": {
                  "type": "array",
                  "items": {
                        "type": "object",
                        "additionalProperties": true
                  }
            },
            "coverage_gaps": {
                  "type": "array",
                  "items": {
                        "type": "string"
                  }
            },
            "next_steps": {
                  "type": "array",
                  "items": {
                        "type": "string"
                  }
            },
            "markdown": {
                  "type": "string"
            },
            "html": {
                  "type": "string"
            }
      }
},
    "schemas/agent/manager-message.v1.json": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "$id": "https://lemma.dev/schemas/agent/manager-message.v1.json",
          "title": "Manager message v1",
          "description": "Host-neutral conversational manager message emitted during a lemma assessment session.",
          "type": "object",
          "additionalProperties": false,
          "required": [
                "type",
                "text",
                "generated_at"
          ],
          "properties": {
                "type": {
                      "type": "string",
                      "enum": [
                            "plan",
                            "question",
                            "progress",
                            "summary"
                      ]
                },
                "text": {
                      "type": "string",
                      "description": "Redacted, human-readable message content."
                },
                "generated_at": {
                      "type": "string",
                      "description": "ISO-8601 timestamp (documented volatile field; may differ across runs)."
                },
                "step": {
                      "type": "integer",
                      "minimum": 0
                },
                "run_ids": {
                      "type": "array",
                      "items": {
                            "type": "string"
                      }
                },
                "details": {
                      "type": "object",
                      "description": "Structured, redacted details for the message type.",
                      "additionalProperties": true
                }
          }
    },
    "schemas/report/index.json": {
      schema_version: "lemma.report.schemas/v1",
      report: "report.v1.schema.json",
    },
    "schemas/report/report.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/report/report.v1.schema.json",
      title: "Lemma report v1",
      description: "Machine-readable report emitted by lemma run.",
      ...defs("ReportV1", ReportV1Schema),
    },
    "schemas/state/progress.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/state/progress.v1.schema.json",
      title: "Lemma progress/state v1",
      ...defs("Progress", ProgressSchema),
    },
    "schemas/state/history.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/state/history.v1.schema.json",
      title: "Lemma history v1",
      ...defs("History", HistorySchema),
    },
    "schemas/state/run-state.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/state/run-state.v1.schema.json",
      title: "Lemma run state v1",
      ...defs("RunState", RunStateSchema),
    },
    "schemas/evidence/manifest.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/evidence/manifest.v1.schema.json",
      title: "Lemma evidence manifest v1",
      ...defs("EvidenceManifest", EvidenceManifestSchema),
    },
    "schemas/persona/contract.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/persona/contract.v1.schema.json",
      title: "Lemma persona contract v1",
      ...defs("PersonaContract", PersonaContractSchema),
    },
    "schemas/persona/output.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/persona/output.v1.schema.json",
      title: "Lemma persona output v1",
      ...defs("PersonaOutput", PersonaOutputSchema),
    },
    "schemas/plugin/definition.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/plugin/definition.v1.schema.json",
      title: "Lemma plugin definition v1",
      ...defs("PluginDefinition", PluginDefinitionSchema),
    },
    "schemas/policy/policy.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/policy/policy.v1.schema.json",
      title: "Lemma policy v1",
      ...defs("Policy", PolicySchema),
    },
    "schemas/metering/index.json": {
      schema_version: "lemma.metering.schemas/v1",
      envelope: "envelope.v1.schema.json",
      events: {
        run_started: "run_started.v1.schema.json",
        check_executed: "check_executed.v1.schema.json",
        browser_minute_consumed: "browser_minute_consumed.v1.schema.json",
        evidence_byte_stored: "evidence_byte_stored.v1.schema.json",
        export_generated: "export_generated.v1.schema.json",
      },
    },
    "schemas/metering/envelope.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/metering/envelope.v1.schema.json",
      title: "Lemma usage event envelope v1",
      ...defs("MeteringEnvelope", MeteringEnvelopeSchema),
    },
    "schemas/metering/run_started.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/metering/run_started.v1.schema.json",
      title: "Lemma metering event run_started v1",
      ...defs("RunStartedEvent", RunStartedEventSchema),
    },
    "schemas/metering/check_executed.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/metering/check_executed.v1.schema.json",
      title: "Lemma metering event check_executed v1",
      ...defs("CheckExecutedEvent", CheckExecutedEventSchema),
    },
    "schemas/metering/browser_minute_consumed.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/metering/browser_minute_consumed.v1.schema.json",
      title: "Lemma metering event browser_minute_consumed v1",
      ...defs("BrowserMinuteConsumedEvent", BrowserMinuteConsumedEventSchema),
    },
    "schemas/metering/evidence_byte_stored.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/metering/evidence_byte_stored.v1.schema.json",
      title: "Lemma metering event evidence_byte_stored v1",
      ...defs("EvidenceByteStoredEvent", EvidenceByteStoredEventSchema),
    },
    "schemas/metering/export_generated.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/metering/export_generated.v1.schema.json",
      title: "Lemma metering event export_generated v1",
      ...defs("ExportGeneratedEvent", ExportGeneratedEventSchema),
    },
    "schemas/cloud/quota-plan.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/cloud/quota-plan.v1.schema.json",
      title: "Lemma quota plan v1",
      ...defs("QuotaPlan", QuotaPlanSchema),
    },
    "schemas/cloud/price-book.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/cloud/price-book.v1.schema.json",
      title: "Lemma price book v1",
      ...defs("PriceBook", PriceBookSchema),
    },
    "schemas/cloud/entitlement.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/cloud/entitlement.v1.schema.json",
      title: "Lemma entitlement v1",
      ...defs("Entitlement", EntitlementSchema),
    },
    "schemas/cloud/queue-job.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/cloud/queue-job.v1.schema.json",
      title: "Lemma queue job v1",
      ...defs("QueueJob", QueueJobSchema),
    },
    "schemas/cloud/billing-record.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/cloud/billing-record.v1.schema.json",
      title: "Lemma billing record v1",
      ...defs("BillingRecord", BillingRecordSchema),
    },
    "schemas/cloud/retention-policy.v1.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://lemma.dev/schemas/cloud/retention-policy.v1.schema.json",
      title: "Lemma retention policy v1",
      ...defs("RetentionPolicy", RetentionPolicySchema),
    },
  };
}
