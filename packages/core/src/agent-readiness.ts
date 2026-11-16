import path from "node:path";
import { randomUUID } from "node:crypto";

import { StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { ensureDir, atomicWriteJson } from "./state.js";
import { redactUnknown } from "./redaction.js";
import { validateUrl } from "./ssrf.js";
import { now as deterministicNow } from "./determinism.js";

export type AgentReadinessDimension = "discoverability" | "semantics" | "safety" | "observability";
export type AgentReadinessStatus = "pass" | "fail" | "unknown";

export interface AgentReadinessCheck {
  id: string;
  dimension: AgentReadinessDimension;
  title: string;
  status: AgentReadinessStatus;
  details: string;
  evidence: string[];
}

export interface RunAgentReadinessParams {
  target: string;
  capabilities?: Record<string, unknown>;
  root?: string;
  runId?: string;
  stateDirName?: string;
  fetch?: (url: string) => Promise<{ status: number; ok: boolean; text?: string; headers?: Record<string, string> }>;
  page?: { url?: string; html?: string; labels?: string[]; ids?: string[]; errors?: unknown[]; logs?: unknown[]; traceIds?: string[]; forms?: Array<{ action?: string; method?: string; hasConfirmation?: boolean; gated?: boolean }>; openapi?: unknown; structuredData?: unknown };
}

export interface AgentReadinessReport {
  schema_version: "lemma.agent_readiness_report/v1";
  run_id: string;
  target: string;
  capabilities?: Record<string, unknown>;
  checks: AgentReadinessCheck[];
  summary: { total: number; pass: number; fail: number; unknown: number };
  evidence: { directory: string; manifest: string; artifacts: string[] };
  [key: string]: unknown;
}

async function safeFetch(fetcher: NonNullable<RunAgentReadinessParams["fetch"]>, url: string): Promise<{ status: number; ok: boolean; text?: string; headers?: Record<string, string> }> {
  try {
    await validateUrl(url);
    return await fetcher(url);
  } catch (e: any) {
    return { status: 0, ok: false, text: `fetch_error:${e?.message || String(e)}` };
  }
}

function check(id: string, dimension: AgentReadinessDimension, title: string, status: AgentReadinessStatus, details: string, evidence: string[]): AgentReadinessCheck {
  return { id, dimension, title, status, details, evidence };
}

function validateReportShape(report: AgentReadinessReport): void {
  if (report.schema_version !== "lemma.agent_readiness_report/v1") throw new StateError("Invalid AgentReadinessReport schema_version");
  if (!report.run_id) throw new StateError("Invalid AgentReadinessReport run_id");
  if (!Array.isArray(report.checks)) throw new StateError("Invalid AgentReadinessReport checks");
  for (const c of report.checks) {
    if (!c || typeof c.id !== "string" || !c.dimension || !c.title || !c.status || !Array.isArray(c.evidence)) {
      throw new StateError("Invalid AgentReadinessReport check");
    }
    if (!["discoverability", "semantics", "safety", "observability"].includes(c.dimension)) throw new StateError("Invalid check dimension");
    if (!["pass", "fail", "unknown"].includes(c.status)) throw new StateError("Invalid check status");
  }
  if (!report.summary || typeof report.summary.total !== "number") throw new StateError("Invalid AgentReadinessReport summary");
  if (!report.evidence || !Array.isArray(report.evidence.artifacts)) throw new StateError("Invalid AgentReadinessReport evidence");
}

export async function runAgentReadiness(params: RunAgentReadinessParams): Promise<AgentReadinessReport> {
  if (!params || typeof params.target !== "string" || !params.target) throw new StateError("runAgentReadiness requires target");
  const root = path.resolve(params.root ?? process.cwd());
  const runId = params.runId || `agent-readiness-${randomUUID()}`;
  await validateUrl(params.target);

  const evidence = new EvidenceStore(root, runId, { stateDirName: params.stateDirName ?? ".lemma" });
  await evidence.init();
  const outDir = path.join(root, ".lemma", "evidence", runId, "agent-readiness");
  await ensureDir(outDir);

  const fetcher = params.fetch ?? (async (url: string) => {
    const res = await fetch(url);
    const text = await res.text().catch(() => "");
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, ok: res.ok, text, headers };
  });

  const base = params.target.replace(/\/+$/, "");
  const discovered: Record<string, any> = {};
  const page = params.page || {};

  // Discoverability resources
  const robots = await safeFetch(fetcher, `${base}/robots.txt`);
  const sitemap = await safeFetch(fetcher, `${base}/sitemap.xml`);
  const wellKnown = await safeFetch(fetcher, `${base}/.well-known/security.txt`);
  const openapiRes = await safeFetch(fetcher, `${base}/openapi.json`);
  discovered.robots = { status: robots.status, ok: robots.ok };
  discovered.sitemap = { status: sitemap.status, ok: sitemap.ok };
  discovered.well_known = { status: wellKnown.status, ok: wellKnown.ok };
  discovered.openapi = { status: openapiRes.status, ok: openapiRes.ok };

  const discoveryEvidence = await evidence.saveJson("agent-readiness-discoverability", redactUnknown({
    target: params.target,
    robots: { ...discovered.robots, sample: (robots.text || "").slice(0, 500) },
    sitemap: { ...discovered.sitemap, sample: (sitemap.text || "").slice(0, 500) },
    well_known: { ...discovered.well_known, sample: (wellKnown.text || "").slice(0, 300) },
    openapi: { ...discovered.openapi, sample: (openapiRes.text || "").slice(0, 500) },
    structured_data: page.structuredData ?? null,
  }), "json", "Discoverability resources and samples", "agent-readiness");
  const semanticsEvidence = await evidence.saveJson("agent-readiness-semantics", redactUnknown({
    labels: page.labels ?? null,
    ids: page.ids ?? null,
    url: page.url ?? params.target,
    html_sample: (page.html || "").slice(0, 800),
  }), "json", "Semantics signals (labels/ids/URLs)", "agent-readiness");
  const safetyEvidence = await evidence.saveJson("agent-readiness-safety", redactUnknown({
    forms: page.forms ?? null,
    capabilities: params.capabilities ?? null,
  }), "json", "Safety signals (destructive actions/approval flows)", "agent-readiness");
  const observabilityEvidence = await evidence.saveJson("agent-readiness-observability", redactUnknown({
    errors: page.errors ?? null,
    logs: page.logs ?? null,
    trace_ids: page.traceIds ?? null,
  }), "json", "Observability signals (errors/logs/trace ids)", "agent-readiness");

  const checks: AgentReadinessCheck[] = [];

  // Discoverability
  if (robots.ok || sitemap.ok || wellKnown.ok) {
    checks.push(check("discoverability.resources", "discoverability", "Robots/sitemap/well-known resources discoverable", "pass", "At least one standard discovery resource is reachable.", [discoveryEvidence]));
  } else if (robots.status === 0 && sitemap.status === 0 && wellKnown.status === 0) {
    checks.push(check("discoverability.resources", "discoverability", "Robots/sitemap/well-known resources discoverable", "unknown", "Discovery resources could not be fetched/inspected.", [discoveryEvidence]));
  } else {
    checks.push(check("discoverability.resources", "discoverability", "Robots/sitemap/well-known resources discoverable", "fail", "Standard discovery resources were not reachable.", [discoveryEvidence]));
  }

  if (openapiRes.ok || page.openapi) {
    checks.push(check("discoverability.openapi", "discoverability", "OpenAPI or machine-readable API description available", "pass", "OpenAPI/machine-readable API description detected.", [discoveryEvidence]));
  } else if (openapiRes.status === 0 && !page.openapi) {
    checks.push(check("discoverability.openapi", "discoverability", "OpenAPI or machine-readable API description available", "unknown", "OpenAPI availability not confirmed (not fetched/inspected).", [discoveryEvidence]));
  } else {
    checks.push(check("discoverability.openapi", "discoverability", "OpenAPI or machine-readable API description available", "fail", "No OpenAPI/machine-readable API description detected at common location.", [discoveryEvidence]));
  }

  if (page.structuredData) {
    checks.push(check("discoverability.structured_data", "discoverability", "Structured data present", "pass", "Structured data provided/observed.", [discoveryEvidence]));
  } else if (page.html) {
    const hasSd = /application\/ld\+json|itemtype=|itemscope/i.test(page.html);
    checks.push(check("discoverability.structured_data", "discoverability", "Structured data present", hasSd ? "pass" : "fail", hasSd ? "Structured data markers found in HTML." : "No structured data markers found in inspected HTML.", [discoveryEvidence]));
  } else {
    checks.push(check("discoverability.structured_data", "discoverability", "Structured data present", "unknown", "Structured data not inspected.", [discoveryEvidence]));
  }

  // Semantics
  if (Array.isArray(page.labels)) {
    checks.push(check("semantics.labels", "semantics", "Meaningful labels present", page.labels.length > 0 ? "pass" : "fail", page.labels.length > 0 ? "Labels observed." : "No labels observed.", [semanticsEvidence]));
  } else if (page.html) {
    const hasLabels = /<label\b|aria-label=|aria-labelledby=/i.test(page.html);
    checks.push(check("semantics.labels", "semantics", "Meaningful labels present", hasLabels ? "pass" : "fail", hasLabels ? "Label/aria attributes detected." : "No label/aria attributes detected in inspected HTML.", [semanticsEvidence]));
  } else {
    checks.push(check("semantics.labels", "semantics", "Meaningful labels present", "unknown", "Labels not inspected.", [semanticsEvidence]));
  }

  if (Array.isArray(page.ids)) {
    checks.push(check("semantics.stable_ids", "semantics", "Stable IDs present", page.ids.length > 0 ? "pass" : "fail", page.ids.length > 0 ? "Element IDs observed." : "No element IDs observed.", [semanticsEvidence]));
  } else if (page.html) {
    const hasIds = /\sid=|data-testid=|data-test=/i.test(page.html);
    checks.push(check("semantics.stable_ids", "semantics", "Stable IDs present", hasIds ? "pass" : "fail", hasIds ? "ID/test-id attributes detected." : "No stable ID/test-id attributes detected in inspected HTML.", [semanticsEvidence]));
  } else {
    checks.push(check("semantics.stable_ids", "semantics", "Stable IDs present", "unknown", "Stable IDs not inspected.", [semanticsEvidence]));
  }

  const meaningfulUrl = /https?:\/\/.+\/.+/.test(params.target) || /https?:\/\/[^\/]+\/?$/.test(params.target);
  checks.push(check("semantics.meaningful_urls", "semantics", "Meaningful URLs used", meaningfulUrl ? "pass" : "unknown", meaningfulUrl ? "Target URL structure is inspectable." : "URL structure not sufficiently inspectable.", [semanticsEvidence]));

  // Safety
  if (Array.isArray(page.forms)) {
    const destructive = page.forms.filter(f => /delete|remove|destroy|cancel|purchase|pay|transfer/i.test(String(f.action || "")) || /post|put|delete/i.test(String(f.method || "").toLowerCase()));
    if (destructive.length === 0) {
      checks.push(check("safety.destructive_gated", "safety", "Destructive actions gated", "pass", "No destructive actions detected in inspected forms.", [safetyEvidence]));
    } else {
      const gated = destructive.every(f => f.gated || f.hasConfirmation);
      checks.push(check("safety.destructive_gated", "safety", "Destructive actions gated", gated ? "pass" : "fail", gated ? "Destructive actions appear gated/confirmed." : "Potentially destructive actions detected without clear gating/confirmation.", [safetyEvidence]));
    }
    const approvals = page.forms.some(f => f.gated || f.hasConfirmation);
    checks.push(check("safety.approval_flows", "safety", "Approval/confirmation flows present where needed", approvals ? "pass" : (destructive.length ? "fail" : "pass"), approvals ? "Approval/confirmation signals observed." : (destructive.length ? "No approval/confirmation flow observed for sensitive actions." : "No sensitive actions requiring approval detected."), [safetyEvidence]));
  } else {
    checks.push(check("safety.destructive_gated", "safety", "Destructive actions gated", "unknown", "Destructive actions not inspected.", [safetyEvidence]));
    checks.push(check("safety.approval_flows", "safety", "Approval/confirmation flows present where needed", "unknown", "Approval flows not inspected.", [safetyEvidence]));
  }

  // Observability
  if (Array.isArray(page.errors)) {
    checks.push(check("observability.error_shapes", "observability", "Structured error shapes observable", "pass", "Error signals/shape data provided for inspection.", [observabilityEvidence]));
  } else {
    checks.push(check("observability.error_shapes", "observability", "Structured error shapes observable", "unknown", "Error shapes not inspected.", [observabilityEvidence]));
  }
  if (Array.isArray(page.logs)) {
    checks.push(check("observability.logs", "observability", "Logs available/observable", "pass", "Log signals provided for inspection.", [observabilityEvidence]));
  } else {
    checks.push(check("observability.logs", "observability", "Logs available/observable", "unknown", "Logs not inspected.", [observabilityEvidence]));
  }
  if (Array.isArray(page.traceIds)) {
    checks.push(check("observability.trace_ids", "observability", "Trace/correlation IDs observable", page.traceIds.length > 0 ? "pass" : "fail", page.traceIds.length > 0 ? "Trace/correlation IDs observed." : "No trace/correlation IDs observed.", [observabilityEvidence]));
  } else {
    checks.push(check("observability.trace_ids", "observability", "Trace/correlation IDs observable", "unknown", "Trace/correlation IDs not inspected.", [observabilityEvidence]));
  }

  // enforce: every check cites evidence; unknowns never pass
  for (const c of checks) {
    if (!c.evidence.length) c.evidence.push(discoveryEvidence);
    if (c.status !== "pass" && c.status !== "fail") c.status = "unknown";
  }

  const summary = {
    total: checks.length,
    pass: checks.filter(c => c.status === "pass").length,
    fail: checks.filter(c => c.status === "fail").length,
    unknown: checks.filter(c => c.status === "unknown").length,
  };

  const report: AgentReadinessReport = {
    schema_version: "lemma.agent_readiness_report/v1",
    run_id: runId,
    target: params.target,
    ...(params.capabilities ? { capabilities: redactUnknown(params.capabilities) as any } : {}),
    checks,
    summary,
    evidence: {
      directory: `.lemma/evidence/${runId}/agent-readiness`,
      manifest: `.lemma/evidence/${runId}/manifest.json`,
      artifacts: [discoveryEvidence, semanticsEvidence, safetyEvidence, observabilityEvidence],
    },
  };

  validateReportShape(report);
  const reportPath = path.join(outDir, "agent-readiness-report.json");
  await atomicWriteJson(reportPath, redactUnknown(report));
  const repRef = await evidence.saveJson("agent-readiness-report", redactUnknown(report), "json", "Agent readiness report", "agent-readiness");
  report.evidence.artifacts = Array.from(new Set([...report.evidence.artifacts, repRef]));

  await evidence.finalize({ workflow: "agent-readiness", target: params.target, generated_at: deterministicNow() });
  validateReportShape(report);
  return report;
}
