import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  StateError,
  atomicWriteJson,
  ensureDir,
  readJsonFile,
  redactText,
  redactUnknown,
} from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const EXPERT_REVIEW_SCHEMA_VERSION = "lemma.pro.expert_review/v1" as const;
export const EXPERT_REVIEW_REQUEST_STATUS = "requested" as const;
export const EXPERT_REVIEW_COMPLETED_STATUS = "completed" as const;

export interface ExpertReviewer {
  name?: string;
  id?: string;
  anonymous_id?: string;
  [key: string]: unknown;
}

export interface ExpertReviewNote {
  finding_id?: string | null;
  note: string;
  severity?: string | null;
  recommendation?: string | null;
  [key: string]: unknown;
}

export interface ExpertReviewRequest {
  schema_version: typeof EXPERT_REVIEW_SCHEMA_VERSION;
  review_id: string;
  run_id: string;
  status: "requested";
  requested_at: string;
  findings: Array<Record<string, unknown>>;
  findings_count: number;
  [key: string]: unknown;
}

export interface ExpertReviewRecord {
  schema_version: typeof EXPERT_REVIEW_SCHEMA_VERSION;
  review_id: string;
  run_id: string;
  status: "completed";
  requested_at?: string;
  ingested_at: string;
  reviewer: { attribution: string; type: "named" | "scoped_anonymous" };
  notes: ExpertReviewNote[];
  explicit_review_notes: Array<Record<string, unknown>>;
  decision_annotation: {
    original_decision: unknown;
    overridden: false;
    annotation: string;
    expert_review_id: string;
  };
  redacted: true;
  [key: string]: unknown;
}

export interface RequestExpertReviewParams {
  runId: string;
  findings: Array<Record<string, unknown>> | unknown;
  root?: string;
  license?: ProLicenseContext | null;
  metering?: MeteringLike | null;
  quota?: QuotaLike | null;
  reviewId?: string;
}

export interface IngestExpertReviewParams {
  reviewId: string;
  response: {
    reviewer?: ExpertReviewer | string | null;
    notes?: ExpertReviewNote[] | unknown;
    note?: string;
    annotations?: unknown;
    report?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  root?: string;
  license?: ProLicenseContext | null;
  metering?: MeteringLike | null;
  quota?: QuotaLike | null;
}

export interface MeteringLike {
  emit: (eventType: string, quantity?: number, unit?: string, options?: Record<string, unknown>) => unknown;
}

export interface QuotaLike {
  consume?: (resource: string, quantity?: number, opts?: Record<string, unknown>) => unknown;
  check?: (resource: string, quantity?: number, opts?: Record<string, unknown>) => unknown;
  enforce?: (resource: string, quantity?: number, opts?: Record<string, unknown>) => unknown;
  peek?: (resource: string, quantity?: number, opts?: Record<string, unknown>) => unknown;
}

function assertLicensed(license: ProLicenseContext | null | undefined): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError("enterprise human-expert review");
}

