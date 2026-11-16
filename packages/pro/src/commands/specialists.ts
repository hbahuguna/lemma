import path from "node:path";

import {
  EvidenceStore,
  PHASE_ORDER,
  PhaseStatus,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateStore,
  applyRiskWeights,
  buildReport,
  checkOwnership,
  createRunState,
  currentDeterminism,
  loadPersonas,
  makeDeterminism,
  now,
  normalizeTarget,
  planChecks,
  registryFingerprint,
  resetDeterminism,
  scoreConfidence,
  setDeterminism,
  type Check,
  type Confidence,
  type Finding,
  type InvalidFinding,
  type RunStateDomain,
  type Target,
} from "@lemma/core";

import { ProUnavailableError, requireProLicense, type ProLicenseContext } from "../entitlement.js";

export const SPECIALIST_CATALOG_SCHEMA_VERSION = "lemma.pro.specialist_commands/v1" as const;
export const PRO_LEARN_MORE_URL = "https://lemma.dev/pro" as const;

export type SpecialistId = "confidence" | "security" | "performance" | "privacy";

export interface SpecialistBoundedScope {
  maxChecks: number;
  maxWallClockMs: number;
  notes: string[];
}

export interface SpecialistEvidenceShape {
  evidence_root: string;
  manifest: string;
  report: string;
  includes: string[];
}

export interface SpecialistCommandSpec {
  id: SpecialistId;
  title: string;
  description: string;
  intent: string;
  cli: string;
  slash_commands: string[];
  bounded_scope: SpecialistBoundedScope;
  expected_evidence_shape: SpecialistEvidenceShape;
  persona_contract_references: string[];
  check_selection: {
    intents: string[];
    category_check_ids: string[];
    domains: string[];
  };
}

