import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import { atomicWriteJson, ensureDir, readJsonFile } from "@lemma/core";
import { AuthError, AuthStore, SCOPE_READ, SCOPE_RUN } from "@lemma/cloud/auth";
import { MeteringEmitter } from "@lemma/cloud/metering";
import { JobQueue, STATUS_COMPLETED, STATUS_QUEUED, type QueueJob } from "@lemma/cloud/queue";
import { QuotaExceeded, QuotaPlan, QuotaStore } from "@lemma/cloud/quota";
import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "@lemma/pro/entitlement";

export const REPORTS_API_BASE = "/api/reports" as const;

export class ReportsApiAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 401, code = "unauthorized") {
    super(message);
    this.name = "ReportsApiAuthError";
    this.status = status;
    this.code = code;
  }
}

export interface ReportsApiOptions {
  host?: string;
  port?: number;
  root: string; // storage root for auth/quota/queue/metering/reports (tenant-isolated)
  license?: ProLicenseContext | null;
  authStorePath?: string;
  quotaPlan?: any;
  quotaStorePath?: string;
  quotaEventsPath?: string;
  queuePath?: string;
  meteringSink?: string;
  /** injectable run executor for tests/integration; must return result for queued job */
  executor?: (job: QueueJob, ctx: { workspaceId: string; root: string }) => Promise<Partial<QueueJob> & { report?: any }> | (Partial<QueueJob> & { report?: any });
}

export interface ReportsApiHandle {
  server: http.Server;
  baseUrl: string;
  root: string;
  authStore: AuthStore;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ReportsApiAuthError("Invalid JSON body", 400, "bad_request"); }
}

function getBearer(req: http.IncomingMessage): string {
  const h = req.headers["authorization"];
  const raw = Array.isArray(h) ? h[0] : h;
  if (typeof raw === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
    if (m?.[1]) return m[1].trim();
  }
  throw new ReportsApiAuthError("Missing bearer token", 401, "unauthorized");
}

function reportStoragePath(root: string, workspaceId: string, reportId: string): string {
  return path.join(root, ".lemma", "tenants", workspaceId, "reports", `${reportId}.json`);
}

async function storeReport(root: string, workspaceId: string, reportId: string, payload: any): Promise<string> {
  const p = reportStoragePath(root, workspaceId, reportId);
  await ensureDir(path.dirname(p));
  await atomicWriteJson(p, payload);
  return p;
}

async function loadStoredReport(root: string, workspaceId: string, reportId: string): Promise<any | null> {
  const p = reportStoragePath(root, workspaceId, reportId);
  try { return await readJsonFile<any>(p); } catch { return null; }
}

function toApiJob(job: any, report?: any | null) {
  return {
    id: job.job_id,
    status: job.status,
    workspace_id: job.workspace_id,
    run_id: job.run_id ?? null,
    created_at: job.created_at ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    target: job.target ?? null,
    ...(job.error ? { error: String(job.error) } : {}),
    ...(report !== undefined ? { report: report ?? null } : {}),
    links: { self: `${REPORTS_API_BASE}/${job.job_id}` },
  };
}

