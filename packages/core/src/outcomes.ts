/**
 * Check outcome application and structured blocker/refusal records.
 *
 * Ports assay's runtime blocker handling: blocked checks carry exactly one
 * redacted blocker record and no findings; a blocker draft or existing blocker
 * forces blocked status; blocker payloads are derived from drafts or fallback
 * hints and validated against the owning persona blocker contract.
 */

import { newId, now } from "./determinism.js";
import { recordCheckFindings, type RecordFindingsOptions } from "./findings.js";
import {
  CheckStatus,
  type Blocker,
  type BlockerDraft,
  type Check,
  type CheckOutcome,
  type Finding,
  type InvalidFinding,
  type RunStateDomain,
} from "./models.js";
import { validatePayload, type PersonaJsonSchema } from "./personas.js";
import { redactText, redactUnknown } from "./redaction.js";

export interface PersonaOutcomeContractLike {
  readonly id?: string;
  readonly output_schema?: PersonaJsonSchema;
  readonly blocker_schema?: PersonaJsonSchema;
}

export interface BlockerRecordOptions {
  now?: () => string;
  nextId?: (prefix: string) => string;
  redact?: (value: string) => string;
  redactPayload?: (value: unknown) => unknown;
  log?: (message: string) => void;
}

export interface RecordCheckOutcomeOptions extends BlockerRecordOptions, RecordFindingsOptions {}

export interface RecordCheckOutcomeResult {
  status: string;
  blocked: boolean;
  blocker: Blocker | null;
  findings: Finding[];
  invalid: InvalidFinding[];
  invalidCount: number;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item));
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeOutcome(
  outcome: CheckOutcome | (Partial<CheckOutcome> & Record<string, unknown>),
): {
  status: string;
  actual: string;
  evidence: string[];
  findings: unknown[];
  blocker: BlockerDraft | Record<string, unknown> | null;
  metadata: Record<string, unknown>;
} {
  const raw = outcome as Record<string, unknown>;
  const blocker = raw.blocker;
  return {
    status: stringValue(raw.status || CheckStatus.PASSED),
    actual: stringValue(raw.actual),
    evidence: stringArray(raw.evidence),
    findings: Array.isArray(raw.findings) ? [...(raw.findings as unknown[])] : [],
    blocker:
      blocker && typeof blocker === "object" && !Array.isArray(blocker)
        ? (blocker as BlockerDraft | Record<string, unknown>)
        : null,
    metadata: plainRecord(raw.metadata),
  };
}

export function blockerForCheck(state: RunStateDomain, checkId: string): Blocker | null {
  return (state.blockers ?? []).find((blocker) => blocker.check_id === checkId) ?? null;
}

/**
 * Deterministic unblock hint for a boundary, matching assay.
 */
export function unblockHints(check: Pick<Check, "id">, boundary: string): string[] {
  const text = String(boundary).toLowerCase();
  if (text.includes("persona") && (text.includes("owner") || text.includes("ownership"))) {
    return [`Declare exactly one persona owner for check '${check.id}' and re-run.`];
  }
  if (["plugin", "signature", "trusted", "verify"].some((token) => text.includes(token))) {
    return [
      `Install a signed plugin with trusted metadata for check '${check.id}' and re-run.`,
    ];
  }
  if (["browser", "playwright", "chromium", "operate"].some((token) => text.includes(token))) {
    return [
      `Provide a runnable browser target and a Playwright/Chromium installation, then re-run check '${check.id}'.`,
    ];
  }
  if (["source", "static", "inventory"].some((token) => text.includes(token))) {
    return [`Provide a readable source directory for check '${check.id}' and re-run.`];
  }
  return [`Resolve the reported boundary for check '${check.id}' and re-run it.`];
}

