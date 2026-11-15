import { describe, expect, it } from "vitest";

import {
  canonicalReportBytes,
  canonicalReportString,
  signReport,
  verifyReportSignature,
} from "../../src/exports.js";

function sampleReport(): Record<string, unknown> {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run_123",
    status: "completed",
    confidence: { score: 82.5, band: "medium" },
    findings: [{ id: "f1", check_id: "static.secret_scan", title: "x", severity: "high" }],
    checks: [{ id: "c1", status: "passed", actual: "ok" }],
  };
}

describe("LEM-067 report signing and verification", () => {
  it("produces deterministic canonical serialization and valid HMAC-SHA256 signature", () => {
    const a = { b: 1, a: { y: 2, x: 1 } } as Record<string, unknown>;
    const b = { a: { x: 1, y: 2 }, b: 1 } as Record<string, unknown>;
    expect(canonicalReportString(a)).toBe(canonicalReportString(b));
    expect(Buffer.from(canonicalReportBytes(a)).toString("utf8")).toBe(canonicalReportString(b));

    const report = sampleReport();
    const sig1 = signReport(report, "test-key");
    const sig2 = signReport(report, "test-key");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyReportSignature(report, sig1, "test-key")).toBe(true);
    expect(verifyReportSignature(report, sig1, new TextEncoder().encode("test-key"))).toBe(true);
  });

  it("fails verification for wrong signature or wrong key", () => {
    const report = sampleReport();
    const sig = signReport(report, "test-key");
    expect(verifyReportSignature(report, "bad-signature", "test-key")).toBe(false);
    expect(verifyReportSignature(report, "00".repeat(32), "test-key")).toBe(false);
    expect(verifyReportSignature(report, sig, "other-key")).toBe(false);
  });

  it("fails verification after report tampering", () => {
    const report = sampleReport();
    const sig = signReport(report, "test-key");
    const tampered = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    (tampered.confidence as Record<string, unknown>).score = 999.0;
    expect(verifyReportSignature(tampered, sig, "test-key")).toBe(false);
  });
});
