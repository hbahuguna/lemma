/**
 * @lemma/agent — Host-neutral agent loop and command catalog.
 *
 * LEM-086: strict-judge loop core (cap 7, allowlist, dedupe).
 * LEM-087: persisted agent state and in-session resume.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { atomicWriteJson, ensureDir, readJsonFile } from "@lemma/core";

export const PACKAGE_NAME = "@lemma/agent" as const;

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
}

export interface PendingContext {
  question?: string;
  requested?: string[];
  reason?: string;
  type?: string;
  [key: string]: unknown;
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
  if (trimmed === "assay-browser") {
    return { args: ["run", "--personas-dir", personasDir], error: "assay-browser requires an explicit URL target" };
  }
  if (trimmed.startsWith("assay-browser ")) {
    const rest = trimmed.slice("assay-browser ".length).trim();
    if (!/^https?:\/\//i.test(rest.split(/\s+/)[0] ?? "")) {
      return { args: [], error: "assay-browser requires an explicit http(s) URL target" };
    }
    const parts = rest.split(/\s+/).filter(Boolean);
    const url = parts[0] ?? rest;
    return { args: ["run", "--target", url, "--personas-dir", personasDir] };
  }
  if (trimmed === "assay-demo" || trimmed.startsWith("assay-demo ")) {
    const rest = trimmed === "assay-demo" ? "" : trimmed.slice("assay-demo ".length).trim();
    return { args: ["run", ...(rest ? rest.split(/\s+/).filter(Boolean) : ["--target", "."]), "--personas-dir", personasDir] };
  }
  if (trimmed === "assay") return { args: ["run", "--target", ".", "--personas-dir", personasDir] };
  if (trimmed.startsWith("assay ")) {
    const rest = trimmed.slice("assay ".length).trim();
    return { args: ["run", ...rest.split(/\s+/).filter(Boolean), "--personas-dir", personasDir] };
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
      ? (JSON.parse(redactTranscriptText(JSON.stringify(state.pending))) as PendingContext)
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
- Do not submit real forms/transactions, create accounts, brute-force, or access other tenants' data.

Allowed commands (must be unique/not previously executed): run, assay-browser, assay-demo, report, status, abort.

Output ONLY one JSON object, no markdown:
{"command":"<full NEW command>","reason":"<why this unique step adds evidence>"}
or
{"need_user_context":{"question":"<what is needed>"},"reason":"<why>"}
or
{"done":true,"summary":"<assessment>","fixes":["<fix>"]}`;
}

function applyPendingInput(state: PersistedAgentState, input: string): { progressed: boolean } {
  if (!state.pending) return { progressed: false };
  const raw = String(input ?? "").trim();
  if (!raw) return { progressed: false };
  const lower = raw.toLowerCase();
  const skip = /\[context:skip\]/i.test(raw) || /\bskip\s+context\b/i.test(lower) || /^(skip|none|no|n\/a|na)$/i.test(lower);
  const snippet = redactTranscriptText(raw).slice(0, 800);
  if (!Array.isArray(state.contextLog)) state.contextLog = [];
  if (skip) {
    state.contextLog.push(`step ${state.step}: context skipped by user`);
  } else {
    state.contextLog.push(`step ${state.step}: context provided: ${snippet}`);
  }
  state.pending = null;
  // consuming a reply progresses the loop step so we don't re-ask forever
  state.step += 1;
  return { progressed: true };
}

async function maybePersist(cwd: string | undefined, state: PersistedAgentState | null): Promise<void> {
  if (!cwd || !state) return;
  await saveAgentState(cwd, state);
}

export async function runStrictJudgeLoop(options: AgentOptions, deps: AgentDeps): Promise<AgentState> {
  const maxIterations = Math.max(1, Math.min(options.maxIterations ?? DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS));
  const minHarnessRuns = Math.max(1, options.minHarnessRuns ?? DEFAULT_MIN_HARNESS_RUNS);
  const personasDir = options.personasDir ?? "personas";
  const log = deps.progress ?? (() => {});
  const sendFinal = deps.sendFinal ?? (async () => {});
  const key = agentStateKey(options);
  const cwd = options.cwd;

  let persisted: PersistedAgentState | null = null;
  if (cwd) {
    const loaded = await loadAgentState(cwd, key);
    if (loaded) {
      persisted = loaded;
      if (options.sessionID) persisted.sessionID = options.sessionID;
      if (options.userInput) {
        applyPendingInput(persisted, options.userInput);
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
    ...(options.sessionID ? { sessionID: options.sessionID } : {}),
    initialArgs,
    initialDone: false,
    updatedAt: new Date().toISOString(),
  };

  const executed = new Set<string>(state.executedCommands);

  // if we just resumed and pending cleared, continue loop; if still pending, report and pause
  if (state.pending) {
    await sendFinal(`Context requested: ${JSON.stringify(state.pending)}`);
    await maybePersist(cwd, state);
    return state;
  }

  // initial run (counts toward harness runs/cap and dedupe) unless already done
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
      await sendFinal(`Context requested: ${JSON.stringify(state.pending)}`);
      await maybePersist(cwd, state);
      return state;
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
        state.step += 1;
        await maybePersist(cwd, state);
        break;
      }
      const fixes = decision.fixes ?? [];
      await sendFinal(`${decision.summary ?? "Assessment complete."}\n\n## Suggested fixes\n${fixes.map((f) => `- ${f}`).join("\n") || "- (none)"}`);
      await maybePersist(cwd, state);
      return state;
    }

    if (decision.type === "need_user_context") {
      state.pending = { ...(decision.need_user_context as PendingContext) };
      await sendFinal(`Context requested: ${JSON.stringify(state.pending)}`);
      await maybePersist(cwd, state);
      return state;
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
