/**
 * @lemma/agent — Host-neutral agent loop and command catalog.
 *
 * LEM-086: strict-judge loop core (cap 7, allowlist, dedupe).
 * LEM-087: persisted agent state and in-session resume.
 * LEM-088: command argument builders.
 * LEM-089: 59-command catalog and intent mapping.
 * LEM-090: browser agent prompt and invariants.
 * LEM-091: context protocol and question flow.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { atomicWriteJson, ensureDir, readJsonFile } from "@lemma/core";

import { browserInvocation, demoInvocation } from "./command-args.js";

export const PACKAGE_NAME = "@lemma/agent" as const;

export {
  SUBCOMMANDS,
  assayInvocation,
  browserInvocation,
  demoInvocation,
  extractUrl,
  isUrl,
} from "./command-args.js";
export type { Invocation } from "./command-args.js";

export {
  ASSAY_COMMAND_CATALOG,
  assayIntent,
  buildCatalogInvocation,
  getAssayCommand,
  getCatalogCommandKind,
} from "./catalog.js";
export type { AssayCommand, CatalogCommandKind, CatalogInvocationResult } from "./catalog.js";

export { CONTEXT_PROTOCOL, buildBrowserAgentPrompt, shellQuote } from "./browser-agent-prompt.js";
export type { BrowserAgentPromptInput } from "./browser-agent-prompt.js";

export {
  adfToText,
  buildJiraFormFields,
  collectJiraForm,
  createHttpFormApi,
  fetchJiraIssue,
  formatJiraContext,
  getJiraFormApi,
  normalizeJiraSite,
  parseJiraTarget,
  readLocalServiceConfig,
  redactSecrets,
  registerJiraContextTool,
  sanitizeError,
  summarizeJiraIssue,
} from "./jira-context.js";
export type {
  JiraContextToolContext,
  JiraContextToolDefinition,
  JiraFormApi,
  JiraFormDetail,
  JiraFormField,
  JiraFormInfo,
  JiraFormPayload,
  JiraFormPrefill,
  JiraIssueContext,
  LocalServiceConfig,
} from "./jira-context.js";

export interface HarnessInvocation {
  args: string[];
  env?: Record<string, string | undefined>;
  error?: string;
}

export interface AgentDeps {
  runHarness: (args: string[], env?: Record<string, string | undefined>) => Promise<string>;
  askLlm: (prompt: string) => Promise<string>;
  progress?: (message: string) => void;
  sendFinal: (text: string) => Promise<void>;
  /** Discover available MCP resources (optional, host-provided). May return display strings or a raw MCP listing object. */
  listMcpResources?: () => Promise<unknown>;
  /** Ask user for in-session reply to a pending context request (interactive mode). */
  requestUserInput?: (prompt: string) => Promise<string>;
}

export const CONTEXT_SOURCES = ["jira", "slack", "github", "doc", "url", "text"] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];
export const CONTEXT_METHODS = ["paste", "mcp", "token"] as const;
export type ContextMethod = (typeof CONTEXT_METHODS)[number];

export type PendingContext =
  | {
      kind: "need_context";
      type?: string;
      question?: string;
      requested?: string[];
      reason?: string;
      [key: string]: unknown;
    }
  | {
      kind: "need_method";
      type: string;
      question?: string;
      requested?: string[];
      reason?: string;
      [key: string]: unknown;
    }
  | {
      // compatibility with simple pending objects
      kind?: string;
      question?: string;
      requested?: string[];
      reason?: string;
      type?: string;
      [key: string]: unknown;
    };

export interface ParsedContextReply {
  skip?: boolean;
  source?: string;
  method?: string;
  envRef?: string;
  id?: string;
  server?: string;
  text?: string;
}

export interface AgentOptions {
  goal: string;
  personasDir?: string;
  initialArgs?: string[];
  initialEnv?: Record<string, string | undefined>;
  maxIterations?: number;
  minHarnessRuns?: number;
  /** Persist/resume agent state under this root (uses <cwd>/.lemma/agent). */
  cwd?: string;
  /** Stable key for persisted state across invocations. Defaults to goal+initial args signature. */
  stateKey?: string;
  /** Session identifier stored in persisted state. */
  sessionID?: string;
  /** User reply/context text to apply when resuming a pending context request. */
  userInput?: string;
  /** Enable interactive in-session context wait when requestUserInput is available. */
  interactive?: boolean;
}

