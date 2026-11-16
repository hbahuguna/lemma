import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  StateError,
  atomicWriteJson,
  ensureDir,
  now,
  readJsonFile,
} from "@lemma/core";

import { requireProLicense, type ProLicenseContext } from "./entitlement.js";

export const REVISION_DIFF_SCHEMA_VERSION = "lemma.pro.revision_diff/v1" as const;
export const EVAL_CASE_REVISION_SCHEMA_VERSION = "lemma.pro.eval_revision/v1" as const;

export type EvalOutcome = "PASS" | "FAIL" | "REGRESSION" | "IMPROVEMENT" | "UNCHANGED" | "UNEVALUATED";

export interface SaveRevisionOptions {
  caseId: string;
  revision: string;
  note: string;
  reviewed: boolean;
  runId?: string;
  projectRoot?: string;
  license?: ProLicenseContext | null;
  /** Optional observed outcome/fingerprint for this revision (from eval result). */
  outcome?: EvalOutcome;
  fingerprint?: string | null;
  /** Optional explicit timestamp for deterministic manifests. */
  created_at?: string;
  [key: string]: unknown;
}

export interface EvalRevisionRecord {
  schema_version: typeof EVAL_CASE_REVISION_SCHEMA_VERSION;
  run_id: string;
  case_id: string;
  revision: string;
  note: string;
  reviewed: true;
  baseline: boolean;
  outcome: EvalOutcome;
  fingerprint: string | null;
  created_at: string;
  manifest_path: string;
  [key: string]: unknown;
}

export interface CompareRevisionsOptions {
  caseId: string;
  from: string;
  to: string;
  runId?: string;
  projectRoot?: string;
  license?: ProLicenseContext | null;
  [key: string]: unknown;
}

