import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  StateError,
  atomicWriteJson,
  ensureDir,
  makeDeterminism,
  now as coreNow,
  readJsonFile,
  redactUnknown,
  setDeterminism,
  resetDeterminism,
  type ClockMode,
} from "@lemma/core";

import { requireProLicense, type ProLicenseContext } from "./entitlement.js";

export const MODEL_EVAL_SCHEMA_VERSION = "lemma.pro.model_eval_result/v1" as const;

export type ModelEvalOutcome =
  | "PASS"
  | "FAIL"
  | "REGRESSION"
  | "IMPROVEMENT"
  | "UNCHANGED"
  | "UNEVALUATED";

export interface ModelEvalCase {
  id: string;
  description?: string;
  input?: unknown;
  expected_business_behavior?: string;
  reviewed: boolean;
  [key: string]: unknown;
}

export interface ModelEndpointResponse {
  output: unknown;
  pass?: boolean;
  rationale?: string;
  raw?: unknown;
}

export interface ModelEndpoint {
  /** Execute the case against the model and/or judge; return output and pass/fail judgement. */
  invoke(input: { case: ModelEvalCase; seed?: number | null; deterministic?: boolean }): Promise<ModelEndpointResponse> | ModelEndpointResponse;
}

export interface ModelEvalConfig {
  /** If omitted/unconfigured, all cases become UNEVALUATED with "no endpoint configured" note. */
  endpoint?: ModelEndpoint | null;
  /** Stub endpoint marker for tests/determinism. */
  stub?: boolean;
  /** Recorded baseline outcomes by case id: "PASS" | "FAIL" (or previous outcome). */
  baselineOutcomes?: Record<string, "PASS" | "FAIL" | "UNEVALUATED">;
  /** Optional path to persist/read baseline outcomes. */
  baselinePath?: string;
  /** Case loading root or glob directory (defaults to evals/cases). */
  casesDir?: string;
  [key: string]: unknown;
}

export interface ModelEvalClock {
  mode?: ClockMode;
  frozen?: string;
  now?: () => string;
}

export interface RunModelEvalOptions {
  cases?: ModelEvalCase[] | string | string[] | null;
  modelConfig?: ModelEvalConfig | null;
  seed?: number | null;
  clock?: ModelEvalClock | string | null;
  license?: ProLicenseContext | null;
  projectRoot?: string;
  runId?: string;
  /** Deterministic timestamp for evidence/result (uses frozen clock if provided). */
  now?: () => string;
}

export interface ModelEvalCaseResult {
  id: string;
  description?: string | null;
  outcome: ModelEvalOutcome;
  reviewed: boolean;
  note: string;
  fingerprint: string;
  evidence_path: string;
  judge_rationale?: string | null;
  baseline_outcome?: string | null;
}

export interface ModelEvalResult {
  schema_version: typeof MODEL_EVAL_SCHEMA_VERSION;
  run_id: string;
  generated_at: string;
  determinism: { seed: number | null; clock_mode: string; entropy: string };
  endpoint_configured: boolean;
  notes: string[];
  cases: ModelEvalCaseResult[];
  summary: {
    PASS: number;
    FAIL: number;
    REGRESSION: number;
    IMPROVEMENT: number;
    UNCHANGED: number;
    UNEVALUATED: number;
    total: number;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ":" + stableJson((value as any)[k])).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function walkJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkJsonFiles(full));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function normalizeCase(raw: unknown): ModelEvalCase | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  return {
    id,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...( "input" in raw ? { input: raw.input } : {}),
    ...(typeof raw.expected_business_behavior === "string" ? { expected_business_behavior: raw.expected_business_behavior } : {}),
    reviewed: raw.reviewed === true,
    ...Object.fromEntries(Object.entries(raw).filter(([k]) => !["id","description","input","expected_business_behavior","reviewed"].includes(k))),
  };
}