export interface AgentState {
  testPlan: string;
  executedCommands: string[];
  runSummaries: string[];
  currentReport: string;
  /** Total completed harness-execution iterations including initial run. */
  iteration: number;
  /** Total loop/consultation steps consumed (including initial run step). */
  step: number;
  pending?: PendingContext | null;
  contextLog?: string[];
  sessionID?: string;
  runIds?: string[];
}

export interface PersistedAgentState extends AgentState {
  version: 1;
  key: string;
  goal: string;
  initialArgs?: string[];
  initialDone: boolean;
  updatedAt: string;
}

export type AgentDecision =
  | { type: "need_user_context"; test_plan?: string; need_user_context: Record<string, unknown>; reason?: string }
  | { type: "command"; test_plan?: string; command: string; reason?: string }
  | { type: "done"; test_plan?: string; summary?: string; fixes?: string[]; reason?: string }
  | { type: "invalid"; raw: string };

export const DEFAULT_MAX_ITERATIONS = 7;
export const DEFAULT_MIN_HARNESS_RUNS = 1;
export const AGENT_STATE_VERSION = 1 as const;

export const ALLOWED_COMMANDS = ["run", "report", "status", "abort", "assay-browser", "assay-demo"] as const;
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+-]+=*/gi;
const SENSITIVE_KV = /\b(authorization|cookie|token|secret|password|api[_-]?key|session|bearer)\b\s*[:=]\s*("?)([^\s,;"'\n]+)("?)/gi;

export function redactTranscriptText(value: string): string {
  return String(value || "")
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SENSITIVE_KV, (_m, key: string, q1: string, _val: string, q2: string) => `${key}=${q1}[REDACTED]${q2}`);
}

export function parseDecision(text: string): AgentDecision {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { type: "invalid", raw: text };
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const test_plan = typeof obj.test_plan === "string" ? obj.test_plan : undefined;
    if (obj.need_user_context && typeof obj.need_user_context === "object") {
      return {
        type: "need_user_context",
        ...(test_plan !== undefined ? { test_plan } : {}),
        need_user_context: obj.need_user_context as Record<string, unknown>,
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      };
    }
    if (typeof obj.command === "string") {
      return {
        type: "command",
        ...(test_plan !== undefined ? { test_plan } : {}),
        command: obj.command.trim(),
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      };
    }
    if (obj.done === true) {
      const fixes = Array.isArray(obj.fixes) ? obj.fixes.filter((f): f is string => typeof f === "string") : [];
      return {
        type: "done",
        ...(test_plan !== undefined ? { test_plan } : {}),
        ...(typeof obj.summary === "string" ? { summary: obj.summary } : {}),
        fixes,
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      };
    }
    return { type: "invalid", raw: text };
  } catch {
    return { type: "invalid", raw: text };
  }
}

export function isAllowedCommand(command: string): boolean {
  return /^(run|report|status|abort|assay-browser|assay-demo)\b/.test(command.trim());
}

export function commandToArgs(command: string, personasDir = "personas"): HarnessInvocation {
  const trimmed = command.trim();
  if (!trimmed) return { args: [], error: "Empty command" };

  if (trimmed === "assay-browser" || trimmed.startsWith("assay-browser ")) {
    return browserInvocation(trimmed.slice("assay-browser".length).trim(), personasDir);
  }
  if (trimmed === "assay-demo" || trimmed.startsWith("assay-demo ")) {
    return demoInvocation(trimmed.slice("assay-demo".length).trim(), personasDir);
  }
  if (trimmed === "assay" || trimmed.startsWith("assay ")) {
    const rest = trimmed === "assay" ? "" : trimmed.slice("assay ".length).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { args: ["run", "--target", ".", "--no-browser", "--personas-dir", personasDir] };
    const first = tokens[0] ?? "";
    if (first === "--version" || first === "-v") return { args: ["--version"] };
    if (first === "help" || first === "--help" || first === "-h") return { args: ["--help"] };
    // passthrough known subcommands as tokenized
    if (/^(run|status|report|abort|personas|verify-evidence|auth|quota|ledger|signup|billing|calibrate|sarif|junit|sign-report|verify-report|prune)$/.test(first)) {
      return { args: tokens };
    }
    const urlMatch = /https?:\/\/[^\s"'`<>]+/i.exec(rest);
    const url = urlMatch ? urlMatch[0].replace(/[),.;:!?]+$/g, "") : null;
    if (url) return { args: ["run", "--target", url, "--personas-dir", personasDir, "--intent", rest] };
    return { args: ["run", "--target", ".", "--no-browser", "--personas-dir", personasDir, "--intent", rest] };
  }

  return { args: trimmed.split(/\s+/).filter(Boolean) };
}