export interface RevisionDiff {
  schema_version: typeof REVISION_DIFF_SCHEMA_VERSION;
  case_id: string;
  from_revision: string;
  to_revision: string;
  diff_id: string;
  outcome_counts: Record<EvalOutcome, number>;
  case_transitions: Array<{
    case_id: string;
    from_outcome: EvalOutcome;
    to_outcome: EvalOutcome;
    transition: "REGRESSION" | "IMPROVEMENT" | "UNCHANGED" | "UNEVALUATED";
  }>;
  evidence_fingerprint_changes: Array<{
    case_id: string;
    from_fingerprint: string | null;
    to_fingerprint: string | null;
    changed: boolean;
  }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function resolveProjectRoot(projectRoot?: string): string {
  return path.resolve(projectRoot ?? process.cwd());
}

function sanitizeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function revisionsDir(projectRoot: string, runId: string, caseId: string): string {
  return path.join(resolveProjectRoot(projectRoot), ".lemma", "evidence", runId, "eval", sanitizeId(caseId), "revisions");
}

function revisionManifestPath(projectRoot: string, runId: string, caseId: string, revision: string): string {
  return path.join(revisionsDir(projectRoot, runId, caseId), `${sanitizeId(revision)}.json`);
}

function normalizeOutcome(v: unknown): EvalOutcome {
  const s = String(v || "UNEVALUATED").toUpperCase();
  if (s === "PASS" || s === "FAIL" || s === "REGRESSION" || s === "IMPROVEMENT" || s === "UNCHANGED" || s === "UNEVALUATED") return s;
  return "UNEVALUATED";
}

function transitionFor(from: EvalOutcome, to: EvalOutcome): "REGRESSION" | "IMPROVEMENT" | "UNCHANGED" | "UNEVALUATED" {
  if (from === to) return "UNCHANGED";
  if (from === "PASS" && to === "FAIL") return "REGRESSION";
  if (from === "FAIL" && to === "PASS") return "IMPROVEMENT";
  if (to === "UNEVALUATED" || from === "UNEVALUATED") return "UNEVALUATED";
  // for other mapped eval outcomes, reduce to allowed transition vocabulary without inventing
  if ((from === "REGRESSION" && to === "PASS") || (from === "IMPROVEMENT" && to === "FAIL")) return "IMPROVEMENT";
  if ((from === "PASS" && to === "REGRESSION") || (from === "FAIL" && to === "IMPROVEMENT") || (from === "IMPROVEMENT" && to === "REGRESSION")) return "REGRESSION";
  return "UNCHANGED";
}

export function validateRevisionDiff(value: unknown): RevisionDiff {
  if (!isRecord(value)) throw new StateError("Invalid revision diff: expected object");
  if (value.schema_version !== REVISION_DIFF_SCHEMA_VERSION) throw new StateError("Invalid revision diff schema_version", { details: { schema_version: value.schema_version } });
  const caseId = String(value.case_id || "");
  const fromRev = String(value.from_revision || "");
  const toRev = String(value.to_revision || "");
  if (!caseId || !fromRev || !toRev) throw new StateError("Invalid revision diff: case_id/from_revision/to_revision required");
  const oc = isRecord(value.outcome_counts) ? value.outcome_counts : {};
  const outcome_counts: Record<EvalOutcome, number> = {
    PASS: Math.max(0, Math.floor(Number(oc.PASS ?? 0) || 0)),
    FAIL: Math.max(0, Math.floor(Number(oc.FAIL ?? 0) || 0)),
    REGRESSION: Math.max(0, Math.floor(Number(oc.REGRESSION ?? 0) || 0)),
    IMPROVEMENT: Math.max(0, Math.floor(Number(oc.IMPROVEMENT ?? 0) || 0)),
    UNCHANGED: Math.max(0, Math.floor(Number(oc.UNCHANGED ?? 0) || 0)),
    UNEVALUATED: Math.max(0, Math.floor(Number(oc.UNEVALUATED ?? 0) || 0)),
  };
  const transitionsRaw = Array.isArray(value.case_transitions) ? value.case_transitions.filter(isRecord) : [];
  const case_transitions = transitionsRaw.map((t) => ({
    case_id: String(t.case_id || caseId),
    from_outcome: normalizeOutcome(t.from_outcome),
    to_outcome: normalizeOutcome(t.to_outcome),
    transition: ((): "REGRESSION" | "IMPROVEMENT" | "UNCHANGED" | "UNEVALUATED" => {
      const v = String(t.transition || "UNCHANGED").toUpperCase();
      if (v === "REGRESSION" || v === "IMPROVEMENT" || v === "UNCHANGED" || v === "UNEVALUATED") return v;
      return "UNCHANGED";
    })(),
  }));
  const fpsRaw = Array.isArray(value.evidence_fingerprint_changes) ? value.evidence_fingerprint_changes.filter(isRecord) : [];
  const evidence_fingerprint_changes = fpsRaw.map((f) => {
    const fromFp = typeof f.from_fingerprint === "string" ? f.from_fingerprint : (f.from_fingerprint === null ? null : null);
    const toFp = typeof f.to_fingerprint === "string" ? f.to_fingerprint : (f.to_fingerprint === null ? null : null);
    return { case_id: String(f.case_id || caseId), from_fingerprint: fromFp, to_fingerprint: toFp, changed: f.changed === true || fromFp !== toFp };
  });
  const diff_id = typeof value.diff_id === "string" && value.diff_id ? value.diff_id : sha256(JSON.stringify({ caseId, fromRev, toRev, outcome_counts, case_transitions, evidence_fingerprint_changes }));
  return { schema_version: REVISION_DIFF_SCHEMA_VERSION, case_id: caseId, from_revision: fromRev, to_revision: toRev, diff_id, outcome_counts, case_transitions, evidence_fingerprint_changes };
}

async function listRevisionRecords(projectRoot: string, runId: string, caseId: string): Promise<EvalRevisionRecord[]> {
  const dir = revisionsDir(projectRoot, runId, caseId);
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: EvalRevisionRecord[] = [];
  for (const f of entries) {
    try {
      const rec = await readJsonFile<any>(path.join(dir, f));
      if (isRecord(rec) && rec.schema_version === EVAL_CASE_REVISION_SCHEMA_VERSION) out.push(rec as EvalRevisionRecord);
    } catch {
      // ignore
    }
  }
  out.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || String(a.revision).localeCompare(String(b.revision)));
  return out;
}

export async function saveRevision(options: SaveRevisionOptions): Promise<EvalRevisionRecord> {
  requireProLicense(options.license ?? null, "eval evidence revisions");
  const caseId = String(options.caseId || "");
  const revision = String(options.revision || "");
  const note = String(options.note || "").trim();
  if (!caseId) throw new StateError("caseId is required", { details: { field: "caseId" } });
  if (!revision) throw new StateError("revision is required", { details: { field: "revision" } });
  if (options.reviewed !== true) {
    const err: any = new StateError("Unreviewed revisions are rejected; saveRevision requires reviewed: true", { details: { field: "reviewed", caseId, revision } });
    err.name = "UnreviewedRevisionError";
    throw err;
  }
  if (!note) {
    const err: any = new StateError("saveRevision requires a non-empty note", { details: { field: "note", caseId, revision } });
    err.name = "InvalidRevisionNoteError";
    throw err;
  }

  const projectRoot = resolveProjectRoot(options.projectRoot);
  const runId = String(options.runId || "eval_revisions");
  const dir = revisionsDir(projectRoot, runId, caseId);
  const filePath = revisionManifestPath(projectRoot, runId, caseId, revision);
  await ensureDir(dir);

  // Immutability: once written, reject
  try {
    await fs.stat(filePath);
    const err: any = new StateError(`Revision is immutable and already exists: ${revision}`, { details: { caseId, revision, path: filePath } });
    err.name = "RevisionImmutableError";
    throw err;
  } catch (e: any) {
    if (e && (e.name === "RevisionImmutableError" || (e instanceof StateError && String(e.message).includes("immutable")))) throw e;
    // ENOENT is fine
  }

  const existing = await listRevisionRecords(projectRoot, runId, caseId);
  const baseline = existing.length === 0; // first revision is reviewed baseline

  const record: EvalRevisionRecord = {
    schema_version: EVAL_CASE_REVISION_SCHEMA_VERSION,
    run_id: runId,
    case_id: caseId,
    revision,
    note,
    reviewed: true,
    baseline,
    outcome: normalizeOutcome(options.outcome),
    fingerprint: typeof options.fingerprint === "string" ? options.fingerprint : (options.fingerprint === null ? null : null),
    created_at: typeof options.created_at === "string" ? options.created_at : (now() as string),
    manifest_path: path.relative(projectRoot, filePath).replace(/\\/g, "/"),
  };

  // atomic write (and immutable thereafter)
  await atomicWriteJson(filePath, record);
  return record;
}

