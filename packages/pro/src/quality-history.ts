import path from "node:path";

import { StateError, atomicWriteJson, ensureDir, now, readJsonFile } from "@lemma/core";

// Dashboard (LEM-143) integration is explicitly out of scope for this task (LEM-160)
// to avoid entangling the Pro tier with the free dashboard. A follow-up task can add
// a Pro dashboard route later if the boundary ADR (LEM-156) allows it.

import { requireProLicense, type ProLicenseContext } from "./entitlement.js";
import type { TestInventory } from "./inventory.js";
import { DEFAULT_INVENTORY_HISTORY_CAP, MAX_INVENTORY_HISTORY_CAP } from "./inventory.js";

export const QUALITY_HISTORY_SCHEMA_VERSION = "lemma.pro.quality_history/v1" as const;

export interface QualityHistoryRunPoint {
  run_id: string;
  observed_at?: string | null;
  score: number | null;
  decision: string | null;
  coverage: number | null;
  findings_by_severity: Record<string, number>;
  blocker_count: number;
  [key: string]: unknown;
}

export interface QualityHistoryCheckStatusChanges {
  /** Checks newly present/failing in current window run vs previous (LEM-068 vocabulary). */
  new: string[];
  /** Checks present/failing previously but not in current (LEM-068 vocabulary). */
  resolved: string[];
  /** Checks present/failing in both previous and current (LEM-068 vocabulary). */
  persistent: string[];
  baseline: boolean;
  previous_run_id: string | null;
  current_run_id: string | null;
  [key: string]: unknown;
}

export interface QualityHistory {
  schema_version: typeof QUALITY_HISTORY_SCHEMA_VERSION;
  project_root: string;
  generated_at: string;
  window: number;
  history_cap: number;
  runs: QualityHistoryRunPoint[];
  score_trend: Array<{ run_id: string; score: number | null }>;
  decision_trend: Array<{ run_id: string; decision: string | null }>;
  coverage_trend: Array<{ run_id: string; coverage: number | null }>;
  findings_by_severity_trend: Array<{ run_id: string; findings_by_severity: Record<string, number> }>;
  blocker_trend: Array<{ run_id: string; blocker_count: number }>;
  check_status_changes: QualityHistoryCheckStatusChanges;
  [key: string]: unknown;
}

export interface HistoryBuildOptions {
  projectRoot: string;
  inventory: TestInventory | { checks: any[]; runs_indexed?: string[] };
  window?: number | { size?: number; n?: number } | null;
  license?: ProLicenseContext | null;
  /** Persist to .lemma/pro/quality-history.json (default true). */
  persist?: boolean;
  /** Bounded growth cap (default 20, max 50), same policy as inventory. */
  historyCap?: number;
  /** Optional run-level snapshots (reports/summaries) to source score/decision/coverage/severity/blockers. */
  runs?: unknown[];
  now?: () => string;
}

export interface HistoryReadOptions {
  projectRoot: string;
  license?: ProLicenseContext | null;
  window?: number | { size?: number; n?: number } | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clampHistoryCap(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : DEFAULT_INVENTORY_HISTORY_CAP;
  return Math.max(1, Math.min(MAX_INVENTORY_HISTORY_CAP, v));
}

function resolveWindow(w: HistoryBuildOptions["window"]): number {
  if (typeof w === "number" && Number.isFinite(w)) return Math.max(1, Math.floor(w));
  if (isRecord(w)) {
    const n = asNumber(w.size) ?? asNumber(w.n);
    if (n !== null) return Math.max(1, Math.floor(n));
  }
  return 10;
}

function resolveProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

export function historyPath(projectRoot: string): string {
  return path.join(resolveProjectRoot(projectRoot), ".lemma", "pro", "quality-history.json");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === "string" && v.length > 0))).sort();
}