export function commandSignature(args: string[], env?: Record<string, string | undefined>): string {
  const relevantEnv = env?.QH_SSRF_ALLOWLIST ? `|QH_SSRF_ALLOWLIST=${env.QH_SSRF_ALLOWLIST}` : "";
  return `${args.join(" ")}${relevantEnv}`;
}

export function agentStateKey(options: Pick<AgentOptions, "goal" | "initialArgs" | "stateKey">): string {
  if (options.stateKey) return options.stateKey;
  return `${options.goal}|${JSON.stringify(options.initialArgs ?? [])}`;
}

export function agentStatePath(cwd: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(cwd, ".lemma", "agent", `${hash}.json`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function loadAgentState(cwd: string, key: string): Promise<PersistedAgentState | null> {
  const p = agentStatePath(cwd, key);
  try {
    const raw = await readJsonFile<unknown>(p);
    if (!isRecord(raw)) return null;
    if (raw.version !== AGENT_STATE_VERSION) return null;
    if (raw.key !== key) return null;
    if (typeof raw.goal !== "string") return null;
    const state: PersistedAgentState = {
      version: 1,
      key,
      goal: raw.goal,
      testPlan: typeof raw.testPlan === "string" ? raw.testPlan : "",
      executedCommands: asStringArray(raw.executedCommands),
      runSummaries: asStringArray(raw.runSummaries),
      currentReport: typeof raw.currentReport === "string" ? raw.currentReport : "",
      iteration: typeof raw.iteration === "number" && Number.isFinite(raw.iteration) ? raw.iteration : 0,
      step: typeof raw.step === "number" && Number.isFinite(raw.step) ? raw.step : 0,
      pending: raw.pending && isRecord(raw.pending) ? raw.pending : null,
      contextLog: asStringArray(raw.contextLog),
      runIds: asStringArray(raw.runIds),
      ...(typeof raw.sessionID === "string" ? { sessionID: raw.sessionID } : {}),
      ...(Array.isArray(raw.initialArgs) && raw.initialArgs.every((x) => typeof x === "string") ? { initialArgs: raw.initialArgs } : {}),
      initialDone: raw.initialDone === true,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
    return state;
  } catch {
    return null;
  }
}

function sanitizeForPersistence(state: PersistedAgentState): PersistedAgentState {
  return {
    ...state,
    currentReport: redactTranscriptText(state.currentReport),
    runSummaries: state.runSummaries.map((s) => redactTranscriptText(s)),
    contextLog: (state.contextLog ?? []).map((s) => redactTranscriptText(s)),
    pending: state.pending
      ? (JSON.parse(redactTranscriptText(JSON.stringify(state.pending))) as PendingContext | null)
      : null,
    updatedAt: new Date().toISOString(),
  };
}

export async function saveAgentState(cwd: string, state: PersistedAgentState): Promise<string> {
  const p = agentStatePath(cwd, state.key);
  await ensureDir(path.dirname(p));
  await atomicWriteJson(p, sanitizeForPersistence(state));
  return p;
}

// ---- Context protocol (LEM-091) ----

export function isContextReply(input: string): boolean {
  const raw = String(input || "");
  const lower = raw.trim().toLowerCase();
  return (
    /\[context:skip\]/i.test(raw) ||
    /\[?source\s*[:=]\s*(?:jira|slack|github|doc|url|text)\]?/i.test(raw) ||
    /\[?method\s*[:=]\s*(?:paste|mcp|token|secret-ref|secret_ref)\]?/i.test(raw) ||
    /\[(?:env|secret_ref|secret-ref|id|server|mcp_server|mcp-server)\s*:/i.test(raw) ||
    /\bskip\s+context\b/i.test(lower) ||
    /^(skip|none|no|n\/a|na)$/i.test(raw.trim())
  );
}

export function parseContextReply(input: string): ParsedContextReply {
  const raw = String(input || "");
  const lower = raw.trim().toLowerCase();
  const out: ParsedContextReply = {};
  if (/\[context:skip\]/i.test(raw) || /\bskip\s+context\b/i.test(lower) || /^(skip|none|no|n\/a|na)$/i.test(raw.trim())) out.skip = true;
  const sourceM =
    raw.match(/\[?source\s*[:=]\s*(jira|slack|github|doc|url|text)\]?/i) ||
    lower.match(/\bsource\s*[:=]\s*(jira|slack|github|doc|url|text)\b/i);
  if (sourceM?.[1]) out.source = sourceM[1].toLowerCase();
  const methodM =
    raw.match(/\[?method\s*[:=]\s*(paste|mcp|token|secret-ref|secret_ref)\]?/i) ||
    lower.match(/\bmethod\s*[:=]\s*(paste|mcp|token|secret-ref|secret_ref)\b/i);
  if (methodM?.[1]) {
    const m = methodM[1].toLowerCase();
    out.method = m === "secret-ref" || m === "secret_ref" ? "token" : m;
  }
  const envM = raw.match(/\[?(?:env|secret_ref|secret-ref)\s*:\s*([^\]\s]+)\]?/i);
  if (envM?.[1]) out.envRef = envM[1].trim();
  const idM = raw.match(/\[?id\s*:\s*([^\]\s]+)\]?/i);
  if (idM?.[1]) out.id = idM[1].trim();
  const serverM = raw.match(/\[?(?:server|mcp_server|mcp-server)\s*:\s*([^\]\s]+)\]?/i);
  if (serverM?.[1]) out.server = serverM[1].trim();
  const text = raw
    .replace(/\[(?:[^\]]*(?:context|source|method|env|secret_ref|secret-ref|id|server|mcp_server|mcp-server)\s*:[^\]]*)\]/gi, "")
    .replace(/\bsource\s*[:=]\s*(?:jira|slack|github|doc|url|text)\b/gi, "")
    .replace(/\bmethod\s*[:=]\s*(?:paste|mcp|token|secret-ref|secret_ref)\b/gi, "")
    .replace(/\bskip\s+context\b/gi, "")
    .trim();
  if (text) out.text = redactTranscriptText(text);
  return out;
}