function rawBoundary(
  check: Check,
  outcome: ReturnType<typeof normalizeOutcome>,
  draft: BlockerDraft | Record<string, unknown> | null,
  explicitBoundary = "",
): string {
  return (
    stringValue((draft as Record<string, unknown> | null)?.boundary) ||
    explicitBoundary ||
    stringValue(outcome.metadata.boundary) ||
    stringValue(outcome.metadata.limitation) ||
    outcome.actual ||
    check.actual ||
    check.skip_reason ||
    "Check was blocked before execution."
  );
}

/**
 * Derive the raw (unredacted) blocker payload for a blocked check.
 */
export function blockerPayload(
  check: Check,
  outcome: CheckOutcome | Record<string, unknown>,
  blockerDraft?: BlockerDraft | Record<string, unknown> | null,
  explicitBoundary = "",
): {
  attempted_action: string;
  boundary: string;
  unblock_evidence: string[];
  covered_elsewhere: boolean;
  covered_by: string[];
} {
  const normalized = normalizeOutcome(outcome);
  const draft = blockerDraft ?? normalized.blocker;
  const boundary = rawBoundary(check, normalized, draft, explicitBoundary);
  const attemptedAction =
    stringValue((draft as Record<string, unknown> | null)?.attempted_action) ||
    check.expected ||
    check.title ||
    check.id;
  const draftUnblock = (draft as Record<string, unknown> | null)?.unblock_evidence;
  const unblockEvidence = Array.isArray(draftUnblock) && draftUnblock.length > 0
    ? stringArray(draftUnblock)
    : typeof normalized.metadata.note === "string" && normalized.metadata.note
      ? [normalized.metadata.note]
      : unblockHints(check, boundary);
  const coveredElsewhereRaw = (draft as Record<string, unknown> | null)?.covered_elsewhere;
  const coveredByRaw = (draft as Record<string, unknown> | null)?.covered_by;
  return {
    attempted_action: attemptedAction,
    boundary,
    unblock_evidence: unblockEvidence,
    covered_elsewhere: typeof coveredElsewhereRaw === "boolean" ? coveredElsewhereRaw : false,
    covered_by: Array.isArray(coveredByRaw) ? stringArray(coveredByRaw) : [],
  };
}

export function blockerFromPayload(
  check: Check,
  payload: ReturnType<typeof blockerPayload>,
  options: BlockerRecordOptions = {},
): Blocker {
  const redact = options.redact ?? redactText;
  return {
    id: (options.nextId ?? newId)("blocker"),
    persona: check.persona,
    check_id: check.id,
    attempted_action: redact(stringValue(payload.attempted_action)),
    boundary: redact(stringValue(payload.boundary)),
    unblock_evidence: (payload.unblock_evidence ?? []).map((item) => redact(stringValue(item))),
    covered_elsewhere: Boolean(payload.covered_elsewhere),
    covered_by: (payload.covered_by ?? []).map((item) => redact(stringValue(item))),
    recorded_at: (options.now ?? now)(),
  };
}

function removeFindingsForCheck(state: RunStateDomain, check: Check): void {
  if (state.findings.some((finding) => finding.check_id === check.id)) {
    state.findings = state.findings.filter((finding) => finding.check_id !== check.id);
  }
  check.finding_ids = [];
}

/**
 * Record exactly one structured blocker for a blocked check.
 */
export function recordBlockedCheck(
  state: RunStateDomain,
  check: Check,
  outcome: CheckOutcome | Record<string, unknown>,
  persona: PersonaOutcomeContractLike | null | undefined,
  options: BlockerRecordOptions & { blockerDraft?: BlockerDraft | Record<string, unknown> | null; boundary?: string } = {},
): Blocker {
  const existing = blockerForCheck(state, check.id);
  if (existing) {
    check.status = CheckStatus.BLOCKED;
    check.skip_reason = check.skip_reason || existing.boundary;
    removeFindingsForCheck(state, check);
    return existing;
  }

  const payload = blockerPayload(check, outcome, options.blockerDraft, options.boundary);
  const record = blockerFromPayload(check, payload, options);

  if (persona?.blocker_schema) {
    const errors = validatePayload(record, persona.blocker_schema);
    if (errors.length > 0) {
      options.log?.(
        `WARNING: blocker for check ${check.id} violates the ${String(persona.id ?? "persona")} blocker contract: ${errors.slice(0, 5).join("; ")}`,
      );
    }
  }

  if (!Array.isArray(state.blockers)) state.blockers = [];
  state.blockers.push(record);
  check.status = CheckStatus.BLOCKED;
  check.skip_reason = check.skip_reason || record.boundary;
  removeFindingsForCheck(state, check);
  state.updated_at = (options.now ?? now)();
  return record;
}

