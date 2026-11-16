import path from "node:path";
import { createHash } from "node:crypto";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactUnknown } from "./redaction.js";

export type EvalDesignChecklistItem = {
  reviewed: boolean;
  ok: boolean;
  notes: string;
  [key: string]: unknown;
};

export interface EvalDesignChecklist {
  populations: EvalDesignChecklistItem;
  cases: EvalDesignChecklistItem;
  repetitions: EvalDesignChecklistItem;
  oracles: EvalDesignChecklistItem;
  dependence: EvalDesignChecklistItem;
  blockers: EvalDesignChecklistItem;
  [key: string]: EvalDesignChecklistItem;
}

export interface EvalDesign {
  schema_version: "lemma.confidence.eval_design/v1";
  eval_id: string;
  workspace: string;
  checklist: EvalDesignChecklist;
  status: "approved" | "refused";
  reviewed: boolean;
  recorded_at: string;
  risks: unknown[];
  claims: unknown[];
  refusal: { refused: boolean; reason: string; failed_items: string[] } | null;
  [key: string]: unknown;
}

export interface RunEvalDesignParams {
  workspace: string;
  risks?: unknown[] | null;
  claims?: unknown[] | null;
  evalId?: string;
  checklist?: Partial<Record<keyof EvalDesignChecklist, Partial<EvalDesignChecklistItem>>> | null;
  recordedAt?: string;
}

export interface EvalRunAnalysis {
  per_outcome_counts: Record<string, number>;
  per_case_transitions: Array<{ id: string; from: string | null; to: string; blocked: boolean }>;
  blocked_cases: string[];
  statistical_significance_claimed: false;
  note: string;
}

export interface EvalRunResult {
  schema_version: "lemma.confidence.eval_run/v1";
  eval_id: string;
  workspace: string;
  design_reviewed: boolean;
  status: "completed" | "refused";
  model_eval: Record<string, unknown> | null;
  analysis: EvalRunAnalysis | null;
  recorded_at: string;
  paths: {
    eval_dir: string;
    design_path: string;
    run_path: string;
    model_eval_path?: string;
  };
  refusal?: { refused: boolean; reason: string; design_path: string } | null;
  [key: string]: unknown;
}