export function formatContextRequest(pending: PendingContext, goal: string, mcpResources: string[] = []): string {
  const kind = pending.kind === "need_method" ? "need_method" : "need_context";
  const requestedType = String(pending.type || "jira").toLowerCase();
  const type = (CONTEXT_SOURCES as readonly string[]).includes(requestedType) ? requestedType : "text";
  const question = String(pending.question || "Additional context is needed before the next step.");
  const requested = Array.isArray(pending.requested) && pending.requested.length
    ? pending.requested.map((x) => `- ${String(x)}`)
    : ["- Relevant acceptance criteria, flows, expected behavior, or constraints"];
  const reason = String(pending.reason || "Current evidence is insufficient to plan precise verification.");
  const mcpSection = mcpResources.length
    ? `\n## Available MCP resources (if relevant)\n${mcpResources.map((r) => `- ${redactTranscriptText(String(r))}`).join("\n")}`
    : `\n## Available MCP resources\n- None discovered in this session.`;

  if (kind === "need_method") {
    return `## How would you like to provide ${type} context?

**Goal/intent:** ${goal}
**Source selected:** ${type}
**Why:** ${reason}

**Question:** ${question}

## Suggested details
${requested.join("\n")}
${mcpSection}

## Choose a method (reply in this chat)
1. **Plain text paste (recommended):** reply with \`[source:${type} method:paste] <paste the context here>\`
2. **Connect via MCP:** reply with \`[source:${type} method:mcp server:<name> id:<identifier>]\` (provide exact ID/URL/resource)
3. **Safely submitted API token (opt-in):** reply with \`[source:${type} method:token env:<ENV_VAR_OR_SECRET_REF> id:<identifier>]\` — do **not** paste tokens/secrets into chat.
4. **Skip this context:** reply with \`[context:skip]\``;
  }

  return `## Context requested before next step

**Goal/intent:** ${goal}
**Suggested source (priority):** ${type} (order: Jira → Slack → GitHub → Doc → URL/Text)
**Why:** ${reason}

**Question:** ${question}

## Suggested details
${requested.join("\n")}
${mcpSection}

## Your choice (reply in this chat)
1. **Skip this context:** reply with \`[context:skip]\`
2. **Provide context** (choose source: Jira/Slack/GitHub/Doc/URL/Text), e.g.:
   - \`[source:jira] <brief note>\`
   - \`[source:jira method:paste] <paste AC/story>\`
   - \`[source:slack method:mcp server:<name> id:<thread>]\`

## Method options when providing third-party context
- **Plain text paste (recommended)**, **MCP**, or **secure env/secret reference** (never paste secrets).`;
}