/**
 * Apply a check outcome to run state, porting assay's refusal/blocker and
 * finding-recording behavior.
 */
export function recordCheckOutcome(
  state: RunStateDomain,
  check: Check,
  outcome: CheckOutcome | Record<string, unknown>,
  persona: PersonaOutcomeContractLike | null | undefined,
  options: RecordCheckOutcomeOptions = {},
): RecordCheckOutcomeResult {
  const normalized = normalizeOutcome(outcome);
  const existingBlocker = blockerForCheck(state, check.id);
  const blocked =
    normalized.status === CheckStatus.BLOCKED ||
    normalized.blocker !== null ||
    existingBlocker !== null;

  check.evidence = [...normalized.evidence];

  let blocker: Blocker | null = existingBlocker;
  let findings: Finding[] = [];
  let invalid: InvalidFinding[] = [];
  let invalidCount = 0;

  if (blocked) {
    const boundary = (options.redact ?? redactText)(
      rawBoundary(check, normalized, normalized.blocker),
    );
    const actual = (options.redact ?? redactText)(normalized.actual);
    const metadata = (options.redactPayload ?? redactUnknown)(normalized.metadata) as Record<string, unknown>;
    check.actual = actual || boundary;
    check.metadata = plainRecord(metadata);
    check.status = CheckStatus.BLOCKED;
    removeFindingsForCheck(state, check);
    check.skip_reason = stringValue(check.metadata.limitation) || boundary;

    if (!existingBlocker) {
      blocker = recordBlockedCheck(state, check, normalized, persona, {
        ...options,
        blockerDraft: normalized.blocker,
        boundary: rawBoundary(check, normalized, normalized.blocker),
      });
    } else {
      state.updated_at = (options.now ?? now)();
    }

    if (normalized.findings.length > 0) {
      options.log?.(
        `WARNING: ${check.id} was blocked; ${normalized.findings.length} finding(s) were discarded because a blocker cannot carry findings.`,
      );
    }
  } else {
    check.actual = normalized.actual;
    check.metadata = { ...normalized.metadata };
    check.status = normalized.status;

    if (normalized.status === CheckStatus.SKIPPED) {
      check.skip_reason = stringValue(normalized.metadata.limitation) || normalized.actual;
    }
    if (normalized.status === CheckStatus.ERROR) {
      options.log?.(`WARNING: ${check.id} errored: ${normalized.actual}`);
    }

    if (normalized.findings.length > 0 || normalized.status === CheckStatus.FAILED || normalized.status === CheckStatus.ERROR) {
      const recorded = recordCheckFindings(
        state,
        check,
        normalized.findings,
        persona?.output_schema
          ? persona.id
            ? { id: persona.id, output_schema: persona.output_schema }
            : { output_schema: persona.output_schema }
          : null,
        options,
      );
      findings = recorded.findings;
      invalid = recorded.invalid;
      invalidCount = recorded.invalidCount;
    } else {
      state.updated_at = (options.now ?? now)();
    }
  }

  if (
    [CheckStatus.PASSED, CheckStatus.FAILED, CheckStatus.BLOCKED, CheckStatus.SKIPPED, CheckStatus.ERROR]
      .map(String)
      .includes(check.status)
  ) {
    check.completed_at = (options.now ?? now)();
  }

  return {
    status: check.status,
    blocked,
    blocker,
    findings,
    invalid,
    invalidCount,
  };
}
