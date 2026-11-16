import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactUnknown } from "./redaction.js";

export type SpecializedReviewKind = "security" | "skeptical" | "statistical" | "release";

export interface SpecializedChecklistItem {
  id: string;
  description: string;
}

export interface SpecializedChecklist {
  schema_version: string;
  kind: SpecializedReviewKind;
  items: SpecializedChecklistItem[];
}

export interface SpecializedReviewItemResult {
  id: string;
  description: string;
  status: "reviewed" | "unreviewed";
  notes?: string;
  evidence?: string[];
}

export interface SpecializedReviewFinding {
  id: string;
  item_id: string;
  status: "issue" | "unreviewed";
  summary: string;
  evidence: string[];
}

export interface SpecializedReviewReport {
  schema_version: "lemma.confidence.specialized_review/v1";
  review_id: string;
  kind: SpecializedReviewKind;
  run_id: string;
  workspace: string;
  status: string;
  checklist: Record<string, SpecializedReviewItemResult>;
  unreviewed_items: string[];
  findings: SpecializedReviewFinding[];
  evidence_links: {
    evals: string[];
    claims: string[];
    reviews?: string[];
    decisions?: string[];
  };
  release_decision?: string | null;
  recorded_at: string;
  paths: { review_dir: string; report_path: string };
  [key: string]: unknown;
}

export interface RunSpecializedReviewParams {
  kind: SpecializedReviewKind;
  runId: string;
  workspace: string;
  /** Optional explicit checklist item statuses (true/false/"reviewed"/"unreviewed") or objects. */
  checklist?: Record<string, unknown>;
  /** Optional freeform findings/notes. */
  findings?: Array<Record<string, unknown>>;
  /** Optional recorded at timestamp (deterministic tests). */
  recordedAt?: string;
  /** Optional: provide release decision value/object for release review consumption. */
  releaseDecision?: unknown;
  /** Optional: provide known review ids/kinds present (for release review dependency checks/tests). */
  availableReviews?: Array<{ kind: SpecializedReviewKind; review_id?: string; status?: string }>;
}

const KINDS: SpecializedReviewKind[] = ["security", "skeptical", "statistical", "release"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableReviewId(kind: string, runId: string, workspace: string): string {
  const h = createHash("sha256").update(kind).update("|").update(runId).update("|").update(workspace).digest("hex").slice(0, 16);
  return `srev-${kind}-${h}`;
}

function checklistCandidates(kind: SpecializedReviewKind): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "../../../schemas/confidence/checklists", `${kind}.v1.json`),
    path.resolve(here, "../../schemas/confidence/checklists", `${kind}.v1.json`),
    path.resolve(process.cwd(), "schemas/confidence/checklists", `${kind}.v1.json`),
  ];
}

async function loadChecklist(kind: SpecializedReviewKind): Promise<SpecializedChecklist> {
  for (const p of checklistCandidates(kind)) {
    try {
      const data = await readJsonFile<any>(p);
      if (data && Array.isArray(data.items)) return data as SpecializedChecklist;
    } catch { /* try next */ }
  }
  // fallback embedded minimal checklist (should not happen in-repo)
  const fallback: Record<SpecializedReviewKind, SpecializedChecklistItem[]> = {
    security: ["prompt_injection","untrusted_channels","leakage","tenant_boundaries","tool_permissions"].map((id) => ({ id, description: id })),
    skeptical: ["weak_evidence","misleading_averages","hidden_severe_failures","confidence_theater"].map((id) => ({ id, description: id })),
    statistical: ["pairing","ordinal_scores","clusters","repetitions","intervals","multiplicity"].map((id) => ({ id, description: id })),
    release: ["independent_synthesis_code","independent_synthesis_evals","severe_failures","production_signals","reversibility"].map((id) => ({ id, description: id })),
  };
  return { schema_version: "lemma.confidence.checklist/v1", kind, items: fallback[kind] };
}

async function listRelativeFiles(dir: string, prefix: string): Promise<string[]> {
  try {
    const out: string[] = [];
    const walk = async (d: string, relBase: string) => {
      const entries = await fs.readdir(d, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(d, e.name), rel);
        else if (e.isFile()) out.push(`${prefix}/${rel}`);
      }
    };
    await walk(dir, "");
    return out.sort();
  } catch {
    return [];
  }
}

function itemReviewed(input: unknown): boolean {
  if (input === true || input === "reviewed" || input === "checked" || input === "pass") return true;
  if (isRecord(input)) {
    if (input.status === "reviewed" || input.reviewed === true || input.checked === true) return true;
  }
  return false;
}

function extractReleaseDecisionValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (isRecord(v)) {
    if (typeof v.decision === "string") return v.decision;
    if (typeof v.release_decision === "string") return v.release_decision;
  }
  return null;
}