function severityCountsFromRun(run: unknown): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  if (!isRecord(run)) return counts;
  const findings = Array.isArray(run.findings) ? run.findings : (isRecord(run.report) && Array.isArray((run.report as any).findings) ? (run.report as any).findings : []);
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (!isRecord(f)) continue;
      const sev = String(f.severity || "medium").toLowerCase();
      if (!(sev in counts)) counts[sev] = 0;
      counts[sev]! += 1;
    }
  }
  // support precomputed
  const pre = isRecord(run.findings_by_severity) ? run.findings_by_severity : (isRecord(run.confidence) && isRecord((run.confidence as any).findings_by_severity) ? (run.confidence as any).findings_by_severity : null);
  if (isRecord(pre)) {
    for (const [k, v] of Object.entries(pre)) {
      const n = asNumber(v);
      if (n !== null) counts[k] = Math.max(0, Math.floor(n));
    }
  }
  return counts;
}

function blockerCountFromRun(run: unknown): number {
  if (!isRecord(run)) return 0;
  const blockers = Array.isArray(run.blockers) ? run.blockers : (isRecord(run.report) && Array.isArray((run.report as any).blockers) ? (run.report as any).blockers : []);
  if (Array.isArray(blockers)) return blockers.length;
  const n = asNumber(run.blocker_count);
  return n !== null ? Math.max(0, Math.floor(n)) : 0;
}

function runIdOf(run: unknown, idx: number): string {
  if (!isRecord(run)) return `run_${idx + 1}`;
  return asString(run.run_id) || (isRecord(run.run) ? asString(run.run.run_id) : null) || asString(run.id) || `run_${idx + 1}`;
}

function observedAtOf(run: unknown): string | null {
  if (!isRecord(run)) return null;
  return asString(run.generated_at) || asString(run.completed_at) || (isRecord(run.run) ? (asString(run.run.completed_at) || asString(run.run.generated_at)) : null) || asString(run.observed_at);
}

function runPoint(run: unknown, idx: number): QualityHistoryRunPoint {
  const r = isRecord(run) ? run : {};
  const conf = isRecord(r.confidence) ? r.confidence : (isRecord(r.report) && isRecord((r.report as any).confidence) ? (r.report as any).confidence : {});
  const decisionObj = isRecord(r.decision) ? r.decision : (isRecord(r.report) && isRecord((r.report as any).decision) ? (r.report as any).decision : {});
  const score = asNumber(r.score) ?? (isRecord(conf) ? asNumber((conf as any).score) : null);
  const coverageRaw = asNumber(r.coverage) ?? (isRecord(conf) ? asNumber((conf as any).coverage) : null);
  const coverage = coverageRaw === null ? null : (coverageRaw <= 1 ? coverageRaw * 100 : coverageRaw);
  const decision = asString(r.decision) || (isRecord(decisionObj) ? asString((decisionObj as any).decision) : null);
  return {
    run_id: runIdOf(run, idx),
    observed_at: observedAtOf(run),
    score,
    decision,
    coverage,
    findings_by_severity: severityCountsFromRun(run),
    blocker_count: blockerCountFromRun(run),
  };
}

function deriveRunsFromInventory(inventory: TestInventory | { checks: any[]; runs_indexed?: string[] }): QualityHistoryRunPoint[] {
  const ids = Array.isArray((inventory as any).runs_indexed) ? ((inventory as any).runs_indexed as string[]) : [];
  const checks = Array.isArray((inventory as any).checks) ? ((inventory as any).checks as any[]) : [];
  return ids.map((runId) => {
    let observed: string | null = null;
    let blockers = 0;
    const sev: Record<string, number> = {};
    for (const c of checks) {
      if (!isRecord(c)) continue;
      const hist = Array.isArray(c.recent_history) ? c.recent_history : [];
      const entry = hist.find((h: any) => isRecord(h) && h.run_id === runId) as any;
      if (!entry) continue;
      if (!observed && typeof entry.observed_at === "string") observed = entry.observed_at;
      // count failed/blocked/error as potential quality blockers proxy at check level if no richer data
      const st = String(entry.status || "").toLowerCase();
      if (st === "failed" || st === "blocked" || st === "error") blockers += 1;
    }
    return {
      run_id: runId,
      observed_at: observed,
      score: null,
      decision: null,
      coverage: null,
      findings_by_severity: sev,
      blocker_count: blockers,
    };
  });
}

