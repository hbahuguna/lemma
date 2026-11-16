import { HarnessError } from "./errors.js";

export const RUN_SIZES = ["quick", "medium", "large"] as const;
export type RunSize = (typeof RUN_SIZES)[number];

export const DEFAULT_RUN_SIZE: RunSize = "medium";

export const RUN_SIZE_PERSPECTIVES: Record<RunSize, number> = {
  quick: 2,
  medium: 4,
  large: 6,
};

export interface RunSizeCutLine {
  size: RunSize;
  perspectives: number;
  in_scope: string[];
  out_of_scope: string[];
  evidence_expectation: string;
}

export const RUN_SIZE_CUT_LINES: Record<RunSize, RunSizeCutLine> = {
  quick: {
    size: "quick",
    perspectives: 2,
    in_scope: [
      "core_critical_functional",
      "security",
      "reliability_intent_risk_linked",
    ],
    out_of_scope: [
      "extended_compatibility",
      "deep_exploratory_browser_matrices",
      "non_critical_integrations",
      "exhaustive_domain_sweeps",
    ],
    evidence_expectation: "Fast signal for highest-risk areas; not full coverage.",
  },
  medium: {
    size: "medium",
    perspectives: 4,
    in_scope: [
      "core_functional_security_reliability",
      "key_ux_accessibility",
      "api_data",
      "intent_risk_relevant_integrations",
    ],
    out_of_scope: [
      "exhaustive_long_tail_matrices",
      "heavy_load_stress_campaigns",
      "broad_exploratory_sweeps_beyond_prioritized_domains",
    ],
    evidence_expectation: "Standard release confidence with documented gaps.",
  },
  large: {
    size: "large",
    perspectives: 6,
    in_scope: [
      "comprehensive_functional_security_reliability",
      "accessibility_ux",
      "api_data",
      "compatibility_integrations",
      "risk_driven_exploratory_families_within_budget",
    ],
    out_of_scope: [
      "policy_budget_capability_exclusions_only",
    ],
    evidence_expectation: "Maximal in-scope confidence; exclusions only by explicit constraints.",
  },
};

export function isRunSize(value: unknown): value is RunSize {
  return typeof value === "string" && (RUN_SIZES as readonly string[]).includes(value);
}

export function normalizeRunSize(value: unknown, fallback: RunSize = DEFAULT_RUN_SIZE): RunSize {
  if (isRunSize(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const lower = value.trim().toLowerCase();
    if (isRunSize(lower)) return lower as RunSize;
  }
  return fallback;
}

export function perspectiveCountForSize(size: RunSize): number {
  return RUN_SIZE_PERSPECTIVES[size];
}

export function runSizeCutLine(size: RunSize): RunSizeCutLine {
  return RUN_SIZE_CUT_LINES[size];
}

export function coverageNoteForOutOfScope(size: RunSize, family: string, reason?: string): string {
  const cut = RUN_SIZE_CUT_LINES[size];
  const why = reason ? ` Reason: ${reason}` : "";
  return `Out of scope for run size '${size}' (${cut.perspectives} perspectives): ${family}.${why}`.trim();
}

export function buildRunSizeCoverageNotes(size: RunSize, outOfScopeFamilies?: string[]): string[] {
  const families = (outOfScopeFamilies && outOfScopeFamilies.length > 0)
    ? outOfScopeFamilies
    : RUN_SIZE_CUT_LINES[size].out_of_scope;
  return families.map((f) => coverageNoteForOutOfScope(size, f));
}

/**
 * Apply run-size metadata to a planned run shape and emit explicit coverage notes
 * for out-of-scope check families (never silent skips).
 */
export function applyRunSizeToPlan<T extends { checks?: any[]; options?: Record<string, any>; coverage_notes?: string[]; perspectives?: string[] }>(
  plan: T,
  size: RunSize,
  opts?: { out_of_scope_families?: string[]; selected_perspectives?: string[] },
): T & { run_size: RunSize; perspectives_count: number; coverage_notes: string[] } {
  const perspectives = perspectiveCountForSize(size);
  const notes = buildRunSizeCoverageNotes(size, opts?.out_of_scope_families);
  const existingNotes = Array.isArray(plan.coverage_notes) ? plan.coverage_notes : [];
  const mergedNotes = [...existingNotes];
  for (const n of notes) if (!mergedNotes.includes(n)) mergedNotes.push(n);
  const selectedPerspectives = (opts?.selected_perspectives ?? (plan.perspectives ?? [])).slice(0, perspectives);
  return {
    ...plan,
    run_size: size,
    perspectives_count: perspectives,
    coverage_notes: mergedNotes,
    perspectives: selectedPerspectives,
    options: { ...(plan.options ?? {}), run_size: size, perspectives_count: perspectives },
  };
}

export function assertRunSizeTransition(saved: RunSize, requested: RunSize): void {
  if (saved !== requested) {
    throw new RunSizeMismatchError(saved, requested);
  }
}

export class RunSizeMismatchError extends HarnessError {
  readonly savedSize: RunSize;
  readonly requestedSize: RunSize;

  constructor(savedSize: RunSize, requestedSize: RunSize) {
    super(`Run size mismatch: saved run size '${savedSize}' cannot be changed to '${requestedSize}' on resume.`, {
      details: { saved_size: savedSize, requested_size: requestedSize, transition: `${savedSize}->${requestedSize}` },
    });
    this.name = "RunSizeMismatchError";
    this.savedSize = savedSize;
    this.requestedSize = requestedSize;
  }
}
