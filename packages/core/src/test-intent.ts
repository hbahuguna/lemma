import { promises as fs } from "node:fs";
import path from "node:path";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactUnknown } from "./redaction.js";
import type { ScenarioPlan } from "./steps.js";

export type TestIntentAction = "create" | "import" | "convert" | "repair" | "bake" | "list" | "delete";
export type TestIntentFormat = "testrail" | "xray" | "xml" | "xlsx" | "docx" | "lemma-native";

export interface ManageTestsParams {
  action: TestIntentAction;
  format?: TestIntentFormat;
  input?: unknown;
  output?: unknown;
  root?: string;
  suite?: string;
  id?: string;
  ids?: string[];
  force?: boolean;
  /** For create: intent payload */
  intent?: any;
  /** For import/convert: max items to accept; overflow recorded explicitly */
  maxTests?: number;
  [key: string]: unknown;
}

export interface TestIntent {
  id: string;
  title: string;
  reviewed: boolean;
  format_origin?: TestIntentFormat | string;
  suite?: string;
  scenario: ScenarioPlan;
  metadata?: Record<string, unknown>;
}

export interface ManageTestsResult {
  action: TestIntentAction;
  format?: TestIntentFormat;
  ok: boolean;
  result: any;
  rejections?: Array<{ id?: string; reason: string; index?: number }>;
  overflow?: Array<{ id?: string; title?: string; reason: string }>;
  redacted?: boolean;
}

function slug(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
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

function validateIntent(intent: any): intent is TestIntent {
  if (!isRecord(intent)) return false;
  if (typeof intent.id !== "string" || !intent.id) return false;
  if (typeof intent.title !== "string") return false;
  if (typeof intent.reviewed !== "boolean") return false;
  return validateScenario(intent.scenario);
}

function redactIntent(intent: TestIntent): { intent: TestIntent; redacted: boolean } {
  const before = JSON.stringify(intent);
  const redacted = redactUnknown(intent) as TestIntent;
  return { intent: redacted, redacted: JSON.stringify(redacted) !== before };
}

function testsRoot(root: string): string { return path.join(root, ".lemma", "tests"); }

async function loadBakedSuite(root: string, suite: string): Promise<{ suite: string; intents: TestIntent[]; manifestPath: string } | null> {
  const manifestPath = path.join(testsRoot(root), suite, "manifest.json");
  try {
    const manifest = await readJsonFile<any>(manifestPath);
    const intents = Array.isArray(manifest.intents) ? manifest.intents : [];
    return { suite, intents, manifestPath };
  } catch (e: any) {
    if (e instanceof StateError && /not found/i.test(e.message)) return null;
    throw e;
  }
}

async function listAllSuites(root: string): Promise<string[]> {
  const dir = testsRoot(root);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch {
    return [];
  }
}

function stableManifest(suite: string, intents: TestIntent[]): any {
  const sorted = [...intents].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema_version: "lemma.tests.manifest/v1",
    suite,
    generated_at: "deterministic",
    count: sorted.length,
    intents: sorted.map(i => ({ ...i, scenario: i.scenario })),
  };
}

// ---------- format parsers/serializers (minimal, deterministic) ----------
function parseLemmaNative(input: any): TestIntent[] {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.intents) ? data.intents : [data]);
  return arr as TestIntent[];
}
function serializeLemmaNative(intents: TestIntent[]): string {
  return JSON.stringify({ schema_version: "lemma.test-intents/v1", intents: intents.map(i => ({ ...i })) }, null, 2) + "\n";
}