export async function createReportsApiServer(opts: ReportsApiOptions): Promise<ReportsApiHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const root = path.resolve(opts.root);
  await ensureDir(root);

  const authStore = new AuthStore(root, opts.authStorePath ?? ".lemma/cloud/auth.json");
  const meteringSink = opts.meteringSink ?? ".lemma/metering/events.jsonl";
  const plan = opts.quotaPlan instanceof QuotaPlan ? opts.quotaPlan : (opts.quotaPlan ? QuotaPlan.fromDict(opts.quotaPlan) : new QuotaPlan({ id: "default", limits: { runs: { hard: 1000 }, checks: { hard: 100000 } } }));
  const quotaStorePath = opts.quotaStorePath ?? ".lemma/quota/usage.json";
  const quotaEventsPath = opts.quotaEventsPath ?? ".lemma/quota/events.jsonl";
  const quotaFor = (workspaceId: string) => new QuotaStore(root, plan, { workspace: workspaceId, store_path: quotaStorePath, events_path: quotaEventsPath, enforce: true });

  const defaultExecutor = async (job: QueueJob, ctx: { workspaceId: string; root: string }) => {
    const report = {
      schema_version: "quality-harness.report/v1",
      run_id: job.run_id ?? `run-${job.job_id}`,
      status: "completed",
      target: { raw: job.target, kind: "url", resolved: job.target, source: "reports-api" },
      decision: { decision: "hold", rationale: "Report generated by reports-api executor." },
      findings: [],
      summary: { generated_by: "pro-services/reports-api" },
      workspace_id: ctx.workspaceId,
      job_id: job.job_id,
    };
    const p = await storeReport(ctx.root, ctx.workspaceId, job.job_id, report);
    return { status: STATUS_COMPLETED, run_id: report.run_id, report_path: p, findings: 0, status_detail: "completed", report } as any;
  };

  const queue = new JobQueue(root, {
    queuePath: opts.queuePath ?? ".lemma/cloud/queue.json",
    tenantRoot: ".lemma/tenants",
    maxAttempts: 1,
    executor: async (job) => {
      const exec = opts.executor ?? defaultExecutor;
      const result = await exec(job, { workspaceId: job.workspace_id, root });
      if ((result as any).report) {
        await storeReport(root, job.workspace_id, job.job_id, (result as any).report);
        if (!(result as any).report_path) (result as any).report_path = reportStoragePath(root, job.workspace_id, job.job_id);
      }
      return result as any;
    },
  });

  function requireLicensed(): void {
    if (!isProLicensed(opts.license ?? null)) throw new ProUnavailableError("test reports REST API");
  }

  function emitRequestMeter(workspaceId: string, runId: string, action: string): void {
    const emitter = new MeteringEmitter(root, runId, { workspace: workspaceId, sink: meteringSink, source: "pro:reports-api" });
    emitter.emit("export_generated", 1, "export", {
      metadata: { format: "reports_api", action },
      idempotency_key: `${runId}:reports_api:${action}:${randomUUID()}`,
    });
  }

  function quotaCheckEveryRequest(workspaceId: string, auth: any, action: "post" | "get"): void {
    // every request is quota-checked (LEM-115); enforce against workspace quota
    const quota = quotaFor(workspaceId);
    if (action === "post") {
      quota.consumeFor(auth, "runs", 1, { metadata: { action } });
    } else {
      // read/check quota state for request enforcement context
      quota.snapshotFor(auth);
      // also consume a minimal check unit to ensure enforcement path is exercised per request
      quota.consumeFor(auth, "checks", 1, { metadata: { action } });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const method = (req.method || "GET").toUpperCase();

      if (!pathname.startsWith(REPORTS_API_BASE)) {
        sendJson(res, 404, { error: { code: "not_found", message: "Not found", type: "invalid_request_error" } });
        return;
      }

      // Unlicensed invocation returns ProUnavailableError
      requireLicensed();

      // Auth uses Pro-tier scoped-key contract (LEM-114)
      const token = getBearer(req);
      const auth = authStore.authenticate(token);

      if (method === "POST" && pathname === REPORTS_API_BASE) {
        auth.require(SCOPE_RUN);
        quotaCheckEveryRequest(auth.workspaceId, auth, "post");
        emitRequestMeter(auth.workspaceId, `reports-post-${Date.now()}-${Math.random().toString(16).slice(2)}`, "create");

        const body = await readBody(req);
        const target = typeof body?.target === "string" ? body.target.trim() : "";
        if (!target) {
          sendJson(res, 400, { error: { code: "bad_request", message: "target is required", type: "invalid_request_error" } });
          return;
        }
        const job = queue.submit(auth.workspaceId, target, { options: body?.options || {}, source: body?.source, intent: body?.intent });
        // process async via queue (LEM-119) - kick off processing without blocking response
        void queue.processPending().catch(() => {});
        sendJson(res, 202, toApiJob(job));
        return;
      }

      if (method === "GET" && pathname.startsWith(`${REPORTS_API_BASE}/`)) {
        auth.require(SCOPE_READ);
        const reportId = decodeURIComponent(pathname.slice(REPORTS_API_BASE.length + 1)).trim();
        if (!reportId) {
          sendJson(res, 400, { error: { code: "bad_request", message: "report id required", type: "invalid_request_error" } });
          return;
        }
        quotaCheckEveryRequest(auth.workspaceId, auth, "get");
        emitRequestMeter(auth.workspaceId, `reports-get-${reportId}`, "get");

        const job = queue.getJob(auth.workspaceId, reportId);
        if (!job) {
          // never leak cross-tenant existence: return 404 for missing or other-tenant
          sendJson(res, 404, { error: { code: "not_found", message: "Report not found", type: "not_found" } });
          return;
        }
        let report: any | null = null;
        if (job.status === STATUS_COMPLETED) {
          report = await loadStoredReport(root, auth.workspaceId, reportId);
        }
        sendJson(res, 200, toApiJob(job, report));
        return;
      }

      sendJson(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed", type: "invalid_request_error" } });
    } catch (e: any) {
      if (e instanceof ProUnavailableError) {
        sendJson(res, 403, { error: { code: (e as any).errorCode || "pro_unavailable", message: e.message, type: "pro_unavailable", name: e.name } });
        return;
      }
      if (e instanceof AuthError) {
        const body = e.toDict();
        sendJson(res, e.statusCode || 401, { error: { code: body.error.code, message: body.error.message, type: "authentication_error", required_scope: body.error.required_scope } });
        return;
      }
      if (e instanceof ReportsApiAuthError) {
        sendJson(res, e.status, { error: { code: e.code, message: e.message, type: "authentication_error" } });
        return;
      }
      if (e instanceof QuotaExceeded) {
        sendJson(res, 429, { error: { code: "quota_exceeded", message: e.message || "Quota exceeded", type: "quota_error" } });
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error", message: "Internal server error", type: "server_error" } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    baseUrl: `http://${host}:${actualPort}`,
    root,
    authStore,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