export interface ApplyContextResult {
  progressed: boolean;
  message?: string;
}

export function applyContextResponse(state: AgentState, input: string): ApplyContextResult {
  if (!state.pending) return { progressed: false };
  const resp = parseContextReply(input);
  const raw = String(input || "").trim();
  const pending = state.pending;
  const kind = pending.kind === "need_method" ? "need_method" : "need_context";
  if (!Array.isArray(state.contextLog)) state.contextLog = [];

  if (kind === "need_method") {
    if (resp.skip) {
      state.contextLog.push(`step ${state.step}: ${String(pending.type || "context")} context skipped by user`);
      state.pending = null;
      state.step += 1;
      return { progressed: true };
    }
    let method = resp.method;
    if (!method) {
      const lower = raw.toLowerCase();
      if (/^(paste|text)$/.test(lower)) method = "paste";
      else if (/^(mcp)$/.test(lower)) method = "mcp";
      else if (/^(token|api token)$/.test(lower)) method = "token";
      else if (resp.text || (raw && !/^\[/.test(raw))) method = "paste";
    }
    if (!method) {
      return { progressed: false, message: "Please choose a method: paste, mcp, or token (secure env ref), or reply `skip`." };
    }
    const type = String(pending.type || resp.source || "text");
    if (method === "token") {
      state.contextLog.push(`step ${state.step}: ${type} context via token/secret-ref (${resp.envRef || "env ref not provided"}${resp.id ? ", id provided" : ""})`);
    } else if (method === "mcp") {
      state.contextLog.push(`step ${state.step}: ${type} context via MCP (server=${resp.server || "?"}, id=${resp.id || "?"})${resp.text ? ` note=${redactTranscriptText(resp.text).slice(0, 200)}` : ""}`);
    } else {
      const snippet = redactTranscriptText(resp.text || raw).slice(0, 800);
      state.contextLog.push(`step ${state.step}: ${type} context via paste${snippet ? `: ${snippet}` : ""}`);
    }
    state.pending = null;
    state.step += 1;
    return { progressed: true };
  }

  // need_context
  if (resp.skip) {
    state.contextLog.push(`step ${state.step}: context skipped by user`);
    state.pending = null;
    state.step += 1;
    return { progressed: true };
  }
  const source = resp.source || String(pending.type || "text");
  const hasFreeText = !!(resp.text && !resp.method);
  if (!resp.method && hasFreeText) {
    state.contextLog.push(`step ${state.step}: ${source} context via paste: ${redactTranscriptText(resp.text || "").slice(0, 800)}`);
    state.pending = null;
    state.step += 1;
    return { progressed: true };
  }
  if (!resp.method) {
    const next: PendingContext = { kind: "need_method", type: source };
    if (typeof pending.question === "string") next.question = pending.question;
    if (Array.isArray(pending.requested)) next.requested = pending.requested;
    if (typeof pending.reason === "string") next.reason = pending.reason;
    state.pending = next;
    return { progressed: true };
  }
  // source + method provided together -> treat as method stage with source
  const next: PendingContext = { kind: "need_method", type: source };
  if (typeof pending.question === "string") next.question = pending.question;
  if (Array.isArray(pending.requested)) next.requested = pending.requested;
  if (typeof pending.reason === "string") next.reason = pending.reason;
  state.pending = next;
  return applyContextResponse(state, input);
}

function toMcpLabel(entry: unknown, prefix: "resource" | "template"): string | null {
  if (typeof entry === "string") {
    const s = redactTranscriptText(entry).trim();
    return s || null;
  }
  if (!isRecord(entry)) return null;
  const server = typeof entry.server === "string" && entry.server ? entry.server : "?";
  const name =
    (typeof entry.name === "string" && entry.name) ||
    (typeof entry.uri === "string" && entry.uri) ||
    (typeof entry.uriTemplate === "string" && entry.uriTemplate) ||
    "?";
  return `${prefix}: ${redactTranscriptText(server)}/${redactTranscriptText(name)}`;
}

/**
 * Normalize heterogeneous MCP resource listing results into bounded, redacted display strings.
 * Accepts display-string arrays or raw listing shapes (resources/resourceTemplates/templates),
 * including common nested `data` wrappers.
 */
export function normalizeMcpResourceEntries(value: unknown, limit = 30): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const s = redactTranscriptText(item).trim();
        if (s) out.push(s);
      } else {
        const label = toMcpLabel(item, "resource");
        if (label) out.push(label);
      }
      if (out.length >= limit) return out;
    }
    return out;
  }
  if (!isRecord(value)) return [];

  const obj = value;
  const data = isRecord(obj.data) ? obj.data : undefined;
  const resourcesRaw = Array.isArray(obj.resources)
    ? obj.resources
    : data && Array.isArray(data.resources)
      ? data.resources
      : [];
  const templatesRaw = Array.isArray(obj.resourceTemplates)
    ? obj.resourceTemplates
    : Array.isArray(obj.templates)
      ? obj.templates
      : data && Array.isArray(data.resourceTemplates)
        ? data.resourceTemplates
        : data && Array.isArray(data.templates)
          ? data.templates
          : [];

  const out: string[] = [];
  for (const item of resourcesRaw) {
    const label = toMcpLabel(item, "resource");
    if (label) out.push(label);
    if (out.length >= limit) return out;
  }
  for (const item of templatesRaw) {
    const label = toMcpLabel(item, "template");
    if (label) out.push(label);
    if (out.length >= limit) return out;
  }

  // Fallback: some hosts may return a single wrapped list
  if (out.length === 0 && Array.isArray(obj.data)) return normalizeMcpResourceEntries(obj.data, limit);
  return out;
}

