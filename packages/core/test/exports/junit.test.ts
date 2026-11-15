import { describe, expect, it } from "vitest";

import { buildJunit } from "../../src/exports.js";

const SECRET = "not-a-real-token-value";

function sampleReport(): Record<string, unknown> {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run_123",
    findings: [],
    checks: [
      { id: "check.passed", domain: "functional", status: "passed", actual: "ok" },
      { id: "check.failed", domain: "security", status: "failed", actual: "Found issue" },
      { id: "check.error", domain: "reliability", status: "error", actual: "Execution error" },
      { id: "check.blocked", domain: "functional", status: "blocked", actual: "Browser unavailable" },
      { id: "check.skipped", domain: "content", status: "skipped", actual: "Not applicable" },
      { id: "check.planned", domain: "functional", status: "planned", actual: "" },
    ],
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("LEM-066 JUnit export", () => {
  it("builds JUnit XML with testsuite counts and one testcase per check with status mapping", () => {
    const xml = buildJunit(sampleReport());

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuite name="quality-harness" tests="6" failures="1" errors="2" skipped="2" time="0">');
    expect(xml).toContain('</testsuite>');

    // one testcase per check with identity/status metadata
    expect(countOccurrences(xml, "<testcase ")).toBe(6);
    expect(xml).toContain('<testcase name="check.passed" classname="functional" time="0" status="passed">');
    expect(xml).toContain('<testcase name="check.failed" classname="security" time="0" status="failed">');
    expect(xml).toContain('<testcase name="check.error" classname="reliability" time="0" status="error">');
    expect(xml).toContain('<testcase name="check.blocked" classname="functional" time="0" status="blocked">');
    expect(xml).toContain('<testcase name="check.skipped" classname="content" time="0" status="skipped">');
    expect(xml).toContain('<testcase name="check.planned" classname="functional" time="0" status="planned">');

    // status element mapping
    expect(xml).toContain('<failure message="Found issue">Found issue</failure>');
    expect(xml).toContain('<error message="Execution error">Execution error</error>');
    expect(xml).toContain('<skipped message="blocked: Browser unavailable">blocked: Browser unavailable</skipped>');
    expect(xml).toContain('<skipped message="Not applicable">Not applicable</skipped>');

    // passed/planned should not emit failure/error/skipped children (spot check by absence around those cases)
    const passedBlock = xml.split('<testcase name="check.passed"')[1]?.split("</testcase>")[0] ?? "";
    expect(passedBlock).not.toContain("<failure");
    expect(passedBlock).not.toContain("<error");
    expect(passedBlock).not.toContain("<skipped");
    const plannedBlock = xml.split('<testcase name="check.planned"')[1]?.split("</testcase>")[0] ?? "";
    expect(plannedBlock).not.toContain("<failure");
    expect(plannedBlock).not.toContain("<error");
    expect(plannedBlock).not.toContain("<skipped");
  });

  it("redacts secret values from exported JUnit output", () => {
    const report = sampleReport();
    const checks = report.checks as Array<Record<string, unknown>>;
    const failed = checks[1];
    const blocked = checks[3];
    if (!failed || !blocked) throw new Error("expected sample checks");
    failed.actual = `authorization: ${SECRET}`;
    blocked.actual = `token=${SECRET}`;

    const xml = buildJunit(report);
    expect(xml).not.toContain(SECRET);
    expect(xml).toContain("[REDACTED");
  });
});
