import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  StateError,
  atomicWriteJson,
  ensureDir,
  now,
  redactUnknown,
} from "@lemma/core";

import { requireProLicense, type ProLicenseContext } from "../entitlement.js";
import { NotOptedInError } from "./jira-xray.js";

export const TESTRAIL_SCHEMA_VERSION = "lemma.pro.testrail/v1" as const;
export const TESTRAIL_TRUST_STORE_FILE = path.join(".lemma", "integrations", "testrail_trust.json");

export type TestRailPushOptIn =
  | boolean
  | {
      agentLoopConfirmation?: boolean;
      confirmed?: boolean;
      [key: string]: unknown;
    };

export interface TestRailProjectConfig {
  testRail?: {
    enabled?: boolean;
    baseUrl?: string;
    projectId?: string | number;
    suiteId?: string | number;
    credentialRef?: string;
    trustStorePath?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TestRailPushConfig extends TestRailProjectConfig {
  pushTestRail?: TestRailPushOptIn;
  runId?: string;
  transport?: TestRailTransport;
  [key: string]: unknown;
}

export interface TestRailCredentials {
  ref: string;
  source: "trust_store" | "env_ref";
  token?: string;
  email?: string;
  username?: string;
  apiToken?: string;
  authorization?: string;
  [key: string]: unknown;
}

export interface TestRailPushRequest {
  kind: "create" | "update";
  finding_id?: string;
  case_id?: string | number;
  result_id?: string | number;
  payload: Record<string, unknown>;
}

export interface TestRailPushResponse {
  ok: boolean;
  status: number;
  case_id?: string | number;
  result_id?: string | number;
  id?: string | number;
  body?: unknown;
  error?: { type: string; code?: string; message: string; status?: number };
}

export interface TestRailTransportInput {
  request: TestRailPushRequest;
  baseUrl: string;
  credentials: TestRailCredentials;
}

export type TestRailTransport = (input: TestRailTransportInput) => Promise<TestRailPushResponse> | TestRailPushResponse;

export interface TestRailPushItemResult {
  finding_id?: string;
  action: "created" | "updated" | "failed";
  case_id?: string | number;
  result_id?: string | number;
  ok: boolean;
  error?: { type: string; code: string; message: string; status?: number };
}

export interface TestRailPushManifestEntry {
  schema_version: typeof TESTRAIL_SCHEMA_VERSION;
  run_id: string;
  project: string;
  created_at: string;
  status: "completed" | "partial" | "failed";
  opt_in: { project_enabled: boolean; per_run: boolean };
  cases: { created: Array<string | number>; updated: Array<string | number> };
  results: { created: Array<string | number>; updated: Array<string | number> };
  failed: number;
  transcript_path: string;
  manifest_path: string;
  transcript: Array<{ request: Record<string, unknown>; response: Record<string, unknown> }>;
  errors: Array<{ type: string; code: string; message: string; status?: number; finding_id?: string }>;
}

export interface TestRailPushResult {
  schema_version: typeof TESTRAIL_SCHEMA_VERSION;
  run_id: string;
  project: string;
  status: "completed" | "partial" | "failed" | "not_opted_in";
  opt_in: { project_enabled: boolean; per_run: boolean };
  created_case_ids: Array<string | number>;
  updated_case_ids: Array<string | number>;
  created_result_ids: Array<string | number>;
  updated_result_ids: Array<string | number>;
  items: TestRailPushItemResult[];
  errors: Array<{ type: string; code: string; message: string; status?: number; finding_id?: string }>;
  manifest_path: string | null;
  evidence_dir: string | null;
  manifest_entry?: TestRailPushManifestEntry;
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function getRunId(report: unknown, config: TestRailPushConfig): string {
  if (config.runId) return String(config.runId);
  if (isRecord(report)) {
    if (typeof report.run_id === "string" && report.run_id) return report.run_id;
    if (isRecord(report.run) && typeof report.run.run_id === "string" && report.run.run_id) return report.run.run_id;
  }
  return `run_${Date.now()}`;
}

function hasPerRunOptIn(push: TestRailPushOptIn | undefined): boolean {
  if (push === true) return true;
  if (!isRecord(push)) return false;
  return push.agentLoopConfirmation === true || push.confirmed === true;
}

function resolveCredentials(config: TestRailPushConfig, projectRoot: string): TestRailCredentials {
  const tr = isRecord(config.testRail) ? config.testRail : {};
  const ref = asString(tr.credentialRef);
  if (!ref) {
    throw new StateError("Missing TestRail credential reference (config.testRail.credentialRef)", { details: { field: "testRail.credentialRef" } });
  }
  if (ref.startsWith("env:")) {
    const envName = ref.slice(4);
    const val = process.env[envName];
    if (!val) throw new StateError(`Secret reference env var not set: ${envName}`, { details: { ref, env: envName } });
    return { ref, source: "env_ref", token: val, apiToken: val, authorization: `Bearer ${val}` };
  }
  const trustPath = asString(tr.trustStorePath)
    ? (path.isAbsolute(asString(tr.trustStorePath)) ? asString(tr.trustStorePath) : path.join(projectRoot, asString(tr.trustStorePath)))
    : path.join(projectRoot, TESTRAIL_TRUST_STORE_FILE);
  if (!existsSync(trustPath)) {
    throw new StateError(`TestRail trust store not found: ${trustPath}`, { details: { path: trustPath, ref } });
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(trustPath, "utf8"));
  } catch {
    throw new StateError(`Failed to read TestRail trust store: ${trustPath}`, { details: { path: trustPath } });
  }
  if (!isRecord(data)) throw new StateError("Invalid TestRail trust store format", { details: { path: trustPath } });
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

function buildRequests(report: unknown, project: string): TestRailPushRequest[] {
  const findings = findingsFromReport(report);
  if (findings.length === 0) {
    const summary = isRecord(report) ? { run_id: (report as any).run_id, decision: (report as any).decision, confidence: (report as any).confidence } : {};
    return [{ kind: "create", payload: { project, title: "Lemma run result", comment: String(redactUnknown(JSON.stringify(summary))) } }];
  }
  return findings.map((f, i) => ({
    kind: "create" as const,
    finding_id: asString(f.id) || `finding_${i + 1}`,
    payload: {
      project,
      title: asString(f.title) || `Lemma finding ${asString(f.id) || i + 1}`,
      custom_steps: asString(f.description) || asString(f.details) || JSON.stringify(redactUnknown(f)),
      refs: asString(f.id) || undefined,
      severity: asString(f.severity) || undefined,
    },
  }));
}

function redactedTranscriptItem(req: TestRailPushRequest, resp: TestRailPushResponse): { request: Record<string, unknown>; response: Record<string, unknown> } {
  return {
    request: redactUnknown({ kind: req.kind, finding_id: req.finding_id, case_id: req.case_id, result_id: req.result_id, payload: req.payload }) as Record<string, unknown>,
    response: redactUnknown({ ok: resp.ok, status: resp.status, case_id: resp.case_id, result_id: resp.result_id, id: resp.id, body: resp.body, error: resp.error }) as Record<string, unknown>,
  };
}

export interface PushToTestRailOptions {
  report: unknown;
  project: string;
  config: TestRailPushConfig;
  license?: ProLicenseContext | null;
  projectRoot?: string;
  agentLoopConfirmation?: boolean;
  now?: () => string;
}

export async function pushToTestRail(options: PushToTestRailOptions): Promise<TestRailPushResult> {
  requireProLicense(options.license ?? null, "TestRail integration");

  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = options.config ?? ({} as TestRailPushConfig);
  const tr = isRecord(config.testRail) ? config.testRail : {};
  const projectEnabled = tr.enabled === true;
  const perRun = hasPerRunOptIn(config.pushTestRail) || options.agentLoopConfirmation === true;
  const runId = getRunId(options.report, config);
  const project = String(options.project || asString(tr.projectId) || "default");

  if (!projectEnabled || !perRun) {
    throw new NotOptedInError("TestRail push requires explicit opt-in (project testRail.enabled=true and per-run --push-testrail or agent-loop confirmation).", {
      project_enabled: projectEnabled,
      per_run_opt_in: perRun,
      required: "config.testRail.enabled=true AND (config.pushTestRail/--push-testrail or agent-loop confirmation)",
    });
  }

  const credentials = resolveCredentials(config, projectRoot);
  const baseUrl = asString(tr.baseUrl) || "https://testrail.example.invalid";
  const requests = buildRequests(options.report, project);
  const transport: TestRailTransport | undefined = typeof config.transport === "function" ? config.transport : undefined;

  const items: TestRailPushItemResult[] = [];
  const transcript: TestRailPushManifestEntry["transcript"] = [];
  const errors: TestRailPushResult["errors"] = [];
  const createdCases: Array<string | number> = [];
  const updatedCases: Array<string | number> = [];
  const createdResults: Array<string | number> = [];
  const updatedResults: Array<string | number> = [];

  for (const req of requests) {
    let resp: TestRailPushResponse;
    try {
      if (transport) {
        const redactedReq: TestRailPushRequest = { ...req, payload: redactUnknown(req.payload) as Record<string, unknown> };
        resp = await transport({ request: redactedReq, baseUrl, credentials });
      } else {
        const n = createdCases.length + createdResults.length + 1;
        resp = { ok: true, status: 201, case_id: `C${n}`, result_id: `R${n}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resp = { ok: false, status: 0, error: { type: "network_error", code: "network_error", message } };
    }

    if (resp.ok && resp.status >= 400) {
      resp = { ...resp, ok: false, error: resp.error ?? { type: "http_error", code: `http_${resp.status}`, message: `HTTP ${resp.status}`, status: resp.status } };
    }

    transcript.push(redactedTranscriptItem(req, resp));

    if (resp.ok) {
      const caseId = resp.case_id ?? resp.id;
      const resultId = resp.result_id;
      const updating = req.kind === "update" || req.case_id !== undefined || req.result_id !== undefined;
      if (updating) {
        if (caseId !== undefined) updatedCases.push(caseId);
        if (resultId !== undefined) updatedResults.push(resultId);
        items.push({ ...(req.finding_id ? { finding_id: req.finding_id } : {}), action: "updated", ...(caseId !== undefined ? { case_id: caseId } : {}), ...(resultId !== undefined ? { result_id: resultId } : {}), ok: true });
      } else {
        if (caseId !== undefined) createdCases.push(caseId);
        if (resultId !== undefined) createdResults.push(resultId);
        items.push({ ...(req.finding_id ? { finding_id: req.finding_id } : {}), action: "created", ...(caseId !== undefined ? { case_id: caseId } : {}), ...(resultId !== undefined ? { result_id: resultId } : {}), ok: true });
      }
    } else {
      const e = resp.error ?? { type: resp.status >= 400 ? "http_error" : "push_error", code: resp.status >= 400 ? `http_${resp.status}` : "push_failed", message: "Push failed", status: resp.status || undefined };
      const errRec = { type: e.type || "push_error", code: e.code || "push_failed", message: String(e.message || "Push failed"), ...(e.status || resp.status ? { status: e.status || resp.status } : {}), ...(req.finding_id ? { finding_id: req.finding_id } : {}) };
      errors.push(errRec);
      items.push({ ...(req.finding_id ? { finding_id: req.finding_id } : {}), action: "failed", ok: false, error: errRec });
    }
  }

  const status: TestRailPushResult["status"] = errors.length === 0 ? "completed" : ((createdCases.length || updatedCases.length || createdResults.length || updatedResults.length) ? "partial" : "failed");
  const evidenceDir = path.join(projectRoot, ".lemma", "evidence", runId, "testrail");
  const manifestPath = path.join(evidenceDir, "push-manifest.json");
  await ensureDir(evidenceDir);

  const manifestEntry: TestRailPushManifestEntry = {
    schema_version: TESTRAIL_SCHEMA_VERSION,
    run_id: runId,
    project,
    created_at: (options.now ? options.now() : now()) as string,
    status: status === "completed" || status === "partial" || status === "failed" ? status : "failed",
    opt_in: { project_enabled: projectEnabled, per_run: perRun },
    cases: { created: [...createdCases], updated: [...updatedCases] },
    results: { created: [...createdResults], updated: [...updatedResults] },
    failed: errors.length,
    transcript_path: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    manifest_path: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    transcript,
    errors,
  };

  await atomicWriteJson(manifestPath, manifestEntry);

  return {
    schema_version: TESTRAIL_SCHEMA_VERSION,
    run_id: runId,
    project,
    status,
    opt_in: manifestEntry.opt_in,
    created_case_ids: createdCases,
    updated_case_ids: updatedCases,
    created_result_ids: createdResults,
    updated_result_ids: updatedResults,
    items,
    errors,
    manifest_path: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    evidence_dir: path.relative(projectRoot, evidenceDir).replace(/\\/g, "/"),
    manifest_entry: manifestEntry,
  };
}

export { NotOptedInError };