export async function loadEvalCases(casesInput: RunModelEvalOptions["cases"], projectRoot: string, modelConfig?: ModelEvalConfig | null): Promise<ModelEvalCase[]> {
  // explicit cases array
  if (Array.isArray(casesInput) && casesInput.every((c) => isRecord(c) && ("id" in c))) {
    return (casesInput as unknown[]).map(normalizeCase).filter((c): c is ModelEvalCase => !!c);
  }

  const dirs: string[] = [];
  if (typeof casesInput === "string") dirs.push(path.isAbsolute(casesInput) ? casesInput : path.join(projectRoot, casesInput));
  else if (Array.isArray(casesInput) && casesInput.every((c) => typeof c === "string")) {
    for (const c of casesInput as string[]) dirs.push(path.isAbsolute(c) ? c : path.join(projectRoot, c));
  } else {
    const base = modelConfig?.casesDir ? (path.isAbsolute(modelConfig.casesDir) ? modelConfig.casesDir : path.join(projectRoot, modelConfig.casesDir)) : path.join(projectRoot, "evals", "cases");
    dirs.push(base);
  }

  const files: string[] = [];
  for (const d of dirs) {
    try {
      const st = await fs.stat(d);
      if (st.isFile() && d.endsWith(".json")) files.push(d);
      else if (st.isDirectory()) files.push(...await walkJsonFiles(d));
    } catch {
      // ignore missing dirs/files
    }
  }
  files.sort();
  const cases: ModelEvalCase[] = [];
  for (const f of files) {
    try {
      const data = await readJsonFile<unknown>(f);
      if (Array.isArray(data)) {
        for (const item of data) { const c = normalizeCase(item); if (c) cases.push(c); }
      } else {
        const c = normalizeCase(data);
        if (c) cases.push(c);
      }
    } catch {
      // skip unreadable case files
    }
  }
  // stable order by id then path-origin order already sorted by file; ensure deterministic
  cases.sort((a, b) => a.id.localeCompare(b.id));
  return cases;
}

