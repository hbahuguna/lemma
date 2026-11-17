import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildHtmlReport, summarizeReport } from "@lemma/core";

import { ProUnavailableError, computeHealthScore, rankFindings, validateHealthScore } from "../../src/index.js";

const licensed = { verification: true };

function sampleReport() {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run-1",
    status: "completed",
    findings: [
      { id: "f-high-e1", check_id: "auth.login", title: "Auth issue", severity: "high", evidence_level: "E1", confidence: 0.4, persona: "security", domain: "auth" },
      { id: "f-high-e3", check_id: "auth.session", title: "Session issue", severity: "high", evidence_level: "E3", confidence: 0.9, persona: "security", domain: "auth" },
      { id: "f-low", check_id: "ui.layout", title: "Layout nit", severity: "low", evidence_level: "E2", confidence: 0.7, persona: "ux", domain: "ui" },
      { id: "f-medium", check_id: "perf.load", title: "Slow load", severity: "medium", evidence_level: "E2", confidence: null, persona: "perf", domain: "performance" },
    ],
    checks: {
      items: [
        { id: "auth.login", status: "failed", domain: "auth", persona: "security" },
        { id: "ui.layout", status: "passed", domain: "ui", persona: "ux" },
        { id: "ops.health", status: "skipped", domain: "ops", persona: "ops" },
      ],
    },
    coverage: { executed_pct: 66 },
    decision: { decision: "hold" },
    confidence: { score: 55 },
  } as any;
}

function loadSchema() {
  return JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "../../schemas/pro/health_score.v1.json"), "utf8"));
}

describe("LEM-201 overall health score and severity-ranked issues", () => {
  it("license gate: unlicensed returns ProUnavailableError", () => {
    expect(() => computeHealthScore({ report: sampleReport(), license: null })).toThrow(ProUnavailableError);
  });

  it("computes explainable deterministic health score with breakdowns and schema-valid output", async () => {
    const report = sampleReport();
    const hs = computeHealthScore({ report, license: licensed });

    expect(hs.schema_version).toBe("lemma.pro.health_score/v1");
    expect(Number.isInteger(hs.score)).toBe(true);
    expect(hs.score).toBeGreaterThanOrEqual(0);
    expect(hs.score).toBeLessThanOrEqual(100);
    expect(hs.formula.id).toBe("lemma.pro.health.v1");
    expect(hs.formula.version).toBe("1");
    expect(typeof hs.formula.description).toBe("string");
    expect(hs.breakdown.dimensions).toBeTruthy();
    expect(hs.breakdown.check_families).toBeTruthy();
    expect(hs.breakdown.personas).toBeTruthy();
    // explainable buckets
    expect(hs.breakdown.dimensions.auth.findings).toBe(2);
    expect(hs.breakdown.check_families.auth.findings).toBe(2);
    expect(hs.breakdown.personas.security.findings).toBe(2);

    expect(validateHealthScore(hs)).toEqual([]);
    const schema = loadSchema();
    expect(hs.score).toBeGreaterThanOrEqual(schema.properties.score.minimum);
    expect(hs.score).toBeLessThanOrEqual(schema.properties.score.maximum);
    expect(hs.severity_ranked_findings.length).toBe(report.findings.length);

    const again = computeHealthScore({ report: JSON.parse(JSON.stringify(report)), license: licensed });
    expect(again.score).toBe(hs.score);
    expect(again.breakdown).toEqual(hs.breakdown);
    expect(again.severity_ranked_findings.map((f) => f.id)).toEqual(hs.severity_ranked_findings.map((f) => f.id));
    expect(again.report_fingerprint).toBe(hs.report_fingerprint);
  });

  it("ranks findings by documented severity + evidence level (LEM-188) + confidence", () => {
    const ranked = rankFindings(sampleReport().findings);
    // high severity first; within high, higher evidence level (E3) before E1; then others by severity
    expect(ranked.map((f) => f.id)).toEqual(["f-high-e3", "f-high-e1", "f-medium", "f-low"]);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.rank_key.evidence_level_rank).toBeGreaterThan(ranked[1]!.rank_key.evidence_level_rank);
    // medium has null confidence -> after low? low is lower severity than medium so medium comes before low regardless of confidence
    expect(ranked[2]!.severity).toBe("medium");
    expect(ranked[3]!.severity).toBe("low");
  });

  it("surfaces health score and severity-ranked view in dashboard summary and HTML report", async () => {
    const report = sampleReport();
    const health_score = computeHealthScore({ report, license: licensed });
    const enriched = { ...report, health_score };

    const summary = summarizeReport(enriched as any) as any;
    expect(summary.health_score).toBe(health_score.score);
    expect(Array.isArray(summary.severity_ranked_findings)).toBe(true);
    expect(summary.severity_ranked_findings[0].id).toBe("f-high-e3");

    const html = await buildHtmlReport(enriched);
    expect(html).toContain("Overall Health Score");
    expect(html).toContain(String(health_score.score));
    expect(html).toContain("Severity-ranked Issues");
    expect(html).toContain("f-high-e3");
    expect(html).toContain("per dimension");
    expect(html).toContain("per check family");
    expect(html).toContain("per persona");
    expect(html).toContain("lemma.pro.health.v1");
  });
});
