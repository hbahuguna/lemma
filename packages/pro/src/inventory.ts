import { createHash } from "node:crypto";
import path from "node:path";

import { StateError, atomicWriteJson, ensureDir, now, readJsonFile } from "@lemma/core";

import { requireProLicense, type ProLicenseContext } from "./entitlement.js";

export const TEST_INVENTORY_SCHEMA_VERSION = "lemma.pro.test_inventory/v1" as const;
export const DEFAULT_INVENTORY_HISTORY_CAP = 20;
export const MAX_INVENTORY_HISTORY_CAP = 50;

export type InventoryCheckSource = "built-in" | "plugin" | "Pro specialist";

export interface InventoryHistoryEntry {
  run_id: string;
  status: string;
  evidence_fingerprint: string;
  observed_at?: string | null;
  [key: string]: unknown;
}

export interface InventoryCheck {
  stable_id: string;
  source: InventoryCheckSource;
  last_seen_run_id: string;
  last_seen_status: string;
  evidence_fingerprint: string;
  owner_persona: string;
  recent_history: InventoryHistoryEntry[];
  [key: string]: unknown;
}

export interface TestInventory {
  schema_version: typeof TEST_INVENTORY_SCHEMA_VERSION;
  project_root: string;
  generated_at: string;
  history_cap: number;
  runs_indexed: string[];
  checks: InventoryCheck[];
  [key: string]: unknown;
}

export interface InventoryBuildOptions {
  projectRoot: string;
  runs: unknown[];
  license?: ProLicenseContext | null;
  /** Persist to .lemma/pro/inventory.json (default true). */
  persist?: boolean;
  /** Bounded recent history entries per check (default 20, max 50). */
  historyCap?: number;
  now?: () => string;
}

