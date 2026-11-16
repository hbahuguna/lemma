import { HarnessError, KillSwitchHaltError, StateError } from "./errors.js";
import { ModeMismatchError, normalizeExecutionMode } from "./execution-modes.js";
import { RunSizeMismatchError, buildRunSizeCoverageNotes, normalizeRunSize, perspectiveCountForSize } from "./run-size.js";
import { registryFingerprint, type CheckRegistryLike } from "./checks.js";
import {
  currentDeterminism,
  entropyCounter,
  makeDeterminism,
  now,
  resetDeterminism,
  setDeterminism,
  type ClockMode,
} from "./determinism.js";
import { EvidenceStore } from "./evidence.js";
import { rebuildContractHealth } from "./findings.js";
import {
  CheckStatus,
  DomainPhaseName,
  PhaseStatus,
  RunStatus,
  createRunState,
  normalizeCheck,
  normalizePhase,
  normalizeRunState,
  normalizeTarget,
  targetToDict,
  type Finding,
  type InvalidFinding,
  type Phase,
  type RunStateDomain,
  type Target,
} from "./models.js";
import type { StateStore } from "./state-store.js";
import {
  PHASE_ORDER,
  RELEASE_CONFIDENCE,
  type PhaseName as WorkflowPhaseName,
  type Workflow,
} from "./workflows.js";

export interface OrchestratorBudget {
  maxChecks: number;
}

export interface OrchestratorRunOptions {
  target: Target | Record<string, unknown>;
  intent?: string;
  workflow?: Workflow;
  workflowId?: string;
  workflowVersion?: string;
  maxChecks?: number;
  runId?: string;
  options?: Record<string, unknown>;
  resume?: boolean;
  /** Precomputed registry fingerprint (wins over `registry` when provided). */
  registryFingerprint?: string;
  /** Registry used to compute/validate the run fingerprint (plugin-aware). */
  registry?: CheckRegistryLike | null;
  evidenceStore?: EvidenceStore;
  stateDirName?: string;
  seed?: number | null;
  clockMode?: ClockMode;
  frozenClock?: unknown;
  mode?: string;
  runSize?: string;
  run_size?: string;
}

export interface PhaseHandlerContext {
  store: StateStore;
  state: RunStateDomain;
  phase: Phase;
  options: Required<Pick<OrchestratorRunOptions, "intent" | "maxChecks">> &
    Omit<OrchestratorRunOptions, "intent" | "maxChecks">;
  budget: OrchestratorBudget;
  halt: (reason: string, manual?: boolean) => Promise<void>;
  isKillRequested: () => Promise<string | null>;
  save: () => Promise<void>;
  appendEvent: (event: Record<string, unknown>) => Promise<void>;
}

export type PhaseHandler = (ctx: PhaseHandlerContext) => void | Promise<void>;

export interface PhaseHandlers {
  risk_analysis?: PhaseHandler;
  test_planning?: PhaseHandler;
  execution?: PhaseHandler;
  evidence_collection?: PhaseHandler;
  confidence_scoring?: PhaseHandler;
}

export interface OrchestratorConfig {
  store: StateStore;
  handlers?: PhaseHandlers;
}

function phaseFromWorkflow(name: WorkflowPhaseName, workflow: Workflow): Phase {
  const def = workflow.phases.find((p) => p.name === name);
  return normalizePhase({
    name,
    title: def?.title ?? name,
    status: PhaseStatus.PENDING,
    summary: "",
    details: {},
  });
}

function validateBudget(options: OrchestratorRunOptions): OrchestratorBudget {
  const maxChecks = options.maxChecks ?? 20;
  if (!Number.isInteger(maxChecks) || maxChecks < 1) {
    throw new HarnessError("maxChecks must be a positive integer");
  }
  return { maxChecks };
}

