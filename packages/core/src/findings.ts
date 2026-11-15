/**
 * Persona output-contract enforcement.
 *
 * Ports assay's execution-time finding handling: raw payload extraction without
 * deriving defaults, finding construction, quarantine of schema-invalid findings,
 * per-persona contract-failure totals and consecutive streaks, degradation after
 * three consecutive failures, and contract-health rebuilding after resume.
 *
 * Invalid findings are persisted for inspection only. They never enter
 * `state.findings`, confidence scoring, or kill-switch evaluation.
 */

import { newId, now } from "./determinism.js";
import { sha256Bytes } from "./evidence.js";
import {
  createFinding,
  type Check,
  type Finding,
  type InvalidFinding,
  type RunStateDomain,
} from "./models.js";
import { redactText, redactUnknown } from "./redaction.js";
import { validatePayload, type PersonaJsonSchema } from "./personas.js";

export const CONTRACT_DEGRADED_THRESHOLD = 3;
export const PERSONA_OUTPUT_CONTRACT = "persona_output_schema";

/** Minimal persona shape needed to validate an output contract. */
export interface PersonaContractLike {
  readonly id?: string;
  readonly output_schema: PersonaJsonSchema;
}

export interface ContractHealthOptions {
  /** Injectable clock for deterministic ids/timestamps. Defaults to `now()`. */
  now?: () => string;
  /** Injectable id factory for deterministic records. Defaults to `newId`. */
  nextId?: (prefix: string) => string;
  /** Error redactor; defaults to `redactText`. */
  redactError?: (value: string) => string;
  /** Payload redactor; defaults to `redactUnknown`. */
  redactPayload?: (value: unknown) => unknown;
  /** Optional warning sink (stderr/UI). Never printed to stdout. */
  log?: (message: string) => void;
}

export interface QuarantineResult {
  record: InvalidFinding;
  contract_failures: number;
  streak: number;
  degraded: boolean;
}

export interface FindingFromPayloadOptions {
  now?: () => string;
  nextId?: (prefix: string) => string;
}

export interface RecordFindingsOptions extends FindingFromPayloadOptions, ContractHealthOptions {}

export interface RecordFindingsResult {
  /** Valid findings recorded or de-duplicated by this call. */
  findings: Finding[];
  /** Quarantined records created by this call. */
  invalid: InvalidFinding[];
  invalidCount: number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Copy own enumerable properties without invoking throwing getters.
 */
function copyOwnEntries(source: object): Record<string, unknown> {
  let keys: string[];
  try {
    keys = Object.keys(source);
  } catch {
    return { value: source };
  }
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    try {
      payload[key] = (source as Record<string, unknown>)[key];
    } catch {
      // Preserve the absence. Validation will reject the missing field.
    }
  }
  return payload;
}

/**
 * Return the raw finding payload without deriving missing fields.
 *
 * A malformed draft is itself a contract violation: absent values stay absent
 * and a throwing getter is skipped instead of aborting the run. Objects that
 * expose `to_dict()` follow assay's mapping fallback.
 */
export function draftPayload(draft: unknown): Record<string, unknown> {
  if (draft instanceof Map) {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of draft) payload[String(key)] = value;
    return payload;
  }
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    return { value: draft };
  }
  const toDict = (draft as { to_dict?: unknown }).to_dict;
  if (typeof toDict === "function") {
    try {
      const data = (toDict as () => unknown).call(draft);
      if (data instanceof Map) {
        return draftPayload(data);
      }
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        return copyOwnEntries(data);
      }
    } catch {
      // Fall through to own properties.
    }
  }
  return copyOwnEntries(draft);
}

/**
 * Assay-compatible finding fingerprint:
 * `sha256("<domain>|<trimmed-lowercase-title>|<location>|<severity>")` first 16
 * hex characters.
 */
export function findingFingerprint(
  domain: string,
  title: string,
  location: string,
  severity: string,
): string {
  return sha256Bytes(`${domain}|${title.trim().toLowerCase()}|${location}|${severity}`).slice(0, 16);
}

/**
 * Convert a validated payload into a finding owned by `check`.
 */
export function findingFromPayload(
  payload: Record<string, unknown>,
  check: Pick<Check, "id" | "persona" | "evidence">,
  options: FindingFromPayloadOptions = {},
): Finding {
  const title = stringValue(payload.title);
  const domain = stringValue(payload.domain);
  const severity = stringValue(payload.severity);
  const location = stringValue(payload.location);
  const evidence = stringArray(payload.evidence);
  return createFinding({
    id: (options.nextId ?? newId)("finding"),
    title,
    severity,
    domain,
    persona: check.persona,
    strength: stringValue(payload.strength),
    consequence: stringValue(payload.consequence),
    location,
    reproduction: stringValue(payload.reproduction),
    evidence: evidence.length > 0 ? evidence : [...(check.evidence ?? [])],
    remediation: stringValue(payload.remediation),
    verification: stringValue(payload.verification),
    check_id: check.id,
    created_at: (options.now ?? now)(),
    tags: stringArray(payload.tags),
    fingerprint: findingFingerprint(domain, title, location, severity),
  });
}

