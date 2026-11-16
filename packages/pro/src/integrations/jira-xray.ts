import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  HarnessError,
  StateError,
  atomicWriteJson,
  ensureDir,
  now,
  redactUnknown,
  type ErrorCode,
} from "@lemma/core";

import { requireProLicense, type ProLicenseContext } from "../entitlement.js";

export const JIRA_XRAY_SCHEMA_VERSION = "lemma.pro.jira_xray/v1" as const;
export const JIRA_XRAY_TRUST_STORE_FILE = path.join(".lemma", "integrations", "jira_xray_trust.json");

export type JiraPushOptIn =
  | boolean
  | {
      /** Agent-loop confirmation (explicit user confirmation). */
      agentLoopConfirmation?: boolean;
      confirmed?: boolean;
      [key: string]: unknown;
    };

export interface JiraXrayProjectConfig {
  jiraXray?: {
    enabled?: boolean;
    baseUrl?: string;
    projectKey?: string;
    issueType?: string;
    /** Secret reference name/id in trust store or "env:VAR". */
    credentialRef?: string;
    /** Optional direct trust-store path override (documented). */
    trustStorePath?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface JiraXrayPushConfig extends JiraXrayProjectConfig {
  /** Per-run opt-in flag/confirmation (required in addition to project enabled). */
  pushJira?: JiraPushOptIn;
  runId?: string;
  /** Test/integration hook: injectable transport; if omitted no network call is made. */
  transport?: JiraXrayTransport;
  [key: string]: unknown;
}

export interface JiraXrayCredentials {
  ref: string;
  source: "trust_store" | "env_ref";
  /** Resolved secret material kept in-memory only; never persisted. */
  token?: string;
  email?: string;
  username?: string;
  apiToken?: string;
  authorization?: string;
  [key: string]: unknown;
}

export interface JiraPushRequest {
  kind: "create" | "update";
  finding_id?: string;
  key?: string;
  payload: Record<string, unknown>;
}

export interface JiraPushResponse {
  ok: boolean;
  status: number;
  key?: string;
  id?: string;
  body?: unknown;
  error?: { type: string; code?: string; message: string; status?: number };
}

export interface JiraXrayTransportInput {
  request: JiraPushRequest;
  baseUrl: string;
  credentials: JiraXrayCredentials;
}

export type JiraXrayTransport = (input: JiraXrayTransportInput) => Promise<JiraPushResponse> | JiraPushResponse;

export interface JiraPushItemResult {
  finding_id?: string;
  action: "created" | "updated" | "failed";
  key?: string;
  ok: boolean;
  error?: { type: string; code: string; message: string; status?: number };
}

export interface JiraPushManifestEntry {
  schema_version: typeof JIRA_XRAY_SCHEMA_VERSION;
  run_id: string;
  project: string;
  created_at: string;
  status: "completed" | "partial" | "failed";
  opt_in: { project_enabled: boolean; per_run: boolean };
  issues: { created: string[]; updated: string[]; failed: number };
  transcript_path: string;
  manifest_path: string;
  /** Redacted transcript of request/response payloads for auditability. */
  transcript: Array<{
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }>;
  errors: Array<{ type: string; code: string; message: string; status?: number; finding_id?: string }>;
}

export interface JiraPushResult {
  schema_version: typeof JIRA_XRAY_SCHEMA_VERSION;
  run_id: string;
  project: string;
  status: "completed" | "partial" | "failed" | "not_opted_in";
  opt_in: { project_enabled: boolean; per_run: boolean };
  created_keys: string[];
  updated_keys: string[];
  items: JiraPushItemResult[];
  errors: Array<{ type: string; code: string; message: string; status?: number; finding_id?: string }>;
  manifest_path: string | null;
  evidence_dir: string | null;
  manifest_entry?: JiraPushManifestEntry;
  [key: string]: unknown;
}

export class NotOptedInError extends HarnessError {
  constructor(message = "Jira/Xray push requires explicit opt-in (project jiraXray.enabled=true and per-run --push-jira or agent-loop confirmation).", details?: Record<string, unknown>) {
    super(message, { code: "auth_error" as ErrorCode, ...(details ? { details } : {}) });
    this.name = "NotOptedInError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function getRunId(report: unknown, config: JiraXrayPushConfig): string {
  if (config.runId) return String(config.runId);
  if (isRecord(report)) {
    if (typeof report.run_id === "string" && report.run_id) return report.run_id;
    if (isRecord(report.run) && typeof report.run.run_id === "string" && report.run.run_id) return report.run.run_id;
  }
  return `run_${Date.now()}`;
}

function hasPerRunOptIn(pushJira: JiraPushOptIn | undefined): boolean {
  if (pushJira === true) return true;
  if (!isRecord(pushJira)) return false;
  return pushJira.agentLoopConfirmation === true || pushJira.confirmed === true;
}

function resolveCredentials(config: JiraXrayPushConfig, projectRoot: string): JiraXrayCredentials {
  const jira = isRecord(config.jiraXray) ? config.jiraXray : {};
  const ref = asString(jira.credentialRef);
  if (!ref) {
    throw new StateError("Missing Jira/Xray credential reference (config.jiraXray.credentialRef)", { details: { field: "jiraXray.credentialRef" } });
  }
  if (ref.startsWith("env:")) {
    const envName = ref.slice(4);
    const val = process.env[envName];
    if (!val) throw new StateError(`Secret reference env var not set: ${envName}`, { details: { ref, env: envName } });
    // token value kept in memory only
    return { ref, source: "env_ref", token: val, apiToken: val, authorization: `Bearer ${val}` };
  }
  // trust store (LEM-079-style HMAC trust store directory/pattern reuse): read JSON store under documented path
  const trustPath = asString(jira.trustStorePath)
    ? (path.isAbsolute(asString(jira.trustStorePath)) ? asString(jira.trustStorePath) : path.join(projectRoot, asString(jira.trustStorePath)))
    : path.join(projectRoot, JIRA_XRAY_TRUST_STORE_FILE);
  if (!existsSync(trustPath)) {
    throw new StateError(`Jira/Xray trust store not found: ${trustPath}`, { details: { path: trustPath, ref } });
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(trustPath, "utf8"));
  } catch (err) {
    throw new StateError(`Failed to read Jira/Xray trust store: ${trustPath}`, { details: { path: trustPath } });
  }
  if (!isRecord(data)) throw new StateError("Invalid Jira/Xray trust store format", { details: { path: trustPath } });
  const secrets = isRecord(data.secrets) ? data.secrets : (isRecord(data.credentials) ? data.credentials : data);
  const entry = isRecord(secrets) ? secrets[ref] : undefined;
  if (entry === undefined) throw new StateError(`Credential reference not found in trust store: ${ref}`, { details: { ref } });
  if (typeof entry === "string") {
    return { ref, source: "trust_store", token: entry, apiToken: entry, authorization: `Bearer ${entry}` };
  }
  if (isRecord(entry)) {
    const token = asString(entry.token) || asString(entry.apiToken) || asString(entry.api_token) || asString(entry.password);
    const email = asString(entry.email) || asString(entry.username) || undefined;
    return {
      ref,
      source: "trust_store",
      ...(token ? { token, apiToken: token } : {}),
      ...(email ? { email, username: email } : {}),
      ...(token ? { authorization: email ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}` } : {}),
    };
  }
  throw new StateError(`Invalid credential entry for ref: ${ref}`, { details: { ref } });
}

function findingsFromReport(report: unknown): Array<Record<string, unknown>> {
  if (!isRecord(report)) return [];
  const candidates = [report.findings, isRecord(report.report) ? (report.report as any).findings : undefined];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter(isRecord) as Array<Record<string, unknown>>;
  }
  return [];
}

function buildRequests(report: unknown, projectKey: string): JiraPushRequest[] {
  const findings = findingsFromReport(report);
  if (findings.length === 0) {
    // push summary result as single item
    const summary = isRecord(report) ? { run_id: (report as any).run_id, decision: (report as any).decision, confidence: (report as any).confidence } : {};
    return [{ kind: "create", payload: { fields: { project: { key: projectKey }, summary: "Lemma run result", description: String(redactUnknown(JSON.stringify(summary))) } } }];
  }
  return findings.map((f, i) => ({
    kind: "create" as const,
    finding_id: asString(f.id) || `finding_${i + 1}`,
    payload: {
      fields: {
        project: { key: projectKey },
        summary: asString(f.title) || `Lemma finding ${asString(f.id) || i + 1}`,
        description: asString(f.description) || asString(f.details) || JSON.stringify(redactUnknown(f)),
        labels: ["lemma", ...(Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t === "string") : [])],
      },
      xray: { finding_id: asString(f.id) || undefined, severity: asString(f.severity) || undefined },
    },
  }));
}

function redactedTranscriptItem(req: JiraPushRequest, resp: JiraPushResponse): { request: Record<string, unknown>; response: Record<string, unknown> } {
  return {
    request: redactUnknown({ kind: req.kind, finding_id: req.finding_id, key: req.key, payload: req.payload }) as Record<string, unknown>,
    response: redactUnknown({ ok: resp.ok, status: resp.status, key: resp.key, id: resp.id, body: resp.body, error: resp.error }) as Record<string, unknown>,
  };
}

export interface PushToJiraXrayOptions {
  report: unknown;
  project: string;
  config: JiraXrayPushConfig;
  license?: ProLicenseContext | null;
  projectRoot?: string;
  /** Per-run confirmation alternative to config.pushJira (agent-loop confirmation). */
  agentLoopConfirmation?: boolean;
  /** Injectable clock for deterministic manifest timestamps. */
  now?: () => string;
}

export async function pushToJiraXray(options: PushToJiraXrayOptions): Promise<JiraPushResult> {
  // Unlicensed invocation refuses (no partial execution)
  requireProLicense(options.license ?? null, "Jira/Xray integration");

  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = options.config ?? ({} as JiraXrayPushConfig);
  const jira = isRecord(config.jiraXray) ? config.jiraXray : {};
  const projectEnabled = jira.enabled === true;
  const perRun = hasPerRunOptIn(config.pushJira) || options.agentLoopConfirmation === true;
  const runId = getRunId(options.report, config);
  const project = String(options.project || asString(jira.projectKey) || "default");

  if (!projectEnabled || !perRun) {
    throw new NotOptedInError(undefined, {
      project_enabled: projectEnabled,
      per_run_opt_in: perRun,
      required: "config.jiraXray.enabled=true AND (config.pushJira/--push-jira or agent-loop confirmation)",
    });
  }

  // Resolve credentials in-memory only (never persisted)
  const credentials = resolveCredentials(config, projectRoot);
  const baseUrl = asString(jira.baseUrl) || "https://jira.example.invalid";
  const projectKey = asString(jira.projectKey) || project;

  const requests = buildRequests(options.report, projectKey);
  const transport: JiraXrayTransport | undefined = typeof config.transport === "function" ? config.transport : undefined;

  const items: JiraPushItemResult[] = [];
  const transcript: JiraPushManifestEntry["transcript"] = [];
  const errors: JiraPushResult["errors"] = [];
  const created: string[] = [];
  const updated: string[] = [];

  for (const req of requests) {
    let resp: JiraPushResponse;
    try {
      if (transport) {
        // Redact outbound payload before send boundary (transport receives redacted payload shape in transcript; we pass structured req but ensure any persisted/logged form is redacted)
        const redactedReq: JiraPushRequest = { ...req, payload: redactUnknown(req.payload) as Record<string, unknown> };
        resp = await transport({ request: redactedReq, baseUrl, credentials });
      } else {
        // No transport/network configured: deterministic simulated success for testable flow
        resp = { ok: true, status: 201, key: `${projectKey}-${created.length + updated.length + 1}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resp = { ok: false, status: 0, error: { type: "network_error", code: "network_error", message } };
    }

    // Normalize 4xx/5xx as typed errors
    if (resp.ok && resp.status >= 400) {
      resp = { ...resp, ok: false, error: resp.error ?? { type: "http_error", code: `http_${resp.status}`, message: `HTTP ${resp.status}`, status: resp.status } };
    }

    transcript.push(redactedTranscriptItem(req, resp));

    if (resp.ok) {
      const key = resp.key || resp.id || "";
      if (req.kind === "update" || req.key) {
        if (key) updated.push(key);
        items.push({ ...(req.finding_id ? { finding_id: req.finding_id } : {}), action: "updated", ...(key ? { key } : {}), ok: true });
      } else {
        if (key) created.push(key);
        items.push({ ...(req.finding_id ? { finding_id: req.finding_id } : {}), action: "created", ...(key ? { key } : {}), ok: true });
      }
    } else {
      const e = resp.error ?? { type: resp.status >= 400 ? "http_error" : "push_error", code: resp.status >= 400 ? `http_${resp.status}` : "push_failed", message: "Push failed", status: resp.status || undefined };
      const errRec = { type: e.type || "push_error", code: e.code || "push_failed", message: String(e.message || "Push failed"), ...(e.status || resp.status ? { status: e.status || resp.status } : {}), ...(req.finding_id ? { finding_id: req.finding_id } : {}) };
      errors.push(errRec);
      items.push({ ...(req.finding_id ? { finding_id: req.finding_id } : {}), action: "failed", ok: false, error: errRec });
    }
  }

  const status: JiraPushResult["status"] = errors.length === 0 ? "completed" : (created.length || updated.length ? "partial" : "failed");
  const evidenceDir = path.join(projectRoot, ".lemma", "evidence", runId, "jira");
  const manifestPath = path.join(evidenceDir, "push-manifest.json");
  await ensureDir(evidenceDir);

  const manifestEntry: JiraPushManifestEntry = {
    schema_version: JIRA_XRAY_SCHEMA_VERSION,
    run_id: runId,
    project,
    created_at: (options.now ? options.now() : now()) as string,
    status: status === "completed" || status === "partial" || status === "failed" ? status : "failed",
    opt_in: { project_enabled: projectEnabled, per_run: perRun },
    issues: { created: [...created], updated: [...updated], failed: errors.length },
    transcript_path: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    manifest_path: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    transcript,
    errors,
  };

  // Atomic write; transcript is redacted (no plaintext credentials)
  await atomicWriteJson(manifestPath, manifestEntry);

  return {
    schema_version: JIRA_XRAY_SCHEMA_VERSION,
    run_id: runId,
    project,
    status,
    opt_in: manifestEntry.opt_in,
    created_keys: created,
    updated_keys: updated,
    items,
    errors,
    manifest_path: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    evidence_dir: path.relative(projectRoot, evidenceDir).replace(/\\/g, "/"),
    manifest_entry: manifestEntry,
  };
}