function markRemainingPhasesSkipped(state: RunStateDomain, fromIndex: number, reason: string): void {
  for (let i = fromIndex; i < PHASE_ORDER.length; i++) {
    const name = PHASE_ORDER[i];
    if (!name) continue;
    let phase = state.phases.find((p) => p.name === name);
    if (!phase) {
      phase = normalizePhase({ name, title: name, status: PhaseStatus.PENDING });
      state.phases.push(phase);
    }
    if (phase.status === PhaseStatus.COMPLETED || phase.status === PhaseStatus.HALTED) continue;
    phase.status = PhaseStatus.SKIPPED;
    phase.summary = reason;
    if (!phase.started_at) phase.started_at = now();
    phase.completed_at = now();
  }
  for (const check of state.checks) {
    if (check.status === CheckStatus.PLANNED || check.status === CheckStatus.RUNNING) {
      check.status = CheckStatus.SKIPPED;
      check.skip_reason = check.skip_reason || reason;
      check.actual = check.actual || reason;
      if (!check.completed_at) check.completed_at = now();
    }
  }
}

function computeCurrentRegistryFingerprint(options: OrchestratorRunOptions): string {
  if (typeof options.registryFingerprint === "string" && options.registryFingerprint.length > 0) {
    return options.registryFingerprint;
  }
  if (options.registry) {
    return registryFingerprint(options.registry);
  }
  return registryFingerprint(null);
}

function prepareResumeState(state: RunStateDomain, requestedTarget: Target): void {
  if (state.status === RunStatus.HALTED) {
    throw new StateError(
      "This run was halted by the kill switch. Start a new run after investigating the finding, or remove the kill file and use a new run ID.",
      { details: { run_id: state.run_id, status: state.status } },
    );
  }
  const savedTarget = normalizeTarget(state.target);
  if (savedTarget.kind !== requestedTarget.kind || savedTarget.resolved !== requestedTarget.resolved) {
    throw new StateError(
      `Resume target does not match the saved run. Saved: ${savedTarget.resolved}; requested: ${requestedTarget.resolved}.`,
      { details: { saved: targetToDict(savedTarget), requested: targetToDict(requestedTarget) } },
    );
  }

  for (const phase of state.phases) {
    if (phase.status === PhaseStatus.RUNNING || phase.status === PhaseStatus.FAILED) {
      phase.status = PhaseStatus.PENDING;
      phase.completed_at = null;
      phase.summary = "";
    }
    if (phase.name === DomainPhaseName.RISK_ANALYSIS || phase.name === DomainPhaseName.TEST_PLANNING) {
      if (phase.status !== PhaseStatus.COMPLETED) {
        phase.status = PhaseStatus.PENDING;
      }
    }
  }

  const execution = state.phases.find((p) => p.name === DomainPhaseName.EXECUTION);
  const rerunIds = new Set<string>();
  if (!execution || execution.status !== PhaseStatus.COMPLETED) {
    for (const check of state.checks) {
      if (
        check.status === CheckStatus.RUNNING ||
        check.status === CheckStatus.PLANNED ||
        check.status === CheckStatus.ERROR
      ) {
        rerunIds.add(check.id);
      }
    }
    state.findings = state.findings.filter((f: Finding) => !rerunIds.has(String(f.check_id ?? "")));
    state.blockers = state.blockers.filter((b) => !rerunIds.has(String(b.check_id ?? "")));
    const beforeInvalid = state.invalid_findings.length;
    state.invalid_findings = state.invalid_findings.filter((f: InvalidFinding) => !rerunIds.has(String(f.check_id ?? "")));
    if (state.invalid_findings.length !== beforeInvalid) {
      rebuildContractHealth(state);
    }
    for (const check of state.checks) {
      if (rerunIds.has(check.id)) {
        check.status = CheckStatus.PLANNED;
        check.actual = "";
        check.evidence = [];
        check.finding_ids = [];
        check.skip_reason = "";
        check.started_at = null;
        check.completed_at = null;
        check.metadata = {};
      }
    }
  }

  state.status = RunStatus.RUNNING;
  state.error = "";
  state.completed_at = null;
  state.halted_reason = "";
  state.updated_at = now();
  if (state.kill_switch.triggered) {
    // A resumed, non-halted run should not remain marked triggered from prior state.
    state.kill_switch = { ...state.kill_switch, triggered: false, reason: "", manual: false, triggered_at: null };
  }
}

export class Orchestrator {
  private readonly store: StateStore;
  private readonly handlers: PhaseHandlers;

  constructor(config: OrchestratorConfig) {
    this.store = config.store;
    this.handlers = config.handlers ?? {};
  }

  async run(options: OrchestratorRunOptions): Promise<RunStateDomain> {
    if (options.resume) return this.resume(options);
    return this.runNew(options);
  }

