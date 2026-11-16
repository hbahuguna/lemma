import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactText, redactUnknown } from "./redaction.js";
import { registryFingerprint, type CheckRegistryLike } from "./checks.js";

export type ForeverStopReason =
  | "completed"
  | "max_cycles"
  | "wall_clock_cap"
  | "manual_kill"
  | "registry_fingerprint_mismatch"
  | "error";

export interface ForeverFinding {
  id?: string;
  fingerprint: string;
  title?: string;
  severity?: string;
  check_id?: string;
  [key: string]: unknown;
}

export interface ForeverCycleExecutionInput {
  root: string;
  run_id: string;
  cycle: number;
  target: unknown;
  resumed: boolean;
  seed: number | null;
  now: () => string;
  expanded_coverage: string[];
  confirmed_fingerprints: string[];
}

export interface ForeverCycleExecutionOutput {
  findings?: ForeverFinding[];
  /** Coverage areas/check ids added this cycle (must only be triggered by confirmed findings). */
  expanded_coverage?: string[];
  notes?: string[];
  artifacts?: Record<string, unknown>;
}

export interface RunForeverParams {
  root: string;
  target: unknown;
  maxCycles?: number;
  checkpointEvery?: number;
  /** Wall-clock cap in ms (real clock unless frozen clock mode). */
  wallClockMs?: number;
  clock?: "real" | "frozen";
  frozenNow?: string;
  seed?: number | null;
  runId?: string;
  resume?: boolean;
  registry?: CheckRegistryLike | null;
  registryFingerprint?: string;
  isKillRequested?: () => boolean | Promise<boolean>;
  executeCycle?: (input: ForeverCycleExecutionInput) => Promise<ForeverCycleExecutionOutput | void> | ForeverCycleExecutionOutput | void;
}

export interface ForeverCycleResult {
  cycle: number;
  started_at: string;
  completed_at: string;
  findings: Array<{ fingerprint: string; confirmed: boolean; count: number; title?: string }>;
  unconfirmed_findings: string[];
  confirmed_findings: string[];
  expansion_triggered: boolean;
  expanded_coverage: string[];
  evidence_dir: string;
  checkpoint_path: string;
}

export interface ForeverMissionReport {
  schema_version: "lemma.forever_mission/v1";
  run_id: string;
  status: "running" | "completed" | "halted" | "failed";
  stop_reason?: ForeverStopReason;
  target: unknown;
  root: string;
  max_cycles: number;
  wall_clock_ms?: number;
  checkpoint_every: number;
  cycles_completed: number;
  current_cycle: number;
  confirmed_fingerprints: string[];
  unconfirmed_fingerprints: string[];
  expanded_coverage: string[];
  cycles: ForeverCycleResult[];
  updated_at: string;
  deterministic: { seed: number | null; clock_mode: "real" | "frozen"; frozen_now?: string };
}

export interface ForeverResult {
  run_id: string;
  status: "completed" | "halted" | "failed";
  stop_reason: ForeverStopReason;
  cycles_completed: number;
  resumed_from_cycle: number;
  evidence_root: string;
  mission_report_path: string;
  checkpoint_paths: string[];
  mission: ForeverMissionReport;
  same_seed_frozen_clock_note?: string;
}

interface ForeverCheckpoint {
  schema_version: "lemma.forever_checkpoint/v1";
  run_id: string;
  registry_fingerprint: string;
  target: unknown;
  max_cycles: number;
  wall_clock_ms?: number;
  checkpoint_every: number;
  deterministic: { seed: number | null; clock_mode: "real" | "frozen"; frozen_now?: string };
  started_at_ms: number;
  created_at: string;
  updated_at: string;
  last_completed_cycle: number;
  status: "running" | "completed" | "halted" | "failed";
  stop_reason?: ForeverStopReason;
  fingerprint_counts: Record<string, number>;
  confirmed_fingerprints: string[];
  unconfirmed_fingerprints: string[];
  expanded_coverage: string[];
  cycles: ForeverCycleResult[];
}

function stableHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function makeNow(params: RunForeverParams, fallback?: string): () => string {
  if (params.clock === "frozen") {
    const fixed = params.frozenNow ?? fallback ?? new Date(0).toISOString();
    return () => fixed;
  }
  return () => new Date().toISOString();
}

