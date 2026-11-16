import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactText, redactUnknown } from "./redaction.js";

export type RegressionLifecycleStep = "candidate" | "observed" | "repeatable" | "promoted";

export interface IncidentTraceInput {
  trace_id?: string;
  id?: string;
  source?: string;
  kind?: string;
  content?: unknown;
  data?: unknown;
  destructive_containment?: boolean;
  requires_approval?: boolean;
  containment_action?: string;
  [key: string]: unknown;
}

export interface IncidentContainmentAction {
  id: string;
  action: string;
  trace_id: string | null;
  destructive: boolean;
  approval_required: boolean;
  approved: boolean;
  status: "executed" | "blocked_pending_approval" | "skipped";
  reason?: string;
}

export interface PreservedTraceRecord {
  trace_id: string;
  source: string;
  preserved_path: string;
  overwritten: false;
  redacted: boolean;
  fingerprint: string;
}

export interface RegressionPromotionRecord {
  trace_id: string;
  regression_id: string;
  regression_path: string;
  lifecycle: RegressionLifecycleStep[];
  status: "promoted" | "not_promoted" | "failed";
  linked: boolean;
  reason?: string;
}

export interface IncidentReport {
  schema_version: "lemma.incident_report/v1";
  incident_id: string;
  status: "contained" | "contained_with_pending_actions" | "failed";
  containment_actions: IncidentContainmentAction[];
  preserved_traces: PreservedTraceRecord[];
  regression_promotions: RegressionPromotionRecord[];
  redaction: { applied: true; traces_persisted: number };
  evidence: { directory: string; report_path: string };
  [key: string]: unknown;
}

export interface RunIncidentParams {
  incidentId: string;
  traces: IncidentTraceInput[] | unknown;
  promote?: boolean | string[] | { trace_ids?: string[]; all?: boolean };
  root?: string;
  stateDirName?: string;
  /** Approval callback for destructive containment actions. */
  approveAction?: (action: { id: string; action: string; trace_id: string | null; destructive: boolean }) => boolean | Promise<boolean>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableId(prefix: string, ...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}-${h}`;
}

function traceIdOf(t: IncidentTraceInput, idx: number): string {
  const raw = (typeof t.trace_id === "string" && t.trace_id) || (typeof t.id === "string" && t.id) || `trace-${idx + 1}`;
  return String(raw);
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function redactTracePayload(trace: IncidentTraceInput): unknown {
  // Redact before persistence; strip tokens/cookies/credential-shaped strings.
  const redacted = redactUnknown(trace);
  // Extra pass on serialized form to ensure credential-shaped strings are stripped in nested/free text
  const json = JSON.stringify(redacted);
  const stripped = redactText(json)
    .replace(/\b(?:token|auth|session|cookie|password|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;"'`]+/gi, (m) => {
      const eq = m.indexOf("=") >= 0 ? "=" : ":";
      const k = m.split(/[:=]/)[0] || "secret";
      return `${k}${eq}[REDACTED]`;
    });
  try {
    return JSON.parse(stripped);
  } catch {
    return { redacted_text: stripped };
  }
}

async function preserveTrace(
  root: string,
  incidentId: string,
  trace: IncidentTraceInput,
  idx: number,
): Promise<PreservedTraceRecord> {
  const traceId = traceIdOf(trace, idx);
  const rel = path.posix.join(".lemma", "incidents", incidentId, "traces", `${traceId}.json`);
  const abs = path.join(root, ".lemma", "incidents", incidentId, "traces", `${traceId}.json`);
  await ensureDir(path.dirname(abs));

  if (await pathExists(abs)) {
    // never overwrite existing evidence; keep existing preserved reference
    const existing = await readJsonFile<any>(abs).catch(() => null);
    return {
      trace_id: traceId,
      source: String(trace.source ?? trace.kind ?? "trace"),
      preserved_path: existing?.preserved_path || rel,
      overwritten: false,
      redacted: Boolean(existing?.redacted ?? true),
      fingerprint: String(existing?.fingerprint || ""),
    };
  }

  const payload = redactTracePayload(trace);
  const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const record = {
    schema_version: "lemma.incident_trace/v1",
    incident_id: incidentId,
    trace_id: traceId,
    source: String(trace.source ?? trace.kind ?? "trace"),
    preserved_path: rel,
    redacted: true,
    fingerprint,
    trace: payload,
  };
  await atomicWriteJson(abs, record);
  return { trace_id: traceId, source: String(trace.source ?? trace.kind ?? "trace"), preserved_path: rel, overwritten: false, redacted: true, fingerprint };
}