async function readBaseline(projectRoot: string, modelConfig: ModelEvalConfig | null | undefined): Promise<Record<string, "PASS" | "FAIL" | "UNEVALUATED">> {
  if (modelConfig?.baselineOutcomes && isRecord(modelConfig.baselineOutcomes)) {
    const out: Record<string, "PASS" | "FAIL" | "UNEVALUATED"> = {};
    for (const [k, v] of Object.entries(modelConfig.baselineOutcomes)) {
      if (v === "PASS" || v === "FAIL" || v === "UNEVALUATED") out[k] = v;
    }
    return out;
  }
  const p = modelConfig?.baselinePath
    ? (path.isAbsolute(modelConfig.baselinePath) ? modelConfig.baselinePath : path.join(projectRoot, modelConfig.baselinePath))
    : path.join(projectRoot, ".lemma", "pro", "model-eval-baseline.json");
  try {
    const data = await readJsonFile<any>(p);
    const src = isRecord(data) ? (isRecord(data.outcomes) ? data.outcomes : data) : {};
    const out: Record<string, "PASS" | "FAIL" | "UNEVALUATED"> = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === "PASS" || v === "FAIL" || v === "UNEVALUATED") out[k] = v as any;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveClockNow(opts: RunModelEvalOptions): { generatedAt: string; determinism: { seed: number | null; clock_mode: string; entropy: string } } {
  const seed = typeof opts.seed === "number" ? opts.seed : null;
  let clockMode: ClockMode = "real";
  let frozen: string | undefined;
  if (typeof opts.clock === "string") {
    clockMode = "frozen";
    frozen = opts.clock;
  } else if (isRecord(opts.clock)) {
    clockMode = (opts.clock.mode === "frozen" ? "frozen" : "real");
    if (typeof opts.clock.frozen === "string") { frozen = opts.clock.frozen; clockMode = "frozen"; }
  }
  if (clockMode === "frozen" && frozen) {
    const det = makeDeterminism({ seed, clockMode: "frozen", frozenClock: frozen });
    return { generatedAt: det.now(), determinism: det.toJSON() };
  }
  // if explicit now provided, treat as deterministic timestamp
  if (typeof opts.now === "function") {
    return { generatedAt: opts.now(), determinism: { seed, clock_mode: "real", entropy: seed === null ? "real" : "seeded" } };
  }
  return { generatedAt: coreNow() as string, determinism: { seed, clock_mode: "real", entropy: seed === null ? "real" : "seeded" } };
}

function endpointConfigured(modelConfig: ModelEvalConfig | null | undefined): boolean {
  if (!modelConfig) return false;
  if (modelConfig.endpoint && typeof (modelConfig.endpoint as any).invoke === "function") return true;
  if (modelConfig.stub === true) return true;
  // any explicit configured marker
  if (isRecord(modelConfig) && (modelConfig as any).configured === true) return true;
  return false;
}

function deriveOutcome(pass: boolean | undefined, baseline: "PASS" | "FAIL" | "UNEVALUATED" | undefined): ModelEvalOutcome {
  const current: "PASS" | "FAIL" = pass ? "PASS" : "FAIL";
  if (!baseline || baseline === "UNEVALUATED") return current;
  if (baseline === "PASS" && current === "FAIL") return "REGRESSION";
  if (baseline === "FAIL" && current === "PASS") return "IMPROVEMENT";
  if (baseline === current) return "UNCHANGED";
  return current;
}

export function validateModelEvalResult(value: unknown): ModelEvalResult {
  if (!isRecord(value)) throw new StateError("Invalid model eval result: expected object");
  if (value.schema_version !== MODEL_EVAL_SCHEMA_VERSION) throw new StateError("Invalid model eval result schema_version", { details: { schema_version: value.schema_version } });
  if (typeof value.run_id !== "string" || !value.run_id) throw new StateError("Invalid model eval result: run_id required");
  if (typeof value.generated_at !== "string" || !value.generated_at) throw new StateError("Invalid model eval result: generated_at required");
  const det = isRecord(value.determinism) ? value.determinism : {};
  const cases = Array.isArray(value.cases) ? value.cases.filter(isRecord) : [];
  const summaryIn = isRecord(value.summary) ? value.summary : {};
  const summary = {
    PASS: Math.max(0, Math.floor(Number(summaryIn.PASS ?? 0) || 0)),
    FAIL: Math.max(0, Math.floor(Number(summaryIn.FAIL ?? 0) || 0)),
    REGRESSION: Math.max(0, Math.floor(Number(summaryIn.REGRESSION ?? 0) || 0)),
    IMPROVEMENT: Math.max(0, Math.floor(Number(summaryIn.IMPROVEMENT ?? 0) || 0)),
    UNCHANGED: Math.max(0, Math.floor(Number(summaryIn.UNCHANGED ?? 0) || 0)),
    UNEVALUATED: Math.max(0, Math.floor(Number(summaryIn.UNEVALUATED ?? 0) || 0)),
    total: Math.max(0, Math.floor(Number(summaryIn.total ?? cases.length) || cases.length)),
  };
  return {
    schema_version: MODEL_EVAL_SCHEMA_VERSION,
    run_id: value.run_id,
    generated_at: value.generated_at,
    determinism: {
      seed: typeof det.seed === "number" ? det.seed : null,
      clock_mode: typeof det.clock_mode === "string" ? det.clock_mode : "real",
      entropy: typeof det.entropy === "string" ? det.entropy : "real",
    },
    endpoint_configured: value.endpoint_configured === true,
    notes: Array.isArray(value.notes) ? value.notes.filter((n): n is string => typeof n === "string") : [],
    cases: cases.map((c) => ({
      id: String(c.id ?? ""),
      ...(typeof c.description === "string" ? { description: c.description } : c.description === null ? { description: null } : {}),
      outcome: (String(c.outcome) as ModelEvalOutcome) || "UNEVALUATED",
      reviewed: c.reviewed === true,
      note: String(c.note ?? ""),
      fingerprint: String(c.fingerprint ?? ""),
      evidence_path: String(c.evidence_path ?? ""),
      ...(typeof c.judge_rationale === "string" ? { judge_rationale: c.judge_rationale } : c.judge_rationale === null ? { judge_rationale: null } : {}),
      ...(typeof c.baseline_outcome === "string" ? { baseline_outcome: c.baseline_outcome } : c.baseline_outcome === null ? { baseline_outcome: null } : {}),
    })),
    summary,
  };
}

export async function runModelEval(options: RunModelEvalOptions): Promise<ModelEvalResult> {
  requireProLicense(options.license ?? null, "AI model evaluation");

  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const modelConfig = options.modelConfig ?? null;
  const configured = endpointConfigured(modelConfig);
  const { generatedAt, determinism } = resolveClockNow(options);
  const runId = options.runId ?? `eval_${sha256(stableJson({ seed: options.seed ?? null, generatedAt, cases: options.cases ?? "default" })).slice(0, 16)}`;

  const cases = await loadEvalCases(options.cases ?? null, projectRoot, modelConfig);
  const baseline = await readBaseline(projectRoot, modelConfig);
  const notes: string[] = [];
  if (!configured) notes.push("no endpoint configured");

  const results: ModelEvalCaseResult[] = [];
  const counts: Record<ModelEvalOutcome, number> = { PASS: 0, FAIL: 0, REGRESSION: 0, IMPROVEMENT: 0, UNCHANGED: 0, UNEVALUATED: 0 };

  // Determinism context for seeded/stub behavior
  let prevDet: any = null;
  let detActive = false;
  try {
    if (determinism.clock_mode === "frozen" || determinism.seed !== null) {
      const det = makeDeterminism({
        seed: determinism.seed,
        clockMode: determinism.clock_mode as any,
        ...(determinism.clock_mode === "frozen" ? { frozenClock: generatedAt } : {}),
      } as any);
      prevDet = setDeterminism(det);
      detActive = true;
    }

    for (const c of cases) {
      const caseDir = path.join(projectRoot, ".lemma", "evidence", runId, "eval", c.id.replace(/[^a-zA-Z0-9._-]/g, "_"));
      await ensureDir(caseDir);
      const evidenceRel = path.relative(projectRoot, path.join(caseDir, "evidence.json")).replace(/\\/g, "/");

      if (c.reviewed !== true) {
        const note = "skipped: case not reviewed (reviewed=false)";
        const fingerprint = sha256(stableJson({ case_id: c.id, outcome: "UNEVALUATED", reason: "unreviewed" }));
        const record = {
          schema_version: "lemma.pro.model_eval_case/v1",
          run_id: runId,
          generated_at: generatedAt,
          case_id: c.id,
          reviewed: false,
          outcome: "UNEVALUATED" as ModelEvalOutcome,
          note,
          fingerprint,
          raw_model_response: null,
          judge_rationale: null,
        };
        const redacted = redactUnknown(record);
        await atomicWriteJson(path.join(caseDir, "evidence.json"), redacted);
        results.push({ id: c.id, ...(c.description ? { description: c.description } : { description: null }), outcome: "UNEVALUATED", reviewed: false, note, fingerprint, evidence_path: evidenceRel, judge_rationale: null, ...(baseline[c.id] ? { baseline_outcome: baseline[c.id] } : {}) });
        counts.UNEVALUATED += 1;
        continue;
      }

      if (!configured) {
        const note = "no endpoint configured";
        const fingerprint = sha256(stableJson({ case_id: c.id, outcome: "UNEVALUATED", reason: "no_endpoint", seed: determinism.seed }));
        const record = {
          schema_version: "lemma.pro.model_eval_case/v1",
          run_id: runId,
          generated_at: generatedAt,
          case_id: c.id,
          reviewed: true,
          outcome: "UNEVALUATED" as ModelEvalOutcome,
          note,
          fingerprint,
          raw_model_response: null,
          judge_rationale: "no endpoint configured",
        };
        const redacted = redactUnknown(record);
        await atomicWriteJson(path.join(caseDir, "evidence.json"), redacted);
        results.push({ id: c.id, ...(c.description ? { description: c.description } : { description: null }), outcome: "UNEVALUATED", reviewed: true, note, fingerprint, evidence_path: evidenceRel, judge_rationale: "no endpoint configured", ...(baseline[c.id] ? { baseline_outcome: baseline[c.id] } : {}) });
        counts.UNEVALUATED += 1;
        continue;
      }

      let response: ModelEndpointResponse;
      try {
        const ep = modelConfig!.endpoint!;
        response = await (ep as any).invoke({ case: c, seed: determinism.seed, deterministic: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const note = `endpoint unavailable: ${msg}`;
        const fingerprint = sha256(stableJson({ case_id: c.id, outcome: "UNEVALUATED", reason: "endpoint_error", seed: determinism.seed }));
        const record = {
          schema_version: "lemma.pro.model_eval_case/v1",
          run_id: runId,
          generated_at: generatedAt,
          case_id: c.id,
          reviewed: true,
          outcome: "UNEVALUATED" as ModelEvalOutcome,
          note,
          fingerprint,
          raw_model_response: null,
          judge_rationale: note,
        };
        await atomicWriteJson(path.join(caseDir, "evidence.json"), redactUnknown(record));
        results.push({ id: c.id, ...(c.description ? { description: c.description } : { description: null }), outcome: "UNEVALUATED", reviewed: true, note, fingerprint, evidence_path: evidenceRel, judge_rationale: note, ...(baseline[c.id] ? { baseline_outcome: baseline[c.id] } : {}) });
        counts.UNEVALUATED += 1;
        continue;
      }

      const rawResponse = response.raw ?? response.output;
      const rationale = typeof response.rationale === "string" ? response.rationale : (typeof (response as any).judge_output === "string" ? (response as any).judge_output : null);
      const pass = typeof response.pass === "boolean" ? response.pass : undefined;
      const base = baseline[c.id];
      const outcome = deriveOutcome(pass, base);
      const note = outcome === "REGRESSION"
        ? "regression: previously PASS, now FAIL"
        : outcome === "IMPROVEMENT"
          ? "improvement: previously FAIL, now PASS"
          : outcome === "UNCHANGED"
            ? `unchanged: ${base}`
            : outcome;

      // Stable fingerprint of case + response pair (deterministic fields)
      const fingerprint = sha256(stableJson({ case_id: c.id, input: c.input ?? null, expected: c.expected_business_behavior ?? null, response: rawResponse ?? null, judge_rationale: rationale ?? null, pass: pass ?? null }));

      const record = {
        schema_version: "lemma.pro.model_eval_case/v1",
        run_id: runId,
        generated_at: generatedAt,
        case_id: c.id,
        description: c.description ?? null,
        input: c.input ?? null,
        expected_business_behavior: c.expected_business_behavior ?? null,
        reviewed: true,
        raw_model_response: rawResponse ?? null,
        judge_rationale: rationale,
        judge_output: rationale,
        outcome,
        baseline_outcome: base ?? null,
        note,
        fingerprint,
      };
      await atomicWriteJson(path.join(caseDir, "evidence.json"), redactUnknown(record));
      results.push({ id: c.id, ...(c.description ? { description: c.description } : { description: null }), outcome, reviewed: true, note, fingerprint, evidence_path: evidenceRel, ...(rationale ? { judge_rationale: rationale } : { judge_rationale: null }), ...(base ? { baseline_outcome: base } : {}) });
      counts[outcome] += 1;
    }
  } finally {
    if (detActive) resetDeterminism(prevDet);
  }

  // deterministic order
  results.sort((a, b) => a.id.localeCompare(b.id));
  const summary = { ...counts, total: results.length };
  const result = validateModelEvalResult({
    schema_version: MODEL_EVAL_SCHEMA_VERSION,
    run_id: runId,
    generated_at: generatedAt,
    determinism,
    endpoint_configured: configured,
    notes,
    cases: results,
    summary,
  });

  // persist run-level result for convenience
  try {
    const outPath = path.join(projectRoot, ".lemma", "evidence", runId, "eval", "result.json");
    await ensureDir(path.dirname(outPath));
    await atomicWriteJson(outPath, result);
  } catch {
    // best effort
  }

  return result;
}
