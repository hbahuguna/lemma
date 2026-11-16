import { HarnessError, StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { planChecks, registryFingerprint, type CheckRegistryLike } from "./checks.js";
import { checkOwnership, type PersonaOwnershipSource } from "./personas.js";
import { DomainPhaseName, PhaseStatus, RunStatus, normalizeCheck, normalizeRunState, type Check, type RunStateDomain } from "./models.js";
import type { StateStore } from "./state-store.js";
import { RELEASE_CONFIDENCE, type Workflow } from "./workflows.js";
import { Orchestrator, type PhaseHandlers } from "./orchestrator.js";

export interface RunMoreOptions {
  runId: string;
  stateStore: StateStore;
  options?: {
    registry?: CheckRegistryLike | null;
    registryFingerprint?: string;
    personas?: PersonaOwnershipSource[];
    ownership?: Record<string, string[]>;
    handlers?: PhaseHandlers;
    workflow?: Workflow;
    /** Full applicable plan in deterministic order (run's own plan), if known. */
    fullPlan?: Check[];
    /** Explicit deferred checks (run's own deferred set), if known. */
    deferredChecks?: Check[];
    /** Additional options merged for execution context. */
    runOptions?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

function computeFingerprint(opts?: RunMoreOptions["options"]): string {
  if (opts && typeof opts.registryFingerprint === "string" && opts.registryFingerprint.length) return opts.registryFingerprint;
  if (opts && opts.registry) return registryFingerprint(opts.registry);
  return registryFingerprint(null);
}

function deriveSelectedPersonas(state: RunStateDomain, opts?: RunMoreOptions["options"]): string[] {
  if (opts && Array.isArray(opts.personas) && opts.personas.length) {
    return opts.personas.map((p: any) => (typeof p === "string" ? p : p?.id)).filter((x: any): x is string => typeof x === "string");
  }
  const rawSel = (state.options as any)?.selected_personas ?? (state.options as any)?.selectedPersonas;
  if (Array.isArray(rawSel)) {
    const ids = rawSel.filter((x: any): x is string => typeof x === "string");
    if (ids.length) return Array.from(new Set(ids));
  }
  if (Array.isArray(state.personas) && state.personas.length) {
    const ids = state.personas.map((p: any) => (typeof p === "string" ? p : p?.id)).filter((x: any): x is string => typeof x === "string");
    if (ids.length) return Array.from(new Set(ids));
  }
  return Array.from(new Set(state.checks.map((c) => c.persona).filter(Boolean)));
}

function deriveOwnership(state: RunStateDomain, opts?: RunMoreOptions["options"]): Record<string, string[]> {
  if (opts && opts.ownership && typeof opts.ownership === "object") return opts.ownership as Record<string, string[]>;
  const optOwn = (state.options as any)?.ownership;
  if (optOwn && typeof optOwn === "object") return optOwn as Record<string, string[]>;
  const personasSrc = (opts?.personas && Array.isArray(opts.personas) ? opts.personas : (Array.isArray(state.personas) ? state.personas : [])) as any[];
  const withChecks = personasSrc.filter((p) => p && typeof p === "object" && Array.isArray(p.checks));
  if (withChecks.length) {
    try {
      return checkOwnership(withChecks as PersonaOwnershipSource[]);
    } catch {
      // fall through
    }
  }
  const ownership: Record<string, string[]> = {};
  for (const c of state.checks) {
    if (!c?.id) continue;
    const set = new Set(ownership[c.id] ?? []);
    if (c.persona) set.add(c.persona);
    ownership[c.id] = Array.from(set);
  }
  return ownership;
}

function executedOrTerminal(check: Check): boolean {
  const s = String(check.status || "");
  // no re-run if already succeeded
  if (s === "passed") return true;
  // treat other terminal/recorded states as not eligible to be "continued" as planned work again
  if (s === "failed" || s === "blocked" || s === "error" || s === "skipped") return true;
  return false;
}

function isRunTerminalForMore(state: RunStateDomain): boolean {
  // halted runs are refused; failed/completed/running after bounded stop can be continued if deferred exist
  return state.status === RunStatus.HALTED;
}

function resetPhaseForContinuation(state: RunStateDomain): void {
  for (const phase of state.phases) {
    if (phase.name === DomainPhaseName.EXECUTION || phase.name === DomainPhaseName.EVIDENCE_COLLECTION || phase.name === DomainPhaseName.CONFIDENCE_SCORING) {
      phase.status = PhaseStatus.PENDING;
      phase.completed_at = null;
      phase.summary = "";
    }
  }
  state.status = RunStatus.RUNNING;
  state.current_phase = DomainPhaseName.EXECUTION;
  state.completed_at = null;
  state.error = "";
  state.halted_reason = "";
  if (state.kill_switch?.triggered) {
    state.kill_switch = { ...state.kill_switch, triggered: false, reason: "", manual: false, triggered_at: null };
  }
}

function dedupeChecksById(checks: Check[]): Check[] {
  const seen = new Set<string>();
  const out: Check[] = [];
  for (const c of checks) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(normalizeCheck(c));
  }
  return out;
}

export async function runMore({ runId, stateStore, options }: RunMoreOptions): Promise<RunStateDomain> {
  if (!stateStore) throw new HarnessError("stateStore is required");
  if (!runId) throw new HarnessError("runId is required");

  const loaded = await stateStore.loadProgress<unknown>();
  const state = normalizeRunState(loaded);
  if (String(state.run_id) !== String(runId)) {
    throw new StateError(`Run id mismatch: requested ${runId}, loaded ${state.run_id}`, { details: { requested: runId, loaded: state.run_id } });
  }

  if (isRunTerminalForMore(state) || state.status === RunStatus.HALTED) {
    throw new StateError("This run was halted by the kill switch and cannot be continued with /lemma-more. Start a new run after investigation.", { details: { run_id: state.run_id, status: state.status } });
  }

  // Registry fingerprint refusal (LEM-021)
  const savedFp = typeof state.options?.registry_fingerprint === "string"
    ? state.options.registry_fingerprint
    : (typeof state.options?.plugin_registry_fingerprint === "string" ? state.options.plugin_registry_fingerprint : "");
  const currentFp = computeFingerprint(options);
  if (savedFp && savedFp !== currentFp) {
    throw new StateError(
      `Plugin registry changed since this run started (saved ${savedFp}, current ${currentFp}). Start a new run instead of continuing deferred checks.`,
      { details: { run_id: state.run_id, saved: savedFp, current: currentFp } },
    );
  }

  const intent = state.intent ?? "";
  const target = state.target as any;
  const inventory = (state.inventory ?? {}) as Record<string, unknown>;
  const maxChecks = typeof state.options?.maxChecks === "number" ? state.options.maxChecks : undefined;
  if (!maxChecks || !Number.isInteger(maxChecks) || maxChecks < 1) {
    throw new StateError("Run has no valid maxChecks budget; cannot derive deferred checks.", { details: { run_id: state.run_id } });
  }

  const existingIds = new Set(state.checks.map((c) => c.id));
  let deferred: Check[] = [];

  if (Array.isArray(options?.deferredChecks) && options.deferredChecks.length) {
    deferred = dedupeChecksById(options.deferredChecks).filter((c) => !existingIds.has(c.id) && !state.checks.some((e) => e.id === c.id && executedOrTerminal(e)));
  } else if (Array.isArray(options?.fullPlan) && options.fullPlan.length) {
    deferred = dedupeChecksById(options.fullPlan).filter((c) => !existingIds.has(c.id) && !state.checks.some((e) => e.id === c.id && executedOrTerminal(e)));
  } else {
    const optFullIds = Array.isArray((state.options as any)?.planned_check_ids) ? ((state.options as any).planned_check_ids as unknown[]) : [];
    if (optFullIds.length > 0) {
      // derive from stored full plan ids (run's own plan metadata)
      const remainingIds = optFullIds.filter((id): id is string => typeof id === "string" && !existingIds.has(id));
      // map to existing check templates if present in state snapshots? fallback: create minimal planned checks
      for (const id of remainingIds) {
        deferred.push(normalizeCheck({ id, title: id, domain: "functional", persona: "functional", kind: "static", intent: "", expected: "", base_weight: 1, status: "planned" }));
      }
    } else {
      const selectedPersonas = deriveSelectedPersonas(state, options);
      const ownership = deriveOwnership(state, options);
      const noBrowser = (state.options as any)?.noBrowser === true || (state.options as any)?.no_browser === true;
      const mobile = (state.options as any)?.mobile === true;
      const scenario = (state.options as any)?.scenario === true || Boolean((state.options as any)?.scenarioPlan || (state.options as any)?.scenario_plan);

      // Try recomputing full applicable plan from run's own inputs. If ownership is incomplete for builtin catalog
      // (custom/synthetic runs), fall back to deferring based on known checks not yet in state is not possible;
      // instead, restrict to checks covered by known ownership to avoid inventing unrelated work.
      let full: Check[] = [];
      try {
        full = planChecks({
          target,
          inventory,
          selectedPersonas,
          ownership,
          maxChecks: Number.MAX_SAFE_INTEGER,
          noBrowser,
          mobile,
          intent,
          scenario,
          ...(options?.registry ? { registry: options.registry } : {}),
        });
      } catch (err) {
        // If planning fails due to ownership gaps for unrelated builtin checks, try restricting to existing/known ids
        const knownIds = new Set<string>([...Object.keys(ownership), ...state.checks.map((c) => c.id)]);
        if (knownIds.size === 0) throw err;
        // fallback: no safe way to derive additional deferred checks beyond what's known
        full = state.checks.map((c) => normalizeCheck(c));
      }
      deferred = dedupeChecksById(full).filter((c) => !existingIds.has(c.id) && !state.checks.some((e) => e.id === c.id && executedOrTerminal(e)));
      if (deferred.length === 0 && full.length > state.checks.length) {
        deferred = dedupeChecksById(full.slice(state.checks.length)).filter((c) => !existingIds.has(c.id));
      }
    }
  }

  // Exclude succeeded/terminal just in case
  deferred = deferred.filter((c) => !state.checks.some((e) => e.id === c.id && executedOrTerminal(e)));

  if (deferred.length === 0) {
    throw new StateError("No deferred checks remain for this run (maxChecks cut line exhausted or nothing deferred).", {
      details: { run_id: state.run_id, maxChecks, planned: state.checks.length },
    });
  }

  const toAdd = deferred.map((c) => {
    const n = normalizeCheck({ ...c, status: c.status === "blocked" ? c.status : "planned", actual: c.status === "blocked" ? c.actual : "", evidence: Array.isArray(c.evidence) ? c.evidence : [], finding_ids: [], skip_reason: c.status === "blocked" ? c.skip_reason : "", started_at: null, completed_at: c.status === "blocked" ? c.completed_at : null });
    return n;
  });
  state.checks = [...state.checks, ...toAdd];
  resetPhaseForContinuation(state);

  // Reconcile evidence store for same run
  const evidenceStore = new EvidenceStore(stateStore.root, state.run_id);
  try {
    await evidenceStore.init();
    await evidenceStore.reconcile(state.checks as any);
  } catch {
    // best effort
  }

  const workflow: Workflow = options?.workflow ?? RELEASE_CONFIDENCE;
  const orchestrator = new Orchestrator({ store: stateStore, ...(options?.handlers ? { handlers: options.handlers } : {}) });
  (state as any).updated_at = new Date().toISOString();
  await stateStore.saveProgress(state as unknown as Record<string, unknown>);

  const runOptions = (options?.runOptions ?? {}) as Record<string, unknown>;
  return orchestrator.run({
    target: state.target as any,
    intent,
    workflow,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    maxChecks: Math.max(maxChecks, state.checks.length),
    runId: state.run_id,
    options: { ...(state.options ?? {}), ...runOptions, maxChecks: Math.max(maxChecks, state.checks.length) },
    resume: true,
    ...(options?.registry ? { registry: options.registry } : {}),
    ...(options?.registryFingerprint ? { registryFingerprint: options.registryFingerprint } : {}),
  });
}
