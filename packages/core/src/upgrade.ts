import { promises as fs } from "node:fs";
import path from "node:path";

import { HarnessError, StateError } from "./errors.js";
import { atomicWriteJson, ensureDir } from "./state.js";
import { redactUnknown } from "./redaction.js";
import type { ScenarioPlan, StepAction } from "./steps.js";

export type UpgradeSourceKind =
  | "selenium"
  | "playwright"
  | "cypress"
  | "pytest"
  | "junit"
  | "testrail"
  | "xray"
  | "xlsx"
  | "docx"
  | "manual";

export interface UpgradeSourceInput {
  kind: UpgradeSourceKind;
  /** Path to source file (read-only). Relative to root unless absolute. */
  path?: string;
  /** Inline source content; if provided, no source file is read/written. */
  content?: string | unknown;
  /** Optional label/id for traceability. */
  id?: string;
  name?: string;
  /** Optional target URL hint. */
  url?: string;
}

export interface UpgradeApprovalContext {
  dryRunReport: UpgradeDryRunReport;
  source: UpgradeSourceInput;
  targetDir: string;
}

export type UpgradeApproval = boolean | { approved: boolean; reason?: string };

export interface RunUpgradeParams {
  source: UpgradeSourceInput;
  target?: string; // subdir under .lemma/tests/upgraded, default "upgraded" or derived
  dryRun?: boolean;
  approve?: (ctx: UpgradeApprovalContext) => UpgradeApproval | Promise<UpgradeApproval>;
  root?: string;
}

export interface UpgradedTestIntent {
  id: string;
  title: string;
  reviewed: false;
  origin: {
    kind: UpgradeSourceKind;
    source_id: string;
    source_path?: string;
    trace: string;
  };
  scenario: ScenarioPlan;
}

export interface UpgradeDryRunReport {
  schema_version: "lemma.upgrade_report/v1";
  mode: "dry-run" | "apply";
  status: "dry-run" | "applied" | "declined";
  source: { kind: UpgradeSourceKind; id: string; path?: string };
  target_dir: string;
  planned: Array<{ id: string; title: string; origin_trace: string }>;
  rejected: Array<{ id?: string; reason: string }>;
  counts: { planned: number; rejected: number };
  reversible: true;
  non_destructive: true;
  generated_at: "deterministic";
}

