import { randomUUID } from "node:crypto";

import { SsrfError, StateError } from "./errors.js";
import { validateUrl } from "./ssrf.js";

export type ApiCoverageClass = "positive" | "negative" | "boundary" | "auth" | "tenant" | "idempotency";

export interface OpenApiLike {
  paths?: Record<string, Record<string, any>>;
  operations?: Array<{ operationId?: string; method?: string; path?: string; [k: string]: any }>;
  "x-lemma-ui-flow-map"?: Record<string, UiFlowMapping>;
  [k: string]: any;
}

export interface TrafficItem {
  operation?: string;
  operationId?: string;
  method?: string;
  path?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  ui_flow?: UiFlowMapping | null;
  [k: string]: any;
}

export interface UiFlowMapping {
  operation: string;
  screen: string;
  user_journey: string;
}

export interface RunApiCoverageParams {
  spec?: OpenApiLike | null;
  traffic?: TrafficItem[] | null;
  target: string;
  maxCases?: number; // documented cap
  uiFlowMap?: Record<string, UiFlowMapping>;
  /** Injectable executor; if provided, cases are executed and failures mapped. */
  execute?: (req: { method: string; url: string; headers?: Record<string, string>; body?: unknown; case: ApiCoverageCase }) => Promise<{ ok: boolean; status?: number; error?: string; [k: string]: any }> | { ok: boolean; status?: number; error?: string; [k: string]: any };
  /** Injectable DNS resolver for SSRF validation (tests/determinism). */
  resolver?: (hostname: string) => string[] | Promise<string[]>;
  allowlist?: Iterable<unknown> | null;
  root?: string | null;
  runId?: string;
}

export interface ApiCoverageCaseSource {
  type: "spec_operation" | "observed_traffic";
  ref: string;
}

export interface ApiCoverageCase {
  id: string;
  class: ApiCoverageClass;
  source: ApiCoverageCaseSource;
  operation: string;
  request: { method: string; path: string; url?: string; headers?: Record<string, string>; body?: unknown; [k: string]: any };
  ui_flow: UiFlowMapping | "unknown";
  result: { ok: boolean; status?: number; [k: string]: any } | null;
  failure: { message: string; status?: number; [k: string]: any } | null;
  [k: string]: any;
}

export interface ApiCoverageReport {
  schema_version: "lemma.api_coverage_report/v1";
  run_id: string;
  status: "completed" | "halted" | "rejected";
  target: string;
  safe_target_validated: boolean;
  max_cases: number;
  spec_source: string | null;
  traffic_source: string | null;
  cases: ApiCoverageCase[];
  summary: {
    total_cases: number;
    by_class: Record<ApiCoverageClass, number>;
    failures: number;
    mapped_failures: number;
    unmapped_failures: number;
    capped: boolean;
  };
  [k: string]: unknown;
}

const CLASSES: ApiCoverageClass[] = ["positive", "negative", "boundary", "auth", "tenant", "idempotency"];

function normalizeTarget(target: string): string {
  const t = String(target || "").trim();
  if (!t) throw new StateError("API coverage target is required");
  return t;
}

function opKey(method: string, p: string): string {
  return `${method.toUpperCase()} ${p}`;
}

function extractSpecOps(spec: OpenApiLike | null | undefined): Array<{ key: string; method: string; path: string; op: any }> {
  const out: Array<{ key: string; method: string; path: string; op: any }> = [];
  if (!spec || typeof spec !== "object") return out;
  if (Array.isArray(spec.operations)) {
    for (const o of spec.operations) {
      const method = String(o.method || "GET").toUpperCase();
      const p = String(o.path || "/");
      out.push({ key: opKey(method, p), method, path: p, op: o });
    }
    return out;
  }
  const paths = spec.paths && typeof spec.paths === "object" ? spec.paths : {};
  for (const [p, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [m, op] of Object.entries(methods as Record<string, any>)) {
      const method = m.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) continue;
      out.push({ key: opKey(method, p), method, path: p, op });
    }
  }
  return out;
}

function extractTrafficOps(traffic: TrafficItem[] | null | undefined): Array<{ key: string; method: string; path: string; item: TrafficItem }> {
  const out: Array<{ key: string; method: string; path: string; item: TrafficItem }> = [];
  for (const t of traffic || []) {
    const method = String(t.method || "GET").toUpperCase();
    const p = String(t.path || t.url || "/");
    const key = String(t.operation || t.operationId || opKey(method, p));
    out.push({ key, method, path: p, item: t });
  }
  return out;
}

function resolveUiFlow(operation: string, maps: Array<Record<string, UiFlowMapping> | undefined | null>, trafficItem?: TrafficItem): UiFlowMapping | "unknown" {
  if (trafficItem?.ui_flow && trafficItem.ui_flow.screen && trafficItem.ui_flow.user_journey) {
    return { operation, screen: String(trafficItem.ui_flow.screen), user_journey: String(trafficItem.ui_flow.user_journey) };
  }
  for (const m of maps) {
    if (!m) continue;
    const hit = m[operation] || m[operation.split(" ").pop() || ""];
    if (hit && hit.screen && hit.user_journey) return { operation, screen: String(hit.screen), user_journey: String(hit.user_journey) };
  }
  return "unknown";
}

