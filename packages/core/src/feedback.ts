import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactText, redactUnknown } from "./redaction.js";
import { now } from "./determinism.js";

export const FEEDBACK_RESPONSE_SCHEMA_VERSION = "lemma.feedback.response/v1" as const;
export const FEEDBACK_REQUEST_SCHEMA_VERSION = "lemma.feedback.request/v1" as const;

export interface FeedbackScope {
  runId: string;
  evidence?: string[];
  findings?: string[];
  checks?: string[];
  [key: string]: unknown;
}

export interface FeedbackReviewer {
  id: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export interface FeedbackInvitation {
  token_hash: string;
  reviewer_id: string;
  expires_at: string;
  issued_at: string;
  scope: "request";
}

export interface FeedbackRequestRecord {
  schema_version: typeof FEEDBACK_REQUEST_SCHEMA_VERSION;
  request_id: string;
  run_id: string;
  scope: FeedbackScope;
  reviewers: FeedbackReviewer[];
  invitations: FeedbackInvitation[];
  created_at: string;
  updated_at: string;
  status: "open" | "closed";
}

export interface FeedbackResponseItemTarget {
  kind: "finding" | "check";
  id: string;
}

export interface FeedbackResponseItem {
  target: FeedbackResponseItemTarget;
  comment: string;
  verdict?: string;
  [key: string]: unknown;
}

export interface FeedbackResponse {
  schema_version: typeof FEEDBACK_RESPONSE_SCHEMA_VERSION;
  request_id: string;
  response_id: string;
  reviewer: { id: string; name?: string; [key: string]: unknown };
  submitted_at: string;
  items: FeedbackResponseItem[];
  summary?: string;
  [key: string]: unknown;
}

export interface IngestedFeedbackContext {
  schema_version: "lemma.feedback.context/v1";
  request_id: string;
  response_id: string;
  reviewer_id: string;
  submitted_at: string;
  target: FeedbackResponseItemTarget;
  comment: string;
  verdict?: string;
  summary?: string;
  ingested_at: string;
  redacted: true;
}

function feedbackRoot(root: string): string {
  return path.join(root, ".lemma", "feedback");
}

function requestDir(root: string, requestId: string): string {
  return path.join(feedbackRoot(root), requestId);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function makeToken(): string {
  return randomBytes(24).toString("base64url");
}

function toIso(v: unknown): string {
  if (typeof v === "string") return v;
  return new Date().toISOString();
}

function validateResponseShape(response: any): FeedbackResponse {
  if (!response || typeof response !== "object") throw new StateError("Invalid feedback response: expected object");
  if (response.schema_version !== FEEDBACK_RESPONSE_SCHEMA_VERSION) {
    throw new StateError(`Invalid feedback response schema_version (expected ${FEEDBACK_RESPONSE_SCHEMA_VERSION})`);
  }
  if (typeof response.request_id !== "string" || !response.request_id) throw new StateError("Invalid feedback response: missing request_id");
  if (typeof response.response_id !== "string" || !response.response_id) throw new StateError("Invalid feedback response: missing response_id");
  if (!response.reviewer || typeof response.reviewer !== "object" || typeof response.reviewer.id !== "string" || !response.reviewer.id) {
    throw new StateError("Invalid feedback response: missing reviewer.id");
  }
  if (typeof response.submitted_at !== "string" || !response.submitted_at) throw new StateError("Invalid feedback response: missing submitted_at");
  if (!Array.isArray(response.items)) throw new StateError("Invalid feedback response: items must be an array");
  for (const item of response.items) {
    if (!item || typeof item !== "object") throw new StateError("Invalid feedback response item");
    const t = (item as any).target;
    if (!t || typeof t !== "object" || (t.kind !== "finding" && t.kind !== "check") || typeof t.id !== "string" || !t.id) {
      throw new StateError("Invalid feedback response item target");
    }
    if (typeof (item as any).comment !== "string") throw new StateError("Invalid feedback response item comment");
  }
  return response as FeedbackResponse;
}

export interface CreateFeedbackRequestParams {
  runId: string;
  scope: Partial<FeedbackScope> & Record<string, unknown>;
  reviewers: FeedbackReviewer[];
  root?: string;
  requestId?: string;
  ttlMs?: number;
  now?: string | Date;
}

export interface CreateFeedbackRequestResult {
  request: FeedbackRequestRecord;
  invitations: Array<{ reviewer_id: string; token: string; expires_at: string; request_id: string }>; // tokens returned once; never persisted/logged
  request_path: string;
}

export async function createFeedbackRequest(params: CreateFeedbackRequestParams): Promise<CreateFeedbackRequestResult> {
  // Free-tier supported per ADR 0006 (LEM-156): feedback loop is not explicitly classified as Pro-only; no Pro entitlement gate required.
  const root = params.root ?? process.cwd();
  const runId = String(params.runId || "");
  if (!runId) throw new StateError("createFeedbackRequest requires runId");
  if (!Array.isArray(params.reviewers)) throw new StateError("createFeedbackRequest requires reviewers array");

  const requestId = params.requestId ?? `fbreq-${randomBytes(8).toString("hex")}`;
  const issuedAt = toIso(params.now ?? now());
  const ttlMs = typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0 ? params.ttlMs : 7 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(new Date(issuedAt).getTime() + ttlMs).toISOString();

  const invitationsOut: Array<{ reviewer_id: string; token: string; expires_at: string; request_id: string }> = [];
  const invitations: FeedbackInvitation[] = [];

  for (const r of params.reviewers) {
    if (!r || typeof r.id !== "string" || !r.id) throw new StateError("Each reviewer must have an id");
    const token = makeToken();
    invitationsOut.push({ reviewer_id: r.id, token, expires_at: expiresAt, request_id: requestId });
    invitations.push({ token_hash: hashToken(token), reviewer_id: r.id, expires_at: expiresAt, issued_at: issuedAt, scope: "request" });
  }

  const scope: FeedbackScope = { runId, ...(params.scope ?? {}) } as FeedbackScope;
  const createdAt = toIso(params.now ?? now());
  const request: FeedbackRequestRecord = {
    schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    run_id: runId,
    scope: redactUnknown(scope) as FeedbackScope,
    reviewers: (params.reviewers || []).map((r) => redactUnknown(r) as FeedbackReviewer),
    invitations,
    created_at: createdAt,
    updated_at: createdAt,
    status: "open",
  };

  const dir = requestDir(root, requestId);
  await ensureDir(dir);
  const reqPath = path.join(dir, "request.json");
  await atomicWriteJson(reqPath, request);
  await ensureDir(path.join(dir, "responses"));
  await ensureDir(path.join(dir, "attachments"));

  return { request, invitations: invitationsOut, request_path: reqPath };
}

export interface IngestFeedbackParams {
  requestId: string;
  response: unknown;
  root?: string;
  /** Optional invitation token to validate scope/expiry (not logged/persisted). */
  invitationToken?: string;
  now?: string | Date;
}

export interface IngestFeedbackResult {
  request_id: string;
  response_id: string;
  idempotent: boolean;
  attached: Array<{ kind: "finding" | "check"; id: string; path: string }>;
  response_path: string;
}

export async function ingestFeedback(params: IngestFeedbackParams): Promise<IngestFeedbackResult> {
  // Free-tier supported per ADR 0006 (LEM-156): not explicitly classified as Pro-only.
  const root = params.root ?? process.cwd();
  const requestId = String(params.requestId || "");
  if (!requestId) throw new StateError("ingestFeedback requires requestId");
  const dir = requestDir(root, requestId);
  const reqPath = path.join(dir, "request.json");

  let request: FeedbackRequestRecord;
  try {
    request = await readJsonFile<FeedbackRequestRecord>(reqPath);
  } catch (err: any) {
    if (err instanceof StateError && /not found/i.test(err.message)) {
      throw new StateError(`Feedback request not found: ${requestId}`, { details: { requestId } });
    }
    throw err;
  }

  // validate invitation token if provided (scoped + expiry). Token never logged/persisted.
  if (params.invitationToken) {
    const tokenHash = hashToken(params.invitationToken);
    const nowMs = new Date(toIso(params.now ?? now())).getTime();
    const match = (request.invitations || []).find((inv) => inv.token_hash === tokenHash);
    if (!match) throw new StateError("Invalid or unscoped invitation token for feedback request");
    if (new Date(match.expires_at).getTime() < nowMs) {
      throw new StateError("Invitation token expired for feedback request");
    }
  }

  const response = validateResponseShape(redactUnknown(params.response));
  if (response.request_id !== requestId) {
    throw new StateError("Feedback response request_id does not match target request");
  }

  const responsesDir = path.join(dir, "responses");
  await ensureDir(responsesDir);
  const responsePath = path.join(responsesDir, `${response.response_id}.json`);
  try {
    await fs.access(responsePath);
    // idempotent: same response id already ingested
    const existing = await readJsonFile<any>(path.join(dir, "attachments", `index-${response.response_id}.json`)).catch(() => null);
    const attached = existing && Array.isArray(existing.attached) ? existing.attached : [];
    return { request_id: requestId, response_id: response.response_id, idempotent: true, attached, response_path: responsePath };
  } catch {
    // continue to ingest
  }

  const sanitized: FeedbackResponse = {
    ...response,
    items: response.items.map((it) => ({
      ...it,
      comment: redactText(String(it.comment ?? "")),
      ...(typeof it.verdict === "string" ? { verdict: redactText(it.verdict) } : {}),
      target: { kind: it.target.kind, id: String(it.target.id) },
    })),
    ...(typeof response.summary === "string" ? { summary: redactText(response.summary) } : {}),
  };

  await atomicWriteJson(responsePath, sanitized);

  // attach as redacted local context to originating findings/checks
  const attachmentsDir = path.join(dir, "attachments");
  await ensureDir(attachmentsDir);
  const attached: Array<{ kind: "finding" | "check"; id: string; path: string }> = [];
  const ingestedAt = toIso(params.now ?? now());
  for (let i = 0; i < sanitized.items.length; i++) {
    const item = sanitized.items[i]!;
    const ctx: IngestedFeedbackContext = {
      schema_version: "lemma.feedback.context/v1",
      request_id: requestId,
      response_id: sanitized.response_id,
      reviewer_id: sanitized.reviewer.id,
      submitted_at: sanitized.submitted_at,
      target: item.target,
      comment: item.comment,
      ...(item.verdict ? { verdict: item.verdict } : {}),
      ...(sanitized.summary ? { summary: sanitized.summary } : {}),
      ingested_at: ingestedAt,
      redacted: true,
    };
    const safeTargetId = item.target.id.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const file = path.join(attachmentsDir, `${item.target.kind}-${safeTargetId}--${sanitized.response_id}--${i}.json`);
    await atomicWriteJson(file, ctx);
    attached.push({ kind: item.target.kind, id: item.target.id, path: file });
  }
  await atomicWriteJson(path.join(attachmentsDir, `index-${sanitized.response_id}.json`), {
    request_id: requestId,
    response_id: sanitized.response_id,
    attached,
    ingested_at: ingestedAt,
  });

  // update request metadata
  request.updated_at = ingestedAt;
  await atomicWriteJson(reqPath, request);

  return { request_id: requestId, response_id: sanitized.response_id, idempotent: false, attached, response_path: responsePath };
}

export async function readFeedbackRequest(root: string, requestId: string): Promise<FeedbackRequestRecord> {
  return readJsonFile<FeedbackRequestRecord>(path.join(requestDir(root, requestId), "request.json"));
}