export async function discoverMcpResources(
  deps: Pick<AgentDeps, "listMcpResources"> | (() => Promise<unknown>) | undefined,
): Promise<string[]> {
  try {
    const fn = typeof deps === "function" ? deps : deps?.listMcpResources;
    if (!fn) return [];
    const items = await fn();
    return normalizeMcpResourceEntries(items, 30);
  } catch {
    // ignore discovery failures
  }
  return [];
}

// ---- Loop ----

function defaultInitialArgs(goal: string, personasDir: string): string[] {
  return ["run", "--target", ".", "--personas-dir", personasDir, "--intent", goal];
}

function buildPrompt(options: AgentOptions, state: AgentState, executed: Set<string>): string {
  const goal = options.goal;
  const planSection = state.testPlan ? `\nTest plan:\n${state.testPlan}\n` : "\nTest plan: (none)\n";
  const report = state.currentReport.length > 12000 ? `${state.currentReport.slice(0, 12000)}\n...[truncated]` : state.currentReport;
  const ctx = (state.contextLog ?? []).length ? `\nContext decisions:\n${(state.contextLog ?? []).map((c) => `- ${c}`).join("\n")}\n` : "";
  return `You are a strict assay judge for the quality-harness agent. Goal: ${goal}

Latest harness report:
${report || "(none)"}
${planSection}${ctx}
Executed commands so far (DO NOT repeat any of these): ${Array.from(executed).join(" || ") || "(none)"}

Rules:
- NEVER run the same test/command again. No two iterations may execute the same command/args.
- Only choose commands from the allowlist: run, report, status, abort, assay-browser, assay-demo.
- Prefer a UNIQUE command that adds evidence. Reject duplicate commands.
- Request user context when needed (source/method/skip) instead of guessing. Use need_user_context to ask for context before the next unique step.
- Do not submit real forms/transactions, create accounts, brute-force, or access other tenants' data.

Allowed commands (must be unique/not previously executed): run, assay-browser, assay-demo, report, status, abort.

Output ONLY one JSON object, no markdown:
{"command":"<full NEW command>","reason":"<why this unique step adds evidence>"}
or
{"need_user_context":{"type":"jira|slack|github|doc|url|text","question":"<what to provide or skip>","requested":["<specific items>"]},"reason":"<why>"}
or
{"done":true,"summary":"<assessment>","fixes":["<fix>"]}`;
}