function makeRequestVariant(cls: ApiCoverageClass, method: string, path: string, baseUrl: string): ApiCoverageCase["request"] {
  const url = baseUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
  const req: ApiCoverageCase["request"] = { method, path, url, headers: { accept: "application/json" } };
  if (cls === "negative") req.body = { __invalid: true };
  if (cls === "boundary") req.headers = { ...req.headers, "x-lemma-boundary": "max" };
  if (cls === "auth") req.headers = { ...req.headers }; // intentionally missing/invalid auth handled by executor/policy
  if (cls === "tenant") req.headers = { ...req.headers, "x-tenant-id": "tenant-other" };
  if (cls === "idempotency") req.headers = { ...req.headers, "idempotency-key": "lemma-fixed-key" };
  return req;
}

function defaultFailForClass(cls: ApiCoverageClass, res: any): { failed: boolean; message?: string } {
  if (!res) return { failed: false };
  const status = typeof res.status === "number" ? res.status : undefined;
  if (cls === "auth" && status && status < 400) return { failed: true, message: `Expected auth enforcement, got ${status}` };
  if (cls === "negative" && status && status < 400) return { failed: true, message: `Expected rejection/validation error, got ${status}` };
  if (cls === "tenant" && status && status < 400) return { failed: true, message: `Expected tenant isolation enforcement, got ${status}` };
  if (res.ok === false || res.error || (status !== undefined && status >= 500)) return { failed: true, message: String(res.error || `Request failed with status ${status}`) };
  return { failed: false };
}

export async function runApiCoverage(params: RunApiCoverageParams): Promise<ApiCoverageReport> {
  const run_id = params.runId || `api-${randomUUID()}`;
  const target = normalizeTarget(params.target);
  const max_cases = Math.max(1, Math.floor(Number(params.maxCases ?? 60) || 60));

  // SSRF-safe validation before any request (LEM-059)
  await validateUrl(target, { resolver: params.resolver ?? null, allowlist: params.allowlist ?? null, root: params.root ?? null });

  const specOps = extractSpecOps(params.spec || null);
  const trafficOps = extractTrafficOps(params.traffic || null);
  const sources: Array<{ source: ApiCoverageCaseSource; operation: string; method: string; path: string; trafficItem?: TrafficItem }> = [];

  for (const op of specOps) sources.push({ source: { type: "spec_operation", ref: op.key }, operation: op.key, method: op.method, path: op.path });
  for (const t of trafficOps) sources.push({ source: { type: "observed_traffic", ref: t.key }, operation: t.key, method: t.method, path: t.path, trafficItem: t.item });

  const maps = [params.uiFlowMap, (params.spec as any)?.["x-lemma-ui-flow-map"]] as Array<Record<string, UiFlowMapping> | undefined>;
  const cases: ApiCoverageCase[] = [];
  let capped = false;

  outer: for (const s of sources) {
    for (const cls of CLASSES) {
      if (cases.length >= max_cases) { capped = true; break outer; }
      const req = makeRequestVariant(cls, s.method, s.path, target);
      const ui_flow = resolveUiFlow(s.operation, maps, s.trafficItem);
      const c: ApiCoverageCase = {
        id: `${s.operation}::${cls}::${cases.length + 1}`,
        class: cls,
        source: s.source,
        operation: s.operation,
        request: req,
        ui_flow,
        result: null,
        failure: null,
      };

      if (params.execute) {
        try {
          // validate each concrete request target before execution
          if (req.url) await validateUrl(req.url, { resolver: params.resolver ?? null, allowlist: params.allowlist ?? null, root: params.root ?? null });
          const execReq: { method: string; url: string; headers?: Record<string, string>; body?: unknown; case: ApiCoverageCase } = {
            method: req.method,
            url: String(req.url || target),
            case: c,
          };
          if (req.headers) execReq.headers = req.headers;
          if (req.body !== undefined) execReq.body = req.body;
          const res = await params.execute(execReq);
          c.result = res.status === undefined ? { ok: !!res.ok } : { ok: !!res.ok, status: res.status };
          const verdict = defaultFailForClass(cls, res);
          if (verdict.failed) c.failure = res.status === undefined ? { message: verdict.message || "API coverage case failed" } : { message: verdict.message || "API coverage case failed", status: res.status };
          else if (res.ok === false || res.error) c.failure = res.status === undefined ? { message: String(res.error || "Request failed") } : { message: String(res.error || "Request failed"), status: res.status };
        } catch (e) {
          if (e instanceof SsrfError) throw e;
          c.result = { ok: false };
          c.failure = { message: e instanceof Error ? e.message : String(e) };
        }
      }
      cases.push(c);
    }
  }

  const by_class = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ApiCoverageClass, number>;
  let failures = 0, mapped_failures = 0, unmapped_failures = 0;
  for (const c of cases) {
    by_class[c.class] = (by_class[c.class] || 0) + 1;
    if (c.failure) {
      failures++;
      if (c.ui_flow === "unknown") unmapped_failures++; else mapped_failures++;
    }
  }

  return {
    schema_version: "lemma.api_coverage_report/v1",
    run_id,
    status: "completed",
    target,
    safe_target_validated: true,
    max_cases,
    spec_source: params.spec ? "provided" : null,
    traffic_source: params.traffic && params.traffic.length ? "provided" : null,
    cases,
    summary: { total_cases: cases.length, by_class, failures, mapped_failures, unmapped_failures, capped },
  };
}
