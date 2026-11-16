import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore, buildHtmlReport, runReleaseDecision, startDashboard } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-release-decision-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run-rd",
    status: "completed",
    generated_at: "2026-01-01T00:00:00.000Z",
    decision: { decision: "review", rationale: "base" },
    confidence: { score: 82, band: "medium" },
    coverage: { executed_pct: 100, planned: 5, passed: 5, failed: 0, blocked: 0, skipped: 0, error: 0 },
    findings: [],
    blockers: [],
    invalid_findings: [],
    checks: [{ id: "C-1", persona: "owner-a", status: "passed", domain: "core" }],
    reviews: [{ review_id: "rev-1", reviewer: "reviewer-b", status: "completed" }],
    review_notes: [],
    reviewer_signoff: { explicit: true, signed_off: true, review_ids: ["rev-1"] },
    human_decision_context: { explicit: true, unanswered_material_question_ids: [] },
    evidence: { directory: ".lemma/evidence/run-rd", summary: {} },
    ...overrides,
  };
}

function allSignalsExplicitPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requested_decision: "SHIP",
    reviewer_signoff: { explicit: true, signed_off: true, review_ids: ["rev-1"] },
    human: { explicit: true, unanswered_material_question_ids: [] },
    ...overrides,
  };
}

describe("LEM-180 explicit release decision workflow", () => {
  it("returns schema-valid ReleaseDecision for all five decisions with required reversibility details", () => {
    const report = baseReport();

    const ship = runReleaseDecision({ report, policy: allSignalsExplicitPolicy({ requested_decision: "SHIP" }) });
    expect(ship.schema_version).toBe("lemma.release_decision/v1");
    expect(ship.decision).toBe("SHIP");
    expect(ship.decision_id).toMatch(/^rdec-/);
    expect(ship.evidence_citations.length).toBeGreaterThan(0);
    expect(ship.reversibility).toEqual({ required: false, satisfied: true, details: {} });

    const canary = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "CANARY", canary_scope: "10% of traffic in us-east" }),
    });
    expect(canary.decision).toBe("CANARY");
    expect(canary.reversibility.required).toBe(true);
    expect(canary.reversibility.satisfied).toBe(true);
    expect(canary.reversibility.details.canary_scope).toBe("10% of traffic in us-east");

    const hold = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "HOLD", hold_reason: "Awaiting security sign-off window" }),
    });
    expect(hold.decision).toBe("HOLD");
    expect(hold.reversibility.required).toBe(true);
    expect(hold.reversibility.satisfied).toBe(true);
    expect(hold.reversibility.details.hold_reason).toBe("Awaiting security sign-off window");

    const rollback = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "ROLL BACK", rollback_plan: "Revert deploy abc123 and restore DB snapshot" }),
    });
    expect(rollback.decision).toBe("ROLL BACK");
    expect(rollback.reversibility.required).toBe(true);
    expect(rollback.reversibility.satisfied).toBe(true);
    expect(rollback.reversibility.details.rollback_plan).toBe("Revert deploy abc123 and restore DB snapshot");

    const more = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "MORE EVIDENCE" }),
    });
    expect(more.decision).toBe("MORE EVIDENCE");
  });

  it("requires score, coverage, blockers/refusals, reviewer sign-off, and unanswered HUM-* questions to be explicit; missing any downgrades to MORE EVIDENCE (never SHIP)", () => {
    const report = baseReport();

    const noScore = runReleaseDecision({ report: { ...report, confidence: undefined }, policy: allSignalsExplicitPolicy() });
    expect(noScore.decision).toBe("MORE EVIDENCE");
    expect(noScore.downgrade_reasons).toContain("missing_explicit_score");

    const noCoverage = runReleaseDecision({ report: { ...report, coverage: undefined }, policy: allSignalsExplicitPolicy() });
    expect(noCoverage.decision).toBe("MORE EVIDENCE");
    expect(noCoverage.downgrade_reasons).toContain("missing_explicit_coverage");

    const noBlockers = runReleaseDecision({ report: { ...report, blockers: undefined, invalid_findings: undefined }, policy: { ...allSignalsExplicitPolicy(), signals: undefined } });
    expect(noBlockers.decision).toBe("MORE EVIDENCE");
    expect(noBlockers.downgrade_reasons).toContain("missing_explicit_blockers_refusals");

    const noSignoff = runReleaseDecision({ report: { ...report, reviewer_signoff: undefined, reviews: [], review_notes: [] }, policy: { requested_decision: "SHIP", human: { explicit: true, unanswered_material_question_ids: [] } } });
    expect(noSignoff.decision).toBe("MORE EVIDENCE");
    expect(noSignoff.downgrade_reasons).toContain("missing_explicit_reviewer_signoff");

    const noHum = runReleaseDecision({ report: { ...report, human_decision_context: undefined }, policy: { requested_decision: "SHIP", reviewer_signoff: { explicit: true, signed_off: true } } });
    expect(noHum.decision).toBe("MORE EVIDENCE");
    expect(noHum.downgrade_reasons).toContain("missing_explicit_unanswered_hum_questions");

    // even if requested SHIP, never ship when downgraded
    expect(noScore.decision).not.toBe("SHIP");
  });

  it("downgrades to MORE EVIDENCE when explicit signals show gating issues, and enforces reversibility recording", () => {
    const report = baseReport();

    const unanswered = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ human: { explicit: true, unanswered_material_question_ids: ["HUM-1"] } }),
    });
    expect(unanswered.decision).toBe("MORE EVIDENCE");
    expect(unanswered.downgrade_reasons).toContain("unanswered_hum_questions");

    const notSigned = runReleaseDecision({
      report: { ...report, reviewer_signoff: { explicit: true, signed_off: false } },
      policy: allSignalsExplicitPolicy({ reviewer_signoff: { explicit: true, signed_off: false } }),
    });
    expect(notSigned.decision).toBe("MORE EVIDENCE");
    expect(notSigned.downgrade_reasons).toContain("reviewer_signoff_not_granted");

    const blockersPresent = runReleaseDecision({
      report: { ...report, blockers: [{ check_id: "C-1", boundary: "blocked" }] },
      policy: allSignalsExplicitPolicy(),
    });
    expect(blockersPresent.decision).toBe("MORE EVIDENCE");
    expect(blockersPresent.downgrade_reasons).toContain("blockers_or_refusals_present");

    // missing reversibility details forces MORE EVIDENCE
    const rollbackMissing = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "ROLL BACK" }),
    });
    expect(rollbackMissing.decision).toBe("MORE EVIDENCE");
    expect(rollbackMissing.downgrade_reasons).toContain("missing_reversibility_details");

    const canaryMissing = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "CANARY" }),
    });
    expect(canaryMissing.decision).toBe("MORE EVIDENCE");

    const holdMissing = runReleaseDecision({
      report,
      policy: allSignalsExplicitPolicy({ requested_decision: "HOLD" }),
    });
    expect(holdMissing.decision).toBe("MORE EVIDENCE");
  });

  it("surfaces the decision in HTML report and dashboard without mutating run evidence", async () => {
    await withTempDir(async (root) => {
      const report = baseReport();
      const rd = runReleaseDecision({ report, policy: allSignalsExplicitPolicy({ requested_decision: "SHIP" }) });
      const reportWithDecision = { ...report, release_decision: rd };

      const html = await buildHtmlReport(reportWithDecision);
      expect(html).toContain("Explicit Release Decision");
      expect(html).toContain("lemma.release_decision/v1");
      expect(html).toContain("SHIP");
      expect(html).toContain(rd.decision_id);

      // workflow does not mutate run's own evidence artifacts: no .lemma/evidence writes performed by runReleaseDecision
      const evidenceDir = path.join(root, ".lemma", "evidence", "run-rd");
      await expect(fs.access(evidenceDir)).rejects.toBeTruthy();

      const store = new StateStore(root);
      await store.ensure();
      const dash = await startDashboard({ stateStore: store, report: reportWithDecision, host: "127.0.0.1", port: 0 } as any);
      try {
        const apiUrl = new URL("/api/live", dash.url).toString();
        const res = await fetch(`${apiUrl}?token=${encodeURIComponent(dash.token)}`);
        expect(res.ok).toBe(true);
        const body: any = await res.json();
        expect(body.release_decision?.decision).toBe("SHIP");
        expect(body.live?.report_summary?.release_decision?.decision).toBe("SHIP");
      } finally {
        await dash.close();
      }
    });
  });
});