async function maybePersist(cwd: string | undefined, state: PersistedAgentState | null): Promise<void> {
  if (!cwd || !state) return;
  await saveAgentState(cwd, state);
}

async function requestContextAndMaybeWait(
  state: PersistedAgentState,
  goal: string,
  deps: AgentDeps,
  options: AgentOptions,
): Promise<boolean> {
  const sendFinal = deps.sendFinal ?? (async () => {});
  const cwd = options.cwd;
  const resources = await discoverMcpResources(deps);
  const pending = state.pending;
  if (!pending) return false;
  await sendFinal(formatContextRequest(pending, goal, resources));
  await maybePersist(cwd, state);

  if (options.interactive && deps.requestUserInput) {
    while (state.pending) {
      const reply = await deps.requestUserInput("awaiting context");
      if (String(reply) === "__ASSAY_WAIT_TIMEOUT__") {
        await sendFinal("Still waiting for your reply in this chat to continue. Reply with `skip`, paste context, or a `[source:... method:...]` tag.");
        await maybePersist(cwd, state);
        return false;
      }
      const applied = applyContextResponse(state, String(reply || ""));
      await maybePersist(cwd, state);
      if (applied.message) {
        await sendFinal(applied.message);
        await maybePersist(cwd, state);
        continue;
      }
      if (applied.progressed) return true;
      if (state.pending) await sendFinal(formatContextRequest(state.pending, goal, await discoverMcpResources(deps)));
      await maybePersist(cwd, state);
    }
    return true;
  }
  return false;
}

