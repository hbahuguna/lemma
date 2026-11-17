import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { now } from "./determinism.js";
import { redactUnknown } from "./redaction.js";
import { catalogIds, type CheckRegistryLike } from "./checks.js";
import { RegressionStore } from "./regression-lifecycle.js";

export type ContinuousTrigger = "pr" | "nightly" | "scheduled";

export interface ContinuousConfig {
  root?: string;
  stateDirName?: string;
  /** Max history entries to retain per trigger (documented retention). Default 50. */
  retention?: number;
  /** Bounded PR subset check ids (documented in workflow/config). */
  prSubsetChecks?: string[];
  /** Registry for default catalog resolution (nightly). */
  registry?: CheckRegistryLike | null;
  /** Injectable run executor (tests/hosts). Receives computed scope and returns run result summary. */
  run?: (input: ContinuousRunInput) => Promise<ContinuousRunResult> | ContinuousRunResult;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export interface ContinuousRunInput {
  trigger: ContinuousTrigger;
  root: string;
  scope: {
    mode: "bounded_subset" | "full_default_plus_promoted_regressions";
    check_ids: string[];
    promoted_regression_checks: Array<{ id: string; regression_id: string; finding_id: string }>;
    documented: string;
  };
  config: ContinuousConfig;
}

export interface ContinuousRunResult {
  status?: "completed" | "failed" | "halted" | "error";
  report?: unknown;
  run_id?: string;
  notes?: string[];
}

export interface ContinuousHistoryEntry {
  schema_version: "lemma.continuous_history/v1";
  id: string;
  trigger: ContinuousTrigger;
  timestamp: string;
  status: "completed" | "failed" | "halted" | "error";
  scope: ContinuousRunInput["scope"];
  result: Record<string, unknown>;
}

export interface ContinuousResult {
  trigger: ContinuousTrigger;
  history_dir: string;
  entry_path: string;
  latest_path: string;
  entry: ContinuousHistoryEntry;
  retained: number;
  pruned: number;
}

function validateTrigger(trigger: string): asserts trigger is ContinuousTrigger {
  if (trigger !== "pr" && trigger !== "nightly" && trigger !== "scheduled") {
    throw new StateError(`Invalid continuous trigger '${String(trigger)}' (expected pr|nightly|scheduled)`);
  }
}

function stableId(trigger: ContinuousTrigger, ts: string, salt: string): string {
  return `cont_${trigger}_${createHash("sha256").update(`${trigger}|${ts}|${salt}`).digest("hex").slice(0, 12)}`;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function historyDir(root: string, stateDirName: string, trigger: ContinuousTrigger): string {
  return path.join(root, stateDirName, "continuous", trigger);
}

export async function readContinuousHistory(root: string, trigger: ContinuousTrigger, options?: { stateDirName?: string }): Promise<ContinuousHistoryEntry[]> {
  validateTrigger(trigger);
  const stateDirName = options?.stateDirName ?? ".lemma";
  const dir = path.join(historyDir(path.resolve(root), stateDirName, trigger), "history");
  if (!(await pathExists(dir))) return [];
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    throw new StateError(`Failed to read continuous history for '${trigger}'`, { details: { error: e instanceof Error ? e.message : String(e) } });
  }
  const out: ContinuousHistoryEntry[] = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const entry = await readJsonFile<ContinuousHistoryEntry>(p);
      // basic integrity/corruption detection
      if (!entry || entry.schema_version !== "lemma.continuous_history/v1" || entry.trigger !== trigger || typeof entry.id !== "string") {
        throw new Error("invalid continuous history entry");
      }
      out.push(entry);
    } catch (e) {
      // corruption raises typed error and never corrupts the run / never mutates state
      throw new StateError(`Corrupt continuous history entry for trigger '${trigger}': ${f}`, { details: { path: p, trigger, error: e instanceof Error ? e.message : String(e) } });
    }
  }
  return out;
}

async function computeScope(trigger: ContinuousTrigger, root: string, config: ContinuousConfig): Promise<ContinuousRunInput["scope"]> {
  if (trigger === "pr") {
    const subset = Array.isArray(config.prSubsetChecks) && config.prSubsetChecks.length
      ? [...config.prSubsetChecks]
      : ["static.integrity", "static.security", "test.functionality", "static.test_integrity"]; // bounded documented subset default
    const uniq = Array.from(new Set(subset));
    return {
      mode: "bounded_subset",
      check_ids: uniq,
      promoted_regression_checks: [],
      documented: "PR validation runs a bounded subset of checks (documented in workflow/config: prSubsetChecks or default bounded subset) and comments one marker-based PR summary (LEM-136).",
    };
  }

  // nightly and scheduled: full default catalog plus promoted regressions
  const all = catalogIds(config.registry ?? null);
  const store = new RegressionStore({ root, stateDirName: config.stateDirName ?? ".lemma" });
  const promoted = await store.listPromotedRegressionChecks().catch(() => []);
  const promotedIds = promoted.map((p) => p.id);
  const check_ids = Array.from(new Set([...all, ...promotedIds]));
  return {
    mode: "full_default_plus_promoted_regressions",
    check_ids,
    promoted_regression_checks: promoted.map((p) => ({ id: p.id, regression_id: p.regression_id, finding_id: p.finding_id })),
    documented: trigger === "nightly"
      ? "Nightly runs the full default catalog plus promoted regressions (LEM-189)."
      : "Scheduled runs the full default catalog plus promoted regressions (LEM-189); cron schedule documented in workflow example.",
  };
}