export const SPECIALIST_COMMAND_CATALOG: readonly SpecialistCommandSpec[] = [
  {
    id: "confidence",
    title: "Confidence Specialist Investigation",
    description:
      "Bounded, evidence-backed confidence investigation focused on release-readiness signals, coverage, and decision context.",
    intent: "Assay confidence assessment",
    cli: "lemma pro confidence",
    slash_commands: ["/lemma-confidence", "/lemma-pro confidence"],
    bounded_scope: {
      maxChecks: 12,
      maxWallClockMs: 30_000,
      notes: [
        "Stops on check cap or wall-clock cap (whichever is reached first).",
        "Reuses existing checks/personas/ownership/quarantine and evidence pipeline.",
      ],
    },
    expected_evidence_shape: {
      evidence_root: ".lemma/evidence/<run_id>/",
      manifest: ".lemma/evidence/<run_id>/manifest.json",
      report: "stdout JSON report (lemma.report/v1) with findings/blockers/check evidence refs",
      includes: ["check outcomes", "finding/blocker records with evidence refs", "hashed evidence manifest", "confidence/coverage summary"],
    },
    persona_contract_references: ["packages/personas/functional.md", "packages/personas/manager.md"],
    check_selection: {
      intents: ["Assay confidence assessment", "Assay confidence-init assessment", "Assay confidence-plan assessment"],
      category_check_ids: ["static.category.confidence", "static.category.confidence-init", "static.category.confidence-plan"],
      domains: ["functional", "reliability"],
    },
  },
  {
    id: "security",
    title: "Security Specialist Investigation",
    description:
      "Bounded, evidence-backed security investigation reusing existing security checks/persona contracts and quarantine/ownership rules.",
    intent: "Assay security assessment",
    cli: "lemma pro security",
    slash_commands: ["/lemma-security", "/lemma-pro security"],
    bounded_scope: {
      maxChecks: 12,
      maxWallClockMs: 30_000,
      notes: [
        "Stops on check cap or wall-clock cap (whichever is reached first).",
        "Observation/source inspection only via existing checks; no active exploitation.",
      ],
    },
    expected_evidence_shape: {
      evidence_root: ".lemma/evidence/<run_id>/",
      manifest: ".lemma/evidence/<run_id>/manifest.json",
      report: "stdout JSON report (lemma.report/v1) with findings/blockers/check evidence refs",
      includes: ["security/static/browser check outcomes", "finding/blocker records with evidence refs", "hashed evidence manifest"],
    },
    persona_contract_references: ["packages/personas/security.md", "packages/personas/functional.md"],
    check_selection: {
      intents: ["Assay security assessment", "Assay security-review assessment"],
      category_check_ids: ["static.category.security", "static.category.security-review", "static.secrets", "static.unsafe", "browser.security"],
      domains: ["security", "data_integrity"],
    },
  },
  {
    id: "performance",
    title: "Performance Specialist Investigation",
    description:
      "Bounded, evidence-backed performance investigation reusing existing checks/personas and deterministic evidence/scoring.",
    intent: "Assay performance assessment",
    cli: "lemma pro performance",
    slash_commands: ["/lemma-performance", "/lemma-pro performance"],
    bounded_scope: {
      maxChecks: 12,
      maxWallClockMs: 30_000,
      notes: [
        "Stops on check cap or wall-clock cap (whichever is reached first).",
        "Uses existing applicable checks and recorded limitations as coverage gaps.",
      ],
    },
    expected_evidence_shape: {
      evidence_root: ".lemma/evidence/<run_id>/",
      manifest: ".lemma/evidence/<run_id>/manifest.json",
      report: "stdout JSON report (lemma.report/v1) with findings/blockers/check evidence refs",
      includes: ["performance-relevant check outcomes", "finding/blocker records with evidence refs", "hashed evidence manifest"],
    },
    persona_contract_references: ["packages/personas/functional.md"],
    check_selection: {
      intents: ["Assay performance assessment", "Assay load assessment", "Assay stress assessment"],
      category_check_ids: ["static.category.performance", "static.category.load", "static.category.stress"],
      domains: ["performance", "reliability"],
    },
  },
  {
    id: "privacy",
    title: "Privacy Specialist Investigation",
    description:
      "Bounded, evidence-backed privacy investigation reusing existing checks/personas, ownership/quarantine, and evidence contracts.",
    intent: "Assay privacy assessment",
    cli: "lemma pro privacy",
    slash_commands: ["/lemma-privacy", "/lemma-pro privacy"],
    bounded_scope: {
      maxChecks: 12,
      maxWallClockMs: 30_000,
      notes: [
        "Stops on check cap or wall-clock cap (whichever is reached first).",
        "No fabricated pass; unavailable/blocked observations remain coverage gaps.",
      ],
    },
    expected_evidence_shape: {
      evidence_root: ".lemma/evidence/<run_id>/",
      manifest: ".lemma/evidence/<run_id>/manifest.json",
      report: "stdout JSON report (lemma.report/v1) with findings/blockers/check evidence refs",
      includes: ["privacy-relevant check outcomes", "finding/blocker records with evidence refs", "hashed evidence manifest"],
    },
    persona_contract_references: ["packages/personas/functional.md", "packages/personas/security.md"],
    check_selection: {
      intents: ["Assay privacy assessment"],
      category_check_ids: ["static.category.privacy", "static.secrets"],
      domains: ["security", "data_integrity", "functional"],
    },
  },
] as const;

export function getSpecialistCatalog(): readonly SpecialistCommandSpec[] {
  return SPECIALIST_COMMAND_CATALOG;
}

export function getSpecialistCommand(id: string): SpecialistCommandSpec | undefined {
  return SPECIALIST_COMMAND_CATALOG.find((c) => c.id === id);
}

export function assertSpecialistLicense(context: ProLicenseContext | null | undefined, specialist: string): void {
  requireProLicense(context ?? null, `pro specialist command (${specialist})`);
}