export interface RunEvalExecuteParams {
  design: EvalDesign | string;
  modelConfig?: Record<string, unknown> | null;
  recordedAt?: string;
  /** Injectable for tests/wiring proof; defaults to LEM-163 runModelEval from @lemma/pro. */
  runModelEval?: (options: any) => Promise<any>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableId(seed: string): string {
  return "eval-" + createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function defaultChecklist(): EvalDesignChecklist {
  const item = (): EvalDesignChecklistItem => ({ reviewed: true, ok: true, notes: "documented" });
  return {
    populations: item(),
    cases: item(),
    repetitions: item(),
    oracles: item(),
    dependence: item(),
    blockers: item(),
  };
}

function normalizeChecklist(input: RunEvalDesignParams["checklist"]): EvalDesignChecklist {
  const base = defaultChecklist();
  if (!isRecord(input)) return base;
  const out = { ...base } as EvalDesignChecklist;
  for (const key of Object.keys(base) as Array<keyof EvalDesignChecklist>) {
    const raw = (input as any)[key];
    if (isRecord(raw)) {
      out[key] = {
        reviewed: raw.reviewed === true,
        ok: raw.ok === true,
        notes: typeof raw.notes === "string" ? raw.notes : String(raw.notes ?? ""),
      };
    }
  }
  return out;
}

function checklistFailures(checklist: EvalDesignChecklist): string[] {
  const failed: string[] = [];
  for (const [k, v] of Object.entries(checklist)) {
    if (!v || v.reviewed !== true || v.ok !== true) failed.push(k);
  }
  return failed.sort();
}

export function validateEvalDesign(design: EvalDesign): void {
  if (design.schema_version !== "lemma.confidence.eval_design/v1") throw new StateError("Invalid eval design schema_version");
  if (!design.eval_id) throw new StateError("Invalid eval design eval_id");
  if (!design.checklist) throw new StateError("Invalid eval design checklist");
  const required = ["populations", "cases", "repetitions", "oracles", "dependence", "blockers"];
  for (const k of required) {
    const item = (design.checklist as any)[k];
    if (!item || typeof item.reviewed !== "boolean" || typeof item.ok !== "boolean" || typeof item.notes !== "string") {
      throw new StateError(`Invalid eval design checklist item: ${k}`);
    }
  }
  if (design.status !== "approved" && design.status !== "refused") throw new StateError("Invalid eval design status");
}

export function validateEvalRun(run: EvalRunResult): void {
  if (run.schema_version !== "lemma.confidence.eval_run/v1") throw new StateError("Invalid eval run schema_version");
  if (!run.eval_id) throw new StateError("Invalid eval run eval_id");
  if (run.status === "completed") {
    if (!run.analysis) throw new StateError("Completed eval run missing analysis");
    if (run.analysis.statistical_significance_claimed !== false) throw new StateError("Eval run must not claim statistical significance without LEM-185 review");
  }
}

export async function runEvalDesign(params: RunEvalDesignParams): Promise<EvalDesign> {
  const workspace = path.resolve(params.workspace || "");
  if (!workspace) throw new StateError("runEvalDesign requires workspace");
  const risks = Array.isArray(params.risks) ? params.risks : [];
  const claims = Array.isArray(params.claims) ? params.claims : [];
  const checklist = normalizeChecklist(params.checklist ?? null);
  const failed = checklistFailures(checklist);
  const status: EvalDesign["status"] = failed.length === 0 ? "approved" : "refused";
  const recorded_at = params.recordedAt ?? new Date(0).toISOString();
  const evalId = params.evalId || stableId(JSON.stringify({ workspace, risks: risks.length, claims: claims.length, checklist, recorded_at }));

  const design: EvalDesign = {
    schema_version: "lemma.confidence.eval_design/v1",
    eval_id: evalId,
    workspace,
    checklist,
    status,
    reviewed: true,
    recorded_at,
    risks: redactUnknown(risks) as unknown[],
    claims: redactUnknown(claims) as unknown[],
    refusal: failed.length ? { refused: true, reason: `Design review failed checklist: ${failed.join(", ")}`, failed_items: failed } : null,
  };
  validateEvalDesign(design);

  // persist documented checklist/design in workspace under .confidence/evals/<eval_id>/ (atomic)
  const evalDir = path.join(workspace, "evals", evalId);
  await ensureDir(evalDir);
  await atomicWriteJson(path.join(evalDir, "design.json"), redactUnknown(design));
  // also persist checklist document explicitly
  await atomicWriteJson(path.join(evalDir, "design-checklist.json"), redactUnknown({ eval_id: evalId, checklist, status, refusal: design.refusal, recorded_at }));
  validateEvalDesign(design);
  return design;
}

function analyzeModelEval(modelEval: any): EvalRunAnalysis {
  const cases = Array.isArray(modelEval?.cases) ? modelEval.cases : [];
  const per_outcome_counts: Record<string, number> = {};
  const per_case_transitions: Array<{ id: string; from: string | null; to: string; blocked: boolean }> = [];
  const blocked_cases: string[] = [];
  for (const c of cases) {
    const id = String(c?.id || "");
    const to = String(c?.outcome || "UNEVALUATED");
    const from = c?.baseline_outcome != null ? String(c.baseline_outcome) : null;
    const blocked = to === "UNEVALUATED" || /block|no endpoint/i.test(String(c?.note || ""));
    per_outcome_counts[to] = (per_outcome_counts[to] || 0) + 1;
    per_case_transitions.push({ id, from, to, blocked });
    if (blocked) blocked_cases.push(id);
  }
  // also include summary counts if present
  if (isRecord(modelEval?.summary)) {
    for (const [k, v] of Object.entries(modelEval.summary)) {
      if (typeof v === "number") per_outcome_counts[k] = Math.max(per_outcome_counts[k] || 0, v);
    }
  }
  return {
    per_outcome_counts,
    per_case_transitions,
    blocked_cases: Array.from(new Set(blocked_cases)).filter(Boolean),
    statistical_significance_claimed: false,
    note: "Descriptive analysis only. No statistical significance is claimed without LEM-185 statistical review.",
  };
}

async function loadDesign(design: EvalDesign | string): Promise<EvalDesign> {
  if (typeof design === "string") {
    const data = await readJsonFile<any>(design);
    validateEvalDesign(data as EvalDesign);
    return data as EvalDesign;
  }
  validateEvalDesign(design);
  return design;
}

export async function runEvalExecute(params: RunEvalExecuteParams): Promise<EvalRunResult> {
  const design = await loadDesign(params.design);
  const workspace = path.resolve(design.workspace);
  const evalId = design.eval_id;
  const evalDir = path.join(workspace, "evals", evalId);
  await ensureDir(evalDir);
  const recorded_at = params.recordedAt ?? new Date(0).toISOString();
  const runPath = path.join(evalDir, "run.json");

  // refuse to execute a run whose design fails review; refusal recorded, not silently skipped
  if (design.status !== "approved" || design.reviewed !== true) {
    const refusal = { refused: true, reason: design.refusal?.reason || "Design review failed; execution refused.", design_path: path.posix.join(".confidence", "evals", evalId, "design.json") };
    const run: EvalRunResult = {
      schema_version: "lemma.confidence.eval_run/v1",
      eval_id: evalId,
      workspace,
      design_reviewed: true,
      status: "refused",
      model_eval: null,
      analysis: null,
      recorded_at,
      paths: { eval_dir: path.posix.join(".confidence", "evals", evalId), design_path: refusal.design_path, run_path: path.posix.join(".confidence", "evals", evalId, "run.json") },
      refusal,
    };
    await atomicWriteJson(path.join(evalDir, "refusal.json"), redactUnknown(refusal));
    await atomicWriteJson(runPath, redactUnknown(run));
    validateEvalRun(run);
    return run;
  }

  const runner = params.runModelEval || (async (opts: any) => {
    const mod = await import("@lemma/pro");
    if (!mod || typeof (mod as any).runModelEval !== "function") {
      throw new StateError("LEM-163 runModelEval is not available");
    }
    return await (mod as any).runModelEval(opts);
  });

  const modelEval = await runner({
    projectRoot: workspace,
    modelConfig: params.modelConfig ?? undefined,
    runId: evalId,
  });

  const modelEvalObj = isRecord(modelEval) ? (modelEval as Record<string, unknown>) : { result: modelEval };
  const modelEvalPath = path.join(evalDir, "model-eval.json");
  await atomicWriteJson(modelEvalPath, redactUnknown(modelEvalObj));

  const analysis = analyzeModelEval(modelEvalObj);
  const run: EvalRunResult = {
    schema_version: "lemma.confidence.eval_run/v1",
    eval_id: evalId,
    workspace,
    design_reviewed: true,
    status: "completed",
    model_eval: redactUnknown(modelEvalObj) as Record<string, unknown>,
    analysis,
    recorded_at,
    paths: {
      eval_dir: path.posix.join(".confidence", "evals", evalId),
      design_path: path.posix.join(".confidence", "evals", evalId, "design.json"),
      run_path: path.posix.join(".confidence", "evals", evalId, "run.json"),
      model_eval_path: path.posix.join(".confidence", "evals", evalId, "model-eval.json"),
    },
  };
  await atomicWriteJson(runPath, redactUnknown(run));
  await atomicWriteJson(path.join(evalDir, "analysis.json"), redactUnknown(analysis));
  validateEvalRun(run);
  return run;
}