export interface UpgradeResult extends UpgradeDryRunReport {
  applied?: { written: string[]; suite: string };
  approval?: { approved: boolean; reason?: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function slug(s: string): string {
  return String(s || "test").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
}

function step(n: number, name: string, action: StepAction["action"], target = "", value = ""): StepAction {
  return { step_number: n, name, action, target, value, options: {}, raw_instruction: name };
}

function validateScenario(plan: any): plan is ScenarioPlan {
  if (!isRecord(plan)) return false;
  if (typeof plan.title !== "string" || !plan.title) return false;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return false;
  for (const s of plan.steps) {
    if (!isRecord(s)) return false;
    if (typeof s.step_number !== "number") return false;
    if (typeof s.name !== "string") return false;
    if (typeof s.action !== "string") return false;
    if (typeof (s as any).target !== "string") return false;
    if (typeof (s as any).value !== "string") return false;
  }
  if (typeof plan.source !== "string") return false;
  if (typeof plan.target_url !== "string") return false;
  return true;
}

async function readSourceContent(root: string, source: UpgradeSourceInput): Promise<string | unknown> {
  if (source.content !== undefined) return source.content;
  if (!source.path) return "";
  const p = path.isAbsolute(source.path) ? source.path : path.join(root, source.path);
  return fs.readFile(p, "utf8");
}

function defaultScenario(title: string, url: string, hint?: string): ScenarioPlan {
  const steps: StepAction[] = [step(1, "Navigate to target", "goto", url || "http://localhost")];
  if (hint) steps.push(step(2, hint.slice(0, 80), "assert_visible", "body"));
  else steps.push(step(2, "Verify page visible", "assert_visible", "body"));
  return { title, steps, source: "explicit", model: "", target_url: url || "http://localhost" };
}

function parseStructuredCases(kind: "testrail" | "xray" | "xlsx" | "docx", raw: any, sourceId: string, url: string): UpgradedTestIntent[] {
  let items: any[] = [];
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (kind === "testrail") items = Array.isArray(data) ? data : (Array.isArray(data?.cases) ? data.cases : []);
  else if (kind === "xray") items = Array.isArray(data) ? data : (Array.isArray(data?.tests) ? data.tests : []);
  else if (kind === "xlsx") items = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
  else if (kind === "docx") items = Array.isArray(data) ? data : (Array.isArray(data?.sections) ? data.sections : []);
  return items.map((c: any, idx: number) => {
    const id = String(c.id ?? c.case_id ?? c.key ?? `${kind}-${idx + 1}`);
    const title = String(c.title ?? c.name ?? c.summary ?? `Case ${idx + 1}`);
    const scenario: ScenarioPlan = c.scenario && validateScenario(c.scenario)
      ? c.scenario
      : defaultScenario(title, String(c.url ?? c.target_url ?? (url || "http://localhost")), title);
    return {
      id: `${slug(sourceId)}-${slug(id)}`,
      title,
      reviewed: false as const,
      origin: { kind, source_id: sourceId, trace: `${kind}:${id}` },
      scenario,
    };
  });
}

function parseManual(raw: any, sourceId: string, url: string): UpgradedTestIntent[] {
  const data = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw;
  let items: any[] = [];
  if (Array.isArray(data)) items = data;
  else if (isRecord(data) && Array.isArray((data as any).tests)) items = (data as any).tests;
  else if (typeof data === "string") {
    items = data.split(/\n\s*\n|\n(?=\d+[\.\)]\s)/).map((s, i) => ({ id: `manual-${i + 1}`, title: s.trim().slice(0, 80) || `Manual ${i + 1}`, text: s.trim() })).filter((x: any) => x.text);
  } else items = [data];
  return items.map((c: any, idx: number) => {
    const id = String(c?.id ?? `manual-${idx + 1}`);
    const title = String(c?.title ?? c?.name ?? c?.text ?? `Manual ${idx + 1}`).slice(0, 120) || `Manual ${idx + 1}`;
    const scenario: ScenarioPlan = c?.scenario && validateScenario(c.scenario)
      ? c.scenario
      : {
          title,
          steps: [
            step(1, "Navigate to target", "goto", String((c?.url ?? url) || "http://localhost")),
            step(2, "Perform manual intent", "assert_visible", "body", title.slice(0, 60)),
          ],
          source: "explicit",
          model: "",
          target_url: String((c?.url ?? url) || "http://localhost"),
        };
    return {
      id: `${slug(sourceId)}-${slug(id)}`,
      title,
      reviewed: false as const,
      origin: { kind: "manual" as const, source_id: sourceId, trace: `manual:${id}` },
      scenario,
    };
  });
}

function extractNamedBlocks(text: string, patterns: RegExp[]): string[] {
  const names = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    while ((m = r.exec(text))) {
      const name = (m[1] || m[2] || "").trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

function parseCodeLike(kind: "selenium" | "playwright" | "cypress" | "pytest" | "junit", raw: any, sourceId: string, url: string): UpgradedTestIntent[] {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  let names: string[] = [];
  if (kind === "playwright" || kind === "cypress") {
    names = extractNamedBlocks(text, [/test\(\s*['"`]([^'"`]+)['"`]/g, /it\(\s*['"`]([^'"`]+)['"`]/g]);
  } else if (kind === "selenium") {
    names = extractNamedBlocks(text, [/def\s+(test_[A-Za-z0-9_]+)/g, /@Test[\s\S]*?void\s+([A-Za-z0-9_]+)/g, /it\(\s*['"`]([^'"`]+)['"`]/g, /test\(\s*['"`]([^'"`]+)['"`]/g]);
  } else if (kind === "pytest") {
    names = extractNamedBlocks(text, [/def\s+(test_[A-Za-z0-9_]+)/g]);
  } else if (kind === "junit") {
    names = extractNamedBlocks(text, [/@Test[\s\S]*?(?:public\s+)?void\s+([A-Za-z0-9_]+)/g, /void\s+(test[A-Za-z0-9_]+)/g]);
  }
  if (names.length === 0) names = [`${kind} upgraded test`];
  return names.map((n, idx) => {
    const title = n.replace(/_/g, " ").trim() || `${kind} test ${idx + 1}`;
    return {
      id: `${slug(sourceId)}-${slug(n)}-${idx + 1}`,
      title,
      reviewed: false as const,
      origin: { kind, source_id: sourceId, trace: `${kind}:${n}` },
      scenario: {
        title,
        steps: [
          step(1, "Navigate to target", "goto", url || "http://localhost"),
          step(2, `Exercise migrated behavior: ${title.slice(0, 50)}`, "assert_visible", "body"),
        ],
        source: "explicit",
        model: "",
        target_url: url || "http://localhost",
      },
    };
  });
}

function parseUpgradeSource(source: UpgradeSourceInput, raw: any): { intents: UpgradedTestIntent[]; rejected: Array<{ id?: string; reason: string }> } {
  const sourceId = String(source.id || source.name || source.path || source.kind);
  const url = String(source.url || "http://localhost");
  const kind = source.kind;
  let intents: UpgradedTestIntent[] = [];
  if (kind === "testrail" || kind === "xray" || kind === "xlsx" || kind === "docx") {
    intents = parseStructuredCases(kind, raw, sourceId, url);
  } else if (kind === "manual") {
    intents = parseManual(raw, sourceId, url);
  } else if (kind === "selenium" || kind === "playwright" || kind === "cypress" || kind === "pytest" || kind === "junit") {
    intents = parseCodeLike(kind, raw, sourceId, url);
  } else {
    throw new StateError(`Unsupported upgrade source kind: ${String(kind)}`);
  }

  // tag origin with path if known
  if (source.path) {
    for (const it of intents) (it.origin as any).source_path = source.path;
  }

  const rejected: Array<{ id?: string; reason: string }> = [];
  const accepted: UpgradedTestIntent[] = [];
  for (const it of intents) {
    if (!validateScenario(it.scenario)) rejected.push({ id: it.id, reason: "scenario schema validation failed" });
    else accepted.push(it);
  }
  // stable order by id
  accepted.sort((a, b) => a.id.localeCompare(b.id));
  return { intents: accepted, rejected };
}

function makeReport(params: {
  source: UpgradeSourceInput;
  sourceId: string;
  targetDir: string;
  intents: UpgradedTestIntent[];
  rejected: Array<{ id?: string; reason: string }>;
  mode: "dry-run" | "apply";
  status: "dry-run" | "applied" | "declined";
}): UpgradeDryRunReport {
  return {
    schema_version: "lemma.upgrade_report/v1",
    mode: params.mode,
    status: params.status,
    source: { kind: params.source.kind, id: params.sourceId, ...(params.source.path ? { path: params.source.path } : {}) },
    target_dir: params.targetDir,
    planned: params.intents.map(i => ({ id: i.id, title: i.title, origin_trace: i.origin.trace })),
    rejected: params.rejected,
    counts: { planned: params.intents.length, rejected: params.rejected.length },
    reversible: true,
    non_destructive: true,
    generated_at: "deterministic",
  };
}

export async function runUpgrade(params: RunUpgradeParams): Promise<UpgradeResult> {
  const root = path.resolve(params.root ?? process.cwd());
  const source = params.source;
  if (!source || !source.kind) throw new StateError("runUpgrade requires source.kind");
  const allowed: UpgradeSourceKind[] = ["selenium","playwright","cypress","pytest","junit","testrail","xray","xlsx","docx","manual"];
  if (!allowed.includes(source.kind)) throw new StateError(`Unsupported upgrade source kind: ${String(source.kind)}`);

  const sourceId = String(source.id || source.name || source.path || source.kind);
  const raw = await readSourceContent(root, source);
  const { intents, rejected } = parseUpgradeSource(source, raw);

  const targetName = slug(String(params.target || "upgraded"));
  const upgradedRootRel = path.join(".lemma", "tests", "upgraded");
  const targetDirAbs = path.join(root, upgradedRootRel, targetName);
  const targetDirRel = path.join(upgradedRootRel, targetName);

  // Always produce dry-run report first
  const dryRunReport = makeReport({ source, sourceId, targetDir: targetDirRel, intents, rejected, mode: params.dryRun === false ? "apply" : "dry-run", status: "dry-run" });

  if (params.dryRun !== false) {
    return { ...dryRunReport, mode: "dry-run", status: "dry-run" };
  }

  // Applying requires approval callback (mutation gate). Refusal leaves source untouched and writes nothing.
  if (typeof params.approve !== "function") {
    throw new HarnessError("runUpgrade apply requires an approval callback (approve)", { code: "UPGRADE_APPROVAL_REQUIRED" } as any);
  }
  const decision = await params.approve({ dryRunReport, source, targetDir: targetDirRel });
  const approved = typeof decision === "boolean" ? decision : !!decision?.approved;
  const reason = typeof decision === "object" && decision ? (decision.reason as string | undefined) : undefined;
  if (!approved) {
    return { ...dryRunReport, mode: "apply", status: "declined", approval: { approved: false, ...(reason ? { reason } : {}) } };
  }

  // Apply: write only to .lemma/tests/upgraded/<target>/, never touch source
  await ensureDir(targetDirAbs);
  const written: string[] = [];
  const redactedIntents = intents.map((i) => redactUnknown(i) as UpgradedTestIntent);
  for (const intent of redactedIntents) {
    const rel = path.join(targetDirRel, `${slug(intent.id)}.json`);
    const abs = path.join(root, rel);
    await atomicWriteJson(abs, intent);
    written.push(rel);
  }
  const manifest = {
    schema_version: "lemma.tests.manifest/v1",
    suite: targetName,
    generated_at: "deterministic",
    upgraded: true,
    source: { kind: source.kind, id: sourceId, ...(source.path ? { path: source.path } : {}) },
    count: redactedIntents.length,
    intents: redactedIntents,
  };
  const manifestRel = path.join(targetDirRel, "manifest.json");
  await atomicWriteJson(path.join(root, manifestRel), manifest);
  written.push(manifestRel);

  const appliedReport = makeReport({ source, sourceId, targetDir: targetDirRel, intents: redactedIntents, rejected, mode: "apply", status: "applied" });
  return {
    ...appliedReport,
    approval: { approved: true },
    applied: { written, suite: targetName },
  };
}
