import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BillingRecordSchema,
  EntitlementSchema,
  EvidenceManifestSchema,
  ExportGeneratedEventSchema,
  HistorySchema,
  MeteringEnvelopeSchema,
  PersonaContractSchema,
  PluginDefinitionSchema,
  PolicySchema,
  PriceBookSchema,
  ProgressSchema,
  QueueJobSchema,
  QuotaPlanSchema,
  ReportV1Schema,
  RetentionPolicySchema,
  RunStateSchema,
  buildJsonSchemas,
  parseReportV1,
} from "../../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
}

function listFiles(dir: string): string[] {
  const abs = join(repoRoot, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const full = join(abs, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(join(dir, name)));
    else out.push(join(dir, name).replaceAll("\\", "/"));
  }
  return out.sort();
}

function makeAssayReport(status: "completed" | "halted" | "failed") {
  const base = {
    schema_version: "quality-harness.report/v1",
    generated_at: "2026-11-14T10:00:00Z",
    run_id: "run-123",
    determinism: { seed: 42, clock_mode: "frozen", entropy: "seeded" },
    status,
    workflow: { id: "default", name: "Default", version: "1", phases: ["risk", "plan", "execute", "evidence", "score"] },
    target: { kind: "path", raw: ".", resolved: "/tmp/repo", source: "cli" },
    intent: "default",
    policy: { id: "advisory-v1", version: "1" },
    metering: { schema_version: "quality-harness.metering/v1", sink: "local", workspace: "local", event_count: 0, event_types: {} },
    decision: { decision: status === "completed" ? "pass" : "hold", rationale: "test" },
    trend: { baseline: true, previous_run_id: null, new: [], resolved: [], persistent: [], score_delta: 0, coverage_delta: 0 },
    confidence: {
      score: status === "completed" ? 95 : 0,
      band: status === "completed" ? "high" : "low",
      coverage: { executed_pct: 100, by_domain: {} },
      rationale: "ok",
      limitations: [],
      penalties: [],
      domain_scores: {},
      breakdown: [],
      gate: {},
    },
    findings: [],
    finding_counts: { low: 0, medium: 0, high: 0, critical: 0 },
    invalid_findings: [],
    blockers: [],
    contract_failures: [],
    checks: [],
    coverage: { executed_pct: 100, by_domain: {} },
    risks: [],
    personas: [],
    inventory: {},
    phases: [],
    kill_switch: { armed: status === "halted", triggered: status === "halted", threshold: "high", reason: "", finding_id: "", manual: false, triggered_at: status === "halted" ? "2026-11-14T10:00:00Z" : null },
    halted_reason: status === "halted" ? "kill_switch" : null,
    limitations: [],
    evidence: { directory: ".harness/evidence/run-123", summary: {} },
    started_at: "2026-11-14T09:59:00Z",
    completed_at: "2026-11-14T10:00:00Z",
    options: {},
    error: status === "failed" ? "boom" : "",
  };
  return base;
}

describe("LEM-004 schemas and contracts", () => {
  it("defines zod schemas for all required contracts", () => {
    const schemas = [
      ReportV1Schema,
      RunStateSchema,
      ProgressSchema,
      HistorySchema,
      EvidenceManifestSchema,
      PersonaContractSchema,
      PluginDefinitionSchema,
      PolicySchema,
      MeteringEnvelopeSchema,
      QuotaPlanSchema,
      PriceBookSchema,
      EntitlementSchema,
      QueueJobSchema,
      BillingRecordSchema,
      RetentionPolicySchema,
      ExportGeneratedEventSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.safeParse).toBe("function");
    }
  });

  it("accepts completed, halted, and failed assay reports after volatile normalization", () => {
    for (const status of ["completed", "halted", "failed"] as const) {
      const assay = makeAssayReport(status);
      const normalized = parseReportV1(assay);
      expect(normalized.schema_version).toBe("lemma.report/v1");
      expect(normalized.status).toBe(status);
      expect(ReportV1Schema.safeParse({ ...assay, schema_version: "quality-harness.report/v1" }).success).toBe(true);
    }
  });

  it("generates JSON Schemas into schemas/ and matches committed files", () => {
    const generated = buildJsonSchemas();
    const files = Object.keys(generated).sort();
    expect(files.length).toBeGreaterThan(0);

    const committed = listFiles("schemas").sort();
    expect(committed).toEqual(files);

    for (const rel of files) {
      const committedJson = readJson(rel);
      expect(committedJson).toEqual(generated[rel]);
    }
  });

  it("rejects removed or typed-wrong fields and allows additive optional fields", () => {
    const good = makeAssayReport("completed");
    const badType = { ...good, run_id: 123 };
    expect(ReportV1Schema.safeParse(badType).success).toBe(false);

    const missingRequired = { ...good } as Record<string, unknown>;
    delete missingRequired.run_id;
    expect(ReportV1Schema.safeParse(missingRequired).success).toBe(false);

    const additive = { ...good, new_optional_field: { hello: "world" }, futureFlag: true };
    expect(ReportV1Schema.safeParse(additive).success).toBe(true);

    const evidenceMissing = { ...good, evidence: { directory: ".harness/evidence/run-123" } };
    expect(ReportV1Schema.safeParse(evidenceMissing).success).toBe(false);

    const entitlementGood = { schema_version: "lemma.entitlement/v1", workspace_id: "w1", extra: "ok" };
    expect(EntitlementSchema.safeParse(entitlementGood).success).toBe(true);
    expect(EntitlementSchema.safeParse({ schema_version: "lemma.entitlement/v1", workspace_id: 1 }).success).toBe(false);
  });

  it("infers public types from schemas", () => {
    // compile-time/type-level check via usage
    const parsed = parseReportV1(makeAssayReport("completed"));
    const runId: string = parsed.run_id;
    expect(runId).toBe("run-123");
    // no hand-written duplicate interface exports required; schema inference drives types
    expect(typeof parsed).toBe("object");
  });
});
