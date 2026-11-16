import { createHash } from "node:crypto";
import path from "node:path";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir } from "./state.js";
import { now } from "./determinism.js";
import type { ScenarioPlan, StepAction } from "./steps.js";

export type GenerateSource = "code" | "page" | "requirements" | "recording" | "custom";

export interface GenerateScope {
  /** Target URL/page for page/recording-derived intents. */
  url?: string;
  /** Source text or path hint (code/requirements/custom). */
  input?: string;
  /** Optional feature/area label. */
  feature?: string;
  /** Optional explicit items (e.g. parsed requirements/steps) for deterministic generation. */
  items?: string[];
  [key: string]: unknown;
}

export interface RunGenerateParams {
  source: GenerateSource;
  scope?: GenerateScope | string | null;
  maxTests?: number;
  root?: string;
  seed?: string | number;
  /** Optional deterministic override for source content in tests. */
  content?: string | string[] | Record<string, unknown>;
}

export interface GeneratedTestIntent {
  id: string;
  title: string;
  source: GenerateSource;
  priority: number; // lower = higher priority (highest-value first)
  priority_reason: string;
  reviewed: false;
  scenario: ScenarioPlan; // browser.steps-compatible
  path: string; // relative path under project root
}

export interface GenerateResult {
  schema_version: "lemma.generate_result/v1";
  source: GenerateSource;
  generated_at: string;
  deterministic: { seed: string; priority_rule: string };
  output_dir: string;
  generated: GeneratedTestIntent[];
  not_generated: Array<{ id: string; title: string; priority: number; reason: string }>;
  counts: { requested_max: number; generated: number; not_generated: number };
}

const PRIORITY_RULE = "priority ascending (1 = highest value). Ordered by source-specific criticality: primary user path/reachability > core interaction correctness > validation/state > edge/secondary behavior.";

function hashSeed(source: GenerateSource, scope: unknown, seed?: string | number): string {
  const h = createHash("sha256");
  h.update(String(seed ?? "0"));
  h.update("|");
  h.update(source);
  h.update("|");
  h.update(typeof scope === "string" ? scope : JSON.stringify(scope ?? {}));
  return h.digest("hex").slice(0, 16);
}

function normalizeScope(scope?: GenerateScope | string | null): GenerateScope {
  if (!scope) return {};
  if (typeof scope === "string") return { input: scope };
  return { ...scope };
}

function slug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "test";
}

function step(n: number, name: string, action: string, target = "", value = ""): StepAction {
  return { step_number: n, name, action, target, value, options: {}, raw_instruction: name };
}

function validateScenario(plan: ScenarioPlan): boolean {
  if (!plan || typeof plan !== "object") return false;
  if (typeof plan.title !== "string" || !plan.title) return false;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return false;
  for (const s of plan.steps) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.step_number !== "number" || typeof s.name !== "string" || typeof s.action !== "string") return false;
    if (typeof s.target !== "string" || typeof s.value !== "string") return false;
  }
  return typeof plan.source === "string" && typeof plan.target_url === "string";
}

