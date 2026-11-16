import http from "node:http";

import { describe, expect, it } from "vitest";

import {
  applyEvidenceLevelToFinding,
  applyEvidenceLevelsToFindings,
  buildHtmlReport,
  buildReport,
  classifyFinding,
  classifySupportedEvidenceLevel,
  scoreConfidence,
  startDashboard,
} from "../../src/index.js";

const workflow = { id: "release-confidence", name: "Release Confidence", version: "1.0.0", phases: [] } as any;

function minimalState(findings: any[], checks: any[] = []): any {
  return {
    run_id: "run-ev",
    workflow_id: "release-confidence",
    workflow_version: "1.0.0",
    target: { raw: ".", kind: "directory", resolved: "fixtures/target", source: null },
    intent: "test",
    status: "completed",
    current_phase: "confidence_scoring",
    phases: [],
    risks: [],
    checks,
    findings,
    invalid_findings: [],
    blockers: [],
    contract_failures: {},
    contract_failure_streaks: {},
    degraded_personas: [],
    confidence: { score: 90, band: "high", coverage: 100, rationale: "ok", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "pass", reasons: [] } },
    kill_switch: { triggered: false, reason: "", manual: false, triggered_at: null },
    inventory: {},
    personas: [],
    options: {},
    evidence_dir: ".lemma/evidence/run-ev",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    halted_reason: "",
    error: "",
    seed: null,
    clock_mode: "real",
    mode: "test",
    run_size: "medium",
    perspectives_count: 4,
    coverage_notes: [],
  };
}

