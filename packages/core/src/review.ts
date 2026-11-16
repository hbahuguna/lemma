import path from "node:path";
import { createHash } from "node:crypto";

import { PersonaError, StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { ensureDir, atomicWriteJson, readJsonFile } from "./state.js";
import { redactUnknown } from "./redaction.js";
import { StateStore } from "./state-store.js";

export interface RunReviewParams {
  runId: string;
  reviewer: string;
  root?: string;
  stateDirName?: string;
  /** Optional explicit disagreements/notes from reviewer (evidence-backed). */
  disagreements?: Array<{ finding_id: string; reason: string; challenged_evidence?: string[]; offered_evidence?: string[] }>;
  weakened_evidence?: Array<{ finding_id?: string; evidence: string[]; reason: string }>;
  unsupported_assumptions?: Array<{ finding_id?: string; assumption: string; reason: string }>;
}

export interface ReviewDisagreement {
  finding_id: string;
  status: "contested";
  challenged_evidence: string[];
  offered_evidence: string[];
  reason: string;
  review_id: string;
}

export interface ReviewReport {
  schema_version: "lemma.review_report/v1";
  review_id: string;
  run_id: string;
  reviewer: string;
  status: "completed";
  disagreements: ReviewDisagreement[];
  weakened_evidence: Array<Record<string, unknown>>;
  unsupported_assumptions: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  evidence?: { directory: string; manifest: string; artifacts: string[] };
  [key: string]: unknown;
}

function stableReviewId(runId: string, reviewer: string): string {
  return "review-" + createHash("sha256").update(runId).update("|").update(reviewer).digest("hex").slice(0, 16);
}

function validateReportShape(report: ReviewReport): void {
  if (report.schema_version !== "lemma.review_report/v1") throw new StateError("Invalid ReviewReport schema_version");
  if (!report.review_id || !report.run_id || !report.reviewer) throw new StateError("Invalid ReviewReport identity");
  if (!Array.isArray(report.disagreements) || !Array.isArray(report.weakened_evidence) || !Array.isArray(report.unsupported_assumptions) || !Array.isArray(report.notes)) {
    throw new StateError("Invalid ReviewReport structure");
  }
  for (const d of report.disagreements) {
    if (d.status !== "contested") throw new StateError("Review disagreement must be contested");
    if (!Array.isArray(d.challenged_evidence) || !Array.isArray(d.offered_evidence)) throw new StateError("Review disagreement must cite evidence");
  }
}

async function tryLoadReport(root: string, runId: string, stateDirName: string): Promise<any | null> {
  const base = path.join(root, stateDirName, "evidence", runId);
  for (const name of ["report.json", "confidence-report.json"]) {
    try { return await readJsonFile<any>(path.join(base, name)); } catch { /* continue */ }
  }
  // also check progress embedded report? not standard
  return null;
}

export async function runReview(params: RunReviewParams): Promise<ReviewReport> {
  if (!params || typeof params.runId !== "string" || !params.runId) throw new StateError("runReview requires runId");
  if (typeof params.reviewer !== "string" || !params.reviewer.trim()) throw new StateError("runReview requires reviewer");
  const root = path.resolve(params.root ?? process.cwd());
  const reviewer = params.reviewer.trim();
  const stateDirName = params.stateDirName ?? ".lemma";

  const store = new StateStore(root, { stateDirName });
  const state = await store.loadProgress<any>();
  if (!state || state.run_id !== params.runId) {
    // try to proceed if report exists for runId? enforce same run context
    // but loadProgress returns current progress; require match
    throw new StateError(`Run state not found for runId '${params.runId}'`);
  }

  // Owner-distinct enforcement (LEM-044): reviewer must be distinct from originating check's owner
  const owners = new Set<string>();
  const checks = Array.isArray(state.checks) ? state.checks : [];
  for (const c of checks) {
    const owner = c?.persona ?? c?.owner;
    if (typeof owner === "string" && owner) owners.add(owner);
  }
  // also consider findings' originating check owners via check map
  const checkById = new Map<string, any>(checks.map((c: any) => [c.id, c]));
  const findings = Array.isArray(state.findings) ? state.findings : [];
  for (const f of findings) {
    const c = checkById.get(f?.check_id);
    const owner = c?.persona ?? c?.owner ?? f?.persona;
    if (typeof owner === "string" && owner) owners.add(owner);
  }
  if (owners.has(reviewer)) {
    throw new PersonaError(`Reviewer '${reviewer}' must be distinct from originating check owner; reviewer matches originating owner.`);
  }

  const reviewId = stableReviewId(params.runId, reviewer);
  const evidence = new EvidenceStore(root, params.runId, { stateDirName });
  await evidence.init();
  const reviewDir = path.join(root, stateDirName, "evidence", params.runId, "reviews");
  await ensureDir(reviewDir);

  const findingsForReview = findings.length ? findings : [];
  const provided = Array.isArray(params.disagreements) ? params.disagreements : [];

  const disagreements: ReviewDisagreement[] = [];
  if (provided.length) {
    for (const d of provided) {
      if (!d || !d.finding_id) continue;
      const finding = findingsForReview.find((f: any) => f.id === d.finding_id);
      const challenged = Array.isArray(d.challenged_evidence) && d.challenged_evidence.length ? d.challenged_evidence : (Array.isArray(finding?.evidence) ? finding.evidence : []);
      const offered = Array.isArray(d.offered_evidence) ? d.offered_evidence : [];
      const offeredRef = await evidence.saveJson(`review-offered-${d.finding_id}`, redactUnknown({ review_id: reviewId, reviewer, finding_id: d.finding_id, reason: d.reason, offered_evidence: offered }), "json", "Evidence offered by independent review", "review");
      disagreements.push({
        finding_id: String(d.finding_id),
        status: "contested",
        challenged_evidence: challenged.map(String),
        offered_evidence: Array.from(new Set([...offered.map(String), offeredRef])),
        reason: String(d.reason || "Challenged by independent review"),
        review_id: reviewId,
      });
    }
  } else {
    // deterministic evidence-backed disagreements/contests derived from run findings (challenge assumptions/evidence quality)
    for (const f of findingsForReview.slice(0, 50)) {
      const fid = String(f.id || "finding");
      const challenged = Array.isArray(f.evidence) ? f.evidence.map(String) : [];
      const reason = challenged.length === 0
        ? "Finding cites no evidence; claim is contested pending evidence."
        : "Independent review contests the strength/completeness of cited evidence and assumptions for this finding.";
      const offeredRef = await evidence.saveJson(`review-contest-${fid}`, redactUnknown({ review_id: reviewId, reviewer, finding_id: fid, challenged_evidence: challenged, reason }), "json", "Independent review contest note (evidence-backed)", "review");
      disagreements.push({ finding_id: fid, status: "contested", challenged_evidence: challenged, offered_evidence: [offeredRef], reason, review_id: reviewId });
    }
  }

  const weakenedEvidence = (Array.isArray(params.weakened_evidence) ? params.weakened_evidence : disagreements.map(d => ({ finding_id: d.finding_id, evidence: d.challenged_evidence, reason: "Evidence challenged as weakened/incomplete by independent review." })))
    .map((x: any) => redactUnknown({ ...x, review_id: reviewId, reviewer })) as Array<Record<string, unknown>>;
  const unsupportedAssumptions = (Array.isArray(params.unsupported_assumptions) ? params.unsupported_assumptions : (findingsForReview.length ? findingsForReview.slice(0, 25).map((f: any) => ({ finding_id: String(f.id || ""), assumption: "Finding relies on assumptions not fully evidenced.", reason: "Unsupported assumption flagged by independent review." })) : []))
    .map((x: any) => redactUnknown({ ...x, review_id: reviewId, reviewer })) as Array<Record<string, unknown>>;

  const notes = disagreements.map(d => ({ type: "review_note", status: "contested", review_id: reviewId, reviewer, finding_id: d.finding_id, reason: d.reason, challenged_evidence: d.challenged_evidence, offered_evidence: d.offered_evidence }));

  const report: ReviewReport = {
    schema_version: "lemma.review_report/v1",
    review_id: reviewId,
    run_id: params.runId,
    reviewer,
    status: "completed",
    disagreements,
    weakened_evidence: weakenedEvidence,
    unsupported_assumptions: unsupportedAssumptions,
    notes,
  };
  validateReportShape(report);

  const reviewPath = path.join(reviewDir, `${reviewId}.json`);
  await atomicWriteJson(reviewPath, redactUnknown(report));
  const reviewRef = await evidence.saveJson(`review-report-${reviewId}`, redactUnknown(report), "json", "Independent evidence review report", "review");
  report.evidence = { directory: `.lemma/evidence/${params.runId}/reviews`, manifest: `.lemma/evidence/${params.runId}/manifest.json`, artifacts: [reviewRef] };

  // attach contested review notes to run report (do not auto-override decision; do not mutate evidence artifacts)
  const runReport = await tryLoadReport(root, params.runId, stateDirName);
  if (runReport && typeof runReport === "object") {
    const existing = Array.isArray(runReport.reviews) ? runReport.reviews : [];
    runReport.reviews = [...existing.filter((r: any) => r?.review_id !== reviewId), redactUnknown(report)];
    const contested = Array.isArray(runReport.review_notes) ? runReport.review_notes : [];
    runReport.review_notes = [...contested.filter((n: any) => n?.review_id !== reviewId), ...notes];
    await atomicWriteJson(path.join(root, stateDirName, "evidence", params.runId, "report.json"), runReport);
  }

  await evidence.finalize({ workflow: "review", run_id: params.runId, review_id: reviewId, generated_at: undefined });
  validateReportShape(report);
  return report;
}
