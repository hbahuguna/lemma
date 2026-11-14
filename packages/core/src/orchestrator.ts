import { HarnessError, KillSwitchHaltError } from "./errors.js";
import { now } from "./determinism.js";
import {
  CheckStatus,
  DomainPhaseName,
  PhaseStatus,
  RunStatus,
  createRunState,
  normalizeCheck,
  normalizePhase,
  normalizeRunState,
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

export class Orchestrator {
  private readonly store: StateStore;
  private readonly handlers: PhaseHandlers;

  constructor(config: OrchestratorConfig) {
    this.store = config.store;
    this.handlers = config.handlers ?? {};
  }

  async run(options: OrchestratorRunOptions): Promise<RunStateDomain> {
    const budget = validateBudget(options);
    const workflow = options.workflow ?? RELEASE_CONFIDENCE;
    const intent = options.intent ?? "";
    const resolvedOptions: Required<Pick<OrchestratorRunOptions, "intent" | "maxChecks">> &
      Omit<OrchestratorRunOptions, "intent" | "maxChecks"> = {
      ...options,
      intent,
      maxChecks: budget.maxChecks,
    };

    const state = createRunState({
      ...(options.runId !== undefined ? { run_id: options.runId } : {}),
      workflow_id: workflow.id,
      workflow_version: workflow.version,
      target: options.target,
      intent,
      options: { ...(options.options ?? {}), maxChecks: budget.maxChecks },
    });
    state.phases = PHASE_ORDER.map((name) => phaseFromWorkflow(name, workflow));
    state.current_phase = DomainPhaseName.RISK_ANALYSIS;
    state.status = RunStatus.RUNNING;
    state.kill_switch = { ...state.kill_switch, armed: true, triggered: false, reason: "", manual: false };

    const persist = async (): Promise<void> => {
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

    await appendEvent({ event: "run_started", workflow_id: state.workflow_id, workflow_version: state.workflow_version });
    await persist();

    let caught: unknown;
    try {
      for (let i = 0; i < PHASE_ORDER.length; i++) {
        const phaseName = PHASE_ORDER[i];
        if (!phaseName) continue;
        const phaseIndex = i;

        const killReason = await isKillRequested();
        if (killReason || state.kill_switch.triggered) {
          const reason = state.halted_reason || killReason || "Kill switch triggered";
          if (!state.kill_switch.triggered) await triggerHalt(reason, Boolean(killReason));
          markRemainingPhasesSkipped(state, phaseIndex, reason);
          await persist();
          break;
        }

        let phase = state.phases.find((p) => p.name === phaseName);
        if (!phase) {
          phase = normalizePhase({ name: phaseName, title: phaseName });
          state.phases.push(phase);
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