function nowIso() { return new Date().toISOString(); }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeId(input: string): string {
  const s = String(input || "").trim();
  if (!s) throw new StateError("reviewId/runId is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/.test(s)) throw new StateError("invalid id");
  return s;
}

function reviewsDir(root: string, reviewId?: string): string {
  const base = path.join(root, ".lemma", "pro", "expert-reviews");
  return reviewId ? path.join(base, reviewId) : base;
}

function enforceQuota(quota: QuotaLike | null | undefined, action: string): void {
  if (!quota) return;
  const fn = quota.consume || quota.enforce || quota.check || quota.peek;
  if (typeof fn === "function") {
    // consume/check one expert-review action unit (LEM-115); prefer consume for enforcement semantics
    (quota.consume || quota.enforce || quota.check || quota.peek)!.call(quota, "checks", 1, { metadata: { action, feature: "expert_review" } });
  }
}

function emitMetering(metering: MeteringLike | null | undefined, reviewId: string, action: string): void {
  if (!metering || typeof metering.emit !== "function") return;
  // LEM-113 metering envelope event
  metering.emit("export_generated", 1, "export", {
    idempotency_key: `expert-review:${action}:${reviewId}`,
    metadata: { format: "expert_review", action, review_id: reviewId },
  });
}

function redactDeep<T>(value: T): T {
  // redact strings/objects; never persist raw credentials/secrets
  const r = redactUnknown(value);
  return r as T;
}

function normalizeReviewer(reviewer: ExpertReviewer | string | null | undefined): { attribution: string; type: "named" | "scoped_anonymous" } {
  if (typeof reviewer === "string" && reviewer.trim()) {
    const name = redactText(reviewer.trim()).slice(0, 200);
    return { attribution: name || "anonymous", type: "named" };
  }
  if (isRecord(reviewer)) {
    const name = typeof reviewer.name === "string" && reviewer.name.trim() ? redactText(reviewer.name.trim()).slice(0, 200) : "";
    const anon = typeof reviewer.anonymous_id === "string" && reviewer.anonymous_id.trim()
      ? redactText(reviewer.anonymous_id.trim()).slice(0, 200)
      : (typeof reviewer.id === "string" && reviewer.id.trim() ? redactText(reviewer.id.trim()).slice(0, 200) : "");
    if (name) return { attribution: name, type: "named" };
    if (anon) return { attribution: anon, type: "scoped_anonymous" };
  }
  // default scoped anonymous attribution
  const anon = `anon-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12)}`;
  return { attribution: anon, type: "scoped_anonymous" };
}

function normalizeNotes(response: IngestExpertReviewParams["response"]): ExpertReviewNote[] {
  const out: ExpertReviewNote[] = [];
  const rawNotes = Array.isArray(response.notes) ? response.notes : [];
  for (const n of rawNotes) {
    if (typeof n === "string") {
      out.push({ note: redactText(n) });
      continue;
    }
    if (isRecord(n)) {
      out.push({
        ...(redactDeep(n) as Record<string, unknown>),
        finding_id: typeof n.finding_id === "string" ? n.finding_id : (n.finding_id == null ? null : String(n.finding_id)),
        note: redactText(typeof n.note === "string" ? n.note : JSON.stringify(redactDeep(n))),
        ...(typeof n.severity === "string" ? { severity: redactText(n.severity) } : {}),
        ...(typeof n.recommendation === "string" ? { recommendation: redactText(n.recommendation) } : {}),
      } as ExpertReviewNote);
    }
  }
  if (typeof response.note === "string" && response.note.trim()) {
    out.push({ note: redactText(response.note.trim()) });
  }
  if (out.length === 0) {
    // still attributable/auditable record even with no explicit notes
    out.push({ note: "Expert review ingested (no explicit notes provided)." });
  }
  return out.map((n) => ({ ...n, note: redactText(String(n.note || "")) }));
}

export async function requestExpertReview(params: RequestExpertReviewParams): Promise<{ review: ExpertReviewRequest; path: string }> {
  assertLicensed(params.license);
  enforceQuota(params.quota, "request");
  emitMetering(params.metering, params.reviewId || "pending", "request");

  const root = path.resolve(params.root ?? process.cwd());
  const runId = safeId(params.runId);
  const reviewId = safeId(params.reviewId || `er-${Date.now()}-${randomUUID().slice(0, 8)}`);
  // re-emit with concrete review id if pending was used
  if (!params.reviewId) emitMetering(params.metering, reviewId, "request.id");

  const findingsRaw = Array.isArray(params.findings) ? params.findings : [];
  const findings = findingsRaw.filter(isRecord).map((f) => redactDeep(f) as Record<string, unknown>);

  const review: ExpertReviewRequest = {
    schema_version: EXPERT_REVIEW_SCHEMA_VERSION,
    review_id: reviewId,
    run_id: runId,
    status: EXPERT_REVIEW_REQUEST_STATUS,
    requested_at: nowIso(),
    findings,
    findings_count: findings.length,
  };

  const dir = reviewsDir(root, reviewId);
  await ensureDir(dir);
  const file = path.join(dir, "request.json");
  await atomicWriteJson(file, review);
  return { review, path: file };
}

export async function ingestExpertReview(params: IngestExpertReviewParams): Promise<{ review: ExpertReviewRecord; path: string; reportAnnotation: Record<string, unknown> }> {
  assertLicensed(params.license);
  const root = path.resolve(params.root ?? process.cwd());
  const reviewId = safeId(params.reviewId);
  enforceQuota(params.quota, "ingest");
  emitMetering(params.metering, reviewId, "ingest");

  const dir = reviewsDir(root, reviewId);
  await ensureDir(dir);

  let request: ExpertReviewRequest | null = null;
  try {
    request = await readJsonFile<ExpertReviewRequest>(path.join(dir, "request.json"));
  } catch {
    request = null;
  }
  const runId = safeId(request?.run_id || (isRecord(params.response) && typeof (params.response as any).runId === "string" ? (params.response as any).runId : "unknown-run"));

  const reviewer = normalizeReviewer(params.response?.reviewer ?? null);
  const notes = normalizeNotes(params.response || {});
  const ingestedAt = nowIso();

  const explicit_review_notes = notes.map((n, i) => ({
    type: "expert_review_note",
    expert_review_id: reviewId,
    reviewer: reviewer.attribution,
    reviewer_type: reviewer.type,
    note_id: `${reviewId}:note:${i + 1}`,
    finding_id: n.finding_id ?? null,
    note: n.note,
    ...(n.severity ? { severity: n.severity } : {}),
    ...(n.recommendation ? { recommendation: n.recommendation } : {}),
    ingested_at: ingestedAt,
    status: "annotated",
  }));

  const reportIn = isRecord(params.response?.report) ? (params.response!.report as Record<string, unknown>) : null;
  const originalDecision = reportIn ? (reportIn as any).decision ?? (reportIn as any).release_decision ?? null : null;
  const decision_annotation = {
    original_decision: redactDeep(originalDecision),
    overridden: false as const,
    annotation: "Expert review attached as explicit notes; run decision was not silently overridden.",
    expert_review_id: reviewId,
  };

  const record: ExpertReviewRecord = {
    schema_version: EXPERT_REVIEW_SCHEMA_VERSION,
    review_id: reviewId,
    run_id: runId,
    status: EXPERT_REVIEW_COMPLETED_STATUS,
    ...(request?.requested_at ? { requested_at: request.requested_at } : {}),
    ingested_at: ingestedAt,
    reviewer,
    notes,
    explicit_review_notes,
    decision_annotation,
    redacted: true,
  };

  const file = path.join(dir, "review.json");
  await atomicWriteJson(file, record);

  // Also persist explicit review notes artifact for auditable attachment (non-overriding)
  await atomicWriteJson(path.join(dir, "report-notes.json"), {
    schema_version: EXPERT_REVIEW_SCHEMA_VERSION,
    review_id: reviewId,
    run_id: runId,
    explicit_review_notes,
    decision_annotation,
  });

  const reportAnnotation = {
    expert_reviews: [{ review_id: reviewId, reviewer, ingested_at: ingestedAt, path: path.relative(root, file) }],
    review_notes: explicit_review_notes,
    decision_annotation,
  };

  // If a report object is provided, attach notes/annotation without overriding decision fields
  if (reportIn) {
    const annotated = { ...reportIn } as Record<string, any>;
    const existingNotes = Array.isArray(annotated.review_notes) ? annotated.review_notes : [];
    annotated.review_notes = [...existingNotes, ...explicit_review_notes];
    const existingReviews = Array.isArray(annotated.expert_reviews) ? annotated.expert_reviews : [];
    annotated.expert_reviews = [...existingReviews, { review_id: reviewId, reviewer, ingested_at: ingestedAt }];
    annotated.decision_annotations = [...(Array.isArray(annotated.decision_annotations) ? annotated.decision_annotations : []), decision_annotation];
    // never silently override decision
    if (Object.prototype.hasOwnProperty.call(annotated, "decision") || originalDecision !== null) {
      annotated.decision = annotated.decision; // preserve
    }
    (reportAnnotation as any).annotated_report = annotated;
  }

  return { review: record, path: file, reportAnnotation };
}