export async function runSpecializedReview(params: RunSpecializedReviewParams): Promise<SpecializedReviewReport> {
  const kind = params.kind;
  if (!KINDS.includes(kind)) throw new StateError(`Invalid specialized review kind: ${String(kind)}`);
  const runId = String(params.runId || "");
  if (!runId) throw new StateError("runSpecializedReview requires runId");
  const workspace = path.resolve(params.workspace || "");
  if (!workspace) throw new StateError("runSpecializedReview requires workspace");

  const checklistDef = await loadChecklist(kind);
  const inputChecklist = isRecord(params.checklist) ? params.checklist : {};
  const checklist: Record<string, SpecializedReviewItemResult> = {};
  const unreviewed: string[] = [];
  const findings: SpecializedReviewFinding[] = [];

  for (const item of checklistDef.items) {
    const raw = (inputChecklist as any)[item.id];
    const reviewed = itemReviewed(raw);
    const notes = isRecord(raw) && typeof raw.notes === "string" ? raw.notes : undefined;
    const evidence = isRecord(raw) && Array.isArray(raw.evidence) ? raw.evidence.filter((x): x is string => typeof x === "string") : [];
    const status: "reviewed" | "unreviewed" = reviewed ? "reviewed" : "unreviewed";
    checklist[item.id] = { id: item.id, description: item.description, status, ...(notes ? { notes } : {}), ...(evidence.length ? { evidence } : {}) };
    if (!reviewed) {
      unreviewed.push(item.id);
      findings.push({ id: `finding-${kind}-${item.id}`, item_id: item.id, status: "unreviewed", summary: `Checklist item '${item.id}' is unreviewed.`, evidence });
    }
  }
  unreviewed.sort();

  // link underlying evidence in .confidence/evals/ and .confidence/claims/
  const evals = await listRelativeFiles(path.join(workspace, "evals"), ".confidence/evals");
  const claims = await listRelativeFiles(path.join(workspace, "claims"), ".confidence/claims");
  const reviews = await listRelativeFiles(path.join(workspace, "reviews"), ".confidence/reviews");
  const decisions = await listRelativeFiles(path.join(workspace, "decisions"), ".confidence/decisions");

  let status = unreviewed.length ? "completed_with_unreviewed" : "completed";
  let releaseDecision: string | null = null;

  if (kind === "release") {
    // consume other three reviews and release decision workflow (LEM-180) when present
    const available = Array.isArray(params.availableReviews) ? params.availableReviews : [];
    const presentKinds = new Set(available.map((r) => r.kind));
    // also detect persisted review dirs/reports for security/skeptical/statistical
    for (const k of ["security", "skeptical", "statistical"] as SpecializedReviewKind[]) {
      if (presentKinds.has(k)) continue;
      const has = reviews.some((p) => p.includes(`/reviews/`) && p.includes(`-${k}-`));
      if (has) presentKinds.add(k);
    }
    const rd = params.releaseDecision ?? null;
    const rdVal = extractReleaseDecisionValue(rd);
    if (rdVal) releaseDecision = rdVal;
    // try discover release decision in decisions dir if not provided
    if (!releaseDecision) {
      for (const d of decisions) {
        if (d.endsWith(".json") && d.includes("release")) {
          try {
            const data = await readJsonFile<any>(path.join(workspace, d.replace(/^\.confidence\//, "")));
            const v = extractReleaseDecisionValue(data) || extractReleaseDecisionValue(data?.release_decision);
            if (v) { releaseDecision = v; break; }
          } catch { /* ignore */ }
        }
      }
    }
    const hasAllThree = presentKinds.has("security") && presentKinds.has("skeptical") && presentKinds.has("statistical");
    const hasReleaseDecision = releaseDecision != null || decisions.some((d) => d.includes("release") || d.includes("decision"));
    // If release decision explicitly provided as MORE EVIDENCE, honor it; missing inputs downgrade to MORE EVIDENCE
    if (!hasAllThree || !hasReleaseDecision) {
      releaseDecision = "MORE EVIDENCE";
      status = "MORE EVIDENCE";
      findings.push({ id: "finding-release-missing-inputs", item_id: "independent_synthesis_evals", status: "issue", summary: "Release review missing required inputs (security/skeptical/statistical reviews and/or release decision); downgraded to MORE EVIDENCE.", evidence: [] });
    } else if (releaseDecision) {
      status = releaseDecision;
    }
  }

  const reviewId = stableReviewId(kind, runId, workspace);
  const recorded_at = params.recordedAt ?? new Date(0).toISOString();
  const reviewDirRel = path.posix.join(".confidence", "reviews", reviewId);
  const reviewDirAbs = path.join(workspace, "reviews", reviewId);
  await ensureDir(reviewDirAbs);

  // append explicit findings input (linked to evidence where possible)
  if (Array.isArray(params.findings)) {
    for (const f of params.findings) {
      if (!isRecord(f)) continue;
      findings.push({
        id: typeof f.id === "string" ? f.id : `finding-${kind}-${findings.length + 1}`,
        item_id: typeof f.item_id === "string" ? f.item_id : "general",
        status: f.status === "unreviewed" ? "unreviewed" : "issue",
        summary: typeof f.summary === "string" ? f.summary : (typeof f.reason === "string" ? f.reason : "Finding"),
        evidence: Array.isArray(f.evidence) ? f.evidence.filter((x): x is string => typeof x === "string") : [],
      });
    }
  }

  const report: SpecializedReviewReport = {
    schema_version: "lemma.confidence.specialized_review/v1",
    review_id: reviewId,
    kind,
    run_id: runId,
    workspace,
    status,
    checklist,
    unreviewed_items: unreviewed,
    findings,
    evidence_links: { evals, claims, reviews, decisions },
    ...(kind === "release" ? { release_decision: releaseDecision } : {}),
    recorded_at,
    paths: { review_dir: reviewDirRel, report_path: path.posix.join(reviewDirRel, "report.json") },
  };

  await atomicWriteJson(path.join(reviewDirAbs, "report.json"), redactUnknown(report));
  await atomicWriteJson(path.join(reviewDirAbs, "checklist.json"), redactUnknown({ kind, checklist, unreviewed_items: unreviewed }));
  await atomicWriteJson(path.join(reviewDirAbs, "findings.json"), redactUnknown({ findings, evidence_links: report.evidence_links }));

  // record/link in workspace manifest if present? regenerate not strictly required, but keep workspace coherent
  try {
    const manifestPath = path.join(workspace, "workspace.manifest.json");
    await fs.access(manifestPath);
    // lightweight regeneration not imported to avoid coupling; manifest will refresh on next workspace write/regenerate call
  } catch { /* ignore */ }

  return report;
}