function mergeRunPoints(base: QualityHistoryRunPoint[], richer: QualityHistoryRunPoint[]): QualityHistoryRunPoint[] {
  const byId = new Map<string, QualityHistoryRunPoint>();
  for (const p of base) byId.set(p.run_id, { ...p });
  for (const p of richer) {
    const prev = byId.get(p.run_id);
    if (!prev) { byId.set(p.run_id, { ...p }); continue; }
    byId.set(p.run_id, {
      ...prev,
      ...p,
      observed_at: p.observed_at ?? prev.observed_at ?? null,
      score: p.score ?? prev.score,
      decision: p.decision ?? prev.decision,
      coverage: p.coverage ?? prev.coverage,
      findings_by_severity: Object.keys(p.findings_by_severity || {}).length ? p.findings_by_severity : prev.findings_by_severity,
      blocker_count: (p.blocker_count || prev.blocker_count) ? Math.max(p.blocker_count || 0, prev.blocker_count || 0) : 0,
    });
  }
  // preserve base order, append unknown richer
  const ordered: QualityHistoryRunPoint[] = [];
  const seen = new Set<string>();
  for (const p of base) { if (byId.has(p.run_id)) { ordered.push(byId.get(p.run_id)!); seen.add(p.run_id); } }
  for (const p of richer) { if (!seen.has(p.run_id) && byId.has(p.run_id)) { ordered.push(byId.get(p.run_id)!); seen.add(p.run_id); } }
  return ordered;
}

function isIssueStatus(status: unknown): boolean {
  const s = String(status || "").toLowerCase();
  return s === "failed" || s === "error" || s === "blocked";
}

function checksSetForRun(inventory: TestInventory | { checks: any[] }, runId: string | null): Set<string> {
  const set = new Set<string>();
  if (!runId) return set;
  const checks = Array.isArray((inventory as any).checks) ? ((inventory as any).checks as any[]) : [];
  for (const c of checks) {
    if (!isRecord(c)) continue;
    const id = asString(c.stable_id);
    if (!id) continue;
    const hist = Array.isArray(c.recent_history) ? c.recent_history : [];
    const entry = hist.find((h: any) => isRecord(h) && h.run_id === runId) as any;
    if (entry && isIssueStatus(entry.status)) set.add(id);
  }
  return set;
}

function sortedSet(values: Iterable<string>): string[] {
  return sortedUnique(Array.from(values));
}

function computeCheckStatusChanges(inventory: TestInventory | { checks: any[] }, windowRuns: QualityHistoryRunPoint[]): QualityHistoryCheckStatusChanges {
  const current = windowRuns.length ? windowRuns[windowRuns.length - 1]! : null;
  const previous = windowRuns.length >= 2 ? windowRuns[windowRuns.length - 2]! : null;
  const currentId = current?.run_id ?? null;
  const prevId = previous?.run_id ?? null;

  if (!currentId || !prevId) {
    const curSet = checksSetForRun(inventory, currentId);
    return {
      new: [],
      resolved: [],
      persistent: sortedSet(curSet),
      baseline: true,
      previous_run_id: null,
      current_run_id: currentId,
    };
  }

  const prevSet = checksSetForRun(inventory, prevId);
  const curSet = checksSetForRun(inventory, currentId);
  const newly = sortedSet(Array.from(curSet).filter((x) => !prevSet.has(x)));
  const resolved = sortedSet(Array.from(prevSet).filter((x) => !curSet.has(x)));
  const persistent = sortedSet(Array.from(curSet).filter((x) => prevSet.has(x)));
  return {
    new: newly,
    resolved,
    persistent,
    baseline: false,
    previous_run_id: prevId,
    current_run_id: currentId,
  };
}

