import { promises as fs } from "node:fs";
import path from "node:path";

import { HarnessError, StateError } from "../errors.js";
import { EvidenceStore } from "../evidence.js";
import { Orchestrator } from "../orchestrator.js";
import { RELEASE_CONFIDENCE } from "../workflows.js";
import { buildReport } from "../report.js";
import { redactUnknown } from "../redaction.js";
import { normalizeTarget, type RunStateDomain } from "../models.js";
import { StateStore } from "../state-store.js";
import { loadSettings, saveSettings } from "../settings.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return undefined;
}

function resolveRoot(root?: string): string {
  return path.resolve(root ?? process.cwd());
}

function redactString(s: string): string {
  try {
    const r = redactUnknown(s);
    return typeof r === "string" ? r : JSON.stringify(r);
  } catch {
    return s;
  }
}

function toHarnessErrorShape(err: unknown): { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } {
  if (err instanceof HarnessError) {
    const details = (err as HarnessError & { details?: Record<string, unknown> }).details;
    return {
      ok: false,
      error: {
        code: err.errorCode || "harness_error",
        message: redactString(err.message || "Harness error"),
        ...(details ? { details: redactUnknown(details) as Record<string, unknown> } : {}),
      },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "harness_error", message: redactString(msg) } };
}

async function loadReportForState(root: string, state: RunStateDomain): Promise<Record<string, unknown>> {
  const evidence = new EvidenceStore(root, state.run_id);
  await evidence.init();
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = await evidence.finalize({ run_id: state.run_id });
  } catch {
    manifest = null;
  }
  const evSummary = evidence.summary();
  const summary: Record<string, unknown> = manifest && isRecord(manifest.summary) ? manifest.summary : (evSummary as unknown as Record<string, unknown>);
  const generatedAt = manifest && typeof manifest.generated_at === "string" ? manifest.generated_at : undefined;
  return buildReport(state, RELEASE_CONFIDENCE, summary, generatedAt);
}

async function loadLatestState(root: string): Promise<RunStateDomain | null> {
  const store = new StateStore(root);
  if (!(await store.exists())) return null;
  return (await store.loadProgress<unknown>()) as RunStateDomain;
}

async function loadLatestReport(root: string): Promise<Record<string, unknown>> {
  const state = await loadLatestState(root);
  if (!state) {
    throw new StateError("No .lemma/progress.json exists yet; run `lemma_start`/`lemma run` first.", { details: { root } });
  }
  return loadReportForState(root, state);
}

export async function toolLemmaStart(args: unknown): Promise<Record<string, unknown>> {
  const a = isRecord(args) ? args : {};
  const targetRaw = asString(a.target);
  if (!targetRaw) throw new HarnessError("Missing required field: target", { code: "harness_error", details: { field: "target" } });
  const root = resolveRoot(asString(a.root));
  const intent = asString(a.intent) ?? "Assess release readiness of the target.";
  const maxChecks = asInt(a.max_checks) ?? 20;
  const resume = asBool(a.resume) ?? false;
  const seed = asInt(a.seed);
  const clock = isRecord(a.clock) ? a.clock : undefined;
  const clockMode = clock && typeof clock.mode === "string" ? (clock.mode as "real" | "frozen") : undefined;
  const frozenClock = clock && (typeof clock.frozen === "string" || clock.frozen === null) ? (clock.frozen as string | null) : undefined;

  const rawTrimmed = targetRaw.trim();
  const isUrl = /^https?:\/\//i.test(rawTrimmed);
  const target = normalizeTarget({
    raw: rawTrimmed,
    kind: isUrl ? "url" : "directory",
    resolved: isUrl ? rawTrimmed : path.resolve(rawTrimmed),
    source: null,
  });

  const store = new StateStore(root);
  const orch = new Orchestrator({ store });
  const state = await orch.run({
    target,
    intent,
    workflow: RELEASE_CONFIDENCE,
    maxChecks,
    resume,
    ...(seed !== undefined ? { seed } : {}),
    ...(clockMode ? { clockMode } : {}),
    ...(frozenClock !== undefined ? { frozenClock } : {}),
  });

  const report = await loadReportForState(root, state as unknown as RunStateDomain);
  return redactUnknown({ ok: true, run_id: state.run_id, status: state.status, report }) as Record<string, unknown>;
}