async function enforceRetention(dir: string, retention: number): Promise<{ retained: number; pruned: number; keptPaths: Set<string> }> {
  const history = path.join(dir, "history");
  await ensureDir(history);
  let files = (await fs.readdir(history)).filter((f) => f.endsWith(".json")).sort();
  let pruned = 0;
  if (files.length > retention) {
    const toDelete = files.slice(0, files.length - retention);
    for (const f of toDelete) {
      await fs.unlink(path.join(history, f));
      pruned++;
    }
    files = files.slice(files.length - retention);
  }
  return { retained: files.length, pruned, keptPaths: new Set(files.map((f) => path.join(history, f))) };
}

export async function runContinuous(params: { trigger: ContinuousTrigger; config?: ContinuousConfig }): Promise<ContinuousResult> {
  const trigger = params.trigger;
  validateTrigger(trigger);
  const config = params.config ?? {};
  const root = path.resolve(config.root ?? process.cwd());
  const stateDirName = config.stateDirName ?? ".lemma";
  const retention = Math.max(1, Math.floor(Number(config.retention ?? 50) || 50));
  const clock = config.now ?? now;

  const dir = historyDir(root, stateDirName, trigger);
  const historyPathDir = path.join(dir, "history");
  await ensureDir(historyPathDir);

  // compute scope before execution (so corrupt history reads elsewhere never corrupt this run; and run is independent)
  const scope = await computeScope(trigger, root, config);

  let runResult: ContinuousRunResult = { status: "completed", notes: [] };
  try {
    if (config.run) {
      runResult = await config.run({ trigger, root, scope, config });
    }
  } catch (e) {
    runResult = { status: "error", notes: [e instanceof Error ? e.message : String(e)] };
  }

  const ts = clock();
  const id = stableId(trigger, ts, randomUUID());
  const entry: ContinuousHistoryEntry = {
    schema_version: "lemma.continuous_history/v1",
    id,
    trigger,
    timestamp: ts,
    status: (runResult.status ?? "completed") as ContinuousHistoryEntry["status"],
    scope: redactUnknown(scope) as ContinuousRunInput["scope"],
    result: redactUnknown({
      run_id: runResult.run_id ?? null,
      notes: runResult.notes ?? [],
      ...(runResult.report && typeof runResult.report === "object" ? { report_summary: { status: (runResult.report as any).status, decision: (runResult.report as any).decision } } : {}),
    }) as Record<string, unknown>,
  };

  const entryPath = path.join(historyPathDir, `${ts.replace(/[:.]/g, "-")}-${id}.json`);
  await atomicWriteJson(entryPath, entry);
  const latestPath = path.join(dir, "latest.json");
  await atomicWriteJson(latestPath, entry);

  const { retained, pruned } = await enforceRetention(dir, retention);

  return {
    trigger,
    history_dir: dir,
    entry_path: entryPath,
    latest_path: latestPath,
    entry,
    retained,
    pruned,
  };
}

export async function getContinuousStatus(root: string, trigger: ContinuousTrigger, options?: { stateDirName?: string }): Promise<{ trigger: ContinuousTrigger; latest: ContinuousHistoryEntry | null; history_count: number }> {
  validateTrigger(trigger);
  const stateDirName = options?.stateDirName ?? ".lemma";
  const dir = historyDir(path.resolve(root), stateDirName, trigger);
  const latestPath = path.join(dir, "latest.json");
  let latest: ContinuousHistoryEntry | null = null;
  if (await pathExists(latestPath)) {
    try {
      const entry = await readJsonFile<ContinuousHistoryEntry>(latestPath);
      if (!entry || entry.schema_version !== "lemma.continuous_history/v1" || entry.trigger !== trigger) throw new Error("invalid latest");
      latest = entry;
    } catch (e) {
      throw new StateError(`Corrupt continuous history entry for trigger '${trigger}': latest.json`, { details: { path: latestPath, trigger, error: e instanceof Error ? e.message : String(e) } });
    }
  }
  const history = await readContinuousHistory(root, trigger, { stateDirName });
  return { trigger, latest, history_count: history.length };
}