function computeFingerprint(params: RunForeverParams): string {
  if (typeof params.registryFingerprint === "string" && params.registryFingerprint.length) return params.registryFingerprint;
  if (params.registry !== undefined) return registryFingerprint(params.registry ?? null);
  return registryFingerprint(null);
}

async function readCheckpoint(pathname: string): Promise<ForeverCheckpoint | null> {
  try {
    return await readJsonFile<ForeverCheckpoint>(pathname);
  } catch (err: any) {
    if (err instanceof StateError && /not found/i.test(String(err?.message))) return null;
    throw err;
  }
}

function missionPath(root: string, runId: string): string {
  return path.join(root, ".lemma", "forever", runId, "mission.json");
}

function checkpointPath(root: string, runId: string): string {
  return path.join(root, ".lemma", "forever", runId, "checkpoint.json");
}

function toMission(cp: ForeverCheckpoint, root: string): ForeverMissionReport {
  return {
    schema_version: "lemma.forever_mission/v1",
    run_id: cp.run_id,
    status: cp.status,
    ...(cp.stop_reason ? { stop_reason: cp.stop_reason } : {}),
    target: cp.target,
    root,
    max_cycles: cp.max_cycles,
    ...(cp.wall_clock_ms !== undefined ? { wall_clock_ms: cp.wall_clock_ms } : {}),
    checkpoint_every: cp.checkpoint_every,
    cycles_completed: cp.last_completed_cycle,
    current_cycle: cp.last_completed_cycle + (cp.status === "running" ? 1 : 0),
    confirmed_fingerprints: [...cp.confirmed_fingerprints],
    unconfirmed_fingerprints: [...cp.unconfirmed_fingerprints],
    expanded_coverage: [...cp.expanded_coverage],
    cycles: cp.cycles.map((c) => ({ ...c })),
    updated_at: cp.updated_at,
    deterministic: { ...cp.deterministic },
  };
}

async function persist(root: string, cp: ForeverCheckpoint): Promise<{ mission: ForeverMissionReport; checkpoint: string; missionPath: string }> {
  const dir = path.join(root, ".lemma", "forever", cp.run_id);
  await ensureDir(dir);
  const cpath = checkpointPath(root, cp.run_id);
  const mpath = missionPath(root, cp.run_id);
  // checkpoint via atomic writes (state store primitive)
  await atomicWriteJson(cpath, cp);
  const mission = toMission(cp, root);
  await atomicWriteJson(mpath, mission);
  return { mission, checkpoint: cpath, missionPath: mpath };
}