export async function toolLemmaUpdate(args: unknown): Promise<Record<string, unknown>> {
  const a = isRecord(args) ? args : {};
  const root = resolveRoot(asString(a.root));
  const action = asString(a.action) ?? "status";
  const store = new StateStore(root);

  if (action === "abort") {
    let aborted = false;
    const anyStore = store as unknown as { requestKill?: (reason?: string) => Promise<void> | void; appendEvent?: (e: Record<string, unknown>) => Promise<void> };
    try {
      if (typeof anyStore.requestKill === "function") {
        await anyStore.requestKill("Manual kill requested via MCP.");
        aborted = true;
      } else {
        await store.ensure();
        const killPath = path.join(store.lemmaDir, "KILL");
        await fs.writeFile(killPath, JSON.stringify({ requested_at: new Date().toISOString(), source: "mcp" }) + "\n", "utf8");
        aborted = true;
      }
      await store.appendEvent({ event: "manual_kill_requested", source: "mcp" }).catch(() => undefined);
    } catch {
      aborted = false;
    }
    const statusRes = await toolLemmaUpdate({ root, action: "status" }).catch(() => ({ status: null }));
    return redactUnknown({ ok: true, action: "abort", aborted, status: (statusRes as any).status ?? null }) as Record<string, unknown>;
  }

  const state = await loadLatestState(root);
  if (!state) return { ok: true, action: "status", status: null };
  const status = {
    run_id: (state as any).run_id ?? null,
    status: (state as any).status ?? null,
    intent: (state as any).intent ?? "",
    target: (state as any).target ?? null,
    started_at: (state as any).started_at ?? null,
    completed_at: (state as any).completed_at ?? null,
    updated_at: (state as any).updated_at ?? null,
    current_phase: (state as any).current_phase ?? null,
    confidence: (state as any).confidence ?? null,
  };
  return redactUnknown({ ok: true, action: "status", status }) as Record<string, unknown>;
}

export async function toolLemmaReport(args: unknown): Promise<Record<string, unknown>> {
  const a = isRecord(args) ? args : {};
  const root = resolveRoot(asString(a.root));
  const report = await loadLatestReport(root);
  return redactUnknown({ ok: true, report }) as Record<string, unknown>;
}

export async function toolLemmaSettings(args: unknown): Promise<Record<string, unknown>> {
  const a = isRecord(args) ? args : {};
  const root = resolveRoot(asString(a.root));
  const action = asString(a.action) ?? "get";
  const store = new StateStore(root);
  if (action === "set") {
    const settingsInput = a.settings;
    if (!isRecord(settingsInput)) {
      throw new HarnessError("Missing settings payload for action=set", { code: "harness_error", details: { field: "settings" } });
    }
    const saved = await saveSettings(store, settingsInput, { source: "mcp" });
    return redactUnknown({ ok: true, settings: saved }) as Record<string, unknown>;
  }
  const settings = await loadSettings(store);
  return redactUnknown({ ok: true, settings }) as Record<string, unknown>;
}

const DEMO_MARKER = ".lemma-demo";