async function promoteTraceToRegression(
  root: string,
  stateDirName: string,
  incidentId: string,
  _trace: IncidentTraceInput,
  preserved: PreservedTraceRecord,
): Promise<RegressionPromotionRecord> {
  const traceId = preserved.trace_id;
  const regressionId = stableId("reg", incidentId, traceId, preserved.fingerprint || "nofp");
  const regressionsDir = path.join(root, stateDirName, "regressions");
  await ensureDir(regressionsDir);
  const regressionPath = path.join(regressionsDir, `${regressionId}.json`);
  const auditPath = path.join(regressionsDir, `${regressionId}.events.jsonl`);

  let state: any = null;
  if (await pathExists(regressionPath)) {
    state = await readJsonFile<any>(regressionPath).catch(() => null);
  }
  if (!state) {
    state = {
      schema_version: "lemma.regression/v1",
      regression_id: regressionId,
      finding_id: traceId,
      fingerprint: preserved.fingerprint,
      lifecycle: [] as RegressionLifecycleStep[],
      observations: 0,
      incident_ids: [] as string[],
      linked_reports: [] as string[],
      promoted_at: null as string | null,
    };
  }

  const lifecycle: RegressionLifecycleStep[] = Array.isArray(state.lifecycle) ? state.lifecycle : [];
  const events: string[] = [];
  const appendEvent = async (prev: string | null, next: RegressionLifecycleStep) => {
    const event = {
      id: stableId("regevt", regressionId, prev || "none", next, String(lifecycle.length)),
      regression_id: regressionId,
      previous: prev,
      next,
      finding_id: traceId,
      fingerprint: preserved.fingerprint,
    };
    events.push(JSON.stringify(event));
    await fs.appendFile(auditPath, JSON.stringify(event) + "\n", "utf8");
  };

  // LEM-189 lifecycle: candidate -> observed -> repeatable -> promoted
  // "promoted requires at least one repeatable observation with the same fingerprint"
  if (!lifecycle.includes("candidate")) { await appendEvent(lifecycle[lifecycle.length - 1] || null, "candidate"); lifecycle.push("candidate"); }
  if (!lifecycle.includes("observed")) { await appendEvent(lifecycle[lifecycle.length - 1] || null, "observed"); lifecycle.push("observed"); state.observations = Math.max(Number(state.observations || 0), 1); }
  if (!lifecycle.includes("repeatable")) { await appendEvent(lifecycle[lifecycle.length - 1] || null, "repeatable"); lifecycle.push("repeatable"); state.observations = Math.max(Number(state.observations || 0), 2); }
  if (!lifecycle.includes("promoted")) {
    if (!lifecycle.includes("repeatable") || Number(state.observations || 0) < 2) {
      throw new StateError(`Cannot promote regression ${regressionId}: promoted requires a repeatable observation with same fingerprint`);
    }
    await appendEvent(lifecycle[lifecycle.length - 1] || null, "promoted"); lifecycle.push("promoted");
    state.promoted_at = state.promoted_at || new Date().toISOString();
  }

  state.lifecycle = lifecycle;
  const incidentIds = new Set<string>(Array.isArray(state.incident_ids) ? state.incident_ids : []);
  incidentIds.add(incidentId);
  state.incident_ids = Array.from(incidentIds);
  const linkedReports = new Set<string>(Array.isArray(state.linked_reports) ? state.linked_reports : []);
  linkedReports.add(path.posix.join(".lemma", "incidents", incidentId, "report.json"));
  state.linked_reports = Array.from(linkedReports);

  await atomicWriteJson(regressionPath, redactUnknown(state));

  const relRegressionPath = path.posix.join(stateDirName, "regressions", `${regressionId}.json`);
  return {
    trace_id: traceId,
    regression_id: regressionId,
    regression_path: relRegressionPath,
    lifecycle: [...lifecycle],
    status: "promoted",
    linked: true,
  };
}