function baseUrlFromScope(scope: GenerateScope): string {
  const url = scope.url || (typeof scope.input === "string" && /^https?:\/\//i.test(scope.input) ? scope.input : "");
  return url || "http://localhost";
}

function pageIntents(scope: GenerateScope): Array<Omit<GeneratedTestIntent, "path">> {
  const url = baseUrlFromScope(scope);
  return [
    { id: "page-load", title: "Primary page loads successfully", source: "page", priority: 1, priority_reason: "Reachability and primary render are highest-value.", reviewed: false, scenario: { title: "Primary page loads successfully", steps: [step(1, "Navigate to page", "goto", url), step(2, "Verify page content visible", "assert_visible", "body"), step(3, "Confirm no client errors", "assert_no_errors")], source: "explicit", model: "", target_url: url } },
    { id: "page-content", title: "Primary content and heading are visible", source: "page", priority: 2, priority_reason: "Core content correctness.", reviewed: false, scenario: { title: "Primary content and heading are visible", steps: [step(1, "Navigate to page", "goto", url), step(2, "Verify main content text", "assert_text", "", "main")], source: "explicit", model: "", target_url: url } },
    { id: "page-navigation", title: "Primary navigation interaction works", source: "page", priority: 3, priority_reason: "Core interaction path.", reviewed: false, scenario: { title: "Primary navigation interaction works", steps: [step(1, "Navigate to page", "goto", url), step(2, "Click primary navigation link", "click", "Home"), step(3, "Verify destination visible", "assert_visible", "body")], source: "explicit", model: "", target_url: url } },
  ];
}

function requirementsIntents(scope: GenerateScope): Array<Omit<GeneratedTestIntent, "path">> {
  const url = baseUrlFromScope(scope);
  const items = Array.isArray(scope.items) && scope.items.length ? scope.items : (typeof scope.input === "string" ? scope.input.split(/\n+/).map(s => s.trim()).filter(Boolean) : []);
  const reqs = items.length ? items.slice(0, 20) : ["User can access the primary flow"];
  return reqs.map((r, i) => ({
    id: `req-${i + 1}`,
    title: `Requirement: ${r.slice(0, 60)}`,
    source: "requirements" as const,
    priority: i + 1,
    priority_reason: "Requirements ordered by provided sequence/value.",
    reviewed: false as const,
    scenario: {
      title: `Requirement: ${r.slice(0, 60)}`,
      steps: [step(1, "Navigate to target", "goto", url), step(2, `Verify requirement behavior: ${r.slice(0, 40)}`, "assert_text", "", r.slice(0, 80))],
      source: "explicit", model: "", target_url: url,
    },
  }));
}

function recordingIntents(scope: GenerateScope): Array<Omit<GeneratedTestIntent, "path">> {
  const url = baseUrlFromScope(scope);
  const items = Array.isArray(scope.items) && scope.items.length ? scope.items : ["Open page", "Perform primary action"];
  const steps: StepAction[] = [step(1, "Navigate to recorded start", "goto", url)];
  items.forEach((it, idx) => steps.push(step(idx + 2, it.slice(0, 60), /click/i.test(it) ? "click" : /type|fill|enter/i.test(it) ? "fill" : "assert_visible", it.slice(0, 40))));
  if (steps.length === 1) steps.push(step(2, "Perform recorded action", "click", "button"));
  return [{
    id: "recording-flow",
    title: "Recorded user flow replay",
    source: "recording",
    priority: 1,
    priority_reason: "Recorded primary flow is highest-value regression intent.",
    reviewed: false,
    scenario: { title: "Recorded user flow replay", steps, source: "explicit", model: "", target_url: url },
  }];
}

function codeIntents(scope: GenerateScope): Array<Omit<GeneratedTestIntent, "path">> {
  const url = baseUrlFromScope(scope);
  const feature = scope.feature || "feature";
  return [
    { id: "code-happy-path", title: `${feature}: happy path`, source: "code", priority: 1, priority_reason: "Primary successful path.", reviewed: false, scenario: { title: `${feature}: happy path`, steps: [step(1, "Navigate to feature", "goto", url), step(2, "Exercise primary action", "click", feature), step(3, "Verify success state", "assert_text", "", "success")], source: "explicit", model: "", target_url: url } },
    { id: "code-validation", title: `${feature}: validation handling`, source: "code", priority: 2, priority_reason: "Input validation/state correctness.", reviewed: false, scenario: { title: `${feature}: validation handling`, steps: [step(1, "Navigate to feature", "goto", url), step(2, "Submit invalid input", "fill", "input", ""), step(3, "Verify validation feedback", "assert_visible", "error")], source: "explicit", model: "", target_url: url } },
    { id: "code-edge", title: `${feature}: edge behavior`, source: "code", priority: 3, priority_reason: "Secondary/edge behavior.", reviewed: false, scenario: { title: `${feature}: edge behavior`, steps: [step(1, "Navigate to feature", "goto", url), step(2, "Exercise edge condition", "click", "secondary"), step(3, "Verify stable state", "assert_no_errors")], source: "explicit", model: "", target_url: url } },
  ];
}

function customIntents(scope: GenerateScope): Array<Omit<GeneratedTestIntent, "path">> {
  const url = baseUrlFromScope(scope);
  const items = Array.isArray(scope.items) && scope.items.length ? scope.items : ["Custom scenario intent"];
  return items.map((it, i) => ({
    id: `custom-${i + 1}`,
    title: it.slice(0, 80),
    source: "custom" as const,
    priority: i + 1,
    priority_reason: "Custom intents ordered by provided sequence.",
    reviewed: false as const,
    scenario: { title: it.slice(0, 80), steps: [step(1, "Navigate to target", "goto", url), step(2, it.slice(0, 60), "assert_visible", "body")], source: "explicit", model: "", target_url: url },
  }));
}

function generateBySource(source: GenerateSource, scope: GenerateScope): Array<Omit<GeneratedTestIntent, "path">> {
  switch (source) {
    case "page": return pageIntents(scope);
    case "requirements": return requirementsIntents(scope);
    case "recording": return recordingIntents(scope);
    case "code": return codeIntents(scope);
    case "custom": return customIntents(scope);
    default: throw new StateError(`Unsupported generate source: ${String(source)}`);
  }
}

export async function runGenerate(params: RunGenerateParams): Promise<GenerateResult> {
  const source = params.source;
  if (!["code", "page", "requirements", "recording", "custom"].includes(source)) {
    throw new StateError(`Invalid generate source: ${String(source)}`);
  }
  const scope = normalizeScope(params.scope);
  const root = path.resolve(params.root ?? process.cwd());
  const seed = hashSeed(source, scope, params.seed);
  const maxTests = Number.isInteger(params.maxTests) && (params.maxTests as number) > 0 ? (params.maxTests as number) : Number.MAX_SAFE_INTEGER;
  const requestedMax = Number.isInteger(params.maxTests) && (params.maxTests as number) > 0 ? (params.maxTests as number) : (generateBySource(source, scope).length);

  // deterministic candidate generation + stable sort (priority asc, then id)
  const candidates = generateBySource(source, scope)
    .map((c) => ({ ...c, reviewed: false as const }))
    .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id) || a.title.localeCompare(b.title));

  // validate intents; invalid are never persisted
  const valid: Array<Omit<GeneratedTestIntent, "path">> = [];
  const invalidAsNotGenerated: GenerateResult["not_generated"] = [];
  for (const c of candidates) {
    if (validateScenario(c.scenario) && c.reviewed === false) valid.push(c);
    else invalidAsNotGenerated.push({ id: c.id, title: c.title, priority: c.priority, reason: "invalid scenario intent (not persisted)" });
  }

  const toGenerate = valid.slice(0, Math.min(maxTests, valid.length));
  const overflow = valid.slice(toGenerate.length).map((c) => ({ id: c.id, title: c.title, priority: c.priority, reason: "maxTests cap exceeded (not generated)" }));
  const notGenerated = [...invalidAsNotGenerated, ...overflow].sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));

  const outDirAbs = path.join(root, ".lemma", "tests", "generated");
  await ensureDir(outDirAbs);
  const generated: GeneratedTestIntent[] = [];
  for (const intent of toGenerate) {
    const rel = path.join(".lemma", "tests", "generated", `${slug(source)}-${String(intent.priority).padStart(2, "0")}-${slug(intent.id)}.json`);
    const abs = path.join(root, rel);
    await ensureDir(path.dirname(abs));
    const payload = { ...intent, path: rel, generated_at: now(), deterministic_seed: seed };
    await atomicWriteJson(abs, payload);
    generated.push({ ...intent, path: rel });
  }

  const result: GenerateResult = {
    schema_version: "lemma.generate_result/v1",
    source,
    generated_at: now(),
    deterministic: { seed, priority_rule: PRIORITY_RULE },
    output_dir: ".lemma/tests/generated",
    generated,
    not_generated: notGenerated,
    counts: { requested_max: requestedMax, generated: generated.length, not_generated: notGenerated.length },
  };

  // persist manifest for resumability/inspection (deterministic content for same inputs+seed)
  await atomicWriteJson(path.join(outDirAbs, `manifest-${source}.json`), result);
  return result;
}
