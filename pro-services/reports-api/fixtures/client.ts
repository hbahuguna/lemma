/** Repo-owned client fixture for Test Reports REST API wire conformance. */

export interface CreateReportRequest {
  target: string;
  options?: Record<string, unknown>;
  source?: string;
  intent?: string;
}

export interface ReportJobResponse {
  id: string;
  status: string;
  workspace_id: string;
  run_id?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  report?: any | null;
  error?: string | null;
  links?: Record<string, unknown>;
  [k: string]: unknown;
}

export async function postReport(baseUrl: string, req: CreateReportRequest, opts: { apiKey?: string } = {}) {
  return fetch(`${baseUrl.replace(/\/$/, "")}/api/reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(req),
  });
}

export async function getReport(baseUrl: string, id: string, opts: { apiKey?: string } = {}) {
  return fetch(`${baseUrl.replace(/\/$/, "")}/api/reports/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: {
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
  });
}

export function assertCreateResponse(value: any): asserts value is ReportJobResponse {
  if (!value || typeof value !== "object") throw new Error("response must be object");
  if (typeof value.id !== "string" || !value.id) throw new Error("id required");
  if (typeof value.status !== "string" || !value.status) throw new Error("status required");
  if (typeof value.workspace_id !== "string" || !value.workspace_id) throw new Error("workspace_id required");
  if (!("created_at" in value)) throw new Error("created_at required");
}

export function assertGetResponse(value: any): asserts value is ReportJobResponse {
  assertCreateResponse(value);
  if (!("report" in value)) throw new Error("report field required");
}