  private wantsDeterminism(options: OrchestratorRunOptions): boolean {
    return options.seed !== undefined || options.clockMode !== undefined || options.frozenClock !== undefined;
  }

  private persistSequence(state: RunStateDomain): void {
    state.options = { ...(state.options ?? {}) };
    if (state.seed !== null && state.seed !== undefined) {
      const seq = entropyCounter();
      state.options.id_sequence = seq;
      state.options.entropy_counter = seq;
    }
  }

  async resume(options: OrchestratorRunOptions): Promise<RunStateDomain> {
    const loadedRaw = await this.store.loadProgress<unknown>();
    const state = normalizeRunState(loadedRaw);
    const workflow = options.workflow ?? RELEASE_CONFIDENCE;
    const requestedTarget = normalizeTarget(options.target ?? state.target);

    if (state.workflow_version && state.workflow_version !== workflow.version) {
      throw new StateError(
        `Workflow '${state.workflow_id}' changed since this run started (saved version ${state.workflow_version}, current version ${workflow.version}). Start a new run instead of resuming.`,
        { details: { run_id: state.run_id, saved: state.workflow_version, current: workflow.version } },
      );
    }

    const savedFingerprint = typeof state.options?.registry_fingerprint === "string"
      ? state.options.registry_fingerprint
      : typeof state.options?.plugin_registry_fingerprint === "string"
        ? state.options.plugin_registry_fingerprint
        : "";
    const currentFingerprint = computeCurrentRegistryFingerprint(options);
    if (savedFingerprint && savedFingerprint !== currentFingerprint) {
      throw new StateError(
        `Plugin registry changed since this run started (saved ${savedFingerprint}, current ${currentFingerprint}). Start a new run instead of resuming.`,
        { details: { run_id: state.run_id, saved: savedFingerprint, current: currentFingerprint } },
      );
    }

    const savedMode = normalizeExecutionMode((state as any).mode ?? state.options?.execution_mode, "test");
    const requestedMode = normalizeExecutionMode(options.mode ?? (options.options as any)?.execution_mode ?? savedMode, savedMode);
    if (savedMode !== requestedMode) {
      throw new ModeMismatchError(savedMode as any, requestedMode as any);
    }
    (state as any).mode = savedMode;
    state.options = { ...(state.options ?? {}), execution_mode: savedMode };

    const savedRunSize = normalizeRunSize((state as any).run_size ?? state.options?.run_size, "medium");
    const requestedRunSize = normalizeRunSize((options as any).runSize ?? (options as any).run_size ?? (options.options as any)?.run_size ?? savedRunSize, savedRunSize);
    if (savedRunSize !== requestedRunSize) {
      throw new RunSizeMismatchError(savedRunSize as any, requestedRunSize as any);
    }
    (state as any).run_size = savedRunSize;
    (state as any).perspectives_count = perspectiveCountForSize(savedRunSize as any);
    state.options = { ...(state.options ?? {}), execution_mode: savedMode, run_size: savedRunSize, perspectives_count: (state as any).perspectives_count };

    prepareResumeState(state, requestedTarget);

    const evidenceStore = options.evidenceStore ?? new EvidenceStore(
      this.store.root,
      state.run_id,
      options.stateDirName ? { stateDirName: options.stateDirName } : undefined,
    );
    const evidencePhase = state.phases.find((p) => p.name === DomainPhaseName.EVIDENCE_COLLECTION);
    if (!evidencePhase || evidencePhase.status !== PhaseStatus.COMPLETED) {
      await evidenceStore.reconcile(state.checks);
    }
    try {
      state.evidence_dir = evidenceStore.summary().directory;
    } catch {
      // keep existing evidence_dir if summary unavailable
    }

    const budget = validateBudget({ ...options, maxChecks: options.maxChecks ?? (typeof state.options?.maxChecks === "number" ? state.options.maxChecks : 20) });
    const intent = options.intent ?? state.intent ?? "";
    state.intent = intent;
    state.options = { ...(state.options ?? {}), ...(options.options ?? {}), maxChecks: budget.maxChecks };
    state.options.registry_fingerprint = currentFingerprint;
    state.options.plugin_registry_fingerprint = currentFingerprint;

    // Restore saved determinism on seeded runs (saved state wins).
    const useDeterminism = state.seed !== null && state.seed !== undefined || this.wantsDeterminism(options);
    let previous: ReturnType<typeof currentDeterminism> | null = null;
    if (useDeterminism) {
      const savedSeqRaw = state.options.id_sequence ?? state.options.entropy_counter ?? 0;
      const savedSeq = typeof savedSeqRaw === "number" && Number.isFinite(savedSeqRaw) ? Math.max(0, Math.trunc(savedSeqRaw)) : 0;
      const seed = state.seed ?? options.seed ?? null;
      const clockMode = (state.clock_mode as ClockMode | undefined) ?? options.clockMode ?? "real";
      const frozenClock = state.options.frozen_clock ?? options.frozenClock;
      const det = makeDeterminism({
        seed,
        clockMode,
        ...(frozenClock !== undefined ? { frozenClock } : {}),
        entropyCounter: savedSeq,
      });
      previous = setDeterminism(det);
      state.seed = det.seed;
      state.clock_mode = det.clockMode;
      if (clockMode === "frozen" && frozenClock !== undefined) state.options.frozen_clock = frozenClock;
      this.persistSequence(state);
    }

    const resolvedOptions: Required<Pick<OrchestratorRunOptions, "intent" | "maxChecks">> &
      Omit<OrchestratorRunOptions, "intent" | "maxChecks"> = {
      ...options,
      intent,
      maxChecks: budget.maxChecks,
      resume: true,
      target: requestedTarget,
      workflow,
    };

    try {
      this.persistSequence(state);
      await this.store.saveProgress(state as unknown as Record<string, unknown>);
      await this.store.appendEvent({ run_id: state.run_id, event: "run_resumed", timestamp: now() });
      return await this.executeFromState(state, workflow, resolvedOptions, budget);
    } finally {
      if (previous) resetDeterminism(previous);
    }
  }