function demoFiles(seed: number): Array<{ relPath: string; content: string }> {
  const fakeSecret = `demo_api_key = "lemma_demo_fake_secret_${seed}_NOT_REAL"`;
  return [
    { relPath: "README.md", content: [
      "> **WARNING: THIS IS A TEST-ONLY DEMO. DO NOT DEPLOY.**", "",
      "# Lemma Demo Project (test-only)", "",
      "This directory was generated by `lemma demo` for local, disposable evaluation only.",
      "It intentionally contains flaws so you can exercise lemma's checks.", "",
      "**Do not deploy, publish, or use in production.**", "",
      "## Intentional flaws (for demo/static checks)",
      "- Missing image alt text (`index.html`)",
      "- Exposed secret-shaped string (clearly fake, in `app.js`)",
      "- Broken link (`index.html` -> `broken.html`)", "",
    ].join("\n") },
    { relPath: DEMO_MARKER, content: `${JSON.stringify({ schema_version: "lemma.demo/v1", test_only: true, seed, generator: "lemma demo" }, null, 2)}\n` },
    { relPath: "NOT-FOR-DEPLOYMENT", content: "TEST-ONLY DEMO. DO NOT DEPLOY. DO NOT PUBLISH. Generated by `lemma demo`.\n" },
    { relPath: "index.html", content: [
      "<!doctype html>", "<html lang=\"en\">", "  <head>", "    <meta charset=\"utf-8\">",
      "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "    <title>Lemma Demo (Test Only)</title>", "  </head>", "  <body>",
      "    <h1>Lemma demo app (test-only)</h1>",
      "    <p>This page contains intentional issues for lemma demo runs. Do not deploy.</p>",
      "    <!-- Intentional flaw: missing alt text -->",
      "    <img src=\"logo.png\">",
      "    <!-- Intentional flaw: broken link -->",
      "    <a href=\"broken.html\">Broken demo link</a>",
      "    <script src=\"app.js\"></script>", "  </body>", "</html>", "",
    ].join("\n") },
    { relPath: "app.js", content: [
      "// Lemma demo script (test-only). Do not deploy.",
      "// Intentional flaw: exposed secret-shaped string (clearly fake/test value).",
      fakeSecret,
      "export function demoPing() { return 'demo'; }", "",
    ].join("\n") },
    { relPath: "logo.png", content: "" },
  ];
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function assertInsideTarget(targetDir: string, relPath: string): string {
  const absTarget = path.resolve(targetDir);
  const absPath = path.resolve(absTarget, relPath);
  const prefix = absTarget.endsWith(path.sep) ? absTarget : absTarget + path.sep;
  if (absPath !== absTarget && !absPath.startsWith(prefix)) {
    throw new HarnessError("Demo generator refused to write outside target directory", { code: "harness_error", details: { targetDir: absTarget, relPath } });
  }
  return absPath;
}

export async function toolLemmaDemo(args: unknown): Promise<Record<string, unknown>> {
  const a = isRecord(args) ? args : {};
  const targetDir = path.resolve(asString(a.target_dir) ?? "./lemma-demo");
  const force = asBool(a.force) ?? false;
  const yes = asBool(a.yes) ?? false;
  const seed = asInt(a.seed) ?? 1;
  const exists = await pathExists(targetDir);
  const entries = exists ? await fs.readdir(targetDir) : [];
  const isEmpty = entries.length === 0;
  const markerPath = path.join(targetDir, DEMO_MARKER);
  const hasDemoMarker = exists && await pathExists(markerPath);

  if (exists && !isEmpty && !hasDemoMarker) {
    if (!force || !yes) {
      throw new HarnessError("Refusing to generate demo into a non-empty non-demo directory without force=true and yes=true.", {
        code: "harness_error",
        details: { targetDir, force, yes },
      });
    }
  }

  await fs.mkdir(targetDir, { recursive: true });
  const files = demoFiles(seed).sort((x, y) => x.relPath.localeCompare(y.relPath));
  const written: string[] = [];
  for (const f of files) {
    const abs = assertInsideTarget(targetDir, f.relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content, "utf8");
    written.push(f.relPath);
  }
  return redactUnknown({ ok: true, targetDir, files: written, regenerated: hasDemoMarker, created: !exists || isEmpty }) as Record<string, unknown>;
}

export async function toolLemmaKnowledge(args: unknown): Promise<Record<string, unknown>> {
  const a = isRecord(args) ? args : {};
  const root = resolveRoot(asString(a.root));
  const store = new StateStore(root);
  const settings = await loadSettings(store).catch(() => null);
  const latestState = await loadLatestState(root).catch(() => null);
  const knowledge = {
    schema_version: "lemma.mcp.knowledge/v1",
    tools: ["lemma_start", "lemma_update", "lemma_report", "lemma_settings", "lemma_demo", "lemma_knowledge"],
    workflows: ["release-confidence"],
    personas: ["functional", "accessibility", "security", "performance", "content", "mobile", "manager"],
    state: latestState ? { run_id: (latestState as any).run_id ?? null, status: (latestState as any).status ?? null } : null,
    settings: settings ? { schema_version: (settings as any).schema_version, analytics_enabled: (settings as any).analytics?.enabled ?? false } : null,
    notes: [
      "Knowledge is deterministic and redacted; no secrets are returned.",
      "Run artifacts and mutable state are confined to project .lemma/ via core state primitives.",
    ],
  };
  return redactUnknown({ ok: true, knowledge }) as Record<string, unknown>;
}

export const MCP_TOOL_HANDLERS: Record<string, (args: unknown) => Promise<Record<string, unknown>>> = {
  lemma_start: async (args) => { try { return await toolLemmaStart(args); } catch (e) { return toHarnessErrorShape(e) as unknown as Record<string, unknown>; } },
  lemma_update: async (args) => { try { return await toolLemmaUpdate(args); } catch (e) { return toHarnessErrorShape(e) as unknown as Record<string, unknown>; } },
  lemma_report: async (args) => { try { return await toolLemmaReport(args); } catch (e) { return toHarnessErrorShape(e) as unknown as Record<string, unknown>; } },
  lemma_settings: async (args) => { try { return await toolLemmaSettings(args); } catch (e) { return toHarnessErrorShape(e) as unknown as Record<string, unknown>; } },
  lemma_demo: async (args) => { try { return await toolLemmaDemo(args); } catch (e) { return toHarnessErrorShape(e) as unknown as Record<string, unknown>; } },
  lemma_knowledge: async (args) => { try { return await toolLemmaKnowledge(args); } catch (e) { return toHarnessErrorShape(e) as unknown as Record<string, unknown>; } },
};

export function getMcpToolDefinitions(): McpToolDefinition[] {
  return [
    { name: "lemma_start", description: "Start or resume a deterministic lemma run and return its report.", inputSchema: { type: "object", properties: { target: { type: "string" }, root: { type: "string" }, intent: { type: "string" }, max_checks: { type: "integer" }, resume: { type: "boolean" }, seed: { type: "integer" }, clock: { type: "object" } }, required: ["target"] } },
    { name: "lemma_update", description: "Get run status/progress or request abort for the current/latest run.", inputSchema: { type: "object", properties: { root: { type: "string" }, action: { type: "string", enum: ["status", "abort"] } } } },
    { name: "lemma_report", description: "Load the latest or specified lemma report for a project root.", inputSchema: { type: "object", properties: { root: { type: "string" }, run_id: { type: "string" }, latest: { type: "boolean" } } } },
    { name: "lemma_settings", description: "Get or set lemma settings for a project root.", inputSchema: { type: "object", properties: { root: { type: "string" }, action: { type: "string", enum: ["get", "set"] }, settings: { type: "object" } } } },
    { name: "lemma_demo", description: "Generate a disposable, test-only demo project.", inputSchema: { type: "object", properties: { target_dir: { type: "string" }, force: { type: "boolean" }, yes: { type: "boolean" }, seed: { type: "integer" } } } },
    { name: "lemma_knowledge", description: "Return deterministic, redacted lemma knowledge/capability information.", inputSchema: { type: "object", properties: { root: { type: "string" }, query: { type: "string" }, topics: { type: "array", items: { type: "string" } } } } },
  ];
}

export function toErrorResult(err: unknown): Record<string, unknown> {
  return toHarnessErrorShape(err);
}