function parseXml(input: any): TestIntent[] {
  // minimal deterministic XML: <tests><test id="..." title="..." reviewed="false"><scenario><![CDATA[json]]></scenario></test></tests>
  if (Array.isArray(input)) {
    return input.map((it: any, idx: number) => ({
      id: String(it.id ?? `xml-${idx + 1}`),
      title: String(it.title ?? `Test ${idx + 1}`),
      reviewed: Boolean(it.reviewed),
      format_origin: "xml",
      scenario: it.scenario,
      metadata: isRecord(it.metadata) ? it.metadata : {},
    }));
  }
  const text = typeof input === "string" ? input : String(input);
  const tests: TestIntent[] = [];
  const re = /<test\b([^>]*)>([\s\S]*?)<\/test>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const id = (attrs.match(/\bid="([^"]*)"/) || [])[1] ?? "";
    const title = (attrs.match(/\btitle="([^"]*)"/) || [])[1] ?? "";
    const reviewed = /reviewed="true"/.test(attrs);
    const scenM = body.match(/<scenario>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/scenario>/);
    const scenario = scenM && scenM[1] !== undefined ? JSON.parse(scenM[1]) : null;
    tests.push({ id, title, reviewed, scenario, format_origin: "xml" });
  }
  if (tests.length === 0 && text.trim() && !text.includes("[object Object]")) throw new StateError("Invalid XML test-intent input");
  if (tests.length === 0 && text.includes("[object Object]")) return [];
  return tests;
}
function serializeXml(intents: TestIntent[]): string {
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = intents.map(i => `  <test id="${esc(i.id)}" title="${esc(i.title)}" reviewed="${i.reviewed ? "true" : "false"}">\n    <scenario><![CDATA[${JSON.stringify(i.scenario)}]]></scenario>\n  </test>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tests>\n${body}\n</tests>\n`;
}

function parseJsonFormat(input: any, format: "testrail" | "xray"): TestIntent[] {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.cases) ? data.cases : Array.isArray(data?.tests) ? data.tests : []);
  return arr.map((c: any, idx: number) => ({
    id: String(c.id ?? c.case_id ?? c.key ?? `${format}-${idx + 1}`),
    title: String(c.title ?? c.name ?? c.summary ?? `Case ${idx + 1}`),
    reviewed: Boolean(c.reviewed),
    format_origin: format,
    scenario: c.scenario ?? {
      title: String(c.title ?? c.name ?? `Case ${idx + 1}`),
      steps: Array.isArray(c.steps) && c.steps.length ? c.steps : [{ step_number: 1, name: String(c.title ?? "Step"), action: "assert_visible", target: "body", value: "", options: {}, raw_instruction: String(c.title ?? "") }],
      source: "explicit", model: "", target_url: String(c.url ?? c.target_url ?? "http://localhost"),
    },
    metadata: isRecord(c.metadata) ? c.metadata : {},
  }));
}
function serializeJsonFormat(intents: TestIntent[], format: "testrail" | "xray"): string {
  const key = format === "testrail" ? "cases" : "tests";
  return JSON.stringify({ format, [key]: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario, metadata: i.metadata ?? {} })) }, null, 2) + "\n";
}

// xlsx/docx: deterministic text-envelope representation (OOXML-like container semantics represented as portable archive-json for round-trip without binary deps)
function parseXlsx(input: any): TestIntent[] {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  let rows: any[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (isRecord(data) && (data as any).format === "xlsx") {
    rows = Array.isArray((data as any).rows) ? (data as any).rows : [];
  } else {
    throw new StateError("Invalid xlsx test-intent input");
  }
  return rows.map((r: any, idx: number) => ({
    id: String(r.id ?? `xlsx-${idx + 1}`),
    title: String(r.title ?? `Row ${idx + 1}`),
    reviewed: Boolean(r.reviewed),
    format_origin: "xlsx",
    scenario: r.scenario,
    metadata: isRecord(r.metadata) ? r.metadata : {},
  }));
}
function serializeXlsx(intents: TestIntent[]): string {
  return JSON.stringify({ format: "xlsx", sheet: "tests", rows: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario, metadata: i.metadata ?? {} })) }, null, 2) + "\n";
}
function parseDocx(input: any): TestIntent[] {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  let sections: any[] = [];
  if (Array.isArray(data)) {
    sections = data;
  } else if (isRecord(data) && (data as any).format === "docx") {
    sections = Array.isArray((data as any).sections) ? (data as any).sections : [];
  } else {
    throw new StateError("Invalid docx test-intent input");
  }
  return sections.map((s: any, idx: number) => ({
    id: String(s.id ?? `docx-${idx + 1}`),
    title: String(s.title ?? `Section ${idx + 1}`),
    reviewed: Boolean(s.reviewed),
    format_origin: "docx",
    scenario: s.scenario,
    metadata: isRecord(s.metadata) ? s.metadata : {},
  }));
}
function serializeDocx(intents: TestIntent[]): string {
  return JSON.stringify({ format: "docx", document: "tests", sections: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario, metadata: i.metadata ?? {} })) }, null, 2) + "\n";
}