  private async runNew(options: OrchestratorRunOptions): Promise<RunStateDomain> {
    const budget = validateBudget(options);
    const workflow = options.workflow ?? RELEASE_CONFIDENCE;
    const intent = options.intent ?? "";
    const mode = normalizeExecutionMode(options.mode ?? (options.options as any)?.execution_mode, "test");
    const runSize = normalizeRunSize((options as any).runSize ?? (options as any).run_size ?? (options.options as any)?.run_size, "medium");
    const resolvedOptions: Required<Pick<OrchestratorRunOptions, "intent" | "maxChecks">> &
      Omit<OrchestratorRunOptions, "intent" | "maxChecks"> = {
      ...options,
      intent,
      maxChecks: budget.maxChecks,
      resume: false,
      workflow,
    };

    const useDeterminism = this.wantsDeterminism(options);
    let previous: ReturnType<typeof currentDeterminism> | null = null;
    if (useDeterminism) {
      const det = makeDeterminism({
        seed: options.seed ?? null,
        clockMode: options.clockMode ?? "real",
        ...(options.frozenClock !== undefined ? { frozenClock: options.frozenClock } : {}),
      });
      previous = setDeterminism(det);
    }

    try {
      const state = createRunState({
        ...(options.runId !== undefined ? { run_id: options.runId } : {}),
        workflow_id: workflow.id,
        workflow_version: workflow.version,
        target: options.target,
        intent,
        mode,
        run_size: runSize,
        perspectives_count: perspectiveCountForSize(runSize as any),
        coverage_notes: buildRunSizeCoverageNotes(runSize as any),
        options: { ...(options.options ?? {}), maxChecks: budget.maxChecks, execution_mode: mode, run_size: runSize, perspectives_count: perspectiveCountForSize(runSize as any) },
      });
      state.phases = PHASE_ORDER.map((name) => phaseFromWorkflow(name, workflow));
      state.current_phase = DomainPhaseName.RISK_ANALYSIS;
      state.status = RunStatus.RUNNING;
      state.kill_switch = { ...state.kill_switch, armed: true, triggered: false, reason: "", manual: false };
      if (useDeterminism) {
        const det = currentDeterminism();
        state.seed = det.seed;
        state.clock_mode = det.clockMode;
        if (options.clockMode === "frozen" && options.frozenClock !== undefined) {
          state.options.frozen_clock = options.frozenClock;
        }
        this.persistSequence(state);
      }
      const fingerprint = computeCurrentRegistryFingerprint(options);
      state.options.registry_fingerprint = fingerprint;
      state.options.plugin_registry_fingerprint = fingerprint;

      await this.store.appendEvent({ run_id: state.run_id, event: "run_started", workflow_id: state.workflow_id, workflow_version: state.workflow_version });
      this.persistSequence(state);
      await this.store.saveProgress(state as unknown as Record<string, unknown>);
      return await this.executeFromState(state, workflow, resolvedOptions, budget);
    } finally {
      if (previous) resetDeterminism(previous);
    }
  }

