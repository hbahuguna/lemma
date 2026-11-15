/**
 * @lemma/agent — Host-neutral agent loop and command catalog.
 *
 * LEM-086 ports the strict-judge loop core: bounded iterations (cap 7),
 * command allowlist enforcement, and executed-command dedupe.
 */

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

export interface AgentOptions {
  goal: string;
  personasDir?: string;
  initialArgs?: string[];
  initialEnv?: Record<string, string | undefined>;
  maxIterations?: number;
  minHarnessRuns?: number;
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
}

export type AgentDecision =
  | { type: "need_user_context"; test_plan?: string; need_user_context: Record<string, unknown>; reason?: string }
  | { type: "command"; test_plan?: string; command: string; reason?: string }
  | { type: "done"; test_plan?: string; summary?: string; fixes?: string[]; reason?: string }
  | { type: "invalid"; raw: string };

export const DEFAULT_MAX_ITERATIONS = 7;
export const DEFAULT_MIN_HARNESS_RUNS = 1;

export const ALLOWED_COMMANDS = ["run", "report", "status", "abort", "assay-browser", "assay-demo"] as const;
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

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

function defaultInitialArgs(goal: string, personasDir: string): string[] {
  return ["run", "--target", ".", "--personas-dir", personasDir, "--intent", goal];
}

function buildPrompt(options: AgentOptions, state: AgentState, executed: Set<string>): string {
  const goal = options.goal;
  const planSection = state.testPlan ? `\nTest plan:\n${state.testPlan}\n` : "\nTest plan: (none)\n";
  // cap prompt size to avoid runaway growth
  const report = state.currentReport.length > 12000 ? `${state.currentReport.slice(0, 12000)}\n...[truncated]` : state.currentReport;
  return `You are a strict assay judge for the quality-harness agent. Goal: ${goal}

Latest harness report:
${report || "(none)"}
${planSection}
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

export async function runStrictJudgeLoop(options: AgentOptions, deps: AgentDeps): Promise<AgentState> {
  const maxIterations = Math.max(1, Math.min(options.maxIterations ?? DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS));
  const minHarnessRuns = Math.max(1, options.minHarnessRuns ?? DEFAULT_MIN_HARNESS_RUNS);
  const personasDir = options.personasDir ?? "personas";
  const log = deps.progress ?? (() => {});
  const sendFinal = deps.sendFinal ?? (async () => {});
  const state: AgentState = {
    testPlan: "",
    executedCommands: [],
    runSummaries: [],
    currentReport: "",
    iteration: 0,
    step: 0,
  };
  const executed = new Set<string>();

  // initial run (counts toward harness runs/cap and dedupe)
  const initialArgs = options.initialArgs ?? defaultInitialArgs(options.goal, personasDir);
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
  state.iteration = 1;
  state.step = 1;

  // bounded loop: total steps (including initial) capped at maxIterations
  while (state.step < maxIterations) {
    log(`Iteration ${state.step + 1}: consulting strict judge...`);
    const prompt = buildPrompt(options, state, executed);
    let llmText = "";
    try {
      llmText = await deps.askLlm(prompt);
    } catch {
      state.step += 1;
      break;
    }
    const decision = parseDecision(llmText);
    if (decision.type === "invalid") {
      log("Could not parse LLM decision; stopping.");
      state.step += 1;
      break;
    }
    if (decision.test_plan && decision.test_plan.trim()) {
      state.testPlan = decision.test_plan.trim();
    }

    if (decision.type === "done") {
      if (state.iteration < minHarnessRuns) {
        log(`Rejecting early completion (${state.iteration}/${minHarnessRuns} runs).`);
        state.step += 1;
        break;
      }
      const fixes = decision.fixes ?? [];
      await sendFinal(`${decision.summary ?? "Assessment complete."}\n\n## Suggested fixes\n${fixes.map((f) => `- ${f}`).join("\n") || "- (none)"}`);
      return state;
    }

    if (decision.type === "need_user_context") {
      await sendFinal(`Context requested: ${JSON.stringify(decision.need_user_context)}`);
      state.step += 1;
      return state;
    }

    // command
    const cmd = decision.command.trim();
    if (!cmd) {
      log("Empty command; stopping.");
      state.step += 1;
      break;
    }
    if (!isAllowedCommand(cmd)) {
      log(`Rejected disallowed command: ${cmd}`);
      state.runSummaries.push(`NOTE: rejected disallowed command: ${cmd}`);
      state.step += 1;
      continue;
    }
    const invocation = commandToArgs(cmd, personasDir);
    if (invocation.error) {
      log(invocation.error);
      state.runSummaries.push(`NOTE: command error: ${cmd}: ${invocation.error}`);
      state.step += 1;
      continue;
    }
    const sig = commandSignature(invocation.args, invocation.env);
    if (executed.has(sig)) {
      log(`Skipping duplicate command (already executed): ${cmd}`);
      state.runSummaries.push(`NOTE: duplicate skipped: ${cmd}`);
      state.step += 1;
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
  }

  await sendFinal(`Agent reached iteration cap (${maxIterations}).`);
  return state;
}