export async function compareRevisions(options: CompareRevisionsOptions): Promise<RevisionDiff & { manifests: { from: string; to: string } }> {
  requireProLicense(options.license ?? null, "eval evidence revisions");
  const caseId = String(options.caseId || "");
  const from = String(options.from || "");
  const to = String(options.to || "");
  if (!caseId || !from || !to) throw new StateError("caseId, from, and to are required", { details: { caseId, from, to } });
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const runId = String(options.runId || "eval_revisions");

  const fromPath = revisionManifestPath(projectRoot, runId, caseId, from);
  const toPath = revisionManifestPath(projectRoot, runId, caseId, to);
  const fromRec = await readJsonFile<any>(fromPath);
  const toRec = await readJsonFile<any>(toPath);
  if (!isRecord(fromRec) || !isRecord(toRec)) throw new StateError("Invalid revision manifests for comparison");

  const fromOutcome = normalizeOutcome(fromRec.outcome);
  const toOutcome = normalizeOutcome(toRec.outcome);
  const transition = transitionFor(fromOutcome, toOutcome);

  const outcome_counts: Record<EvalOutcome, number> = { PASS: 0, FAIL: 0, REGRESSION: 0, IMPROVEMENT: 0, UNCHANGED: 0, UNEVALUATED: 0 };
  outcome_counts[transition] = 1;

  const fromFp = typeof fromRec.fingerprint === "string" ? fromRec.fingerprint : (fromRec.fingerprint === null ? null : null);
  const toFp = typeof toRec.fingerprint === "string" ? toRec.fingerprint : (toRec.fingerprint === null ? null : null);

  const diffBase = {
    schema_version: REVISION_DIFF_SCHEMA_VERSION,
    case_id: caseId,
    from_revision: from,
    to_revision: to,
    outcome_counts,
    case_transitions: [{ case_id: caseId, from_outcome: fromOutcome, to_outcome: toOutcome, transition }],
    evidence_fingerprint_changes: [{ case_id: caseId, from_fingerprint: fromFp, to_fingerprint: toFp, changed: fromFp !== toFp }],
  };
  const diff_id = sha256(JSON.stringify(diffBase));
  const diff = validateRevisionDiff({ ...diffBase, diff_id });

  // write comparison manifest under revisions dir (audit)
  const cmpPath = path.join(revisionsDir(projectRoot, runId, caseId), `diff.${sanitizeId(from)}.${sanitizeId(to)}.json`);
  await ensureDir(path.dirname(cmpPath));
  await atomicWriteJson(cmpPath, { ...diff, manifests: { from: path.relative(projectRoot, fromPath).replace(/\\/g, "/"), to: path.relative(projectRoot, toPath).replace(/\\/g, "/") } });

  return { ...diff, manifests: { from: path.relative(projectRoot, fromPath).replace(/\\/g, "/"), to: path.relative(projectRoot, toPath).replace(/\\/g, "/") } };
}

export async function listRevisions(options: { caseId: string; runId?: string; projectRoot?: string; license?: ProLicenseContext | null }): Promise<{ case_id: string; run_id: string; revisions: EvalRevisionRecord[] }> {
  requireProLicense(options.license ?? null, "eval evidence revisions");
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const runId = String(options.runId || "eval_revisions");
  const caseId = String(options.caseId || "");
  if (!caseId) throw new StateError("caseId is required", { details: { field: "caseId" } });
  const revisions = await listRevisionRecords(projectRoot, runId, caseId);
  return { case_id: caseId, run_id: runId, revisions };
}

export const evidence = {
  saveRevision,
  compareRevisions,
  listRevisions,
};