/**
 * Persist a contract-violating finding outside scoring and kill policy.
 */
export function quarantineFinding(
  state: RunStateDomain,
  check: Pick<Check, "id" | "persona">,
  payload: unknown,
  errors: readonly string[],
  options: ContractHealthOptions = {},
): QuarantineResult {
  const timestamp = (options.now ?? now)();
  const persona = String(check.persona || "");
  const record: InvalidFinding = {
    id: (options.nextId ?? newId)("invalid-finding"),
    persona,
    check_id: check.id,
    errors: errors.map((error) => (options.redactError ?? redactText)(String(error))),
    payload: (options.redactPayload ?? redactUnknown)(payload),
    contract: PERSONA_OUTPUT_CONTRACT,
    recorded_at: timestamp,
  };

  if (!Array.isArray(state.invalid_findings)) state.invalid_findings = [];
  if (!state.contract_failures || typeof state.contract_failures !== "object") {
    state.contract_failures = {};
  }
  if (!state.contract_failure_streaks || typeof state.contract_failure_streaks !== "object") {
    state.contract_failure_streaks = {};
  }
  if (!Array.isArray(state.degraded_personas)) state.degraded_personas = [];

  state.invalid_findings.push(record);
  const failures = (state.contract_failures[persona] ?? 0) + 1;
  state.contract_failures[persona] = failures;
  const streak = (state.contract_failure_streaks[persona] ?? 0) + 1;
  state.contract_failure_streaks[persona] = streak;

  let degraded = false;
  if (streak >= CONTRACT_DEGRADED_THRESHOLD && !state.degraded_personas.includes(persona)) {
    state.degraded_personas.push(persona);
    degraded = true;
  }
  state.updated_at = timestamp;
  options.log?.(
    `WARNING: quarantined invalid finding from ${persona} check ${check.id} (${record.errors.length} validation error(s)); first: ${record.errors[0] ?? "unknown"}`,
  );
  return { record, contract_failures: failures, streak, degraded };
}

/**
 * Reset a persona's consecutive contract-failure streak after a valid finding.
 * The degraded list is intentionally unchanged, matching assay.
 */
export function recordValidContract(state: RunStateDomain, persona: string): void {
  if (!persona) return;
  const streak = state.contract_failure_streaks?.[persona] ?? 0;
  if (streak) state.contract_failure_streaks[persona] = 0;
}

/**
 * Recompute contract-failure counters after resume removes invalid records.
 */
export function rebuildContractHealth(state: RunStateDomain): void {
  const failures: Record<string, number> = {};
  const streaks: Record<string, number> = {};
  const degraded: string[] = [];
  for (const record of state.invalid_findings ?? []) {
    const persona = String(record.persona || "");
    failures[persona] = (failures[persona] ?? 0) + 1;
    const streak = (streaks[persona] ?? 0) + 1;
    streaks[persona] = streak;
    if (streak >= CONTRACT_DEGRADED_THRESHOLD && !degraded.includes(persona)) {
      degraded.push(persona);
    }
  }
  state.contract_failures = failures;
  state.contract_failure_streaks = streaks;
  state.degraded_personas = degraded;
}

/**
 * Validate and record the findings produced by one check.
 *
 * Invalid drafts are quarantined; valid drafts are recorded with fingerprint
 * de-duplication, evidence merge, and check linkage. A valid finding resets the
 * owning persona's consecutive failure streak.
 */
export function recordCheckFindings(
  state: RunStateDomain,
  check: Check,
  drafts: readonly unknown[],
  persona: PersonaContractLike | null | undefined,
  options: RecordFindingsOptions = {},
): RecordFindingsResult {
  const recorded: Finding[] = [];
  const invalid: InvalidFinding[] = [];
  if (!Array.isArray(check.finding_ids)) check.finding_ids = [];

  for (const draft of drafts) {
    const payload = draftPayload(draft);
    const errors = persona ? validatePayload(payload, persona.output_schema) : [];
    if (errors.length > 0) {
      invalid.push(quarantineFinding(state, check, payload, errors, options).record);
      continue;
    }

    const finding = findingFromPayload(payload, check, options);
    const existing = state.findings.find((item) => item.fingerprint === finding.fingerprint);
    if (existing) {
      for (const evidencePath of finding.evidence) {
        if (evidencePath && !existing.evidence.includes(evidencePath)) {
          existing.evidence.push(evidencePath);
        }
      }
      if (!check.finding_ids.includes(existing.id)) check.finding_ids.push(existing.id);
      recorded.push(existing);
      recordValidContract(state, check.persona);
      continue;
    }

    state.findings.push(finding);
    check.finding_ids.push(finding.id);
    recorded.push(finding);
    recordValidContract(state, check.persona);
  }

  if (invalid.length > 0) {
    check.metadata = { ...(check.metadata ?? {}), invalid_findings: invalid.length };
  }
  state.updated_at = (options.now ?? now)();
  return { findings: recorded, invalid, invalidCount: invalid.length };
}
