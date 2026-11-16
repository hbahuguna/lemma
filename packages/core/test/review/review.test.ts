import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PersonaError, StateStore, buildHtmlReport, runReview, startDashboard } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-review-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedRun(root: string, runId: string, owner: string) {
  const store = new StateStore(root);
  await store.ensure();
  const finding = { id: "F-1", check_id: "C-1", severity: "high", title: "Issue", evidence: [`.lemma/evidence/${runId}/ev.json`] };
  const state: any = {
    schema_version: "quality-harness.state/v1",
    run_id: runId,
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    checks: [{ id: "C-1", persona: owner, status: "failed", domain: "core" }],
    findings: [finding],
    blockers: [],
  };
  await store.saveProgress(state);
  // seed minimal report
  const report = {
    schema_version: "quality-harness.report/v1",
    run_id: runId,
    status: "completed",
    generated_at: "2026-01-01T00:00:00.000Z",
    decision: { decision: "review", rationale: "r" },
    confidence: { score: 50, band: "medium" },
    coverage: { executed_pct: 100 },
    findings: [finding],
    blockers: [],
    invalid_findings: [],
    checks: state.checks,
    evidence: { directory: `.lemma/evidence/${runId}`, summary: {} },
  };
  const reportPath = path.join(root, ".lemma", "evidence", runId, "report.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { store, report };
}

describe("LEM-179 independent evidence review workflow", () => {
  it("enforces owner-distinct reviewer and refuses with PersonaError when reviewer is same originating owner", async () => {
    await withTempDir(async (root) => {
      await seedRun(root, "run-1", "persona-a");
      await expect(runReview({ root, runId: "run-1", reviewer: "persona-a" } as any)).rejects.toBeInstanceOf(PersonaError);
      await expect(runReview({ root, runId: "run-1", reviewer: "persona-b" } as any)).resolves.toMatchObject({ run_id: "run-1", reviewer: "persona-b" });
    });
  });

  it("produces schema-valid ReviewReport with stable review_id, disagreements per finding, weakened evidence, unsupported assumptions, and contested evidence-backed notes", async () => {
    await withTempDir(async (root) => {
      await seedRun(root, "run-2", "owner-x");
      const r1 = await runReview({ root, runId: "run-2", reviewer: "reviewer-y" } as any);
      const r2 = await runReview({ root, runId: "run-2", reviewer: "reviewer-y" } as any);

      expect(r1.schema_version).toBe("lemma.review_report/v1");
      expect(r1.review_id).toBe(r2.review_id);
      expect(r1.run_id).toBe("run-2");
      expect(r1.status).toBe("completed");
      expect(r1.disagreements.length).toBeGreaterThan(0);
      for (const d of r1.disagreements) {
        expect(d.status).toBe("contested");
        expect(Array.isArray(d.challenged_evidence)).toBe(true);
        expect(Array.isArray(d.offered_evidence)).toBe(true);
        expect(d.offered_evidence.length).toBeGreaterThan(0); // evidence-backed (review offers evidence ref)
        expect(typeof d.reason).toBe("string");
      }
      expect(Array.isArray(r1.weakened_evidence)).toBe(true);
      expect(Array.isArray(r1.unsupported_assumptions)).toBe(true);
      expect(r1.notes.some((n: any) => n.status === "contested")).toBe(true);

      // persisted review artifact
      const reviewPath = path.join(root, ".lemma", "evidence", "run-2", "reviews", `${r1.review_id}.json`);
      const saved = JSON.parse(await fs.readFile(reviewPath, "utf8"));
      expect(saved.review_id).toBe(r1.review_id);

      // attached to report without overriding decision
      const report = JSON.parse(await fs.readFile(path.join(root, ".lemma", "evidence", "run-2", "report.json"), "utf8"));
      expect(Array.isArray(report.reviews)).toBe(true);
      expect(Array.isArray(report.review_notes)).toBe(true);
      expect(report.review_notes.some((n: any) => n.status === "contested")).toBe(true);
      expect(report.decision.decision).toBe("review"); // unchanged
    });
  });

  it("surfaces contested notes in HTML report and dashboard", async () => {
    await withTempDir(async (root) => {
      await seedRun(root, "run-3", "owner-z");
      await runReview({ root, runId: "run-3", reviewer: "independent" } as any);
      const report = JSON.parse(await fs.readFile(path.join(root, ".lemma", "evidence", "run-3", "report.json"), "utf8"));

      const html = await buildHtmlReport(report);
      expect(html).toContain("Review Notes (Contested)");
      expect(html).toContain("contested");
      expect(html).toContain("Contested disagreements");

      // dashboard live endpoint includes contested review notes
      const store = new StateStore(root);
      const dash = await startDashboard({ stateStore: store, report, host: "127.0.0.1", port: 0 } as any);
      try {
        const apiUrl = new URL('/api/live', dash.url).toString();
        const res = await fetch(`${apiUrl}?token=${encodeURIComponent(dash.token)}`);
        expect(res.ok).toBe(true);
        const body: any = await res.json();
        const contestedNotes = Array.isArray(body.review_notes) ? body.review_notes : (Array.isArray(body.live?.review_notes) ? body.live.review_notes : []);
        expect(contestedNotes.some((n: any) => n.status === "contested")).toBe(true);
        expect(body.live?.report_summary?.contested_count).toBeGreaterThan(0);
      } finally {
        await dash.close();
      }
    });
  });
});