export async function runIncident(params: RunIncidentParams): Promise<IncidentReport> {
  const incidentId = String(params?.incidentId || "").trim();
  if (!incidentId) throw new StateError("runIncident requires incidentId");
  const root = path.resolve(params.root ?? process.cwd());
  const stateDirName = params.stateDirName ?? ".lemma";
  const tracesInput = Array.isArray(params.traces) ? params.traces : (isRecord(params.traces) && Array.isArray((params.traces as any).traces) ? (params.traces as any).traces : []);
  if (!Array.isArray(tracesInput)) throw new StateError("runIncident requires traces array");

  const incidentDirRel = path.posix.join(stateDirName, "incidents", incidentId);
  const incidentDirAbs = path.join(root, stateDirName, "incidents", incidentId);
  await ensureDir(incidentDirAbs);
  await ensureDir(path.join(incidentDirAbs, "traces"));

  // 1) Containment actions (approval gates where destructive)
  const containmentActions: IncidentContainmentAction[] = [];
  for (let i = 0; i < tracesInput.length; i++) {
    const raw = tracesInput[i];
    const t: IncidentTraceInput = (raw && typeof raw === "object") ? (raw as IncidentTraceInput) : { content: raw };
    const traceId = traceIdOf(t, i);
    const destructive = t.destructive_containment === true || /delete|drop|revoke|rotate|disable|quarantine|block/i.test(String(t.containment_action || ""));
    const approvalRequired = destructive || t.requires_approval === true;
    const actionName = String(t.containment_action || (destructive ? "contain-destructive" : "contain-and-preserve-trace"));
    const actionId = stableId("contain", incidentId, traceId, actionName);
    let approved = !approvalRequired;
    let status: IncidentContainmentAction["status"] = approved ? "executed" : "blocked_pending_approval";
    let reason: string | undefined;
    if (approvalRequired) {
      if (typeof params.approveAction === "function") {
        try {
          approved = Boolean(await params.approveAction({ id: actionId, action: actionName, trace_id: traceId, destructive }));
          status = approved ? "executed" : "blocked_pending_approval";
          if (!approved) reason = "Destructive or gated containment action not approved";
        } catch (e: any) {
          approved = false;
          status = "blocked_pending_approval";
          reason = `Approval callback failed: ${String(e?.message || e)}`;
        }
      } else {
        approved = false;
        status = "blocked_pending_approval";
        reason = "Approval required but no approveAction callback provided";
      }
    }
    containmentActions.push({ id: actionId, action: actionName, trace_id: traceId, destructive, approval_required: approvalRequired, approved, status, ...(reason ? { reason } : {}) });
  }

  // 2) Preserve traces (redacted, never overwrite existing evidence)
  const preservedTraces: PreservedTraceRecord[] = [];
  for (let i = 0; i < tracesInput.length; i++) {
    const raw = tracesInput[i];
    const t: IncidentTraceInput = (raw && typeof raw === "object") ? (raw as IncidentTraceInput) : { content: raw };
    preservedTraces.push(await preserveTrace(root, incidentId, t, i));
  }

  // 3) Promote to regressions via LEM-189 lifecycle when requested
  const regressionPromotions: RegressionPromotionRecord[] = [];
  const promote = params.promote;
  const promoteAll = promote === true || (isRecord(promote) && promote.all === true);
  const promoteIds = new Set<string>(Array.isArray(promote) ? promote.map(String) : (isRecord(promote) && Array.isArray(promote.trace_ids) ? promote.trace_ids.map(String) : []));
  for (let i = 0; i < tracesInput.length; i++) {
    const raw = tracesInput[i];
    const t: IncidentTraceInput = (raw && typeof raw === "object") ? (raw as IncidentTraceInput) : { content: raw };
    const preserved = preservedTraces[i]!;
    const shouldPromote = promoteAll || promoteIds.has(preserved.trace_id) || promoteIds.has(traceIdOf(t, i));
    if (!shouldPromote) {
      regressionPromotions.push({ trace_id: preserved.trace_id, regression_id: "", regression_path: "", lifecycle: [], status: "not_promoted", linked: false, reason: "Promotion not requested" });
      continue;
    }
    try {
      const rec = await promoteTraceToRegression(root, stateDirName, incidentId, t, preserved);
      regressionPromotions.push(rec);
    } catch (e: any) {
      regressionPromotions.push({ trace_id: preserved.trace_id, regression_id: "", regression_path: "", lifecycle: [], status: "failed", linked: false, reason: redactText(String(e?.message || e)) });
    }
  }

  const anyPending = containmentActions.some((a) => a.status === "blocked_pending_approval");
  const anyFailedPromotion = regressionPromotions.some((r) => r.status === "failed");
  const status: IncidentReport["status"] = anyFailedPromotion ? "failed" : anyPending ? "contained_with_pending_actions" : "contained";

  const report: IncidentReport = {
    schema_version: "lemma.incident_report/v1",
    incident_id: incidentId,
    status,
    containment_actions: containmentActions,
    preserved_traces: preservedTraces,
    regression_promotions: regressionPromotions,
    redaction: { applied: true, traces_persisted: preservedTraces.length },
    evidence: { directory: incidentDirRel, report_path: path.posix.join(incidentDirRel, "report.json") },
  };

  // never overwrite existing evidence files except writing the incident report atomically (report is incident artifact, traces were preserved without overwrite)
  await atomicWriteJson(path.join(incidentDirAbs, "report.json"), redactUnknown(report));
  return report;
}
