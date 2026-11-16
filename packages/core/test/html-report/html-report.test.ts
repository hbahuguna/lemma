import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceStore,
  HTML_REPORT_EMBED_MAX_BYTES,
  buildHtmlReport,
  writeHtmlReport,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function sampleReport(evidenceRef?: string) {
  return {
    schema_version: "quality-harness.report/v1",
    generated_at: "2026-11-16T00:00:00Z",
    run_id: "run_test_001",
    determinism: { seed: 1, clock_mode: "frozen", entropy: "seeded" },
    status: "completed",
    workflow: { id: "release-confidence", name: "Release Confidence", version: "1.0", phases: ["risk", "plan", "execute", "evidence", "confidence"] },
    target: { raw: ".", kind: "directory", resolved: ".", source: "" },
    intent: "test intent",
    policy: { id: "advisory-v1", version: "1.0", result: "pass" },
    metering: { schema_version: "quality-harness.metering/v1", sink: ".lemma/metering/events.jsonl", workspace: "local", event_count: 1, event_types: {}, run_event_count: 1, run_event_types: {} },
    decision: { decision: "review", rationale: "Review before shipping." },
    trend: { baseline: true, previous_run_id: null, new: ["f1"], resolved: [], persistent: [], score_delta: 0, coverage_delta: 0 },
    confidence: {
      score: 72,
      band: "medium",
      coverage: 0.8,
      rationale: "Moderate confidence.",
      limitations: ["Limited scope"],
      penalties: { critical: 0 },
      domain_scores: { functional: 70 },
      breakdown: { base: 80 },
      gate: { status: "warn" },
    },
    findings: [
      {
        id: "finding_1",
        title: "Missing alt text",
        severity: "high",
        domain: "accessibility",
        persona: "accessibility",
        strength: "observed",
        consequence: "Screen reader issue.",
        location: "index.html",
        reproduction: "Open page",
        evidence: evidenceRef ? [evidenceRef] : [],
        remediation: "Add alt",
        verification: "Re-run",
        check_id: "a11y.img_alt",
        created_at: "2026-11-16T00:00:00Z",
      },
    ],
    finding_counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    invalid_findings: [{ id: "invalid_1", check_id: "x", persona: "functional", reason: "schema invalid", recorded_at: "2026-11-16T00:00:00Z" }],
    blockers: [{ id: "blocker_1", persona: "functional", check_id: "browser.load", attempted_action: "load page", boundary: "browser unavailable", unblock_evidence: ["provide browser"], covered_elsewhere: false, recorded_at: "2026-11-16T00:00:00Z" }],
    contract_failures: { total: 1, by_persona: { functional: 1 }, degraded_personas: [] },
    checks: [
      { id: "a11y.img_alt", title: "Images have alt", domain: "accessibility", persona: "accessibility", kind: "static", intent: "check", expected: "alt", status: "failed", weight: 1, actual: "missing", evidence: evidenceRef ? [evidenceRef] : [], finding_ids: ["finding_1"], skip_reason: "", metadata: {} },
    ],
    coverage: { total_checks: 1, executed: 1, passed: 0, failed: 1, blocked: 0, skipped: 0, error: 0, planned_not_run: 0, blockers: 1, blockers_covered_elsewhere: 0, blockers_uncovered: 1, blockers_by_persona: { functional: 1 }, executed_pct: 100, by_domain: {} },
    risks: [],
    personas: [],
    inventory: {},
    phases: [],
    kill_switch: { halted: false },
    halted_reason: null,
    limitations: ["Limited scope"],
    evidence: { directory: ".lemma/evidence/run_test_001", summary: { count: evidenceRef ? 1 : 0, total_bytes: 10 } },
    started_at: "2026-11-16T00:00:00Z",
    completed_at: "2026-11-16T00:00:01Z",
    options: {},
    error: "",
  };
}

