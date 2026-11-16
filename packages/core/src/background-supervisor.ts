import path from "node:path";
import { promises as fs } from "node:fs";

import { currentDeterminism, makeDeterminism, resetDeterminism, setDeterminism, type DeterminismOptions } from "./determinism.js";
import { HarnessError } from "./errors.js";
import { StateStore } from "./state-store.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";

export type BackgroundCheckKind = "static" | "quick";

export interface BackgroundCheckResult {
  id: string;
  kind: BackgroundCheckKind;
  status: "passed" | "failed" | "blocked" | "skipped" | "error";
  summary: string;
  evidence_refs?: string[];
  findings?: Array<Record<string, unknown>>;
  limitations?: string[];
  duration_ms?: number;
}

export interface BackgroundCheck {
  id: string;
  kind: BackgroundCheckKind;
  /** Execute the lightweight check. Must be bounded and non-browser by default. */
  run(ctx: BackgroundRunContext): Promise<BackgroundCheckResult> | BackgroundCheckResult;
}

export interface BackgroundRunContext {
  root: string;
  runId: string;
  now: () => string;
  evidenceDir: string;
  signal: AbortSignal;
}

export interface BackgroundSettings {
  background?: {
    enabled?: boolean;
    intervalMs?: number;
    allowBrowserChecks?: boolean;
    checks?: string[]; // allowlist by id (optional)
    seed?: number | null;
    clock?: { mode?: "real" | "frozen"; frozen?: string | null };
  };
}

export interface BackgroundBudget {
  /** Max wall-clock ms per check execution. */
  checkTimeoutMs?: number;
  /** Max checks per interval/tick. */
  maxChecksPerTick?: number;
}