export function validateQualityHistory(value: unknown): QualityHistory {
  if (!isRecord(value)) throw new StateError("Invalid quality history: expected object", { details: { reason: "not_object" } });
  if (value.schema_version !== QUALITY_HISTORY_SCHEMA_VERSION) {
    throw new StateError(`Invalid quality history schema_version: ${String(value.schema_version)}`, { details: { schema_version: value.schema_version } });
  }
  if (typeof value.project_root !== "string" || !value.project_root) throw new StateError("Invalid quality history: project_root required", { details: { field: "project_root" } });
  if (typeof value.generated_at !== "string" || !value.generated_at) throw new StateError("Invalid quality history: generated_at required", { details: { field: "generated_at" } });
  const window = Math.max(1, Math.floor(asNumber(value.window) ?? 1));
  const historyCap = clampHistoryCap(value.history_cap);
  const runsRaw = Array.isArray(value.runs) ? value.runs.filter(isRecord) : [];
  const runs: QualityHistoryRunPoint[] = runsRaw.slice(-historyCap).map((r, i) => ({
    run_id: asString(r.run_id) || `run_${i + 1}`,
    observed_at: typeof r.observed_at === "string" ? r.observed_at : (r.observed_at === null ? null : null),
    score: asNumber(r.score),
    decision: asString(r.decision),
    coverage: asNumber(r.coverage),
    findings_by_severity: isRecord(r.findings_by_severity)
      ? Object.fromEntries(Object.entries(r.findings_by_severity).map(([k, v]) => [k, Math.max(0, Math.floor(asNumber(v) ?? 0))]))
      : {},
    blocker_count: Math.max(0, Math.floor(asNumber(r.blocker_count) ?? 0)),
  }));

  const changesRaw = isRecord(value.check_status_changes) ? value.check_status_changes : {};
  const check_status_changes: QualityHistoryCheckStatusChanges = {
    new: sortedUnique(Array.isArray(changesRaw.new) ? changesRaw.new.filter((x): x is string => typeof x === "string") : []),
    resolved: sortedUnique(Array.isArray(changesRaw.resolved) ? changesRaw.resolved.filter((x): x is string => typeof x === "string") : []),
    persistent: sortedUnique(Array.isArray(changesRaw.persistent) ? changesRaw.persistent.filter((x): x is string => typeof x === "string") : []),
    baseline: Boolean(changesRaw.baseline),
    previous_run_id: asString(changesRaw.previous_run_id),
    current_run_id: asString(changesRaw.current_run_id),
  };

  return {
    schema_version: QUALITY_HISTORY_SCHEMA_VERSION,
    project_root: value.project_root,
    generated_at: value.generated_at,
    window,
    history_cap: historyCap,
    runs,
    score_trend: Array.isArray(value.score_trend)
      ? (value.score_trend as any[]).filter(isRecord).map((x) => ({ run_id: asString(x.run_id) || "", score: asNumber(x.score) }))
      : runs.map((r) => ({ run_id: r.run_id, score: r.score })),
    decision_trend: Array.isArray(value.decision_trend)
      ? (value.decision_trend as any[]).filter(isRecord).map((x) => ({ run_id: asString(x.run_id) || "", decision: asString(x.decision) }))
      : runs.map((r) => ({ run_id: r.run_id, decision: r.decision })),
    coverage_trend: Array.isArray(value.coverage_trend)
      ? (value.coverage_trend as any[]).filter(isRecord).map((x) => ({ run_id: asString(x.run_id) || "", coverage: asNumber(x.coverage) }))
      : runs.map((r) => ({ run_id: r.run_id, coverage: r.coverage })),
    findings_by_severity_trend: Array.isArray(value.findings_by_severity_trend)
      ? (value.findings_by_severity_trend as any[]).filter(isRecord).map((x) => ({ run_id: asString(x.run_id) || "", findings_by_severity: isRecord(x.findings_by_severity) ? Object.fromEntries(Object.entries(x.findings_by_severity).map(([k,v]) => [k, Math.max(0, Math.floor(asNumber(v) ?? 0))])) : {} }))
      : runs.map((r) => ({ run_id: r.run_id, findings_by_severity: r.findings_by_severity })),
    blocker_trend: Array.isArray(value.blocker_trend)
      ? (value.blocker_trend as any[]).filter(isRecord).map((x) => ({ run_id: asString(x.run_id) || "", blocker_count: Math.max(0, Math.floor(asNumber(x.blocker_count) ?? 0)) }))
      : runs.map((r) => ({ run_id: r.run_id, blocker_count: r.blocker_count })),
    check_status_changes,
  };
}