function parseByFormat(format: TestIntentFormat, input: any): TestIntent[] {
  switch (format) {
    case "lemma-native": return parseLemmaNative(input);
    case "xml": return parseXml(input);
    case "testrail":
    case "xray": return parseJsonFormat(input, format);
    case "xlsx": return parseXlsx(input);
    case "docx": return parseDocx(input);
    default: throw new StateError(`Unsupported format: ${String(format)}`);
  }
}
function serializeByFormat(format: TestIntentFormat, intents: TestIntent[]): string {
  switch (format) {
    case "lemma-native": return serializeLemmaNative(intents);
    case "xml": return serializeXml(intents);
    case "testrail":
    case "xray": return serializeJsonFormat(intents, format);
    case "xlsx": return serializeXlsx(intents);
    case "docx": return serializeDocx(intents);
    default: throw new StateError(`Unsupported format: ${String(format)}`);
  }
}

async function readInput(input: unknown, root: string): Promise<any> {
  if (typeof input === "string") {
    const p = path.isAbsolute(input) ? input : path.join(root, input);
    try { return await fs.readFile(p, "utf8"); } catch { return input; }
  }
  return input;
}
async function writeOutput(output: unknown, content: string, root: string): Promise<string | null> {
  if (typeof output !== "string") return null;
  const p = path.isAbsolute(output) ? output : path.join(root, output);
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, content, "utf8");
  return p;
}

