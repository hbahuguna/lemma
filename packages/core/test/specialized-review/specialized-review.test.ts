import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initConfidenceWorkspace, runSpecializedReview } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-specialized-review-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeJson(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}

describe("LEM-185 specialized review workflows", () => {
  it("enforces checklists for each kind and reports unchecked items as unreviewed (never pass) with schema-valid reports", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const workspace = path.join(root, ".confidence");

      const kinds: Array<"security" | "skeptical" | "statistical"> = ["security", "skeptical", "statistical"];
      for (const kind of kinds) {
        const report = await runSpecializedReview({ kind, runId: "run-1", workspace, recordedAt: "2026-11-17T00:00:00Z" } as any);
        expect(report.schema_version).toBe("lemma.confidence.specialized_review/v1");
        expect(report.kind).toBe(kind);
        expect(report.review_id).toMatch(/^srev-/);
        // all unchecked => unreviewed, never pass
        expect(report.unreviewed_items.length).toBeGreaterThan(0);
        expect(report.status).toBe("completed_with_unreviewed");
        expect(Object.values(report.checklist).every((i) => i.status === "unreviewed")).toBe(true);
        expect(report.findings.some((f) => f.status === "unreviewed")).toBe(true);
        const saved = JSON.parse(await fs.readFile(path.join(workspace, report.paths.report_path.replace(/^\.confidence\//, "")), "utf8"));
        expect(saved.schema_version).toBe("lemma.confidence.specialized_review/v1");
      }

      // marking items reviewed removes unreviewed status for those items
      const reviewed = await runSpecializedReview({
        kind: "security",
        runId: "run-2",
        workspace,
        recordedAt: "2026-11-17T00:00:00Z",
        checklist: {
          prompt_injection: true,
          untrusted_channels: { status: "reviewed", notes: "ok" },
          leakage: "reviewed",
          tenant_boundaries: { reviewed: true },
          tool_permissions: false,
        },
      } as any);
      expect(reviewed.unreviewed_items).toEqual(["tool_permissions"]);
      expect(reviewed.checklist.tool_permissions.status).toBe("unreviewed");
      expect(reviewed.checklist.prompt_injection.status).toBe("reviewed");
    });
  });

  it("writes reviews atomically under .confidence/reviews/<review_id>/ and links underlying evidence in evals/ and claims/", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const workspace = path.join(root, ".confidence");
      // seed underlying evidence
      await writeJson(path.join(workspace, "evals", "e1", "run.json"), { eval_id: "e1", ok: true });
      await writeJson(path.join(workspace, "claims", "claim-1.json"), { id: "claim-1" });

      const report = await runSpecializedReview({ kind: "skeptical", runId: "run-link", workspace, recordedAt: "2026-11-17T00:00:00Z" } as any);
      const reviewDir = path.join(workspace, "reviews", report.review_id);
      const reportPath = path.join(reviewDir, "report.json");
      const checklistPath = path.join(reviewDir, "checklist.json");
      const findingsPath = path.join(reviewDir, "findings.json");
      for (const p of [reportPath, checklistPath, findingsPath]) {
        const st = await fs.stat(p);
        expect(st.isFile()).toBe(true);
      }
      expect(report.evidence_links.evals.some((p) => p.includes(".confidence/evals/e1/run.json"))).toBe(true);
      expect(report.evidence_links.claims.some((p) => p.includes(".confidence/claims/claim-1.json"))).toBe(true);
      const saved = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(saved.evidence_links.evals).toEqual(report.evidence_links.evals);
      expect(saved.evidence_links.claims).toEqual(report.evidence_links.claims);
    });
  });

  it("release review consumes other three reviews and release decision when present; missing inputs downgrade to MORE EVIDENCE", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const workspace = path.join(root, ".confidence");

      // missing other reviews and release decision => downgrade
      const missing = await runSpecializedReview({ kind: "release", runId: "run-rel-1", workspace, recordedAt: "2026-11-17T00:00:00Z" } as any);
      expect(missing.status).toBe("MORE EVIDENCE");
      expect(missing.release_decision).toBe("MORE EVIDENCE");

      // provide other three reviews and release decision => no downgrade (consumes inputs)
      const sec = await runSpecializedReview({ kind: "security", runId: "run-rel-2", workspace, recordedAt: "2026-11-17T00:00:00Z", checklist: { prompt_injection: true, untrusted_channels: true, leakage: true, tenant_boundaries: true, tool_permissions: true } } as any);
      const skep = await runSpecializedReview({ kind: "skeptical", runId: "run-rel-2", workspace, recordedAt: "2026-11-17T00:00:00Z", checklist: { weak_evidence: true, misleading_averages: true, hidden_severe_failures: true, confidence_theater: true } } as any);
      const stat = await runSpecializedReview({ kind: "statistical", runId: "run-rel-2", workspace, recordedAt: "2026-11-17T00:00:00Z", checklist: { pairing: true, ordinal_scores: true, clusters: true, repetitions: true, intervals: true, multiplicity: true } } as any);

      const ok = await runSpecializedReview({
        kind: "release",
        runId: "run-rel-2",
        workspace,
        recordedAt: "2026-11-17T00:00:00Z",
        checklist: { independent_synthesis_code: true, independent_synthesis_evals: true, severe_failures: true, production_signals: true, reversibility: true },
        availableReviews: [
          { kind: "security", review_id: sec.review_id },
          { kind: "skeptical", review_id: skep.review_id },
          { kind: "statistical", review_id: stat.review_id },
        ],
        releaseDecision: { decision: "SHIP", decision_id: "rdec-1" },
      } as any);
      expect(ok.status).toBe("SHIP");
      expect(ok.release_decision).toBe("SHIP");
      expect(ok.unreviewed_items).toEqual([]);

      // missing release decision (but reviews present) => downgrade
      const missingRd = await runSpecializedReview({
        kind: "release",
        runId: "run-rel-3",
        workspace,
        recordedAt: "2026-11-17T00:00:00Z",
        checklist: { independent_synthesis_code: true, independent_synthesis_evals: true, severe_failures: true, production_signals: true, reversibility: true },
        availableReviews: [
          { kind: "security", review_id: sec.review_id },
          { kind: "skeptical", review_id: skep.review_id },
          { kind: "statistical", review_id: stat.review_id },
        ],
      } as any);
      expect(missingRd.status).toBe("MORE EVIDENCE");
      expect(missingRd.release_decision).toBe("MORE EVIDENCE");
    });
  });
});