export interface StartBackgroundSupervisorOptions {
  stateStore?: StateStore;
  root?: string;
  settings?: BackgroundSettings;
  maxConcurrent?: number;
  budget?: BackgroundBudget;
  checks?: BackgroundCheck[];
  /** Optional injectable scheduler for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

export interface BackgroundSupervisorStatus {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  stopped: boolean;
  interval_ms: number;
  max_concurrent: number;
  active_runs: number;
  completed_ticks: number;
  last_tick_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  allow_browser_checks: boolean;
}

export interface BackgroundSupervisorHandle {
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  status(): BackgroundSupervisorStatus;
  stop(): Promise<void> | void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

function clampInt(n: unknown, fallback: number, min: number, max: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function envOff(): boolean {
  const v = (process.env.LEMMA_BACKGROUND ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "disabled";
}

function isoNow(): string {
  try { return currentDeterminism().now(); } catch { return new Date().toISOString(); }
}

function defaultChecks(): BackgroundCheck[] {
  return [
    {
      id: "background.static.quick_status",
      kind: "static",
      async run(ctx) {
        const start = Date.now();
        // lightweight deterministic static/health check: background dir writable and root accessible
        await ensureDir(ctx.evidenceDir);
        await fs.access(ctx.root);
        const payload = { ok: true, root: ctx.root, checked_at: ctx.now() };
        const refPath = path.join(ctx.evidenceDir, "quick-status.json");
        await atomicWriteJson(refPath, payload);
        return {
          id: "background.static.quick_status",
          kind: "static",
          status: "passed",
          summary: "Background quick status check completed.",
          evidence_refs: [refPath.replaceAll(path.sep, "/")],
          duration_ms: Math.max(0, Date.now() - start),
        };
      },
    },
  ];
}

function isAllowedCheck(check: BackgroundCheck, settings: BackgroundSettings | undefined): boolean {
  const bg = settings?.background;
  const allowBrowser = bg?.allowBrowserChecks === true;
  if (!allowBrowser && /browser/i.test(check.id)) return false;
  // allowlist: static and non-browser quick checks only by default
  if (check.kind !== "static" && check.kind !== "quick") return false;
  if (/browser/i.test(check.kind)) return false;
  const ids = bg?.checks;
  if (Array.isArray(ids) && ids.length > 0) return ids.includes(check.id);
  return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new HarnessError("Background check aborted", { code: "run_error" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const onAbort = () => reject(new HarnessError("Background check aborted", { code: "run_error" }));
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          reject(new HarnessError(`Background check timed out after ${ms}ms`, { code: "run_error" }));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startBackgroundSupervisor(options: StartBackgroundSupervisorOptions): BackgroundSupervisorHandle {
  const settings = options.settings ?? {};
  const enabledSetting = settings.background?.enabled === true; // default false
  const disabled = !enabledSetting || envOff();
  const root = path.resolve(options.root ?? options.stateStore?.root ?? process.cwd());
  const intervalMs = clampInt(settings.background?.intervalMs, DEFAULT_INTERVAL_MS, 250, 24 * 60 * 60 * 1000);
  const maxConcurrent = clampInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, 8);
  const checkTimeoutMs = clampInt(options.budget?.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 50, 60_000);
  const maxChecksPerTick = clampInt(options.budget?.maxChecksPerTick, maxConcurrent, 1, 16);
  const allowBrowserChecks = settings.background?.allowBrowserChecks === true;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  const fgStore = options.stateStore ?? new StateStore(root);
  const bgStore = new StateStore(root, { stateDirName: path.join(".lemma", "background") });
  const bgEvidenceRoot = path.join(root, ".lemma", "background", "evidence");

  const status: BackgroundSupervisorStatus = {
    enabled: !disabled,
    running: false,
    paused: false,
    stopped: false,
    interval_ms: intervalMs,
    max_concurrent: maxConcurrent,
    active_runs: 0,
    completed_ticks: 0,
    last_tick_at: null,
    last_run_at: null,
    last_error: null,
    allow_browser_checks: allowBrowserChecks,
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let paused = false;
  let stopped = disabled; // no-op when disabled
  const active = new Set<Promise<void>>();

  async function emit(event: string, details: Record<string, unknown> = {}): Promise<void> {
    try {
      await bgStore.appendEvent({ event, source: "background-supervisor", ...details });
    } catch {
      // ignore
    }
  }

  async function readBackgroundStatusFile(): Promise<void> {
    try {
      await ensureDir(path.join(root, ".lemma", "background"));
      await atomicWriteJson(path.join(root, ".lemma", "background", "status.json"), status);
    } catch {
      // ignore
    }
  }

  async function globalKillRequested(): Promise<boolean> {
    try {
      const reason = await fgStore.killRequest();
      return reason !== null;
    } catch {
      return false;
    }
  }

  async function backgroundKillRequested(): Promise<boolean> {
    try {
      const reason = await bgStore.killRequest();
      return reason !== null;
    } catch {
      return false;
    }
  }

  async function runCheck(check: BackgroundCheck): Promise<void> {
    if (stopped || paused) return;
    if (active.size >= maxConcurrent) return;
    status.active_runs += 1;
    const ac = new AbortController();
    const detOpts: DeterminismOptions | null = settings.background?.seed != null || settings.background?.clock
      ? {
          ...(settings.background.seed != null ? { seed: settings.background.seed } : {}),
          ...(settings.background.clock?.mode ? { clockMode: settings.background.clock.mode } : {}),
          ...(settings.background.clock?.frozen ? { frozenClock: settings.background.clock.frozen } : {}),
        }
      : null;
    const det = detOpts ? makeDeterminism(detOpts) : null;
    const prev = det ? setDeterminism(det) : null;
    const runId = det ? det.runId() : `bg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const evidenceDir = path.join(bgEvidenceRoot, runId);
    const task = (async () => {
      try {
        await emit("background_check_started", { run_id: runId, check_id: check.id });
        await ensureDir(evidenceDir);
        const result = await withTimeout(
          Promise.resolve(check.run({ root, runId, now: isoNow, evidenceDir, signal: ac.signal })),
          checkTimeoutMs,
          ac.signal,
        );
        status.last_run_at = isoNow();
        await emit("background_check_completed", { run_id: runId, check_id: check.id, status: result.status, summary: result.summary });
        const summaryPath = path.join(root, ".lemma", "background", "summary.json");
        let summary: any = { runs: [] };
        try { summary = await readJsonFile<any>(summaryPath); } catch { summary = { runs: [] }; }
        if (!Array.isArray(summary.runs)) summary.runs = [];
        summary.runs.unshift({ run_id: runId, at: isoNow(), result });
        summary.runs = summary.runs.slice(0, 50);
        await ensureDir(path.dirname(summaryPath));
        await atomicWriteJson(summaryPath, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status.last_error = msg;
        await emit("background_check_error", { run_id: runId, check_id: check.id, error: msg });
      } finally {
        if (prev) resetDeterminism(prev);
        status.active_runs = Math.max(0, status.active_runs - 1);
      }
    })();
    active.add(task);
    task.finally(() => active.delete(task));
    // do not await here to respect maxConcurrent scheduling
  }

  async function tick(): Promise<void> {
    if (disabled || stopped || paused || ticking) return;
    ticking = true;
    try {
      status.last_tick_at = isoNow();
      if (await globalKillRequested() || await backgroundKillRequested()) {
        await emit("background_kill_observed", { global: await globalKillRequested(), background: await backgroundKillRequested() });
        await stopInternal("kill");
        return;
      }
      const checks = (options.checks ?? defaultChecks()).filter((c) => isAllowedCheck(c, settings));
      let launched = 0;
      for (const check of checks) {
        if (launched >= maxChecksPerTick) break;
        if (active.size >= maxConcurrent) break;
        if (stopped || paused) break;
        void runCheck(check);
        launched += 1;
      }
      status.completed_ticks += 1;
      await readBackgroundStatusFile();
    } catch (err) {
      status.last_error = err instanceof Error ? err.message : String(err);
      await emit("background_tick_error", { error: status.last_error });
    } finally {
      ticking = false;
    }
  }

  async function stopInternal(reason = "stop"): Promise<void> {
    if (stopped) return;
    stopped = true;
    status.stopped = true;
    status.running = false;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    await emit("background_stopped", { reason });
    await Promise.allSettled([...active]);
    await readBackgroundStatusFile();
  }

  const handle: BackgroundSupervisorHandle = {
    async pause() {
      if (disabled || stopped) return;
      paused = true;
      status.paused = true;
      await emit("background_paused", {});
      await readBackgroundStatusFile();
    },
    async resume() {
      if (disabled || stopped) return;
      paused = false;
      status.paused = false;
      await emit("background_resumed", {});
      await readBackgroundStatusFile();
    },
    status() {
      return { ...status, active_runs: active.size, running: !stopped && !disabled, paused, stopped };
    },
    async stop() {
      await stopInternal("stop");
    },
  };

  if (!disabled) {
    status.running = true;
    void (async () => {
      await ensureDir(path.join(root, ".lemma", "background"));
      await emit("background_started", { interval_ms: intervalMs, max_concurrent: maxConcurrent });
      await readBackgroundStatusFile();
      // run first tick asynchronously; scheduler handles subsequent ticks
      void tick();
      timer = setIntervalFn(() => { void tick(); }, intervalMs);
    })();
  }

  return handle;
}