export async function manageTests(params: ManageTestsParams): Promise<ManageTestsResult> {
  const action = params.action;
  const root = path.resolve(params.root ?? process.cwd());
  const format = params.format as TestIntentFormat | undefined;

  if (action === "list") {
    const suites = await listAllSuites(root);
    const out: any[] = [];
    for (const s of suites) {
      const loaded = await loadBakedSuite(root, s);
      if (loaded) out.push({ suite: s, count: loaded.intents.length, intents: loaded.intents });
    }
    return { action, ok: true, result: { suites: out } };
  }

  if (action === "delete") {
    const suite = String(params.suite || params.input || "");
    const id = params.id ? String(params.id) : null;
    if (!suite) throw new StateError("delete requires suite");
    const loaded = await loadBakedSuite(root, suite);
    if (!loaded) throw new StateError(`Suite not found: ${suite}`);
    const targets = loaded.intents.filter(i => !id || i.id === id);
    if (targets.length === 0) throw new StateError(id ? `Test not found: ${id}` : `No tests in suite: ${suite}`);
    const reviewed = targets.filter(t => t.reviewed);
    if (reviewed.length > 0 && !params.force) {
      throw new StateError(`Refusing to delete reviewed test(s) without --force: ${reviewed.map(t=>t.id).join(", ")}`);
    }
    const remaining = id ? loaded.intents.filter(i => i.id !== id) : loaded.intents.filter(i => !targets.includes(i));
    if (id && remaining.length === loaded.intents.length) throw new StateError(`Test not found: ${id}`);
    if (!id) {
      // delete whole suite
      await fs.rm(path.join(testsRoot(root), suite), { recursive: true, force: true });
      return { action, ok: true, result: { deleted_suite: suite, deleted_ids: targets.map(t=>t.id) } };
    }
    // rewrite manifest and remove file
    const suiteDir = path.join(testsRoot(root), suite);
    const manifest = stableManifest(suite, remaining);
    await atomicWriteJson(path.join(suiteDir, "manifest.json"), manifest);
    const testFile = path.join(suiteDir, `${slug(String(id ?? ''))}.json`);
    try { await fs.unlink(testFile); } catch { /* ignore */ }
    return { action, ok: true, result: { suite, deleted_ids: [id], remaining: remaining.length } };
  }

  if (action === "create") {
    const intentIn = params.intent ?? params.input;
    if (!intentIn) throw new StateError("create requires intent");
    const baseIntent = { ...(intentIn as any) };
    if (typeof baseIntent.reviewed !== "boolean") baseIntent.reviewed = false;
    const { intent, redacted } = redactIntent(baseIntent as TestIntent);
    if (!validateIntent(intent as any)) throw new StateError("Invalid test intent (schema validation failed)");
    const suite = String(params.suite || intent.suite || "default");
    const suiteDir = path.join(testsRoot(root), suite);
    await ensureDir(suiteDir);
    const existing = await loadBakedSuite(root, suite);
    const intents = existing ? [...existing.intents.filter(i => i.id !== intent.id), intent] : [intent];
    intents.sort((a,b)=>a.id.localeCompare(b.id));
    await atomicWriteJson(path.join(suiteDir, `${slug(intent.id)}.json`), intent);
    await atomicWriteJson(path.join(suiteDir, "manifest.json"), stableManifest(suite, intents));
    return { action, ok: true, result: { suite, intent }, redacted };
  }

  if (action === "bake") {
    const suite = String(params.suite || "default");
    let intents: TestIntent[] = [];
    if (params.input) {
      // bake from provided intents list
      const raw = await readInput(params.input, root);
      intents = Array.isArray(raw) ? raw : (Array.isArray(raw?.intents) ? raw.intents : []);
    } else {
      // bake existing loose files in suite dir? or require input; try reading manifest/intents
      const existing = await loadBakedSuite(root, suite);
      intents = existing?.intents ?? [];
    }
    // validate all, no partial invalid bake
    const prepared: TestIntent[] = [];
    for (const it of intents) {
      const baseIt = { ...it } as any;
      if (typeof baseIt.reviewed !== "boolean") baseIt.reviewed = false;
      const red = redactIntent(baseIt as TestIntent);
      const intentAny: any = red.intent;
      if (!validateIntent(intentAny)) throw new StateError(`Invalid test intent cannot be baked: ${String(intentAny?.id ?? "unknown")}`);
      prepared.push(intentAny as TestIntent);
    }
    prepared.sort((a,b)=>a.id.localeCompare(b.id));
    const suiteDir = path.join(testsRoot(root), suite);
    await ensureDir(suiteDir);
    // write reproducible tree
    for (const it of prepared) await atomicWriteJson(path.join(suiteDir, `${slug(it.id)}.json`), it);
    const manifest = stableManifest(suite, prepared);
    await atomicWriteJson(path.join(suiteDir, "manifest.json"), manifest);
    return { action, ok: true, result: { suite, manifest_path: path.join(suiteDir, "manifest.json"), count: prepared.length } };
  }

  if (action === "import" || action === "convert" || action === "repair") {
    if (!format) throw new StateError(`${action} requires format`);
    const raw = await readInput(params.input, root);
    let parsed: TestIntent[];
    try {
      parsed = parseByFormat(format, raw);
    } catch (e: any) {
      throw new StateError(`Invalid import input for format ${format}: ${e?.message || String(e)}`);
    }
    const rejections: Array<{ id?: string; reason: string; index?: number }> = [];
    const accepted: TestIntent[] = [];
    let anyRedacted = false;
    for (let i = 0; i < parsed.length; i++) {
      const base = { format_origin: format, ...(parsed[i] as any) } as any;
      if (typeof base.reviewed !== "boolean") base.reviewed = false;
      const { intent, redacted } = redactIntent(base);
      if (redacted) anyRedacted = true;
      if (!validateIntent(intent)) {
        rejections.push({ id: (base as any)?.id, reason: "schema validation failed", index: i });
        continue;
      }
      if (action === "repair") {
        // minimal repair: ensure required fields
        intent.title = intent.title || intent.id;
      }
      accepted.push(intent);
    }
    // invalid imports raise typed error and do not partially write (no persisted state changes)
    if (rejections.length > 0) {
      throw new StateError(`Import/convert validation failed; no data written`, { details: { rejections } } as any);
    }
    const maxTests = Number.isInteger(params.maxTests) && (params.maxTests as number) > 0 ? (params.maxTests as number) : accepted.length;
    const toKeep = accepted.slice(0, maxTests);
    const overflow = accepted.slice(maxTests).map(i => ({ id: i.id, title: i.title, reason: "maxTests overflow (not written)" }));

    if (action === "import" || action === "repair") {
      const suite = String(params.suite || "imported");
      const suiteDir = path.join(testsRoot(root), suite);
      await ensureDir(suiteDir);
      for (const it of toKeep) await atomicWriteJson(path.join(suiteDir, `${slug(it.id)}.json`), it);
      await atomicWriteJson(path.join(suiteDir, "manifest.json"), stableManifest(suite, toKeep));
    }

    let exportedPath: string | null = null;
    let exportedContent: string | null = null;
    if (action === "convert") {
      const outFormat = (params.outputFormat as TestIntentFormat) || format;
      exportedContent = serializeByFormat(outFormat, toKeep);
      exportedPath = await writeOutput(params.output, exportedContent, root);
    }

    return { action, format, ok: true, result: { intents: toKeep, count: toKeep.length, ...(exportedPath ? { output_path: exportedPath } : {}), ...(exportedContent ? { output: exportedContent } : {}) }, overflow, redacted: anyRedacted };
  }

  throw new StateError(`Unsupported action: ${String(action)}`);
}