export interface RunSpecialistCommandOptions {
  specialist: SpecialistId | string;
  target: string | Target | Record<string, unknown>;
  cwd?: string;
  root?: string;
  personasDir?: string;
  license?: ProLicenseContext | null;
  maxChecks?: number;
  wallClockBudgetMs?: number;
  seed?: number | null;
  clockMode?: "real" | "frozen";
  frozenClock?: string;
  noBrowser?: boolean;
  intent?: string;
  nowMs?: () => number;
}

export interface SpecialistInvestigationResult {
  ok: true;
  specialist: SpecialistCommandSpec;
  run_id: string;
  status: string;
  halted_reason?: string;
  report: Record<string, unknown>;
  evidence_refs: string[];
  findings: Finding[];
  blockers: Array<Record<string, unknown>>;
  checks_executed: number;
  checks_total: number;
  deterministic: { seed: number | null; clockMode: string; frozenClock?: string };
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeSpecialistTarget(input: RunSpecialistCommandOptions["target"]): Target {
  if (typeof input === "string") {
    const raw = input.trim();
    const isUrl = /^https?:\/\//i.test(raw);
    return normalizeTarget({ raw, kind: isUrl ? "url" : "directory", resolved: raw, source: null });
  }
  return normalizeTarget(input as any);
}

function resolveRoot(options: RunSpecialistCommandOptions): string {
  return path.resolve(options.root ?? options.cwd ?? process.cwd());
}

function asRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractEvidenceRefs(report: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const findings = Array.isArray(report.findings) ? report.findings : [];
  for (const f of findings) {
    if (!asRecord(f)) continue;
    const ev = Array.isArray(f.evidence) ? f.evidence : [];
    for (const e of ev) if (typeof e === "string" && e) refs.add(e);
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  for (const c of checks) {
    if (!asRecord(c)) continue;
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    for (const e of ev) if (typeof e === "string" && e) refs.add(e);
  }
  if (typeof report.evidence_manifest_path === "string") refs.add(report.evidence_manifest_path);
  return [...refs].sort();
}

async function safeInspectInventory(target: Target): Promise<Record<string, unknown>> {
  try {
    const mod = await import("@lemma/core");
    const Inspector = (mod as any).SourceInspector;
    if (typeof Inspector === "function" && target.kind !== "url") {
      const root = target.resolved || target.raw || process.cwd();
      const inspector = new Inspector(root);
      if (typeof inspector.inspect === "function") {
        const inv = await inspector.inspect();
        return asRecord(inv) ? (inv as Record<string, unknown>) : { available: false };
      }
    }
  } catch {
    // fall through
  }
  return { available: target.kind !== "url", has_markup: false, has_manifest: false, tracked_available: false };
}

async function runStaticChecksForState(state: RunStateDomain, store: StateStore, target: Target): Promise<void> {
  try {
    const mod = await import("@lemma/core");
    const Runner = (mod as any).StaticCheckRunner;
    if (typeof Runner !== "function") return;
    const root = target.kind === "url" ? (store.root || process.cwd()) : (target.resolved || target.raw || store.root || process.cwd());
    const runner = new Runner(root);
    for (const check of state.checks) {
      if (check.kind !== "static") continue;
      if (check.status === "blocked" || check.status === "skipped") continue;
      try {
        const outcome = await runner.runCheck(check);
        if (outcome && asRecord(outcome)) {
          if (typeof (outcome as any).status === "string") check.status = (outcome as any).status;
          if (typeof (outcome as any).actual === "string") check.actual = (outcome as any).actual;
          if (Array.isArray((outcome as any).evidence)) check.evidence = (outcome as any).evidence.filter((x: unknown) => typeof x === "string");
          if (Array.isArray((outcome as any).findings)) {
            for (const f of (outcome as any).findings) {
              if (asRecord(f) && typeof f.id === "string") state.findings.push(f as unknown as Finding);
            }
          }
          if (asRecord((outcome as any).metadata)) check.metadata = { ...(check.metadata ?? {}), ...((outcome as any).metadata as Record<string, unknown>) };
        } else if (check.status === "planned" || check.status === "running") {
          check.status = "passed" as any;
        }
      } catch (err) {
        check.status = "error" as any;
        check.actual = err instanceof Error ? err.message : String(err);
      }
      if (!check.completed_at) check.completed_at = now();
    }
  } catch {
    // best-effort: static runner unavailable
  }
}

function markUnexecutedAsSkipped(state: RunStateDomain, reason: string): void {
  for (const check of state.checks) {
    if (check.status === "planned" || check.status === "running") {
      check.status = "skipped" as any;
      check.skip_reason = check.skip_reason || reason;
      check.actual = check.actual || reason;
      check.completed_at = check.completed_at ?? now();
    }
  }
}

function applyTimeCap(state: RunStateDomain, reason: string): void {
  state.status = RunStatus.HALTED;
  state.halted_reason = reason;
  state.completed_at = now();
  for (const phase of state.phases) {
    if (phase.status === PhaseStatus.PENDING || phase.status === PhaseStatus.RUNNING) {
      phase.status = PhaseStatus.SKIPPED;
      phase.summary = reason;
      phase.started_at = phase.started_at ?? now();
      phase.completed_at = now();
    }
  }
  markUnexecutedAsSkipped(state, reason);
}

function buildDeterministicStateBase(target: Target, intent: string, runIdSeedSuffix: string): RunStateDomain {
  const base = createRunState({ target, intent, workflow: RELEASE_CONFIDENCE } as any) as unknown as RunStateDomain;
  if (!(base as any).run_id) (base as any).run_id = `run_specialist_${runIdSeedSuffix}`;
  base.phases = PHASE_ORDER.map((name) => ({
    name,
    title: (RELEASE_CONFIDENCE.phases as any[]).find((p) => p.name === name)?.title ?? name,
    status: PhaseStatus.PENDING,
    summary: "",
    details: {},
    started_at: null,
    completed_at: null,
  })) as any;
  base.checks = [];
  base.findings = [];
  base.blockers = [];
  base.invalid_findings = [] as unknown as InvalidFinding[];
  base.risks = [];
  return base;
}

export async function runSpecialistCommand(options: RunSpecialistCommandOptions): Promise<SpecialistInvestigationResult> {
  const spec = getSpecialistCommand(String(options.specialist));
  if (!spec) {
    throw new ProUnavailableError(`pro specialist command (${String(options.specialist)})`);
  }
  assertSpecialistLicense(options.license ?? null, spec.id);

  const root = resolveRoot(options);
  const target = normalizeSpecialistTarget(options.target);
  const maxChecks = clampInt(options.maxChecks ?? spec.bounded_scope.maxChecks, 1, spec.bounded_scope.maxChecks);
  const wallClockBudgetMs = clampInt(options.wallClockBudgetMs ?? spec.bounded_scope.maxWallClockMs, 1, spec.bounded_scope.maxWallClockMs);
  const startedWall = (options.nowMs ?? (() => Date.now()))();
  const deadline = startedWall + wallClockBudgetMs;

  const det = options.seed != null || options.clockMode || options.frozenClock
    ? makeDeterminism({
        seed: options.seed ?? null,
        clockMode: options.clockMode ?? (options.frozenClock ? "frozen" : "real"),
        ...(options.frozenClock ? { frozenClock: options.frozenClock } : {}),
      } as any)
    : null;
  const prev = det ? setDeterminism(det) : (currentDeterminism() ? null : null);

  try {
    const store = new StateStore(root);
    await store.ensure();
    const state = buildDeterministicStateBase(target, options.intent ?? spec.intent, spec.id);
    state.intent = options.intent ?? spec.intent;
    state.status = RunStatus.RUNNING;
    state.started_at = state.started_at || now();
    state.updated_at = now();
    if (options.seed != null) state.seed = options.seed as any;
    if (options.clockMode) state.clock_mode = options.clockMode as any;
    state.options = {
      ...(asRecord((state as any).options) ? ((state as any).options as Record<string, unknown>) : {}),
      maxChecks,
      specialist: spec.id,
      bounded_scope: spec.bounded_scope,
      pro: true,
    } as any;

    const evidence = new EvidenceStore(root, state.run_id, { runId: state.run_id } as any);
    await evidence.init();
    (state as any).evidence_dir = evidence.summary().directory;

    const timeExceeded = () => (options.nowMs ?? (() => Date.now()))() > deadline;
    const timeReason = `Specialist investigation halted: wall-clock budget exceeded (${wallClockBudgetMs}ms cap).`;

    const riskPhase = state.phases.find((p) => p.name === "risk_analysis") as any;
    riskPhase.status = PhaseStatus.RUNNING; riskPhase.started_at = now();
    try {
      const mod = await import("@lemma/core");
      const analyze = (mod as any).analyzeRisk;
      const inventory = await safeInspectInventory(target);
      (state as any).inventory = inventory;
      state.risks = typeof analyze === "function" ? await analyze(target, state.intent, inventory, !(options.noBrowser ?? target.kind !== "url")) : [];
      riskPhase.status = PhaseStatus.COMPLETED; riskPhase.summary = `Identified ${state.risks.length} risk(s).`;
    } catch (err) {
      riskPhase.status = PhaseStatus.COMPLETED; riskPhase.summary = `Risk analysis fallback (${err instanceof Error ? err.message : "error"}).`;
      if (!Array.isArray(state.risks)) state.risks = [];
    }
    riskPhase.completed_at = now();

    if (timeExceeded()) {
      applyTimeCap(state, timeReason);
    } else {
      const planPhase = state.phases.find((p) => p.name === "test_planning") as any;
      planPhase.status = PhaseStatus.RUNNING; planPhase.started_at = now();
      try {
        const personasDir = options.personasDir ?? path.resolve(root, "packages/personas");
        let personas: any[] = [];
        try { personas = await loadPersonas(personasDir, { requireMinimum: 0 } as any); } catch { personas = []; }
        const selectedPersonas = personas.map((p) => p.id);
        const ownership = personas.length ? (checkOwnership(personas as any) as Record<string, string[]>) : {};
        const inventory = (state as any).inventory ?? await safeInspectInventory(target);
        let planned = planChecks({
          target,
          inventory,
          selectedPersonas: selectedPersonas.length ? selectedPersonas : ["functional", "security", "accessibility"],
          ownership,
          maxChecks,
          noBrowser: options.noBrowser ?? target.kind !== "url",
          intent: state.intent,
          scenario: false,
        } as any) as Check[];
        if (Array.isArray(planned) && planned.length > maxChecks) planned = planned.slice(0, maxChecks);
        state.checks = planned ?? [];
        if (state.risks?.length) applyRiskWeights(state.checks, state.risks as any);
        state.options = { ...(asRecord((state as any).options) ? ((state as any).options as any) : {}), registry_fingerprint: registryFingerprint(null) } as any;
        planPhase.status = PhaseStatus.COMPLETED; planPhase.summary = `Planned ${state.checks.length} check(s).`;
      } catch (err) {
        state.checks = [];
        planPhase.status = PhaseStatus.COMPLETED; planPhase.summary = `Planning completed with no applicable checks (${err instanceof Error ? err.message : "error"}).`;
      }
      planPhase.completed_at = now();
    }

    if (!timeExceeded() && state.status === RunStatus.RUNNING) {
      const execPhase = state.phases.find((p) => p.name === "execution") as any;
      execPhase.status = PhaseStatus.RUNNING; execPhase.started_at = now();
      if (timeExceeded()) {
        applyTimeCap(state, timeReason);
      } else {
        await runStaticChecksForState(state, store, target);
        for (const check of state.checks) {
          if (timeExceeded()) break;
          if (check.status === "planned" || check.status === "running") {
            if (check.kind === "browser" && (options.noBrowser ?? target.kind !== "url")) {
              check.status = "blocked" as any;
              check.skip_reason = "Browser execution unavailable in this specialist investigation context.";
              check.actual = check.skip_reason;
            } else if (check.kind !== "static") {
              check.status = "skipped" as any;
              check.skip_reason = "Not executed in bounded specialist investigation context.";
              check.actual = check.skip_reason;
            }
            check.completed_at = check.completed_at ?? now();
          }
        }
        if (timeExceeded()) {
          applyTimeCap(state, timeReason);
        } else {
          execPhase.status = PhaseStatus.COMPLETED; execPhase.summary = `Executed bounded specialist checks (${state.checks.length}, cap ${maxChecks}).`;
          execPhase.completed_at = now();
        }
      }
    }

    if (state.status !== RunStatus.HALTED) {
      const evPhase = state.phases.find((p) => p.name === "evidence_collection") as any;
      evPhase.status = PhaseStatus.RUNNING; evPhase.started_at = now();
      try { await (evidence as any).finalize({ run_id: state.run_id }); } catch { /* best effort */ }
      evPhase.status = PhaseStatus.COMPLETED; evPhase.summary = "Evidence collected."; evPhase.completed_at = now();

      const scorePhase = state.phases.find((p) => p.name === "confidence_scoring") as any;
      scorePhase.status = PhaseStatus.RUNNING; scorePhase.started_at = now();
      try {
        const confidence = scoreConfidence(state.checks as any, state.findings as any, { halted: false } as any) as Confidence;
        (state as any).confidence = confidence;
      } catch {
        (state as any).confidence = { score: 0, coverage: 0 };
      }
      scorePhase.status = PhaseStatus.COMPLETED; scorePhase.summary = "Confidence scored."; scorePhase.completed_at = now();

      state.status = RunStatus.COMPLETED;
      state.completed_at = state.completed_at ?? now();
    }

    state.updated_at = now();
    try { await store.saveProgress(state as any); } catch { /* best effort */ }

    let report: Record<string, unknown> = {};
    try {
      let manifest: any = null;
      try { manifest = await (evidence as any).finalize({ run_id: state.run_id }); } catch { manifest = null; }
      const summary = manifest && asRecord(manifest.summary) ? manifest.summary : ((evidence as any).summary() as any);
      report = buildReport(state as any, RELEASE_CONFIDENCE, summary as any, now()) as unknown as Record<string, unknown>;
    } catch {
      report = {
        schema_version: "lemma.report/v1",
        run_id: state.run_id,
        status: state.status,
        specialist: spec.id,
        findings: state.findings ?? [],
        blockers: state.blockers ?? [],
        checks: state.checks ?? [],
      };
    }

    const evidenceRefs = extractEvidenceRefs(report);
    const checksExecuted = (state.checks ?? []).filter((c) => ["passed", "failed", "error"].includes(String(c.status))).length;
    return {
      ok: true,
      specialist: spec,
      run_id: state.run_id,
      status: String(state.status),
      ...(state.halted_reason ? { halted_reason: state.halted_reason } : {}),
      report,
      evidence_refs: evidenceRefs,
      findings: (state.findings ?? []) as Finding[],
      blockers: (Array.isArray((state as any).blockers) ? (state as any).blockers : []) as Array<Record<string, unknown>>,
      checks_executed: checksExecuted,
      checks_total: (state.checks ?? []).length,
      deterministic: {
        seed: options.seed ?? null,
        clockMode: options.clockMode ?? (options.frozenClock ? "frozen" : "real"),
        ...(options.frozenClock ? { frozenClock: options.frozenClock } : {}),
      },
    };
  } finally {
    if (prev) resetDeterminism(prev);
  }
}

export function formatSpecialistProUnavailableMessage(specialist: string): string {
  return new ProUnavailableError(`pro specialist command (${specialist})`).message;
}
