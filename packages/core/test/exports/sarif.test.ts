import { describe, expect, it } from "vitest";

import { buildSarif, SARIF_SCHEMA, SARIF_VERSION } from "../../src/exports.js";

const SECRET = "not-a-real-token-value";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  throw new Error("expected object");
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error("expected array");
}

function sampleReport(): JsonRecord {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run_123",
    findings: [
      {
        id: "finding_1",
        check_id: "static.secret_scan",
        title: "Potential secret in source",
        severity: "high",
        domain: "security",
        persona: "security",
        strength: "source_proven",
        consequence: "A credential could be exposed.",
        location: "src/app.ts:10",
        reproduction: "Open the file and inspect the assignment.",
        evidence: ["evidence/run_123/static-secret-scan.json"],
        remediation: "Rotate and remove the secret.",
        verification: "Rescan after removal.",
        tags: ["secrets", "source"],
        fingerprint: "fp-secret-1",
        suppressed: false,
        suppression_owner: "",
        suppression_reason: "",
        suppression_ticket: "",
        suppression_expires_at: "",
      },
      {
        id: "finding_2",
        check_id: "browser.content",
        title: "Content issue",
        severity: "medium",
        domain: "content",
        persona: "functional",
        strength: "observed",
        consequence: "Users may be confused.",
        location: "https://example.test/page",
        reproduction: "Visit the page.",
        evidence: [],
        remediation: "Fix the content.",
        verification: "Recheck the page.",
        tags: ["content"],
        fingerprint: "fp-content-1",
        suppressed: false,
        suppression_owner: "",
        suppression_reason: "",
        suppression_ticket: "",
        suppression_expires_at: "",
      },
    ],
    checks: [],
  };
}

describe("LEM-065 SARIF export", () => {
  it("builds SARIF 2.1.0 document with rules/results mapped from findings", () => {
    const report = sampleReport();
    const sarif = asRecord(buildSarif(report));

    expect(sarif.$schema).toBe(SARIF_SCHEMA);
    expect(sarif.version).toBe(SARIF_VERSION);
    const runs = asArray(sarif.runs);
    expect(runs).toHaveLength(1);

    const run = asRecord(runs[0]);
    const tool = asRecord(run.tool);
    const driver = asRecord(tool.driver);
    expect(driver.name).toBe("quality-harness");
    expect(typeof driver.informationUri).toBe("string");
    const rules = asArray(driver.rules);
    const results = asArray(run.results);
    expect(rules).toHaveLength(2);
    expect(results).toHaveLength(2);

    const rule = asRecord(rules[0]);
    expect(rule.id).toBe("quality-harness/static.secret_scan");
    expect(rule.name).toBe("static.secret_scan");
    expect(asRecord(rule.shortDescription).text).toBe("Potential secret in source");
    expect(asRecord(rule.fullDescription).text).toContain("credential could be exposed");
    expect(asRecord(rule.help).text).toContain("Rotate and remove");
    expect(asRecord(rule.defaultConfiguration).level).toBe("error");
    expect(asRecord(rule.properties)).toMatchObject({ severity: "high", domain: "security" });
    expect(asArray(asRecord(rule.properties).tags)).toEqual(["secrets", "source"]);

    const result = asRecord(results[0]);
    expect(result.ruleId).toBe("quality-harness/static.secret_scan");
    expect(result.level).toBe("error");
    expect(String(asRecord(result.message).text)).toContain("Potential secret in source");
    expect(String(asRecord(result.message).text)).toContain("Consequence:");
    expect(String(asRecord(result.message).text)).toContain("Remediation:");
    const locations = asArray(result.locations);
    const loc0 = asRecord(locations[0]);
    const physical = asRecord(loc0.physicalLocation);
    const artifact = asRecord(physical.artifactLocation);
    expect(artifact.uri).toBe("src/app.ts:10");
    expect(asRecord(result.properties)).toMatchObject({
      fingerprint: "fp-secret-1",
      persona: "security",
      strength: "source_proven",
      check_id: "static.secret_scan",
    });
    expect(asArray(result.relatedLocations)).toEqual([
      { id: 0, physicalLocation: { artifactLocation: { uri: "evidence/run_123/static-secret-scan.json" } } },
    ]);

    expect(asRecord(results[1]).level).toBe("warning");
    expect(asRecord(results[1]).ruleId).toBe("quality-harness/browser.content");
  });

  it("redacts secret values from exported SARIF output", () => {
    const report = sampleReport();
    const findings = asArray(report.findings) as JsonRecord[];
    const first = findings[0];
    if (!first) throw new Error("expected first finding");
    first.location = `token=${SECRET}`;
    first.consequence = `Authorization: Bearer ${SECRET}`;
    first.evidence = [`evidence/run?token=${SECRET}`];

    const sarif = buildSarif(report);
    const text = JSON.stringify(sarif);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED");
  });

  it("preserves non-finding report data semantics while producing stable finding mapping", () => {
    const report = sampleReport();
    const sarifA = buildSarif(report);
    const sarifB = buildSarif(report);
    expect(sarifA).toEqual(sarifB);
    const runs = asArray(asRecord(sarifA).runs);
    const run = asRecord(runs[0]);
    const results = asArray(run.results).map((r) => asRecord(r).ruleId);
    expect(results).toEqual([
      "quality-harness/static.secret_scan",
      "quality-harness/browser.content",
    ]);
  });
});
