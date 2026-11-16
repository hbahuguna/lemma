import path from "node:path";

import { currentDeterminism, makeDeterminism, newId, resetDeterminism, setDeterminism, type ClockMode } from "./determinism.js";
import { HarnessError, StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import {
  Severity,
  Strength,
  createFinding,
  normalizeTarget,
  severityRank,
  type Finding,
  type Target,
} from "./models.js";
import {
  HeuristicStepPlanner,
  type ScenarioPlan,
  type StepAction,
} from "./steps.js";
import { loadPersonas, validatePayload, type Persona } from "./personas.js";
import { draftPayload, quarantineFinding } from "./findings.js";

export interface BugHuntBlockerDraft {
  persona: string;
  check_id: string;
  attempted_action: string;
  boundary: string;
  unblock_evidence: string[];
  covered_elsewhere: boolean;
  covered_by?: string[];
  step_number?: number;
}

export interface BugHuntStepRecord {
  step_number: number;
  name: string;
  action: string;
  status: "passed" | "failed" | "skipped" | "blocked" | "halted";
  duration_ms: number;
  error: string;
  evidence_refs: string[];
  persona?: string;
  notes?: string;
}

export interface BugHuntCoverageLimitation {
  step_number?: number;
  kind: "blocked" | "halted" | "budget" | "browser_unavailable";
  message: string;
  evidence_refs?: string[];
}

export interface BugHuntResult {
  status: "completed" | "halted" | "blocked" | "failed";
  run_id: string;
  target: Target;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  max_steps: number;
  wall_clock_budget_ms: number;
  steps_executed: number;
  scenario: ScenarioPlan | null;
  steps: BugHuntStepRecord[];
  findings: Finding[];
  blockers: BugHuntBlockerDraft[];
  invalid_findings: Array<Record<string, unknown>>;
  evidence_directory: string;
  evidence_refs: string[];
  coverage_limitations: BugHuntCoverageLimitation[];
  personas: string[];
  degraded_personas: string[];
  deterministic: { seed: number | null; clock_mode: ClockMode; frozen_clock?: string | null };
  error?: { code?: string; type?: string; message: string } | null;
}

export interface BugHuntBrowserStepContext {
  runId: string;
  step: StepAction;
  stepIndex: number;
  target: Target;
  scenario: ScenarioPlan;
  evidence: EvidenceStore;
  determinism: { seed: number | null; now: string };
}

export interface BugHuntBrowserStepOutcome {
  status: "passed" | "failed" | "skipped" | "blocked";
  error?: string;
  evidence_refs?: string[];
  findings?: Array<Record<string, unknown>>;
  blockers?: Array<Record<string, unknown>>;
  notes?: string;
  duration_ms?: number;
}

export interface BugHuntBrowserRuntime {
  /** Optional probe; if false/unavailable, hunt records blocked coverage gaps. */
  isAvailable?(): boolean | Promise<boolean>;
  unavailableReason?(): string | Promise<string>;
  executeStep(ctx: BugHuntBrowserStepContext): Promise<BugHuntBrowserStepOutcome> | BugHuntBrowserStepOutcome;
  close?(): Promise<void> | void;
}

export interface BugHuntPluginRunner {
  // reserved for future plugin-driven exploration hooks
  [key: string]: unknown;
}

export interface RunBugHuntOptions {
  target: string | { raw?: string; kind?: string; resolved?: string; source?: string | null } | Target;
  scenarioPlan?: ScenarioPlan | string | null;
  personas?: string[] | Persona[];
  personasDir?: string;
  maxSteps?: number;
  /** Wall-clock budget in ms. Default 30_000. Exceeding halts cleanly. */
  wallClockBudgetMs?: number;
  seed?: number | null;
  clock?: { mode?: ClockMode; frozen?: string | null } | null;
  /** Root directory for .lemma/evidence state (defaults to cwd). */
  root?: string;
  cwd?: string;
  runId?: string;
}

export interface RunBugHuntDeps {
  browserRuntime?: BugHuntBrowserRuntime | null;
  pluginRunner?: BugHuntPluginRunner | null;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_WALL_CLOCK_BUDGET_MS = 30_000;

function clampInt(value: unknown, fallback: number, min = 1, max = 10_000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function toTarget(input: RunBugHuntOptions["target"]): Target {
  if (typeof input === "string") return normalizeTarget({ raw: input, kind: /^https?:\/\//i.test(input) ? "url" : "directory", resolved: input, source: null });
  return normalizeTarget(input);
}

function isPersona(value: unknown): value is Persona {
  return !!value && typeof value === "object" && typeof (value as Persona).id === "string" && Array.isArray((value as Persona).checks);
}

async function resolvePersonas(options: RunBugHuntOptions): Promise<Persona[]> {
  const p = options.personas;
  if (Array.isArray(p) && p.length > 0 && p.every(isPersona)) return p as Persona[];
  if (options.personasDir) {
    const selected = Array.isArray(p) && p.every((x) => typeof x === "string") ? (p as string[]) : undefined;
    try {
      return await loadPersonas(options.personasDir, { selected, requireMinimum: selected?.length ? 0 : 1 } as any);
    } catch {
      // fall through to empty; personas may be omitted in constrained contexts
    }
  }
  return [];
}

function resolveScenarioPlan(target: Target, scenarioPlan: RunBugHuntOptions["scenarioPlan"]): ScenarioPlan | null {
  if (!scenarioPlan) return null;
  if (typeof scenarioPlan === "string") {
    const planner = new HeuristicStepPlanner();
    return planner.plan(scenarioPlan, target.kind === "url" ? target.resolved || target.raw : "");
  }
  if (scenarioPlan && typeof scenarioPlan === "object" && Array.isArray((scenarioPlan as ScenarioPlan).steps)) {
    return scenarioPlan as ScenarioPlan;
  }
  return null;
}

function defaultScenario(target: Target): ScenarioPlan {
  const baseUrl = target.kind === "url" ? target.resolved || target.raw : "";
  const planner = new HeuristicStepPlanner();
  if (baseUrl) {
    return planner.plan(
      [
        `1) Open ${baseUrl}`,
        "2) Verify the primary content is visible",
        "3) Check for obvious client errors",
      ].join("\n"),
      baseUrl,
    );
  }
  return planner.plan("1) Inspect target scope\n2) Verify accessible content\n3) Check for obvious issues", "");
}

function findingCheckIdForStep(step: StepAction, _personaId: string): string {
  // deterministic synthetic check id for bug-hunt step findings (persona ownership recorded on finding)
  const action = String(step.action || "step").replace(/[^a-z0-9_.-]+/gi, "_").toLowerCase();
  return `bug_hunt.step.${action}.${step.step_number}`;
}

function makeBlockedBlocker(step: StepAction, reason: string, evidenceRefs: string[] = []): BugHuntBlockerDraft {
  return {
    persona: "functional",
    check_id: findingCheckIdForStep(step, "functional"),
    attempted_action: `Execute bug-hunt step ${step.step_number}: ${step.name || step.action}`,
    boundary: reason,
    unblock_evidence: ["Provide an available browser runtime and a reachable target URL."],
    covered_elsewhere: false,
    step_number: step.step_number,
    ...(evidenceRefs.length ? { covered_by: evidenceRefs } : {}),
  };
}

function deterministicRunId(): string {
  const det = currentDeterminism();
  return det.runId();
}

export async function runBugHunt(options: RunBugHuntOptions, deps: RunBugHuntDeps = {}): Promise<BugHuntResult> {
  const target = toTarget(options.target);
  const maxSteps = clampInt(options.maxSteps, DEFAULT_MAX_STEPS, 1, 100);
  const wallClockBudgetMs = clampInt(options.wallClockBudgetMs, DEFAULT_WALL_CLOCK_BUDGET_MS, 1, 60 * 60 * 1000);
  const seed = options.seed ?? null;
  const clockMode: ClockMode = options.clock?.mode ?? "real";
  const frozenClock = options.clock?.frozen ?? null;
  const determinism = makeDeterminism({ seed, clockMode, frozenClock: frozenClock ?? undefined });
  const prev = setDeterminism(determinism);
  const startedWall = Date.now();
  let status: BugHuntResult["status"] = "completed";
  let error: BugHuntResult["error"] = null;
  let completedAt: string | null = null;

  try {
    const startedAt = determinism.now();
    const runId = options.runId ?? deterministicRunId();
    const root = path.resolve(options.root ?? options.cwd ?? process.cwd());
    const evidence = new EvidenceStore(root, runId);
    await evidence.init();

    const personas = await resolvePersonas(options);
    const personaIds = personas.map((p) => p.id);
    const scenario = resolveScenarioPlan(target, options.scenarioPlan) ?? defaultScenario(target);
    const plannedTotal = (scenario.steps ?? []).length;
    const plannedSteps = (scenario.steps ?? []).slice(0, maxSteps);
    const steps: BugHuntStepRecord[] = [];
    const findings: Finding[] = [];
    const blockers: BugHuntBlockerDraft[] = [];
    const invalidFindings: Array<Record<string, unknown>> = [];
    const coverageLimitations: BugHuntCoverageLimitation[] = [];
    const evidenceRefs: string[] = [];
    const contractState = { invalid_findings: [] as any[], contract_failures: {}, contract_failure_streaks: {}, degraded_personas: [] as string[] } as any;
    let executedCount = 0;

    const runtime = deps.browserRuntime ?? null;
    const runtimeAvailable = runtime ? (runtime.isAvailable ? await runtime.isAvailable() : true) : false;
    const unavailableReason = !runtime
      ? "Browser runtime unavailable (no browser runtime provided)."
      : !runtimeAvailable
        ? String((runtime.unavailableReason ? await runtime.unavailableReason() : "") || "Browser runtime unavailable.")
        : "";

    if (!runtime || !runtimeAvailable) {
      // Browser unavailable: every planned step is a blocked coverage gap (never pass)
      for (const step of plannedSteps) {
        const blockedAt = determinism.now();
        const stepEvidence = await evidence.saveJson(
          `bug-hunt-step-${step.step_number}-blocked`,
          {
            step_number: step.step_number,
            name: step.name,
            action: step.action,
            status: "blocked",
            reason: unavailableReason,
            target: target.resolved || target.raw,
            at: blockedAt,
          },
          "json",
          unavailableReason,
          findingCheckIdForStep(step, "functional"),
        );
        evidenceRefs.push(stepEvidence);
        const blocker = makeBlockedBlocker(step, unavailableReason, [stepEvidence]);
        blockers.push(blocker);
        steps.push({
          step_number: step.step_number,
          name: step.name,
          action: step.action,
          status: "blocked",
          duration_ms: 0,
          error: unavailableReason,
          evidence_refs: [stepEvidence],
          persona: "functional",
          notes: "Browser unavailable: recorded as blocked coverage gap (never pass).",
        });
        executedCount += 1;
        coverageLimitations.push({
          step_number: step.step_number,
          kind: "browser_unavailable",
          message: `Step ${step.step_number} blocked: ${unavailableReason}`,
          evidence_refs: [stepEvidence],
        });
      }
      status = "blocked";
    } else {
      for (let i = 0; i < plannedSteps.length; i += 1) {
        const step = plannedSteps[i]!;
        const elapsed = Date.now() - startedWall;
        if (elapsed > wallClockBudgetMs) {
          status = "halted";
          const msg = `Bug hunt halted: wall-clock budget exceeded (${elapsed}ms > ${wallClockBudgetMs}ms).`;
          coverageLimitations.push({ kind: "budget", message: msg });
          // record remaining steps as not executed due to halt
          for (let j = i; j < plannedSteps.length; j += 1) {
            const rem = plannedSteps[j]!;
            steps.push({
              step_number: rem.step_number,
              name: rem.name,
              action: rem.action,
              status: "halted",
              duration_ms: 0,
              error: msg,
              evidence_refs: [],
              notes: "Not executed due to wall-clock budget halt.",
            });
            coverageLimitations.push({ step_number: rem.step_number, kind: "halted", message: `Step ${rem.step_number} not executed: ${msg}` });
          }
          break;
        }

        const stepStart = Date.now();
        let outcome: BugHuntBrowserStepOutcome;
        try {
          outcome = await runtime.executeStep({
            runId,
            step,
            stepIndex: i,
            target,
            scenario,
            evidence,
            determinism: { seed, now: determinism.now() },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outcome = { status: "failed", error: msg, evidence_refs: [], findings: [], blockers: [] };
        }
        const durationMs = typeof outcome.duration_ms === "number" && Number.isFinite(outcome.duration_ms)
          ? Math.max(0, Math.trunc(outcome.duration_ms))
          : Math.max(0, Date.now() - stepStart);
        const stepEvidenceRefs = Array.isArray(outcome.evidence_refs) ? outcome.evidence_refs.filter((x): x is string => typeof x === "string") : [];
        for (const ref of stepEvidenceRefs) if (!evidenceRefs.includes(ref)) evidenceRefs.push(ref);

        // record blockers/finding drafts with ownership/quarantine invariants
        const rawBlockers = Array.isArray(outcome.blockers) ? outcome.blockers : [];
        for (const b of rawBlockers) {
          if (!b || typeof b !== "object") continue;
          const bo = b as Record<string, unknown>;
          blockers.push({
            persona: typeof bo.persona === "string" ? bo.persona : "functional",
            check_id: typeof bo.check_id === "string" ? bo.check_id : findingCheckIdForStep(step, "functional"),
            attempted_action: typeof bo.attempted_action === "string" ? bo.attempted_action : `Execute step ${step.step_number}`,
            boundary: typeof bo.boundary === "string" ? bo.boundary : (outcome.error || "Blocked"),
            unblock_evidence: Array.isArray(bo.unblock_evidence) ? bo.unblock_evidence.filter((x): x is string => typeof x === "string") : [],
            covered_elsewhere: bo.covered_elsewhere === true,
            ...(Array.isArray(bo.covered_by) ? { covered_by: bo.covered_by.filter((x): x is string => typeof x === "string") } : {}),
            step_number: step.step_number,
          });
        }

        const rawFindings = Array.isArray(outcome.findings) ? outcome.findings : [];
        for (const f of rawFindings) {
          const payload = draftPayload(f);
          // ownership invariant: if payload declares persona, it must match allowed persona context; enforce by quarantining mismatches
          const declaredPersona = typeof payload.persona === "string" ? payload.persona : "";
          const persona = personas.find((p) => p.id === declaredPersona) ?? personas[0] ?? null;
          const checkId = findingCheckIdForStep(step, persona?.id ?? "functional");
          if (persona) {
            // ensure check ownership consistency: finding must not claim another persona via mismatch
            if (declaredPersona && declaredPersona !== persona.id) {
              quarantineFinding(contractState, { id: checkId, persona: persona.id }, payload, [`persona ownership mismatch: declared '${declaredPersona}'`]);
              continue;
            }
            // if persona has output schema, validate; if it owns no checks (manager-like), quarantine as invalid for ownership
            if (Array.isArray(persona.checks) && persona.checks.length === 0) {
              quarantineFinding(contractState, { id: checkId, persona: persona.id }, payload, ["persona owns no checks and cannot emit findings"]);
              continue;
            }
            const validationErrors = validatePayload(payload, persona.output_schema);
            if (validationErrors.length > 0) {
              quarantineFinding(contractState, { id: checkId, persona: persona.id }, payload, validationErrors);
              continue;
            }
            // normalize minimal required fields into Finding
            const ev = Array.isArray(payload.evidence) ? payload.evidence.filter((x): x is string => typeof x === "string") : [];
            const mergedEvidence = [...new Set([...ev, ...stepEvidenceRefs])];
            const title = typeof payload.title === "string" ? payload.title : `Bug hunt finding (step ${step.step_number})`;
            const severity = typeof payload.severity === "string" ? payload.severity : Severity.MEDIUM;
            const domain = typeof payload.domain === "string" ? payload.domain : "functional";
            const location = typeof payload.location === "string" ? payload.location : (target.resolved || target.raw);
            findings.push(createFinding({
              id: newId("finding"),
              title,
              severity,
              domain,
              persona: persona.id,
              strength: typeof payload.strength === "string" ? payload.strength : Strength.OBSERVED,
              consequence: typeof payload.consequence === "string" ? payload.consequence : "Observed during bug-hunt exploration.",
              location,
              reproduction: typeof payload.reproduction === "string" ? payload.reproduction : `Step ${step.step_number}: ${step.name || step.action}`,
              evidence: mergedEvidence,
              remediation: typeof payload.remediation === "string" ? payload.remediation : "Investigate and remediate the observed issue.",
              verification: typeof payload.verification === "string" ? payload.verification : "Re-run the bug-hunt scenario and confirm the issue no longer reproduces.",
              check_id: checkId,
              tags: Array.isArray(payload.tags) ? payload.tags.filter((x): x is string => typeof x === "string") : ["bug-hunt"],
            }));
          } else {
            // no persona contract available: accept as functional draft finding with required fields
            const title = typeof payload.title === "string" ? payload.title : `Bug hunt finding (step ${step.step_number})`;
            findings.push(createFinding({
              id: newId("finding"),
              title,
              severity: typeof payload.severity === "string" ? payload.severity : Severity.MEDIUM,
              domain: typeof payload.domain === "string" ? payload.domain : "functional",
              persona: "functional",
              strength: typeof payload.strength === "string" ? payload.strength : Strength.OBSERVED,
              consequence: typeof payload.consequence === "string" ? payload.consequence : "Observed during bug-hunt exploration.",
              location: typeof payload.location === "string" ? payload.location : (target.resolved || target.raw),
              reproduction: typeof payload.reproduction === "string" ? payload.reproduction : `Step ${step.step_number}: ${step.name || step.action}`,
              evidence: [...new Set([...(Array.isArray(payload.evidence) ? payload.evidence.filter((x): x is string => typeof x === "string") : []), ...stepEvidenceRefs])],
              remediation: typeof payload.remediation === "string" ? payload.remediation : "Investigate and remediate the observed issue.",
              verification: typeof payload.verification === "string" ? payload.verification : "Re-run the bug-hunt scenario and confirm the issue no longer reproduces.",
              check_id: checkId,
              tags: Array.isArray(payload.tags) ? payload.tags.filter((x): x is string => typeof x === "string") : ["bug-hunt"],
            }));
          }
        }
        for (const rec of contractState.invalid_findings ?? []) {
          invalidFindings.push({ ...(rec as Record<string, unknown>) });
        }
        // dedupe invalid findings by id after accumulation
        const seenInvalid = new Set<string>();
        const uniqueInvalid: Array<Record<string, unknown>> = [];
        for (const rec of invalidFindings) {
          const id = typeof rec.id === "string" ? rec.id : JSON.stringify(rec);
          if (seenInvalid.has(id)) continue;
          seenInvalid.add(id);
          uniqueInvalid.push(rec);
        }
        invalidFindings.length = 0;
        invalidFindings.push(...uniqueInvalid);

        if (outcome.status === "blocked") {
          const blocker = makeBlockedBlocker(step, outcome.error || "Step blocked", stepEvidenceRefs);
          blockers.push(blocker);
          coverageLimitations.push({ step_number: step.step_number, kind: "blocked", message: outcome.error || `Step ${step.step_number} blocked`, evidence_refs: stepEvidenceRefs });
        }

        steps.push({
          step_number: step.step_number,
          name: step.name,
          action: step.action,
          status: outcome.status === "passed" ? "passed" : outcome.status === "failed" ? "failed" : outcome.status === "skipped" ? "skipped" : "blocked",
          duration_ms: durationMs,
          error: outcome.error ?? "",
          evidence_refs: stepEvidenceRefs,
          ...(outcome.notes ? { notes: outcome.notes } : {}),
        });
        executedCount += 1;

        // record step result artifact
        const resultRef = await evidence.saveJson(
          `bug-hunt-step-${step.step_number}-result`,
          { step, outcome: { ...outcome, duration_ms: durationMs }, at: determinism.now() },
          "json",
          `Bug hunt step ${step.step_number} result`,
          findingCheckIdForStep(step, "functional"),
        );
        if (!evidenceRefs.includes(resultRef)) evidenceRefs.push(resultRef);

        if (steps.length >= maxSteps) break;
      }

      if (status === "completed" && executedCount >= maxSteps && plannedTotal > maxSteps) {
        status = "halted";
        coverageLimitations.push({ kind: "budget", message: `Bug hunt halted: maxSteps reached (${maxSteps}).` });
      } else if (status === "completed" && executedCount >= maxSteps && plannedTotal > maxSteps) {
        status = "halted";
      }

      try { await runtime.close?.(); } catch { /* ignore */ }
    }

    const manifest = await evidence.finalize({
      run_id: runId,
      workflow: "bug-hunt",
      target: target,
      status,
      steps_executed: executedCount,
      max_steps: maxSteps,
      seed,
      clock_mode: clockMode,
      frozen_clock: frozenClock,
    });
    if (manifest.manifest_path && !evidenceRefs.includes(manifest.manifest_path)) {
      // manifest tracked separately; evidence refs list artifact refs
    }

    completedAt = determinism.now();
    const degradedPersonas = Array.isArray(contractState.degraded_personas) ? [...contractState.degraded_personas] : [];
    return {
      status,
      run_id: runId,
      target,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Math.max(0, Date.now() - startedWall),
      max_steps: maxSteps,
      wall_clock_budget_ms: wallClockBudgetMs,
      steps_executed: executedCount,
      scenario,
      steps,
      findings: findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id)),
      blockers,
      invalid_findings: invalidFindings,
      evidence_directory: path.join(root, ".lemma", "evidence", runId).replaceAll(path.sep, "/"),
      evidence_refs: [...evidenceRefs],
      coverage_limitations: coverageLimitations,
      personas: personaIds,
      degraded_personas: degradedPersonas,
      deterministic: { seed, clock_mode: clockMode, ...(frozenClock !== null && frozenClock !== undefined ? { frozen_clock: frozenClock } : {}) },
      error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const type = err instanceof Error ? err.name : "Error";
    const code = err instanceof HarnessError ? err.errorCode : err instanceof StateError ? err.errorCode : undefined;
    // clean halt/failure result shape (typed, no crash to caller)
    const runId = options.runId ?? "bug-hunt-error";
    completedAt = safeNow();
    return {
      status: "failed",
      run_id: runId,
      target: toTarget(options.target),
      started_at: safeNow(),
      completed_at: completedAt,
      duration_ms: Math.max(0, Date.now() - startedWall),
      max_steps: clampInt(options.maxSteps, DEFAULT_MAX_STEPS, 1, 100),
      wall_clock_budget_ms: clampInt(options.wallClockBudgetMs, DEFAULT_WALL_CLOCK_BUDGET_MS, 1, 60 * 60 * 1000),
      steps_executed: 0,
      scenario: null,
      steps: [],
      findings: [],
      blockers: [],
      invalid_findings: [],
      evidence_directory: "",
      evidence_refs: [],
      coverage_limitations: [],
      personas: [],
      degraded_personas: [],
      deterministic: { seed: options.seed ?? null, clock_mode: options.clock?.mode ?? "real" },
      error: { ...(code ? { code } : {}), type, message },
    };
  } finally {
    resetDeterminism(prev);
  }
}

function safeNow(): string {
  try { return currentDeterminism().now(); } catch { return new Date().toISOString(); }
}