describe("LEM-142 HTML report", () => {
  it("renders all required sections with same core data as JSON report", async () => {
    const report = sampleReport();
    const html = await buildHtmlReport(report);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain("Summary &amp; Decision");
    expect(html).toContain("Findings");
    expect(html).toContain("Blockers");
    expect(html).toContain("Invalid / Quarantined Findings");
    expect(html).toContain("Contract Health");
    expect(html).toContain("Confidence / Coverage Details");
    expect(html).toContain("Policy");
    expect(html).toContain("Trend");
    expect(html).toContain("Evidence");
    expect(html).toContain("Limitations");
    expect(html).toContain("run_test_001");
    expect(html).toContain("finding_1");
    expect(html).toContain("a11y.img_alt");
    expect(html).toContain("blocker_1");
    expect(html).toContain("invalid_1");
    expect(html).toContain("review");
    expect(html).toContain("72");
  });

  it("is deterministic for same report and evidence (fixed volatile fields)", async () => {
    const root = await mkdtemp("lemma-html-det-");
    tempDirs.push(root);
    const store = new EvidenceStore(root, "run_test_001");
    await store.init();
    const rel = await store.saveText("note", "evidence text", "text", "note", "a11y.img_alt");
    await store.finalize({ run_id: "run_test_001", status: "completed" });
    const report = sampleReport(rel);

    const a = await buildHtmlReport(report, store);
    const b = await buildHtmlReport(report, store);
    expect(a).toBe(b);
  });

  it("redacts secrets before embedding and does not leak secret values", async () => {
    const root = await mkdtemp("lemma-html-redact-");
    tempDirs.push(root);
    const store = new EvidenceStore(root, "run_test_001");
    await store.init();
    const secret = "Bearer supersecret123";
    const rel = await store.saveText("secret-artifact", `token context ${secret}`, "text", "secret", "check");
    await store.finalize({ run_id: "run_test_001", status: "completed" });
    const report = sampleReport(rel);
    report.findings[0].title = `Issue with ${secret}`;

    const html = await buildHtmlReport(report, store);
    expect(html).not.toContain("supersecret123");
    expect(html).toContain("[REDACTED]");
  });

  it("embeds small evidence as data URIs and escapes/links large evidence (size ceiling behavior)", async () => {
    const root = await mkdtemp("lemma-html-evidence-");
    tempDirs.push(root);
    const store = new EvidenceStore(root, "run_test_001");
    await store.init();
    const smallRel = await store.saveText("small", "small", "text", "small", "a11y.img_alt");
    const largeContent = "x".repeat(HTML_REPORT_EMBED_MAX_BYTES + 1024);
    const largeRel = await store.saveText("large", largeContent, "text", "large", "a11y.img_alt");
    await store.finalize({ run_id: "run_test_001", status: "completed" });
    const report = sampleReport(smallRel);
    report.findings[0].evidence = [smallRel, largeRel];
    report.checks[0].evidence = [smallRel, largeRel];

    const html = await buildHtmlReport(report, store);
    expect(html).toContain("data:");
    expect(html).toContain("too large");
    expect(html).toContain(largeRel);
    // relative link for large file (escaped path text)
    expect(html).toContain(`href="${largeRel}"`);
  });

  it("refuses to include absolute paths and refuses unsafe evidence refs", async () => {
    const report = sampleReport("/tmp/absolute-evidence.txt");
    await expect(buildHtmlReport(report)).rejects.toThrow(/absolute path/i);

    const report2 = sampleReport();
    report2.evidence.directory = "/Users/someone/.lemma/evidence/run_test_001";
    await expect(buildHtmlReport(report2)).rejects.toThrow(/absolute path/i);
  });

  it("writes HTML via atomic write to specified path without accidental writes elsewhere", async () => {
    const root = await mkdtemp("lemma-html-write-");
    tempDirs.push(root);
    const outPath = path.join(root, "out", "lemma-report.html");
    const report = sampleReport();
    const written = await writeHtmlReport(report, outPath);
    expect(written).toBe(outPath);
    const content = await fs.readFile(outPath, "utf8");
    expect(content).toContain("lemma.report.html/v1");
    // no other files written in root except out/
    const rootEntries = await fs.readdir(root);
    expect(rootEntries).toEqual(["out"]);
  });
});
