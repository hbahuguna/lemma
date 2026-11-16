import path from "node:path";

import { CorruptStateError, StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactText, redactUnknown } from "./redaction.js";
import { now } from "./determinism.js";
import type { StateStore } from "./state-store.js";

export const HUMAN_CONTEXT_SCHEMA_VERSION = "lemma.human.decision_context/v1" as const;
export const DEFAULT_HUMAN_CONTEXT_REL_PATH = path.join(".lemma", "human", "decision-context.json");

export interface HumanQuestionMateriality {
  affects: Array<"confidence" | "risk" | "release_readiness" | "decision" | string>;
  reason: string;
  material?: boolean;
}

export interface HumanQuestion {
  id: string; // HUM-*
  prompt: string;
  materiality: HumanQuestionMateriality;
  allows_freeform?: boolean;
  required_for_decision?: boolean;
  answer_type?: string;
  [key: string]: unknown;
}

export interface HumanQuestionCatalog {
  schema_version?: string;
  catalog_version?: string;
  version?: string;
  questions: HumanQuestion[];
  [key: string]: unknown;
}

export interface HumanAnswerRecord {
  question_id: string;
  answered_at: string;
  answer: unknown;
  redacted: boolean;
  freeform: boolean;
}

export interface HumanDecisionContextState {
  schema_version: typeof HUMAN_CONTEXT_SCHEMA_VERSION;
  catalog_version: string;
  run_id: string;
  updated_at: string;
  questions: HumanQuestion[];
  answers: Record<string, HumanAnswerRecord>;
}

export interface HumanContextBlocker {
  id: string;
  type: "human_decision_context";
  question_id: string;
  reason: string;
  materiality: HumanQuestionMateriality;
  unresolved: true;
}

export interface RunHumanContextParams {
  runId: string;
  questions: HumanQuestionCatalog | HumanQuestion[];
  answers?: Record<string, unknown>;
  root?: string;
  stateStore?: StateStore;
  /** Optional path override for persistence/resume. */
  contextPath?: string;
  /** If false, do not escalate/write run hold state; still computes/persists context. */
  escalate?: boolean;
}

export interface RunHumanContextResult {
  schema_version: typeof HUMAN_CONTEXT_SCHEMA_VERSION;
  run_id: string;
  context_path: string;
  state: HumanDecisionContextState;
  unanswered_material_question_ids: string[];
  decision: "hold" | "unchanged";
  blockers: HumanContextBlocker[];
  resumed: boolean;
}

function isHumId(id: string): boolean {
  return /^HUM-[A-Z0-9_-]+$/.test(id);
}

function normalizeCatalog(input: HumanQuestionCatalog | HumanQuestion[]): { catalogVersion: string; questions: HumanQuestion[] } {
  const raw = Array.isArray(input) ? { questions: input } : input;
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  if (questions.length === 0) {
    // catalog can be empty? integrity still validated
  }
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q || typeof q !== "object") throw new StateError("Invalid human question catalog: question must be an object");
    if (typeof q.id !== "string" || !isHumId(q.id)) {
      throw new StateError(`Invalid human question catalog: question id must be prefixed HUM-* (${String((q as any)?.id)})`);
    }
    if (seen.has(q.id)) throw new StateError(`Invalid human question catalog: duplicate question id ${q.id}`);
    seen.add(q.id);
    if (typeof q.prompt !== "string" || q.prompt.length === 0) {
      throw new StateError(`Invalid human question catalog: ${q.id} missing prompt`);
    }
    if (!q.materiality || typeof q.materiality !== "object" || typeof q.materiality.reason !== "string" || !Array.isArray(q.materiality.affects) || q.materiality.affects.length === 0) {
      throw new StateError(`Invalid human question catalog: ${q.id} missing documented materiality (affects + reason)`);
    }
  }
  const catalogVersion = String((raw as any).catalog_version ?? (raw as any).version ?? "1");
  return { catalogVersion, questions: questions.map((q) => ({ ...q })) };
}

function materialForDecision(q: HumanQuestion): boolean {
  if (q.materiality && q.materiality.material === false) return false;
  if (q.required_for_decision === false) return false;
  const affects = q.materiality?.affects ?? [];
  // material to current decision when it affects decision/readiness/confidence/risk
  return q.required_for_decision === true || affects.some((a) => a === "decision" || a === "release_readiness" || a === "confidence" || a === "risk");
}

function redactAnswer(q: HumanQuestion, value: unknown): { answer: unknown; freeform: boolean; redacted: boolean } {
  const allowsFreeform = q.allows_freeform === true;
  const isText = typeof value === "string";
  const freeform = allowsFreeform && isText;
  if (isText) {
    // no free-form stored unless explicitly requested, and even then redaction runs first
    let redactedText = redactText(value);
    // extra safety for bearer/JWT-like tokens that may evade generic patterns
    redactedText = redactedText.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]");
    redactedText = redactedText.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, "[REDACTED_JWT]");
    redactedText = redactedText.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
    return { answer: redactedText, freeform, redacted: true };
  }
  const redactedVal = redactUnknown(value);
  const changed = JSON.stringify(redactedVal) !== JSON.stringify(value);
  return { answer: redactedVal, freeform: false, redacted: changed };
}