export async function runStrictJudgeLoop(options: AgentOptions, deps: AgentDeps): Promise<AgentState> {
  const maxIterations = Math.max(1, Math.min(options.maxIterations ?? DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS));
  const minHarnessRuns = Math.max(1, options.minHarnessRuns ?? DEFAULT_MIN_HARNESS_RUNS);
  const personasDir = options.personasDir ?? "personas";
  const log = deps.progress ?? (() => {});
  const sendFinal = deps.sendFinal ?? (async () => {});
  const key = agentStateKey(options);
  const cwd = options.cwd;
  const userInput = String(options.userInput || "");

  let persisted: PersistedAgentState | null = null;
  if (cwd) {
    const loaded = await loadAgentState(cwd, key);
    if (loaded) {
      const hasContextResponse = isContextReply(userInput) || !!userInput.trim();
      // Fresh interactive invocation without an explicit reply should not resume stale pending state.
      if (options.interactive && loaded.pending && !hasContextResponse) {
        persisted = null;
      } else {
        persisted = loaded;
        if (options.sessionID) persisted.sessionID = options.sessionID;
        if (userInput) {
          applyContextResponse(persisted, userInput);
        }
      }
    }
  }

  const initialArgs = options.initialArgs ?? persisted?.initialArgs ?? defaultInitialArgs(options.goal, personasDir);
  const state: PersistedAgentState = persisted ?? {
    version: 1,
    key,
    goal: options.goal,
    testPlan: "",
    executedCommands: [],
    runSummaries: [],
    currentReport: "",
    iteration: 0,
    step: 0,
    pending: null,
    contextLog: [],
    runIds: [],
    ...(options.sessionID ? { sessionID: options.sessionID } : {}),
    initialArgs,
    initialDone: false,
    updatedAt: new Date().toISOString(),
  };

  const executed = new Set<string>(state.executedCommands);

  if (state.pending) {
    const continued = await requestContextAndMaybeWait(state, options.goal, deps, options);
    if (!continued) return state;
  }

  if (!state.initialDone) {
    const initialSig = commandSignature(initialArgs, options.initialEnv);
    if (!executed.has(initialSig)) {
      log("Iteration 1: running initial assessment...");
      executed.add(initialSig);
      state.executedCommands = [...executed];
      const output = await deps.runHarness(initialArgs, options.initialEnv);
      state.currentReport = output;
      state.runSummaries.push(`Command: ${initialArgs.join(" ")}\n${output}`);
    } else {
      state.runSummaries.push(`NOTE: initial command already executed: ${initialArgs.join(" ")}`);
    }
    state.initialDone = true;
    state.iteration = Math.max(state.iteration, 1);
    state.step = Math.max(state.step, 1);
    await maybePersist(cwd, state);
  }

  while (state.step < maxIterations) {
    if (state.pending) {
      const continued = await requestContextAndMaybeWait(state, options.goal, deps, options);
      if (!continued) return state;
    }

    log(`Iteration ${state.step + 1}: consulting strict judge...`);
    const prompt = buildPrompt(options, state, executed);
    let llmText = "";
    try {
      llmText = await deps.askLlm(prompt);
    } catch {
      state.step += 1;
      await maybePersist(cwd, state);
      break;
    }
    const decision = parseDecision(llmText);
    if (decision.type === "invalid") {
      log("Could not parse LLM decision; stopping.");
      state.step += 1;
      await maybePersist(cwd, state);
      break;
    }
    if (decision.test_plan && decision.test_plan.trim()) {
      state.testPlan = decision.test_plan.trim();
    }

    if (decision.type === "done") {
      if (state.iteration < minHarnessRuns) {
        log(`Rejecting early completion (${state.iteration}/${minHarnessRuns} runs).`);
        state.pending = {
          kind: "need_context",
          type: "jira",
          question: "More evidence is required before finishing. Provide context for the next unique step or skip.",
          requested: ["Acceptance criteria / expected behavior", "Areas to prioritize next"],
          reason: `Completion rejected: only ${state.iteration} of ${minHarnessRuns} required harness run(s) completed.`,
        };
        await maybePersist(cwd, state);
        const continued = await requestContextAndMaybeWait(state, options.goal, deps, options);
        if (!continued) return state;
        continue;
      }
      const fixes = decision.fixes ?? [];
      await sendFinal(`${decision.summary ?? "Assessment complete."}\n\n## Suggested fixes\n${fixes.map((f) => `- ${f}`).join("\n") || "- (none)"}`);
      await maybePersist(cwd, state);
      return state;
    }

    if (decision.type === "need_user_context") {
      const ctx = decision.need_user_context ?? {};
      const typeVal = typeof ctx.type === "string" ? ctx.type : "jira";
      const questionVal = typeof ctx.question === "string" ? ctx.question : "What context can you provide for the next step?";
      const requestedVal = Array.isArray(ctx.requested) ? ctx.requested.map(String) : [];
      state.pending = {
        kind: "need_context",
        type: typeVal,
        question: questionVal,
        requested: requestedVal,
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      await maybePersist(cwd, state);
      const continued = await requestContextAndMaybeWait(state, options.goal, deps, options);
      if (!continued) return state;
      continue;
    }

    const cmd = decision.command.trim();
    if (!cmd) {
      log("Empty command; stopping.");
      state.step += 1;
      await maybePersist(cwd, state);
      break;
    }
    if (!isAllowedCommand(cmd)) {
      log(`Rejected disallowed command: ${cmd}`);
      state.runSummaries.push(`NOTE: rejected disallowed command: ${cmd}`);
      state.step += 1;
      await maybePersist(cwd, state);
      continue;
    }
    const invocation = commandToArgs(cmd, personasDir);
    if (invocation.error) {
      log(invocation.error);
      state.runSummaries.push(`NOTE: command error: ${cmd}: ${invocation.error}`);
      state.step += 1;
      await maybePersist(cwd, state);
      continue;
    }
    const sig = commandSignature(invocation.args, invocation.env);
    if (executed.has(sig)) {
      log(`Skipping duplicate command (already executed): ${cmd}`);
      state.runSummaries.push(`NOTE: duplicate skipped: ${cmd}`);
      state.step += 1;
      await maybePersist(cwd, state);
      continue;
    }

    log(`Executing unique step: ${cmd}`);
    executed.add(sig);
    state.executedCommands = [...executed];
    const output = await deps.runHarness(invocation.args, invocation.env);
    state.currentReport = output;
    state.runSummaries.push(`Command: ${cmd}\n${output}`);
    state.iteration += 1;
    state.step += 1;
    await maybePersist(cwd, state);
  }

  await sendFinal(`Agent reached iteration cap (${maxIterations}).`);
  await maybePersist(cwd, state);
  return state;
}
