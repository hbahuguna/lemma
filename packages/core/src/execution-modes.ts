import { HarnessError } from "./errors.js";

export const EXECUTION_MODES = ["plan", "test", "review", "focused", "learn"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "test";

export interface ExecutionModeSemantics {
  mode: ExecutionMode;
  produces_planned_tests_only: boolean;
  executes_planned_tests: boolean;
  executes_independent_review: boolean;
  bounded_subset: boolean;
  exploration_without_final_findings: boolean;
  evidence: string;
}

export const EXECUTION_MODE_SEMANTICS: Record<ExecutionMode, ExecutionModeSemantics> = {
  plan: {
    mode: "plan",
    produces_planned_tests_only: true,
    executes_planned_tests: false,
    executes_independent_review: false,
    bounded_subset: false,
    exploration_without_final_findings: false,
    evidence: "Planned tests/checks and scope only; no execution findings produced.",
  },
  test: {
    mode: "test",
    produces_planned_tests_only: false,
    executes_planned_tests: true,
    executes_independent_review: false,
    bounded_subset: false,
    exploration_without_final_findings: false,
    evidence: "Executes planned tests/checks and records execution evidence/findings.",
  },
  review: {
    mode: "review",
    produces_planned_tests_only: false,
    executes_planned_tests: false,
    executes_independent_review: true,
    bounded_subset: false,
    exploration_without_final_findings: false,
    evidence: "Executes independent review (LEM-179) and records review artifacts/notes.",
  },
  focused: {
    mode: "focused",
    produces_planned_tests_only: false,
    executes_planned_tests: true,
    executes_independent_review: false,
    bounded_subset: true,
    exploration_without_final_findings: false,
    evidence: "Executes a bounded subset; evidence is valid for executed subset with explicit scope.",
  },
  learn: {
    mode: "learn",
    produces_planned_tests_only: false,
    executes_planned_tests: false,
    executes_independent_review: false,
    bounded_subset: false,
    exploration_without_final_findings: true,
    evidence: "Exploratory observations/evidence only; no final findings produced.",
  },
};

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

export function normalizeExecutionMode(value: unknown, fallback: ExecutionMode = DEFAULT_EXECUTION_MODE): ExecutionMode {
  if (isExecutionMode(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const lower = value.trim().toLowerCase();
    if (isExecutionMode(lower)) return lower as ExecutionMode;
  }
  return fallback;
}

export function executionModeSemantics(mode: ExecutionMode): ExecutionModeSemantics {
  return EXECUTION_MODE_SEMANTICS[mode];
}

export function assertExecutionModeTransition(saved: ExecutionMode, requested: ExecutionMode): void {
  if (saved !== requested) {
    throw new ModeMismatchError(saved, requested);
  }
}

export class ModeMismatchError extends HarnessError {
  readonly savedMode: ExecutionMode;
  readonly requestedMode: ExecutionMode;

  constructor(savedMode: ExecutionMode, requestedMode: ExecutionMode) {
    super(`Execution mode mismatch: saved run mode '${savedMode}' cannot be changed to '${requestedMode}' on resume.`, {
      details: { saved_mode: savedMode, requested_mode: requestedMode, transition: `${savedMode}->${requestedMode}` },
    });
    this.name = "ModeMismatchError";
    this.savedMode = savedMode;
    this.requestedMode = requestedMode;
  }
}