export async function runForever(params: RunForeverParams): Promise<ForeverResult> {
  if (!params || !params.root) throw new StateError("runForever requires root");
  const root = path.resolve(params.root);
  const target = params.target;
  const maxCycles = Math.max(1, Math.trunc(params.maxCycles ?? 5));
  const checkpointEvery = Math.max(1, Math.trunc(params.checkpointEvery ?? 1));
  const wallClockMs = params.wallClockMs !== undefined ? Math.max(0, Math.trunc(params.wallClockMs)) : undefined;
  const clockMode: "real" | "frozen" = params.clock === "frozen" ? "frozen" : "real";
  const seed = params.seed ?? null;
  const fingerprint = computeFingerprint(params);

  let cp: ForeverCheckpoint | null = null;
  let runId = params.runId || "";
  let resumedFromCycle = 0;

  if (params.resume || params.runId) {
    const candidateId = params.runId;
    if (candidateId) {
      cp = await readCheckpoint(checkpointPath(root, candidateId));
      runId = candidateId;
    } else {
      // find latest checkpoint
      const base = path.join(root, ".lemma", "forever");
      try {
        const entries = await fs.readdir(base, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        for (let i = dirs.length - 1; i >= 0; i--) {
          const found = await readCheckpoint(checkpointPath(root, dirs[i]!));
          if (found) { cp = found; runId = found.run_id; break; }
        }
      } catch { /* ignore */ }
    }
    if (cp) {
      if (cp.registry_fingerprint !== fingerprint) {
        // refusal per LEM-021 / registry fingerprint mismatch
        throw new StateError(
          `Registry fingerprint mismatch: plugin registry changed since this forever run started (saved ${cp.registry_fingerprint}, current ${fingerprint}). Start a new forever run instead of resuming.`,
          { details: { run_id: cp.run_id, saved: cp.registry_fingerprint, current: fingerprint, reason: "registry_fingerprint_mismatch" } }
        );
      }
      resumedFromCycle = cp.last_completed_cycle;
      runId = cp.run_id;
    }
  }

  if (!cp) {
    runId = runId || `forever-${seed !== null ? stableHash({ seed, target, root: path.basename(root) }).slice(0, 12) : randomUUID()}`;
    const nowFn = makeNow(params);
    const createdAt = nowFn();
    cp = {
      schema_version: "lemma.forever_checkpoint/v1",
      run_id: runId,
      registry_fingerprint: fingerprint,
      target: redactUnknown(target),
      max_cycles: maxCycles,
      ...(wallClockMs !== undefined ? { wall_clock_ms: wallClockMs } : {}),
      checkpoint_every: checkpointEvery,
      deterministic: { seed, clock_mode: clockMode, ...(params.frozenNow ? { frozen_now: params.frozenNow } : {}) },
      started_at_ms: clockMode === "frozen" ? 0 : Date.now(),
      created_at: createdAt,
      updated_at: createdAt,
      last_completed_cycle: 0,
      status: "running",
      fingerprint_counts: {},
      confirmed_fingerprints: [],
      unconfirmed_fingerprints: [],
      expanded_coverage: [],
      cycles: [],
    };
    await persist(root, cp);
  } else {
    // update caps/settings for resumed run while preserving deterministic identity
    cp.max_cycles = maxCycles;
    cp.checkpoint_every = checkpointEvery;
    if (wallClockMs !== undefined) cp.wall_clock_ms = wallClockMs;
    cp.status = "running";
    delete (cp as any).stop_reason;
  }

  const nowFn = params.clock === "frozen" ? () => (cp!.deterministic.frozen_now ?? params.frozenNow ?? cp!.created_at) : () => new Date().toISOString();
  const isKillRequested = async () => {
    if (typeof params.isKillRequested === "function") {
      try { return !!(await params.isKillRequested()); } catch { return false; }
    }
    try { await fs.access(path.join(root, ".lemma", "kill")); return true; } catch { return false; }
  };

  const finalize = async (status: ForeverResult["status"], reason: ForeverStopReason): Promise<ForeverResult> => {
    cp!.status = status;
    cp!.stop_reason = reason;
    cp!.updated_at = nowFn();
    const saved = await persist(root, cp!);
    return {
      run_id: cp!.run_id,
      status,
      stop_reason: reason,
      cycles_completed: cp!.last_completed_cycle,
      resumed_from_cycle: resumedFromCycle,
      evidence_root: path.join(root, ".lemma", "forever", cp!.run_id),
      mission_report_path: saved.missionPath,
      checkpoint_paths: [saved.checkpoint],
      mission: saved.mission,
      ...(clockMode === "frozen" && seed !== null ? { same_seed_frozen_clock_note: "Deterministic run: same seed + frozen clock + same root yields byte-identical checkpoints modulo documented volatile fields." } : {}),
    };
  };

  try {
    for (let cycle = cp.last_completed_cycle + 1; cycle <= cp.max_cycles; cycle++) {
      if (await isKillRequested()) return await finalize("halted", "manual_kill");
      if (cp.wall_clock_ms !== undefined && clockMode !== "frozen") {
        const elapsed = Date.now() - cp.started_at_ms;
        if (elapsed > cp.wall_clock_ms) return await finalize("halted", "wall_clock_cap");
      }

      const cycleDir = path.join(root, ".lemma", "forever", cp.run_id, String(cycle));
      await ensureDir(cycleDir);
      const startedAt = nowFn();

      let out: ForeverCycleExecutionOutput | void;
      if (typeof params.executeCycle === "function") {
        out = await params.executeCycle({
          root,
          run_id: cp.run_id,
          cycle,
          target,
          resumed: resumedFromCycle > 0 && cycle === resumedFromCycle + 1,
          seed,
          now: nowFn,
          expanded_coverage: [...cp.expanded_coverage],
          confirmed_fingerprints: [...cp.confirmed_fingerprints],
        });
      } else {
        // deterministic default: no new findings, no expansion
        out = { findings: [], expanded_coverage: [], notes: ["default_noop_cycle"] };
      }

      const findingsIn = Array.isArray(out?.findings) ? out!.findings! : [];
      // normalize findings and count observations by fingerprint
      const seenThisCycle = new Set<string>();
      for (const f of findingsIn) {
        const fp = typeof f?.fingerprint === "string" && f.fingerprint ? f.fingerprint : stableHash({ id: f?.id, title: f?.title, check_id: f?.check_id, cycle });
        if (seenThisCycle.has(fp)) continue;
        seenThisCycle.add(fp);
        cp.fingerprint_counts[fp] = (cp.fingerprint_counts[fp] || 0) + 1;
      }
      const confirmedSet = new Set(cp.confirmed_fingerprints);
      const unconfirmedSet = new Set(cp.unconfirmed_fingerprints);
      for (const fp of Object.keys(cp.fingerprint_counts)) {
        if ((cp.fingerprint_counts[fp] || 0) >= 2) {
          confirmedSet.add(fp);
          unconfirmedSet.delete(fp);
        } else {
          if (!confirmedSet.has(fp)) unconfirmedSet.add(fp);
        }
      }
      cp.confirmed_fingerprints = Array.from(confirmedSet).sort();
      cp.unconfirmed_fingerprints = Array.from(unconfirmedSet).sort();

      // expansion only when confirmed findings trigger it (observed twice with same fingerprint)
      const requestedExpansion = Array.isArray(out?.expanded_coverage) ? out!.expanded_coverage!.filter((x) => typeof x === "string" && x) : [];
      const newlyConfirmed = cp.confirmed_fingerprints.filter((fp) => (cp!.fingerprint_counts[fp] || 0) === 2 && seenThisCycle.has(fp));
      const expansionTriggered = newlyConfirmed.length > 0 && requestedExpansion.length > 0;
      const expandedCoverage = expansionTriggered ? Array.from(new Set([...cp.expanded_coverage, ...requestedExpansion])).sort() : [...cp.expanded_coverage];
      cp.expanded_coverage = expandedCoverage;

      const cycleFindings = Array.from(seenThisCycle).sort().map((fp) => {
        const count = cp!.fingerprint_counts[fp] || 0;
        const src = findingsIn.find((f) => (f.fingerprint || stableHash({ id: f?.id, title: f?.title, check_id: f?.check_id, cycle })) === fp);
        return { fingerprint: fp, confirmed: count >= 2, count, ...(src?.title ? { title: String(src.title) } : {}) };
      });

      const cycleResult: ForeverCycleResult = {
        cycle,
        started_at: startedAt,
        completed_at: nowFn(),
        findings: cycleFindings,
        unconfirmed_findings: cycleFindings.filter((f) => !f.confirmed).map((f) => f.fingerprint),
        confirmed_findings: cycleFindings.filter((f) => f.confirmed).map((f) => f.fingerprint),
        expansion_triggered: expansionTriggered,
        expanded_coverage: expansionTriggered ? requestedExpansion.slice().sort() : [],
        evidence_dir: path.posix.join(".lemma", "forever", cp.run_id, String(cycle)),
        checkpoint_path: path.posix.join(".lemma", "forever", cp.run_id, "checkpoint.json"),
      };

      // per-cycle evidence
      await atomicWriteJson(path.join(cycleDir, "cycle.json"), redactUnknown(cycleResult));
      await atomicWriteJson(path.join(cycleDir, "findings.json"), redactUnknown({ cycle, findings: findingsIn.map((f) => ({ ...f, fingerprint: f.fingerprint || stableHash({ id: f.id, title: f.title, check_id: f.check_id, cycle }) })) }));
      await atomicWriteJson(path.join(cycleDir, "notes.json"), redactUnknown({ cycle, notes: (out?.notes || []).map((n) => redactText(String(n))) }));
      if (out?.artifacts) await atomicWriteJson(path.join(cycleDir, "artifacts.json"), redactUnknown(out.artifacts));

      cp.cycles.push(cycleResult);
      cp.last_completed_cycle = cycle;
      cp.updated_at = nowFn();
      await persist(root, cp);

      if (cp.wall_clock_ms !== undefined && clockMode !== "frozen") {
        const elapsed = Date.now() - cp.started_at_ms;
        if (elapsed > cp.wall_clock_ms) return await finalize("halted", "wall_clock_cap");
      }
    }
    return await finalize(cp.last_completed_cycle >= cp.max_cycles ? "halted" : "completed", cp.last_completed_cycle >= cp.max_cycles ? "max_cycles" : "completed");
  } catch (err) {
    cp.status = "failed";
    cp.stop_reason = "error";
    cp.updated_at = nowFn();
    await persist(root, cp);
    throw err;
  }
}