export async function historyBuild(options: HistoryBuildOptions): Promise<QualityHistory> {
  requireProLicense(options.license ?? null, "quality history and trend analysis");

  const projectRoot = resolveProjectRoot(options.projectRoot);
  const window = resolveWindow(options.window);
  const historyCap = clampHistoryCap(options.historyCap);
  const inventory = options.inventory ?? { checks: [], runs_indexed: [] };

  let runs: QualityHistoryRunPoint[] = deriveRunsFromInventory(inventory as any);
  if (Array.isArray(options.runs) && options.runs.length) {
    const richer = options.runs.map((r, i) => runPoint(r, i));
    runs = mergeRunPoints(runs, richer);
  }
  // apply window (most recent N) and bounded growth cap
  const effectiveCap = Math.min(historyCap, window);
  const windowRuns = runs.slice(-effectiveCap);

  const check_status_changes = computeCheckStatusChanges(inventory as any, windowRuns);
  const generatedAt = options.now ? options.now() : (now() as string);

  const history: QualityHistory = validateQualityHistory({
    schema_version: QUALITY_HISTORY_SCHEMA_VERSION,
    project_root: projectRoot,
    generated_at: generatedAt,
    window: effectiveCap,
    history_cap: historyCap,
    runs: windowRuns,
    score_trend: windowRuns.map((r) => ({ run_id: r.run_id, score: r.score })),
    decision_trend: windowRuns.map((r) => ({ run_id: r.run_id, decision: r.decision })),
    coverage_trend: windowRuns.map((r) => ({ run_id: r.run_id, coverage: r.coverage })),
    findings_by_severity_trend: windowRuns.map((r) => ({ run_id: r.run_id, findings_by_severity: r.findings_by_severity })),
    blocker_trend: windowRuns.map((r) => ({ run_id: r.run_id, blocker_count: r.blocker_count })),
    check_status_changes,
  });

  if (options.persist !== false) {
    await historyWrite(projectRoot, history);
  }
  return history;
}

export async function historyWrite(projectRoot: string, history: QualityHistory): Promise<string> {
  const filePath = historyPath(projectRoot);
  await ensureDir(path.dirname(filePath));
  const validated = validateQualityHistory(history);
  await atomicWriteJson(filePath, validated);
  return filePath;
}

export async function historyRead(options: HistoryReadOptions): Promise<QualityHistory> {
  requireProLicense(options.license ?? null, "quality history and trend analysis");
  const filePath = historyPath(options.projectRoot);
  try {
    const data = await readJsonFile<unknown>(filePath);
    const hist = validateQualityHistory(data);
    if (options.window !== undefined && options.window !== null) {
      const w = resolveWindow(options.window);
      if (w < hist.runs.length) {
        const runs = hist.runs.slice(-w);
        return validateQualityHistory({ ...hist, window: w, runs, score_trend: runs.map((r) => ({ run_id: r.run_id, score: r.score })), decision_trend: runs.map((r) => ({ run_id: r.run_id, decision: r.decision })), coverage_trend: runs.map((r) => ({ run_id: r.run_id, coverage: r.coverage })), findings_by_severity_trend: runs.map((r) => ({ run_id: r.run_id, findings_by_severity: r.findings_by_severity })), blocker_trend: runs.map((r) => ({ run_id: r.run_id, blocker_count: r.blocker_count })) });
      }
      return { ...hist, window: w };
    }
    return hist;
  } catch (err) {
    if (err instanceof StateError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new StateError(`Failed to read quality history: ${msg}`, { details: { path: filePath } });
  }
}

export const history = {
  build: historyBuild,
  read: historyRead,
  write: historyWrite,
  path: historyPath,
  schema_version: QUALITY_HISTORY_SCHEMA_VERSION,
};