  private async executeFromState(
    state: RunStateDomain,
    _workflow: Workflow,
    resolvedOptions: Required<Pick<OrchestratorRunOptions, "intent" | "maxChecks">> &
      Omit<OrchestratorRunOptions, "intent" | "maxChecks">,
    budget: OrchestratorBudget,
  ): Promise<RunStateDomain> {
    const persist = async (): Promise<void> => {
      this.persistSequence(state);
      state.updated_at = now();
      await this.store.saveProgress(state as unknown as Record<string, unknown>);
    };
    const appendEvent = async (event: Record<string, unknown>): Promise<void> => {
      await this.store.appendEvent({ run_id: state.run_id, ...event });
    };
    const isKillRequested = async (): Promise<string | null> => this.store.killRequest();
    const triggerHalt = async (reason: string, manual = false): Promise<void> => {
      if (state.kill_switch.triggered) return;
      state.kill_switch = {
        ...state.kill_switch,
        triggered: true,
        reason,
        manual,
        triggered_at: now(),
      };
      state.status = RunStatus.HALTED;
      state.halted_reason = reason;
      state.completed_at = now();
      await appendEvent({ event: "kill_switch_triggered", reason, manual, timestamp: now() });
      await persist();
    };

    let caught: unknown;
    try {
      for (let i = 0; i < PHASE_ORDER.length; i++) {
        const phaseName = PHASE_ORDER[i];
        if (!phaseName) continue;
        const phaseIndex = i;
        let phase = state.phases.find((p) => p.name === phaseName);
        if (!phase) {
          phase = normalizePhase({ name: phaseName, title: phaseName });
          state.phases.push(phase);
        }

        const killReason = await isKillRequested();
        if (killReason || state.kill_switch.triggered) {
          const reason = state.halted_reason || killReason || "Kill switch triggered";
          if (!state.kill_switch.triggered) await triggerHalt(reason, Boolean(killReason));
          markRemainingPhasesSkipped(state, phaseIndex, reason);
          await persist();
          break;
        }

        if (phase.status === PhaseStatus.COMPLETED) {
          continue;
        }

        state.current_phase = phaseName;
        phase.status = PhaseStatus.RUNNING;
        phase.started_at = phase.started_at ?? now();
        phase.completed_at = null;
        await appendEvent({ event: "phase_started", phase: phaseName });
        await persist();

        const ctx: PhaseHandlerContext = {
          store: this.store,
          state,
          phase,
          options: resolvedOptions,
          budget,
          halt: triggerHalt,
          isKillRequested,
          save: persist,
          appendEvent,
        };

        try {
          const handler = this.handlers[phaseName];
          if (handler) {
            await handler(ctx);
          } else if (!phase.summary) {
            phase.summary = "No handler registered";
          }

          const midKill = await isKillRequested();
          if (midKill && !state.kill_switch.triggered) {
            await triggerHalt(midKill, true);
          }

          if (state.kill_switch.triggered) {
            phase.status = PhaseStatus.HALTED;
            phase.completed_at = now();
            phase.summary = phase.summary || state.halted_reason || "Halted by kill switch";
            markRemainingPhasesSkipped(state, phaseIndex + 1, state.halted_reason || "Kill switch triggered");
            await appendEvent({ event: "phase_halted", phase: phaseName, reason: state.halted_reason });
            await persist();
            break;
          }

          state.checks = state.checks.map((c) => normalizeCheck(c));
          phase.status = PhaseStatus.COMPLETED;
          phase.completed_at = now();
          await appendEvent({ event: "phase_completed", phase: phaseName });
          await persist();
        } catch (err) {
          if (state.kill_switch.triggered) {
            phase.status = PhaseStatus.HALTED;
            phase.completed_at = now();
            markRemainingPhasesSkipped(state, phaseIndex + 1, state.halted_reason || "Kill switch triggered");
            await persist();
            break;
          }
          if (err instanceof KillSwitchHaltError) {
            await triggerHalt(err.message || "Kill switch halt", false);
            phase.status = PhaseStatus.HALTED;
            phase.completed_at = now();
            markRemainingPhasesSkipped(state, phaseIndex + 1, state.halted_reason || err.message);
            await persist();
            break;
          }
          phase.status = PhaseStatus.FAILED;
          phase.completed_at = now();
          const message = err instanceof Error ? err.message : String(err);
          phase.summary = message;
          state.status = RunStatus.FAILED;
          state.error = message;
          state.completed_at = now();
          await appendEvent({ event: "phase_failed", phase: phaseName, error: message });
          await appendEvent({ event: "run_failed", error: message });
          await persist();
          caught = err;
          break;
        }
      }

      if (state.status === RunStatus.RUNNING) {
        const allCompleted = state.phases.every((p) => p.status === PhaseStatus.COMPLETED);
        if (allCompleted) {
          state.status = RunStatus.COMPLETED;
          state.completed_at = state.completed_at ?? now();
        }
      }

      // Mode semantics (LEM-186): enforce evidence-per-mode contract at run boundary
      const mode = normalizeExecutionMode((state as any).mode ?? state.options?.execution_mode, "test");
      (state as any).mode = mode;
      const runSizeFinal = normalizeRunSize((state as any).run_size ?? state.options?.run_size, "medium");
      (state as any).run_size = runSizeFinal;
      (state as any).perspectives_count = perspectiveCountForSize(runSizeFinal as any);
      if (!Array.isArray((state as any).coverage_notes)) (state as any).coverage_notes = [];
      for (const note of buildRunSizeCoverageNotes(runSizeFinal as any)) {
        if (!(state as any).coverage_notes.includes(note)) (state as any).coverage_notes.push(note);
      }
      state.options = { ...(state.options ?? {}), execution_mode: mode, run_size: runSizeFinal, perspectives_count: (state as any).perspectives_count };
      if (mode === "learn") {
        // exploration without producing final findings
        state.findings = [];
        state.invalid_findings = [];
      } else if (mode === "plan") {
        // planned tests only: no execution findings produced
        state.findings = [];
        state.invalid_findings = [];
        for (const check of state.checks) {
          if (check.status === CheckStatus.PASSED || check.status === CheckStatus.FAILED || check.status === CheckStatus.ERROR) {
            check.status = CheckStatus.PLANNED;
            check.actual = check.actual || "Planned only (plan mode)";
          }
        }
      } else if (mode === "focused") {
        // bounded subset: record explicit scope note in options if provided
        if (!state.options.focus_scope && Array.isArray(state.options.focus_checks)) {
          state.options.focus_scope = { checks: state.options.focus_checks };
        }
      } else if (mode === "review") {
        // independent review mode marker; review artifacts/evidence are carried by run/report state
        state.options.independent_review_mode = true;
      }
    } finally {
      if (state.kill_switch.triggered) {
        state.status = RunStatus.HALTED;
        state.completed_at = state.completed_at ?? now();
        if (!state.halted_reason) state.halted_reason = state.kill_switch.reason || "Kill switch triggered";
      }

      await appendEvent({ event: "run_finished", status: state.status });
      await this.store.recordRun({
        run_id: state.run_id,
        status: state.status,
        workflow_id: state.workflow_id,
        workflow_version: state.workflow_version,
        started_at: state.started_at,
        updated_at: state.updated_at,
        completed_at: state.completed_at ?? undefined,
        current_phase: state.current_phase,
        halted_reason: state.halted_reason || undefined,
        error: state.error || undefined,
      });
      await persist();
    }

    if (caught !== undefined) {
      if (caught instanceof Error) throw caught;
      const message =
        typeof caught === "string"
          ? caught
          : (() => {
              try {
                return JSON.stringify(caught);
              } catch {
                return "Non-Error thrown";
              }
            })();
      throw new Error(message);
    }
    return normalizeRunState(state);
  }
}
