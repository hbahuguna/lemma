import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { StateError, HarnessError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { now as realNow } from "./determinism.js";
import { redactText, redactUnknown } from "./redaction.js";
import { registryFingerprint, type CheckRegistryLike } from "./checks.js";

export type AutoStopReason =
  | "completed"
  | "max_cycles"
  | "wall_clock_budget"
  | "no_new_findings"
  | "no_progress"
  | "manual_kill"
  | "mutation_declined"
  | "registry_fingerprint_mismatch"
  | "error";

export interface AutoMutationProposal {
  id?: string;
  description: string;
  files?: string[];
  kind?: string;
  patch?: string;
  metadata?: Record<string, unknown>;
}

export type AutoMutationDecision =
  | { approved: true; note?: string }
  | { approved: false; reason?: string };

export interface AutoMutationRecord {
  cycle: number;
  proposal: AutoMutationProposal;
  decision: AutoMutationDecision;
  recorded_at: string;
  status: "approved" | "declined";
}

export interface AutoCycleEvidence {
  cycle: number;
  directory: string;
  files: string[];
  redacted: true;
}

export interface AutoCycleResult {
  cycle: number;
  started_at: string;
  completed_at: string;
  status: "completed" | "halted" | "failed";
  findings_count: number;
  new_findings_count: number;
  progress_made: boolean;
  mutations: AutoMutationRecord[];
  notes?: string[];
  evidence: AutoCycleEvidence;
}

export interface AutoLoopResult {
  run_id: string;
  status: "completed" | "halted" | "failed";
  stop_reason: AutoStopReason;
  cycles_completed: number;
  max_cycles: number;
  halted: boolean;
  resumed_from_cycle: number;
  cycles: AutoCycleResult[];
  evidence_root: string;
  state_path: string;
  same_run_id: string;
  declined_mutation?: AutoMutationRecord;
  error?: { type: string; message: string };
  deterministic: {
    seed: number | null;
    clock_mode: "real" | "frozen";
    frozen_now?: string;
  };
}

export interface AutoStopOn {
  maxCycles?: number;
  wallClockMs?: number;
  haltOnNoNewFindings?: boolean;
  haltOnNoProgress?: boolean;
  /** External/manual kill check. */
  isKillRequested?: () => boolean | Promise<boolean>;
}

export interface AutoMutationContext {
  cycle: number;
  run_id: string;
}

export type ApproveMutationFn = (
  proposal: AutoMutationProposal,
  context: AutoMutationContext,
) => AutoMutationDecision | Promise<AutoMutationDecision>;

export interface AutoCycleExecutionInput {
  root: string;
  run_id: string;
  cycle: number;
  target: unknown;
  resumed: boolean;
  seed: number | null;
  now: () => string;
  /** Request mutation approval; throws/halts handled by loop when declined. */
  requestMutation: (proposal: AutoMutationProposal) => Promise<AutoMutationRecord>;
  /** Write redacted cycle evidence file; returns relative/absolute path recorded. */
  writeEvidence: (name: string, data: unknown) => Promise<string>;
  /** Optional manual kill signal. */
  isKillRequested: () => Promise<boolean>;
  previous?: AutoCycleResult | null;
  loopState: AutoLoopState;
}

export interface AutoCycleExecutionOutput {
  findings_count?: number;
  new_findings_count?: number;
  progress_made?: boolean;
  notes?: string[];
  /** Optional proposed mutations to attempt this cycle (each gated). */
  mutations?: AutoMutationProposal[];
  /** Optional hook to apply an approved mutation. */
  applyMutation?: (record: AutoMutationRecord) => void | Promise<void>;
  /** If true, cycle reports explicit no-progress/new-findings based on values; else inferred. */
  explicit?: boolean;
  /** Extra redacted artifacts. */
  artifacts?: Record<string, unknown>;
}

export type ExecuteAutoCycleFn = (input: AutoCycleExecutionInput) => Promise<AutoCycleExecutionOutput | void> | AutoCycleExecutionOutput | void;

export interface RunAutoLoopParams {
  root: string;
  target: unknown;
  maxCycles?: number;
  stopOn?: AutoStopOn;
  approveMutation: ApproveMutationFn;
  /** Injectable/test hooks (not part of minimal signature but supported). */
  executeCycle?: ExecuteAutoCycleFn;
  clock?: "real" | "frozen";
  frozenNow?: string;
  seed?: number | null;
  runId?: string;
  registry?: CheckRegistryLike | null;
  registryFingerprint?: string;
  resume?: boolean;
}

interface AutoLoopState {
  schema_version: "lemma.auto_loop/v1";
  run_id: string;
  target: unknown;
  registry_fingerprint: string;
  max_cycles: number;
  stop_on: {
    wall_clock_ms?: number;
    halt_on_no_new_findings: boolean;
    halt_on_no_progress: boolean;
  };
  status: "running" | "completed" | "halted" | "failed";
  stop_reason?: AutoStopReason;
  created_at: string;
  updated_at: string;
  started_at_ms: number;
  last_completed_cycle: number;
  cycles: AutoCycleResult[];
  declined_mutation?: AutoMutationRecord;
  deterministic: {
    seed: number | null;
    clock_mode: "real" | "frozen";
    frozen_now?: string;
  };
}

function toMsBudget(stopOn?: AutoStopOn): number | undefined {
  const v = stopOn?.wallClockMs;
  if (v === undefined || v === null) return undefined;
  if (!Number.isFinite(v) || v < 0) throw new HarnessError("stopOn.wallClockMs must be a non-negative number");
  return Math.floor(v);
}

function computeFingerprint(params: RunAutoLoopParams): string {
  if (typeof params.registryFingerprint === "string" && params.registryFingerprint.length) return params.registryFingerprint;
  if (params.registry !== undefined) return registryFingerprint(params.registry ?? null);
  return registryFingerprint(null);
}

function makeNow(params: RunAutoLoopParams, fallbackStart?: string): () => string {
  if (params.clock === "frozen") {
    const fixed = params.frozenNow ?? fallbackStart ?? new Date(0).toISOString();
    return () => fixed;
  }
  return () => realNow();
}

async function writeCycleEvidence(dir: string, name: string, data: unknown): Promise<string> {
  await ensureDir(dir);
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_") || "evidence.json";
  const file = path.join(dir, safe);
  const redacted = redactUnknown(data);
  await atomicWriteJson(file, redacted);
  return file;
}

async function loadLoopState(statePath: string): Promise<AutoLoopState | null> {
  try {
    return await readJsonFile<AutoLoopState>(statePath);
  } catch (err: any) {
    if (err instanceof StateError && /not found/i.test(String(err?.message))) return null;
    throw err;
  }
}

async function saveLoopState(statePath: string, state: AutoLoopState): Promise<void> {
  await ensureDir(path.dirname(statePath));
  await atomicWriteJson(statePath, state);
}

export async function runAutoLoop(params: RunAutoLoopParams): Promise<AutoLoopResult> {
  const { root, target, approveMutation } = params;
  if (!root) throw new HarnessError("runAutoLoop requires root");
  if (typeof approveMutation !== "function") throw new HarnessError("runAutoLoop requires approveMutation callback");

  const autoRoot = path.join(root, ".lemma", "auto");
  await ensureDir(autoRoot);

  const maxCyclesRaw = params.maxCycles ?? params.stopOn?.maxCycles ?? 5;
  if (!Number.isInteger(maxCyclesRaw) || maxCyclesRaw < 1) throw new HarnessError("maxCycles must be a positive integer");
  const effectiveMax = Math.max(1, Math.min(maxCyclesRaw, params.stopOn?.maxCycles ?? maxCyclesRaw)); // explicit/default cap (default <=5)

  const wallClockMs = toMsBudget(params.stopOn);
  const haltOnNoNewFindings = params.stopOn?.haltOnNoNewFindings !== false;
  const haltOnNoProgress = params.stopOn?.haltOnNoProgress !== false;
  const fingerprint = computeFingerprint(params);
  const seed = params.seed ?? null;
  const clockMode: "real" | "frozen" = params.clock === "frozen" ? "frozen" : "real";

  // determine run id / resume
  const explicitRunId = params.runId;
  const statePathFor = (id: string) => path.join(autoRoot, `${id}.state.json`);
  let state: AutoLoopState | null = null;
  let resumedFromCycle = 0;
  let runId = explicitRunId ?? "";

  if (params.resume || explicitRunId) {
    if (explicitRunId) {
      state = await loadLoopState(statePathFor(explicitRunId));
      runId = explicitRunId;
    } else {
      // best-effort: find latest state file
      try {
        const files = (await fs.readdir(autoRoot)).filter((f) => f.endsWith('.state.json')).sort();
        const last = files[files.length - 1];
        if (last) {
          state = await loadLoopState(path.join(autoRoot, last));
          runId = state?.run_id ?? "";
        }
      } catch { /* ignore */ }
    }
    if (state) {
      if (state.registry_fingerprint !== fingerprint) {
        throw new StateError(
          `Plugin registry changed since this auto loop started (saved ${state.registry_fingerprint}, current ${fingerprint}). Start a new auto loop instead of resuming.`,
          { details: { run_id: state.run_id, saved: state.registry_fingerprint, current: fingerprint } },
        );
      }
      resumedFromCycle = state.last_completed_cycle;
      // adopt persisted deterministic settings for stable resume
      // (seed/clock kept from state)
    }
  }

  if (!state) {
    runId = runId || `auto-${randomUUID()}`;
    const nowFnInit = makeNow(params);
    const createdAt = nowFnInit();
    state = {
      schema_version: "lemma.auto_loop/v1",
      run_id: runId,
      target: redactUnknown(target),
      registry_fingerprint: fingerprint,
      max_cycles: effectiveMax,
      stop_on: {
        ...(wallClockMs !== undefined ? { wall_clock_ms: wallClockMs } : {}),
        halt_on_no_new_findings: haltOnNoNewFindings,
        halt_on_no_progress: haltOnNoProgress,
      },
      status: "running",
      created_at: createdAt,
      updated_at: createdAt,
      started_at_ms: clockMode === "frozen" ? 0 : Date.now(),
      last_completed_cycle: 0,
      cycles: [],
      deterministic: {
        seed,
        clock_mode: clockMode,
        ...(params.frozenNow ? { frozen_now: params.frozenNow } : {}),
      },
    };
    await saveLoopState(statePathFor(runId), state);
  } else {
    // ensure mutable fields reflect requested caps where safe
    state.max_cycles = effectiveMax;
    state.stop_on.halt_on_no_new_findings = haltOnNoNewFindings;
    state.stop_on.halt_on_no_progress = haltOnNoProgress;
    if (wallClockMs !== undefined) state.stop_on.wall_clock_ms = wallClockMs;
    state.status = "running";
  }

  const statePath = statePathFor(state.run_id);
  const nowFn = params.clock === "frozen"
    ? () => (state!.deterministic.frozen_now ?? params.frozenNow ?? state!.created_at)
    : () => realNow();

  const isKillRequested = async (): Promise<boolean> => {
    if (typeof params.stopOn?.isKillRequested === "function") {
      try { return !!(await params.stopOn.isKillRequested()); } catch { return false; }
    }
    // also check conventional kill file under root/.lemma/kill
    try {
      await fs.access(path.join(root, ".lemma", "kill"));
      return true;
    } catch {
      return false;
    }
  };

  let stopReason: AutoStopReason = "completed";
  let declinedMutation: AutoMutationRecord | undefined = state.declined_mutation;

  const finalize = async (status: AutoLoopResult["status"], reason: AutoStopReason, err?: unknown): Promise<AutoLoopResult> => {
    state!.status = status;
    state!.stop_reason = reason;
    state!.updated_at = nowFn();
    if (declinedMutation) state!.declined_mutation = declinedMutation;
    await saveLoopState(statePath, state!);
    const result: AutoLoopResult = {
      run_id: state!.run_id,
      status,
      stop_reason: reason,
      cycles_completed: state!.last_completed_cycle,
      max_cycles: state!.max_cycles,
      halted: status === "halted",
      resumed_from_cycle: resumedFromCycle,
      cycles: [...state!.cycles],
      evidence_root: path.join(autoRoot, state!.run_id),
      state_path: statePath,
      same_run_id: state!.run_id,
      ...(declinedMutation ? { declined_mutation: declinedMutation } : {}),
      ...(err ? { error: { type: (err as any)?.name || "Error", message: redactText(String((err as any)?.message || err)) } } : {}),
      deterministic: { ...state!.deterministic },
    };
    return result;
  };

  try {
    for (let cycle = state.last_completed_cycle + 1; cycle <= state.max_cycles; cycle++) {
      // wall-clock budget (checked before cycle)
      if (state.stop_on.wall_clock_ms !== undefined && clockMode !== "frozen") {
        const elapsed = Date.now() - state.started_at_ms;
        if (elapsed > state.stop_on.wall_clock_ms) {
          stopReason = "wall_clock_budget";
          return await finalize("halted", stopReason);
        }
      }
      if (await isKillRequested()) {
        stopReason = "manual_kill";
        return await finalize("halted", stopReason);
      }

      const cycleDir = path.join(autoRoot, state.run_id, String(cycle));
      await ensureDir(cycleDir);
      const cycleStartedAt = nowFn();
      const mutationRecords: AutoMutationRecord[] = [];
      const evidenceFiles: string[] = [];

      const writeEvidence = async (name: string, data: unknown) => {
        const f = await writeCycleEvidence(cycleDir, name, data);
        evidenceFiles.push(f);
        return f;
      };

      const requestMutation = async (proposal: AutoMutationProposal): Promise<AutoMutationRecord> => {
        // Every mutation gated by callback; silent mutation impossible.
        const decision = await approveMutation(proposal, { cycle, run_id: state!.run_id });
        const record: AutoMutationRecord = {
          cycle,
          proposal: redactUnknown(proposal) as AutoMutationProposal,
          decision: decision.approved ? { approved: true, ...(decision.note ? { note: redactText(decision.note) } : {}) } : { approved: false, ...(decision.reason ? { reason: redactText(decision.reason) } : {}) },
          recorded_at: nowFn(),
          status: decision.approved ? "approved" : "declined",
        };
        mutationRecords.push(record);
        await writeEvidence(`mutation-${mutationRecords.length}.json`, record);
        if (!decision.approved) {
          declinedMutation = record;
          // stop loop and record declined mutation as typed result
          const declinedErr = new StateError("Mutation declined; auto loop halted", { details: { cycle, proposal: record.proposal } });
          (declinedErr as any).__mutation_declined = record;
          throw declinedErr;
        }
        return record;
      };

      let execOut: AutoCycleExecutionOutput | void = undefined;
      const executeCycle = params.executeCycle;
      let cycleError: unknown = null;
      let findingsCount = 0;
      let newFindings = 0;
      let progress = false;
      const notes: string[] = [];

      try {
        await writeEvidence("before.json", { cycle, run_id: state.run_id, target: state.target, started_at: cycleStartedAt });
        if (executeCycle) {
          execOut = await executeCycle({
            root,
            run_id: state.run_id,
            cycle,
            target,
            resumed: resumedFromCycle > 0 && cycle === resumedFromCycle + 1,
            seed: state.deterministic.seed,
            now: nowFn,
            requestMutation,
            writeEvidence,
            isKillRequested,
            previous: state.cycles[state.cycles.length - 1] ?? null,
            loopState: state,
          });
        }
        const out = (execOut || {}) as AutoCycleExecutionOutput;
        // apply gated mutations if executor returned proposals and/or apply hooks
        if (Array.isArray(out.mutations)) {
          for (const m of out.mutations) {
            const rec = mutationRecords.find((r) => r.proposal.description === m.description) || await requestMutation(m);
            if (typeof out.applyMutation === "function") {
              await out.applyMutation(rec);
              await writeEvidence(`applied-${mutationRecords.length}.json`, { mutation: rec, applied_at: nowFn() });
            }
          }
        }
        findingsCount = Number.isFinite(out.findings_count as number) ? Number(out.findings_count) : findingsCount;
        newFindings = Number.isFinite(out.new_findings_count as number) ? Number(out.new_findings_count) : newFindings;
        progress = typeof out.progress_made === "boolean" ? out.progress_made : (newFindings > 0);
        if (Array.isArray(out.notes)) notes.push(...out.notes.map((n) => redactText(String(n))));
        if (out.artifacts) await writeEvidence("artifacts.json", out.artifacts);
        await writeEvidence("after.json", { cycle, completed_at: nowFn(), findings_count: findingsCount, new_findings_count: newFindings, progress_made: progress });
        await writeEvidence("diff.json", { cycle, mutations: mutationRecords.map((m) => ({ description: m.proposal.description, status: m.status, files: m.proposal.files || [] })) });
        await writeEvidence("transcript.json", { cycle, notes, seed: state.deterministic.seed, clock_mode: state.deterministic.clock_mode });
      } catch (e: any) {
        if (e && e.__mutation_declined) {
          // persist partial cycle? record halt due to decline without marking cycle completed
          await writeEvidence("halt.json", { reason: "mutation_declined", declined_mutation: declinedMutation });
          stopReason = "mutation_declined";
          return await finalize("halted", stopReason);
        }
        cycleError = e;
      }

      if (cycleError) {
        await writeEvidence("error.json", { message: redactText(String((cycleError as any)?.message || cycleError)), type: (cycleError as any)?.name || "Error" });
        stopReason = "error";
        state.updated_at = nowFn();
        await saveLoopState(statePath, state);
        return await finalize("failed", stopReason, cycleError);
      }

      const cycleResult: AutoCycleResult = {
        cycle,
        started_at: cycleStartedAt,
        completed_at: nowFn(),
        status: "completed",
        findings_count: findingsCount,
        new_findings_count: newFindings,
        progress_made: progress,
        mutations: mutationRecords,
        ...(notes.length ? { notes } : {}),
        evidence: { cycle, directory: cycleDir, files: evidenceFiles, redacted: true },
      };
      state.cycles.push(cycleResult);
      state.last_completed_cycle = cycle;
      state.updated_at = nowFn();
      await saveLoopState(statePath, state);

      // stop conditions after cycle
      if (haltOnNoNewFindings && newFindings === 0) {
        stopReason = "no_new_findings";
        return await finalize("halted", stopReason);
      }
      if (haltOnNoProgress && !progress) {
        stopReason = "no_progress";
        return await finalize("halted", stopReason);
      }
      if (state.stop_on.wall_clock_ms !== undefined && clockMode !== "frozen") {
        const elapsed = Date.now() - state.started_at_ms;
        if (elapsed > state.stop_on.wall_clock_ms) {
          stopReason = "wall_clock_budget";
          return await finalize("halted", stopReason);
        }
      }
      if (cycle >= state.max_cycles) {
        stopReason = "max_cycles";
        return await finalize("halted", stopReason);
      }
    }

    stopReason = state.last_completed_cycle >= state.max_cycles ? "max_cycles" : "completed";
    return await finalize(stopReason === "completed" ? "completed" : "halted", stopReason);
  } catch (err) {
    if ((err as any)?.__mutation_declined) {
      stopReason = "mutation_declined";
      return await finalize("halted", stopReason);
    }
    stopReason = "error";
    return await finalize("failed", stopReason, err);
  }
}