export interface InventoryReadOptions {
  projectRoot: string;
  license?: ProLicenseContext | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function resolveProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

export function inventoryPath(projectRoot: string): string {
  return path.join(resolveProjectRoot(projectRoot), ".lemma", "pro", "inventory.json");
}

function clampHistoryCap(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : DEFAULT_INVENTORY_HISTORY_CAP;
  return Math.max(1, Math.min(MAX_INVENTORY_HISTORY_CAP, v));
}

function normalizeSource(v: unknown): InventoryCheckSource {
  if (v === "plugin") return "plugin";
  if (v === "Pro specialist" || v === "pro_specialist" || v === "pro") return "Pro specialist";
  return "built-in";
}

function extractRunId(run: unknown, idx: number): string {
  if (!isRecord(run)) return `run_${idx + 1}`;
  if (typeof run.run_id === "string" && run.run_id) return run.run_id;
  if (isRecord(run.run) && typeof run.run.run_id === "string" && run.run.run_id) return run.run.run_id;
  if (typeof run.id === "string" && run.id) return run.id;
  if (typeof run.name === "string" && run.name) return run.name;
  return `run_${idx + 1}`;
}

function extractObservedAt(run: unknown): string | null {
  if (!isRecord(run)) return null;
  const candidates: unknown[] = [
    run.generated_at,
    run.completed_at,
    isRecord(run.run) ? run.run.completed_at : undefined,
    isRecord(run.run) ? run.run.generated_at : undefined,
    run.timestamp,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return null;
}

function extractResults(run: unknown): Array<Record<string, unknown>> {
  if (!isRecord(run)) return [];
  const arrays: unknown[] = [run.results, run.checks, run.test_results, run.checks_results];
  for (const a of arrays) {
    if (Array.isArray(a)) return a.filter(isRecord) as Array<Record<string, unknown>>;
  }
  // normalized baselines may have normalized.checks
  if (isRecord(run.normalized) && Array.isArray(run.normalized.checks)) {
    return (run.normalized.checks as unknown[]).filter(isRecord) as Array<Record<string, unknown>>;
  }
  return [];
}

function evidenceFingerprint(check: Record<string, unknown>, run: unknown): string {
  const evidence = asStringArray(check.evidence);
  if (evidence.length > 0) return sha256([...evidence].sort().join("\n"));
  // try manifest evidence refs
  if (isRecord(run)) {
    const ev = isRecord(run.evidence) ? run.evidence : (isRecord(run.evidence_summary) ? run.evidence_summary : undefined);
    if (isRecord(ev) && typeof ev.manifest === "string" && ev.manifest) return sha256(ev.manifest);
  }
  if (isRecord(check.metadata)) return sha256(JSON.stringify(check.metadata));
  const id = asString(check.id) || asString(check.check_id);
  const status = asString(check.status);
  return sha256(`${id}\n${status}`);
}

function toInventoryEntry(runId: string, observedAt: string | null, check: Record<string, unknown>, run: unknown): InventoryCheck {
  const stableId = asString(check.id) || asString(check.check_id) || asString(check.stable_id);
  const status = asString(check.status) || asString(check.outcome) || "unknown";
  const persona = asString(check.persona) || asString(check.owner_persona) || "unknown";
  const source = normalizeSource(check.source ?? (asString(check.kind) === "plugin" ? "plugin" : undefined));
  const fp = evidenceFingerprint(check, run);
  return {
    stable_id: stableId,
    source,
    last_seen_run_id: runId,
    last_seen_status: status,
    evidence_fingerprint: fp,
    owner_persona: persona,
    recent_history: [
      {
        run_id: runId,
        status,
        evidence_fingerprint: fp,
        observed_at: observedAt,
      },
    ],
  };
}

function mergeCheck(existing: InventoryCheck, incoming: InventoryCheck, historyCap: number): InventoryCheck {
  const history = [incoming.recent_history[0]!, ...existing.recent_history];
  // dedupe consecutive identical run entries while preserving order
  const deduped: InventoryHistoryEntry[] = [];
  for (const h of history) {
    if (!h) continue;
    const prev = deduped[deduped.length - 1];
    if (prev && prev.run_id === h.run_id && prev.status === h.status && prev.evidence_fingerprint === h.evidence_fingerprint) {
      continue;
    }
    deduped.push(h);
    if (deduped.length >= historyCap) break;
  }
  return {
    stable_id: existing.stable_id,
    source: incoming.source !== "built-in" ? incoming.source : existing.source,
    last_seen_run_id: incoming.last_seen_run_id,
    last_seen_status: incoming.last_seen_status,
    evidence_fingerprint: incoming.evidence_fingerprint,
    owner_persona: incoming.owner_persona || existing.owner_persona,
    recent_history: deduped.slice(0, historyCap),
  };
}

export function validateTestInventory(value: unknown): TestInventory {
  if (!isRecord(value)) {
    throw new StateError("Invalid inventory: expected object", { details: { reason: "not_object" } });
  }
  if (value.schema_version !== TEST_INVENTORY_SCHEMA_VERSION) {
    throw new StateError(`Invalid inventory schema_version: ${String(value.schema_version)}`, { details: { schema_version: value.schema_version } });
  }
  if (typeof value.project_root !== "string" || !value.project_root) {
    throw new StateError("Invalid inventory: project_root is required", { details: { field: "project_root" } });
  }
  if (typeof value.generated_at !== "string" || !value.generated_at) {
    throw new StateError("Invalid inventory: generated_at is required", { details: { field: "generated_at" } });
  }
  const historyCap = clampHistoryCap(value.history_cap);
  const runsIndexed = Array.isArray(value.runs_indexed) ? value.runs_indexed.filter((x): x is string => typeof x === "string") : [];
  const rawChecks = Array.isArray(value.checks) ? value.checks : null;
  if (!rawChecks) {
    throw new StateError("Invalid inventory: checks must be an array", { details: { field: "checks" } });
  }
  const checks: InventoryCheck[] = rawChecks.filter(isRecord).map((c) => {
    const stableId = asString(c.stable_id);
    if (!stableId) throw new StateError("Invalid inventory check: stable_id is required", { details: { field: "checks.stable_id" } });
    const source = normalizeSource(c.source);
    const recentRaw = Array.isArray(c.recent_history) ? c.recent_history.filter(isRecord) : [];
    const recent_history: InventoryHistoryEntry[] = recentRaw.slice(0, historyCap).map((h) => ({
      run_id: asString(h.run_id),
      status: asString(h.status),
      evidence_fingerprint: asString(h.evidence_fingerprint),
      observed_at: typeof h.observed_at === "string" ? h.observed_at : (h.observed_at === null ? null : null),
      ...Object.fromEntries(Object.entries(h).filter(([k]) => !["run_id", "status", "evidence_fingerprint", "observed_at"].includes(k))),
    }));
    return {
      stable_id: stableId,
      source,
      last_seen_run_id: asString(c.last_seen_run_id),
      last_seen_status: asString(c.last_seen_status),
      evidence_fingerprint: asString(c.evidence_fingerprint),
      owner_persona: asString(c.owner_persona),
      recent_history,
      ...Object.fromEntries(Object.entries(c).filter(([k]) => !["stable_id", "source", "last_seen_run_id", "last_seen_status", "evidence_fingerprint", "owner_persona", "recent_history"].includes(k))),
    };
  });

  return {
    schema_version: TEST_INVENTORY_SCHEMA_VERSION,
    project_root: value.project_root,
    generated_at: value.generated_at,
    history_cap: historyCap,
    runs_indexed: runsIndexed,
    checks,
    ...Object.fromEntries(Object.entries(value).filter(([k]) => !["schema_version", "project_root", "generated_at", "history_cap", "runs_indexed", "checks"].includes(k))),
  };
}

export async function inventoryBuild(options: InventoryBuildOptions): Promise<TestInventory> {
  // Unlicensed: no reads/writes occur (enforce before any I/O)
  requireProLicense(options.license ?? null, "project test inventory");

  const projectRoot = resolveProjectRoot(options.projectRoot);
  const historyCap = clampHistoryCap(options.historyCap);
  const runs = Array.isArray(options.runs) ? options.runs : [];
  const runsIndexed: string[] = [];
  const byId = new Map<string, InventoryCheck>();

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const runId = extractRunId(run, i);
    runsIndexed.push(runId);
    const observedAt = extractObservedAt(run);
    for (const r of extractResults(run)) {
      const entry = toInventoryEntry(runId, observedAt, r, run);
      if (!entry.stable_id) continue;
      const prev = byId.get(entry.stable_id);
      byId.set(entry.stable_id, prev ? mergeCheck(prev, entry, historyCap) : { ...entry, recent_history: entry.recent_history.slice(0, historyCap) });
    }
  }

  const inventory: TestInventory = validateTestInventory({
    schema_version: TEST_INVENTORY_SCHEMA_VERSION,
    project_root: projectRoot,
    generated_at: options.now ? options.now() : now(),
    history_cap: historyCap,
    runs_indexed: runsIndexed,
    checks: Array.from(byId.values()).sort((a, b) => a.stable_id.localeCompare(b.stable_id)),
  });

  if (options.persist !== false) {
    await inventoryWrite(projectRoot, inventory);
  }
  return inventory;
}

export async function inventoryWrite(projectRoot: string, inventory: TestInventory): Promise<string> {
  const filePath = inventoryPath(projectRoot);
  await ensureDir(path.dirname(filePath));
  const validated = validateTestInventory(inventory);
  await atomicWriteJson(filePath, validated);
  return filePath;
}

export async function inventoryRead(options: InventoryReadOptions): Promise<TestInventory> {
  // Unlicensed: no reads occur
  requireProLicense(options.license ?? null, "project test inventory");
  const filePath = inventoryPath(options.projectRoot);
  try {
    const data = await readJsonFile<unknown>(filePath);
    return validateTestInventory(data);
  } catch (err) {
    if (err instanceof StateError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new StateError(`Failed to read inventory: ${msg}`, { details: { path: filePath } });
  }
}

export async function inventoryListCheck(options: InventoryReadOptions & { checkId: string }): Promise<{ inventory: TestInventory; check: InventoryCheck | null }> {
  const inventoryData = await inventoryRead(options);
  const check = inventoryData.checks.find((c) => c.stable_id === options.checkId) ?? null;
  return { inventory: inventoryData, check };
}

export const inventory = {
  build: inventoryBuild,
  read: inventoryRead,
  write: inventoryWrite,
  listCheck: inventoryListCheck,
  path: inventoryPath,
  schema_version: TEST_INVENTORY_SCHEMA_VERSION,
  default_history_cap: DEFAULT_INVENTORY_HISTORY_CAP,
};

// Backward-compat/AC-friendly name
export const TestInventorySchema = {
  version: TEST_INVENTORY_SCHEMA_VERSION,
  parse: validateTestInventory,
};