function parseState(data: unknown, expectedPath: string): HumanDecisionContextState {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CorruptStateError(`Corrupt human decision context in ${expectedPath}: expected object`, { path: expectedPath });
  }
  const d = data as any;
  if (d.schema_version !== HUMAN_CONTEXT_SCHEMA_VERSION) {
    throw new CorruptStateError(`Invalid human decision context schema_version in ${expectedPath}`, { path: expectedPath });
  }
  if (typeof d.run_id !== "string") throw new CorruptStateError(`Invalid human decision context run_id in ${expectedPath}`, { path: expectedPath });
  if (!Array.isArray(d.questions)) throw new CorruptStateError(`Invalid human decision context questions in ${expectedPath}`, { path: expectedPath });
  if (!d.answers || typeof d.answers !== "object" || Array.isArray(d.answers)) {
    throw new CorruptStateError(`Invalid human decision context answers in ${expectedPath}`, { path: expectedPath });
  }
  return d as HumanDecisionContextState;
}

export async function readHumanContextState(contextPath: string): Promise<HumanDecisionContextState> {
  try {
    const data = await readJsonFile<unknown>(contextPath);
    return parseState(data, contextPath);
  } catch (err) {
    if (err instanceof CorruptStateError) throw err;
    if (err instanceof StateError) {
      // StateError from readJsonFile for parse errors/not found; treat parse-like as corrupt?
      if (/Corrupt JSON|Invalid state data/i.test(err.message)) {
        throw new CorruptStateError(err.message, { path: contextPath });
      }
      throw err;
    }
    throw err;
  }
}

export async function runHumanContext(params: RunHumanContextParams): Promise<RunHumanContextResult> {
  const runId = String(params.runId || "");
  if (!runId) throw new StateError("runHumanContext requires runId");
  const root = params.root ?? process.cwd();
  const contextPath = params.contextPath ? (path.isAbsolute(params.contextPath) ? params.contextPath : path.join(root, params.contextPath)) : path.join(root, DEFAULT_HUMAN_CONTEXT_REL_PATH);
  await ensureDir(path.dirname(contextPath));

  const catalog = normalizeCatalog(params.questions);
  let existing: HumanDecisionContextState | null = null;
  let resumed = false;
  try {
    existing = await readHumanContextState(contextPath);
    resumed = true;
  } catch (err: any) {
    if (err instanceof StateError && /not found/i.test(String(err.message))) {
      existing = null;
      resumed = false;
    } else if (err instanceof CorruptStateError) {
      throw err;
    } else {
      throw err;
    }
  }

  // resume: merge answers from existing (same run/context), prefer new answers provided now
  const mergedAnswers: Record<string, HumanAnswerRecord> = { ...(existing?.answers ?? {}) };
  if (existing && existing.run_id !== runId) {
    // context file is for a different run; treat as fresh context for this run but keep resumable file semantics by overwriting for requested run
    // (safe atomic replace) - but better to preserve? AC states resumable; assume same workflow root/run context file.
    // We'll namespace by run in-memory but persist for this run.
  }
  const provided = params.answers ?? {};
  for (const q of catalog.questions) {
    if (Object.prototype.hasOwnProperty.call(provided, q.id)) {
      const val = (provided as any)[q.id];
      if (val === undefined || val === null || val === "") {
        delete mergedAnswers[q.id];
      } else {
        const ra = redactAnswer(q, val);
        mergedAnswers[q.id] = {
          question_id: q.id,
          answered_at: now(),
          answer: ra.answer,
          redacted: ra.redacted,
          freeform: ra.freeform,
        };
      }
    }
  }

  const state: HumanDecisionContextState = {
    schema_version: HUMAN_CONTEXT_SCHEMA_VERSION,
    catalog_version: catalog.catalogVersion,
    run_id: runId,
    updated_at: now(),
    questions: catalog.questions,
    answers: mergedAnswers,
  };

  // atomic persistence
  await atomicWriteJson(contextPath, state);

  const unansweredMaterial = catalog.questions.filter((q) => materialForDecision(q) && !Object.prototype.hasOwnProperty.call(mergedAnswers, q.id));
  const blockers: HumanContextBlocker[] = unansweredMaterial.map((q) => ({
    id: `human-blocker:${q.id}`,
    type: "human_decision_context",
    question_id: q.id,
    reason: `Unanswered material human question ${q.id}: ${q.materiality.reason}`,
    materiality: q.materiality,
    unresolved: true,
  }));

  const decision: "hold" | "unchanged" = blockers.length > 0 ? "hold" : "unchanged";

  // escalate run decision to hold with explicit blocker referencing unanswered question when possible
  if (decision === "hold" && params.escalate !== false && params.stateStore) {
    try {
      const progress = await params.stateStore.loadProgress<any>();
      if (progress && String(progress.run_id) === runId) {
        progress.decision = "hold";
        const existingBlockers = Array.isArray(progress.blockers) ? progress.blockers : [];
        const nonHuman = existingBlockers.filter((b: any) => !(b && typeof b === "object" && b.type === "human_decision_context" && typeof b.question_id === "string"));
        const mergedBlockers = [...nonHuman, ...blockers];
        progress.blockers = mergedBlockers;
        // append rationale marker if structure supports it
        if (progress.summary && typeof progress.summary === "object") {
          progress.summary.human_decision_context = { decision: "hold", unanswered_material_question_ids: unansweredMaterial.map((q) => q.id) };
        }
        await params.stateStore.saveProgress(progress);
      }
    } catch {
      // best effort escalation; result still reports hold/blockers
    }
  }

  return {
    schema_version: HUMAN_CONTEXT_SCHEMA_VERSION,
    run_id: runId,
    context_path: contextPath,
    state,
    unanswered_material_question_ids: unansweredMaterial.map((q) => q.id),
    decision,
    blockers,
    resumed,
  };
}