describe("LEM-188 E0–E3 evidence-level classification", () => {
  it("classifies each level strictly (E3 executed+captured, E2 corroborated >=2 sources, E1 source-only, E0 unknown)", () => {
    expect(classifySupportedEvidenceLevel([])).toBe("E0");
    expect(classifySupportedEvidenceLevel(undefined)).toBe("E0");

    // E1: source-only/inspected
    expect(classifySupportedEvidenceLevel([{ path: "src/app.ts", kind: "source", description: "inspected source" }])).toBe("E1");
    expect(classifySupportedEvidenceLevel([{ source: "static-analysis", inspected_only: true }])).toBe("E1");

    // E2: corroborating evidence across >= 2 independent sources
    expect(classifySupportedEvidenceLevel([
      { source: "scanner-a", path: "a.json", kind: "scan" },
      { source: "scanner-b", path: "b.json", kind: "scan" },
    ])).toBe("E2");

    // E3: executed behavior AND captured result (screenshot/http response/etc)
    expect(classifySupportedEvidenceLevel([
      { kind: "browser", description: "executed navigation and observed live behavior", path: ".lemma/evidence/run/shot.png" },
    ])).toBe("E3");
    expect(classifySupportedEvidenceLevel([
      { type: "http_response", source: "runtime", executed: true, captured_result: true, description: "HTTP response 200" },
    ])).toBe("E3");
  });

  it("downgrades findings whose declared level exceeds supported level with a typed note", () => {
    const finding = {
      id: "F1",
      title: "x",
      severity: "medium",
      evidence: [{ path: "src/x.ts", kind: "source", description: "inspected source only" }],
      evidence_level: "E3",
    } as any;
    const c = classifyFinding(finding);
    expect(c.supported_level).toBe("E1");
    expect(c.level).toBe("E1");
    expect(c.declared_level).toBe("E3");
    expect(c.downgraded).toBe(true);
    expect(String(c.note || "")).toMatch(/downgraded/i);
    expect(String(c.note || "")).toContain("E3");
    expect(String(c.note || "")).toContain("E1");

    const applied = applyEvidenceLevelToFinding(finding);
    expect(applied.evidence_level).toBe("E1");
    expect((applied as any).evidence_level_note).toMatch(/downgraded/i);
  });

  it("persists classified level in the report and is deterministic", () => {
    const findings = [
      { id: "F1", title: "a", severity: "low", domain: "functional", persona: "p", strength: "suspected", consequence: "", location: "", reproduction: "", evidence: [{ source: "s1" }, { source: "s2" }], remediation: "", verification: "", check_id: "C1", created_at: "2026-01-01T00:00:00.000Z", tags: [], fingerprint: "", suppressed: false, suppression_owner: "", suppression_reason: "", suppression_ticket: "", suppression_expires_at: "" },
      { id: "F2", title: "b", severity: "low", domain: "functional", persona: "p", strength: "suspected", consequence: "", location: "", reproduction: "", evidence: [], remediation: "", verification: "", check_id: "C2", created_at: "2026-01-01T00:00:00.000Z", tags: [], fingerprint: "", suppressed: false, suppression_owner: "", suppression_reason: "", suppression_ticket: "", suppression_expires_at: "", evidence_level: "E3" },
    ];
    const r1 = buildReport(minimalState(findings as any), workflow, {}) as any;
    const r2 = buildReport(minimalState(JSON.parse(JSON.stringify(findings)) as any), workflow, {}) as any;
    expect(r1.findings[0].evidence_level).toBe("E2");
    expect(r1.findings[1].evidence_level).toBe("E0"); // downgraded from declared E3 with no evidence
    expect(String(r1.findings[1].evidence_level_note || "")).toMatch(/downgraded/i);
    expect(r1.findings).toEqual(r2.findings);

    // deterministic helper
    expect(applyEvidenceLevelsToFindings(findings as any)).toEqual(applyEvidenceLevelsToFindings(JSON.parse(JSON.stringify(findings)) as any));
  });

  it("policy gates can require a minimum evidence level for SHIP", () => {
    const checks = [
      { id: "C1", domain: "functional", kind: "static", status: "passed", weight: 1 } as any,
    ];
    const findings = [
      { id: "F1", title: "t", severity: "low", domain: "functional", persona: "p", strength: "observed", consequence: "", location: "", reproduction: "", evidence: [{ path: "src/x.ts", kind: "source", description: "inspected" }], remediation: "", verification: "", check_id: "C1", created_at: "2026-01-01T00:00:00.000Z", tags: [], fingerprint: "fp", suppressed: false, suppression_owner: "", suppression_reason: "", suppression_ticket: "", suppression_expires_at: "" } as any,
    ];
    const policy = {
      schema_version: "quality-harness.policy/v1",
      id: "min-level",
      version: "1.0",
      domain_weights: { functional: 1 },
      severity_penalties: { critical: 45, high: 20, medium: 8, low: 2, info: 0 },
      scope_factors: { both: 1, source: 0.9, live: 0.9, none: 0.75 },
      penalty_cap: 70,
      caps: { critical: 30, two_high: 65, halted: 25 },
      gate: { pass_score: 80, warn_score: 60, fail_on_critical: true, fail_on_high: false, coverage_warn: 0.8, coverage_fail: 0.7, min_evidence_level: "E2" },
    };
    const conf = scoreConfidence(checks as any, findings as any, { policy });
    expect(conf.gate.status).toBe("fail");
    expect(JSON.stringify(conf.gate.reasons)).toContain("minimum evidence level");
  });

  it("surfaces classified levels in HTML report and dashboard report summary", async () => {
    const findings = [
      { id: "F1", title: "a", severity: "low", domain: "functional", persona: "p", strength: "suspected", consequence: "", location: "", reproduction: "", evidence: [{ source: "s1" }, { source: "s2" }], remediation: "", verification: "", check_id: "C1", created_at: "2026-01-01T00:00:00.000Z", tags: [], fingerprint: "", suppressed: false, suppression_owner: "", suppression_reason: "", suppression_ticket: "", suppression_expires_at: "" },
    ];
    const report = buildReport(minimalState(findings as any), workflow, {}) as any;
    expect(report.findings[0].evidence_level).toBe("E2");

    const html = await buildHtmlReport(report);
    expect(html).toContain("E2");
    expect(html).toContain("Level");

    // dashboard surfacing (live view report summary includes finding_evidence_levels)
    const handle = await startDashboard({
      stateStore: {
        root: process.cwd(),
        async loadProgress() { return { run_id: report.run_id, status: "completed" }; },
      } as any,
      report,
      host: "127.0.0.1",
    });
    try {
      expect(handle.disabled).not.toBe(true);
      const res = await fetch(`${handle.url.replace(/\/\?token=.*/, "")}/api/live?token=${handle.token}`, { headers: { "x-lemma-dashboard-token": handle.token } });
      // token in query is supported; also try without header mismatch issues by using returned url base
      const base = handle.url.split("?")[0]!;
      const res2 = await fetch(`${base}api/live?token=${encodeURIComponent(handle.token)}`);
      const json: any = await res2.json();
      expect(json.ok).toBe(true);
      expect(json.live?.report_summary?.finding_evidence_levels?.E2).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
