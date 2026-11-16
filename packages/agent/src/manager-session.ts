import path from "node:path";

import {
  atomicWriteJson,
  currentDeterminism,
  ensureDir,
  formatTimestamp,
  makeDeterminism,
  readJsonFile,
  redactText,
  redactUnknown,
  resetDeterminism,
  setDeterminism,
  type DeterminismOptions,
} from "@lemma/core";

import type {
  AgentDeps,
  AgentOptions,
  AgentState,
  PendingContext,
} from "./index.js";
import { formatHelpMessage, isSlashCommand, routeSlashCommand } from "./slash-commands.js";

export type ManagerMessageType = "plan" | "question" | "progress" | "summary";

export interface ManagerMessage {
  type: ManagerMessageType;
  text: string;
  generated_at: string;
  step?: number;
  run_ids?: string[];
  details?: Record<string, unknown>;
}

export type ManagerMessageSink = (message: ManagerMessage) => void | Promise<void>;

export interface ManagerSessionOptions {
  /** Working/root directory; manager state persists under <cwd>/.lemma/agent/manager.json */
  cwd: string;
  goal: string;
  personasDir?: string;
  initialArgs?: string[];
  initialEnv?: Record<string, string | undefined>;
  maxIterations?: number;
  minHarnessRuns?: number;
  sessionID?: string;
  stateKey?: string;
  userInput?: string;
  interactive?: boolean;
  /** Determinism for stable timestamps/replay (seed/clock_mode/frozen_clock). */
  determinism?: DeterminismOptions;
  /** Host-neutral sink for plan/question/progress/summary messages. */
  sink?: ManagerMessageSink;
}

export interface ManagerSessionState {
  version: 1;
  goal: string;
  cwd: string;
  session_id?: string;
  state_key?: string;
  status: "idle" | "running" | "awaiting_input" | "completed";
  step: number;
  iteration: number;
  run_ids: string[];
  plan_text: string;
  last_question?: ManagerMessage | null;
  last_summary?: ManagerMessage | null;
  progress: ManagerMessage[];
  questions: ManagerMessage[];
  summaries: ManagerMessage[];
  messages: ManagerMessage[];
  agent_state?: AgentState | null;
  updated_at: string;
}

export function managerStatePath(cwd: string): string {
  return path.join(cwd, ".lemma", "agent", "manager.json");
}

function redactString(value: unknown): string {
  return redactText(typeof value === "string" ? value : value == null ? "" : String(value));
}

function redactDetails(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return redactUnknown(value) as Record<string, unknown>;
}

function deterministicNow(): string {
  try {
    return currentDeterminism().now();
  } catch {
    return formatTimestamp(new Date());
  }
}


function extractRunIdsFromText(text: string): string[] {
  const ids: string[] = [];
  const pattern = /"run_id"\s*:\s*"([^"]+)"|\bRun IDs\b[\s\S]*?(?:^|\n)([a-zA-Z0-9._:-]+(?:,\s*[a-zA-Z0-9._:-]+)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m[1]) {
      if (!ids.includes(m[1])) ids.push(m[1]);
    } else if (m[2]) {
      for (const part of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!ids.includes(part)) ids.push(part);
      }
    }
  }
  // also catch plain run_* tokens in "Run run_x" / "Run IDs\nrun_x"
  const tokenPattern = /\brun[_-][A-Za-z0-9]+/g;
  let t: RegExpExecArray | null;
  while ((t = tokenPattern.exec(text)) !== null) {
    if (!ids.includes(t[0])) ids.push(t[0]);
  }
  return ids;
}

function stableClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function redactManagerMessage(message: ManagerMessage): ManagerMessage {
  const out: ManagerMessage = {
    type: message.type,
    text: redactString(message.text),
    generated_at: typeof message.generated_at === "string" ? message.generated_at : deterministicNow(),
  };
  if (typeof message.step === "number" && Number.isFinite(message.step)) out.step = message.step;
  if (Array.isArray(message.run_ids)) out.run_ids = message.run_ids.map((id) => redactString(id)).filter(Boolean);
  if (message.details && typeof message.details === "object") {
    const rd = redactDetails(message.details);
    if (rd) out.details = rd;
  }
  return out;
}

function buildPlanMessage(goal: string, step: number): ManagerMessage {
  const g = redactString(goal).trim() || "(no goal provided)";
  return {
    type: "plan",
    text: [
      "Test plan (manager):",
      `- Goal: ${g}`,
      "- Start with a deterministic assessment run to collect evidence and current status.",
      "- Review report/status and request missing context only when needed for the next safe unique step.",
      "- Narrate progress, record run IDs/evidence, and summarize findings, limitations, and next actions.",
    ].join("\n"),
    generated_at: deterministicNow(),
    step,
    details: { goal: g },
  };
}

function buildProgressMessage(text: string, step: number, runIds: string[]): ManagerMessage {
  return {
    type: "progress",
    text: redactString(text),
    generated_at: deterministicNow(),
    step,
    run_ids: [...runIds],
  };
}

function buildQuestionMessage(text: string, pending: PendingContext | null | undefined, step: number, runIds: string[]): ManagerMessage {
  const details: Record<string, unknown> = {};
  if (pending && typeof pending === "object") {
    if (typeof pending.kind === "string") details.kind = pending.kind;
    if (typeof pending.type === "string") details.source = pending.type;
    if (typeof pending.question === "string") details.question = redactString(pending.question);
    if (Array.isArray(pending.requested)) details.requested = pending.requested.map((x) => redactString(String(x)));
    if (typeof pending.reason === "string") details.reason = redactString(pending.reason);
  }
  return {
    type: "question",
    text: redactString(text),
    generated_at: deterministicNow(),
    step,
    run_ids: [...runIds],
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function buildSummaryMessage(text: string, state: AgentState | null | undefined, step: number): ManagerMessage {
  const runIds = Array.isArray(state?.runIds) ? state!.runIds.map((x) => redactString(x)) : [];
  const details: Record<string, unknown> = {};
  if (state) {
    details.iteration = state.iteration;
    details.step = state.step;
    details.executed_commands = Array.isArray(state.executedCommands) ? state.executedCommands.length : 0;
    details.has_pending = Boolean(state.pending);
  }
  return {
    type: "summary",
    text: redactString(text),
    generated_at: deterministicNow(),
    step,
    ...(runIds.length ? { run_ids: runIds } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

async function emitAndRecord(
  state: ManagerSessionState,
  sink: ManagerMessageSink | undefined,
  message: ManagerMessage,
): Promise<ManagerMessage> {
  const redacted = redactManagerMessage(message);
  if (!redacted.run_ids || redacted.run_ids.length === 0) {
    const fromText = extractRunIdsFromText(redacted.text);
    const merged = [...(state.run_ids ?? []), ...fromText].filter((v, i, a) => a.indexOf(v) === i);
    if (merged.length) redacted.run_ids = merged;
  }
  state.messages.push(stableClone(redacted));
  if (redacted.type === "progress") state.progress.push(stableClone(redacted));
  if (redacted.type === "question") {
    state.questions.push(stableClone(redacted));
    state.last_question = stableClone(redacted);
  }
  if (redacted.type === "summary") {
    state.summaries.push(stableClone(redacted));
    state.last_summary = stableClone(redacted);
  }
  if (redacted.type === "plan") state.plan_text = redacted.text;
  state.step = Math.max(state.step, redacted.step ?? state.step);
  if (Array.isArray(redacted.run_ids) && redacted.run_ids.length) {
    for (const id of redacted.run_ids) if (!state.run_ids.includes(id)) state.run_ids.push(id);
  }
  state.updated_at = deterministicNow();
  if (sink) await sink(redacted);
  return redacted;
}

function sanitizeAgentStateForPersistence(agentState: AgentState | null | undefined): AgentState | null {
  if (!agentState) return null;
  const redacted = redactUnknown(agentState) as AgentState;
  return stableClone(redacted);
}

async function persistManagerState(state: ManagerSessionState): Promise<void> {
  const filePath = managerStatePath(state.cwd);
  await ensureDir(path.dirname(filePath));
  const sanitized: ManagerSessionState = stableClone({
    ...state,
    goal: redactString(state.goal),
    ...(state.session_id ? { session_id: redactString(state.session_id) } : {}),
    ...(state.state_key ? { state_key: redactString(state.state_key) } : {}),
    plan_text: redactString(state.plan_text),
    run_ids: (state.run_ids ?? []).map((id) => redactString(id)),
    messages: (state.messages ?? []).map((m) => redactManagerMessage(m)),
    progress: (state.progress ?? []).map((m) => redactManagerMessage(m)),
    questions: (state.questions ?? []).map((m) => redactManagerMessage(m)),
    summaries: (state.summaries ?? []).map((m) => redactManagerMessage(m)),
    last_question: state.last_question ? redactManagerMessage(state.last_question) : state.last_question ?? null,
    last_summary: state.last_summary ? redactManagerMessage(state.last_summary) : state.last_summary ?? null,
    agent_state: sanitizeAgentStateForPersistence(state.agent_state),
    updated_at: deterministicNow(),
  });
  await atomicWriteJson(filePath, sanitized);
}

export async function loadManagerSessionState(cwd: string): Promise<ManagerSessionState | null> {
  try {
    const raw = await readJsonFile<unknown>(managerStatePath(cwd));
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1 || typeof obj.goal !== "string") return null;
    return raw as ManagerSessionState;
  } catch {
    return null;
  }
}

export class ManagerSession {
  readonly options: ManagerSessionOptions;
  private state: ManagerSessionState;

  constructor(options: ManagerSessionOptions) {
    this.options = options;
    this.state = {
      version: 1,
      goal: redactString(options.goal),
      cwd: options.cwd,
      ...(options.sessionID ? { session_id: redactString(options.sessionID) } : {}),
      ...(options.stateKey ? { state_key: redactString(options.stateKey) } : {}),
      status: "idle",
      step: 0,
      iteration: 0,
      run_ids: [],
      plan_text: "",
      last_question: null,
      last_summary: null,
      progress: [],
      questions: [],
      summaries: [],
      messages: [],
      agent_state: null,
      updated_at: deterministicNow(),
    };
  }

  getState(): ManagerSessionState {
    return stableClone({
      ...this.state,
      goal: redactString(this.state.goal),
      ...(this.state.session_id ? { session_id: redactString(this.state.session_id) } : {}),
      ...(this.state.state_key ? { state_key: redactString(this.state.state_key) } : {}),
      plan_text: redactString(this.state.plan_text),
      run_ids: (this.state.run_ids ?? []).map((id) => redactString(id)),
      messages: (this.state.messages ?? []).map((m) => redactManagerMessage(m)),
      progress: (this.state.progress ?? []).map((m) => redactManagerMessage(m)),
      questions: (this.state.questions ?? []).map((m) => redactManagerMessage(m)),
      summaries: (this.state.summaries ?? []).map((m) => redactManagerMessage(m)),
      last_question: this.state.last_question ? redactManagerMessage(this.state.last_question) : this.state.last_question ?? null,
      last_summary: this.state.last_summary ? redactManagerMessage(this.state.last_summary) : this.state.last_summary ?? null,
      agent_state: sanitizeAgentStateForPersistence(this.state.agent_state),
    });
  }

  static statePath(cwd: string): string {
    return managerStatePath(cwd);
  }

  static async load(cwd: string): Promise<ManagerSessionState | null> {
    return loadManagerSessionState(cwd);
  }

  async emit(type: ManagerMessageType, text: string, details?: Record<string, unknown>, step?: number, runIds?: string[]): Promise<ManagerMessage> {
    const msg: ManagerMessage = {
      type,
      text,
      generated_at: deterministicNow(),
      ...(step !== undefined ? { step } : { step: this.state.step }),
      ...(runIds ? { run_ids: runIds } : this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
      ...(details ? { details } : {}),
    };
    const emitted = await emitAndRecord(this.state, this.options.sink, msg);
    await persistManagerState(this.state);
    return emitted;
  }

  async run(deps: AgentDeps): Promise<ManagerSessionState> {
    // Resume if a compatible persisted state exists for same goal/cwd context
    const existing = await loadManagerSessionState(this.options.cwd);
    const hasReply = typeof this.options.userInput === "string" && this.options.userInput.trim().length > 0;
    const expectedGoal = redactString(this.options.goal);
    if (existing && existing.goal === expectedGoal && (existing.status === "awaiting_input" || existing.status === "running" || existing.status === "completed")) {
      // For deterministic replay/resume, keep prior messages/state and continue.
      this.state = stableClone(existing);
      if (this.options.sessionID) this.state.session_id = redactString(this.options.sessionID);
      if (this.options.stateKey) this.state.state_key = redactString(this.options.stateKey);
      // If already completed and no new input, replay is complete (idempotent)
      if (existing.status === "completed" && !hasReply) {
        return this.getState();
      }
    }

    // LEM-154: slash commands flow through manager persona/narration
    const slashInput = String(this.options.goal || this.options.userInput || "").trim();
    if (isSlashCommand(slashInput)) {
      const routed = routeSlashCommand(slashInput);
      if (!this.state.plan_text) {
        await emitAndRecord(this.state, this.options.sink, buildPlanMessage(this.options.goal, this.state.step));
      }
      if (routed.decision.kind === "unknown") {
        this.state.status = "completed";
        await emitAndRecord(this.state, this.options.sink, {
          type: "summary",
          text: routed.message || formatHelpMessage(),
          generated_at: deterministicNow(),
          step: this.state.step,
          ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
        } as any);
        await persistManagerState(this.state);
        return this.getState();
      }
      const d = routed.decision;
      if (d.command === "/lemma-help" || d.intent === "manager.help") {
        this.state.status = "completed";
        await emitAndRecord(this.state, this.options.sink, {
          type: "summary",
          text: formatHelpMessage(),
          generated_at: deterministicNow(),
          step: this.state.step,
          ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
        } as any);
        await persistManagerState(this.state);
        return this.getState();
      }
      const lemmaMore = (d as any).lemma_more === true;
      if (lemmaMore) {
        this.state.status = "running";
        const runId = (d as any).more_run_id || (this.state.run_ids.length ? this.state.run_ids[this.state.run_ids.length - 1] : undefined);
        await emitAndRecord(this.state, this.options.sink, {
          type: "progress",
          text: "Continuing run with deferred checks (/lemma-more).",
          generated_at: deterministicNow(),
          step: this.state.step,
          details: { command: d.command, intent: d.intent, ...(runId ? { run_id: runId } : {}) },
        } as any);
        try {
          if (!runId) throw new Error("No run id available to continue with /lemma-more.");
          const { StateStore, runMore, buildReport, EvidenceStore, RELEASE_CONFIDENCE } = await import("@lemma/core");
          const store = new StateStore(this.options.cwd);
          const result = await runMore({ runId, stateStore: store } as any);
          let report: any = null;
          try {
            const evidence = new EvidenceStore(this.options.cwd, result.run_id);
            await evidence.init();
            let manifest: any = null;
            try { manifest = await evidence.finalize({ run_id: result.run_id }); } catch { manifest = null; }
            const summary: any = manifest && manifest.summary ? manifest.summary : evidence.summary();
            report = buildReport(result as any, RELEASE_CONFIDENCE, summary, manifest?.generated_at || deterministicNow());
          } catch { /* ignore */ }
          this.state.run_ids = Array.from(new Set([...(this.state.run_ids ?? []), result.run_id]));
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: `Continued deferred checks for run ${result.run_id}.`,
            generated_at: deterministicNow(),
            step: this.state.step,
            run_ids: [...this.state.run_ids],
            details: { run_id: result.run_id, ...(report ? { report } : {}) },
          } as any);
        } catch (err: any) {
          const msg = err && typeof err.message === "string" ? err.message : String(err);
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: msg,
            generated_at: deterministicNow(),
            step: this.state.step,
            details: { error: { type: err?.name || "Error", code: err?.errorCode, message: msg } },
            ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
          } as any);
        }
        await persistManagerState(this.state);
        return this.getState();
      }

      const proModelEval = (d as any).pro_model_eval === true;
      if (proModelEval) {
        this.state.status = "running";
        const cases = (d as any).model_eval_cases || d.parsed?.named?.["cases"] || (d.args.join(" ").trim() || undefined);
        await emitAndRecord(this.state, this.options.sink, {
          type: "progress",
          text: "Running Pro AI model evaluation workflow (entitlement-gated).",
          generated_at: deterministicNow(),
          step: this.state.step,
          details: { command: d.command, intent: d.intent },
        } as any);
        try {
          const { runModelEval } = await import("@lemma/pro");
          const result = await runModelEval({
            ...(cases ? { cases } : {}),
            modelConfig: null,
            license: null,
            projectRoot: this.options.cwd,
          } as any);
          this.state.run_ids = Array.from(new Set([...(this.state.run_ids ?? []), result.run_id]));
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: `Pro model eval ${result.summary.total} case(s), run ${result.run_id}.`,
            generated_at: deterministicNow(),
            step: this.state.step,
            run_ids: [...this.state.run_ids],
            details: { run_id: result.run_id, summary: result.summary, endpoint_configured: result.endpoint_configured },
          } as any);
        } catch (err: any) {
          const msg = err && typeof err.message === "string" ? err.message : String(err);
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: msg,
            generated_at: deterministicNow(),
            step: this.state.step,
            details: { error: { type: err?.name || "Error", code: err?.errorCode, message: msg } },
            ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
          } as any);
        }
        await persistManagerState(this.state);
        return this.getState();
      }

      const proProof = (d as any).pro_proof === true;
      if (proProof) {
        this.state.status = "running";
        const property = String((d as any).proof_property || "").trim();
        const target = String((d as any).proof_target || d.parsed?.named?.["target_or_args"] || d.args.join(" ") || ".").trim() || ".";
        await emitAndRecord(this.state, this.options.sink, {
          type: "progress",
          text: "Running Pro property proof workflow (entitlement-gated).",
          generated_at: deterministicNow(),
          step: this.state.step,
          details: { command: d.command, intent: d.intent },
        } as any);
        try {
          if (!property) {
            throw new Error("Missing required property for proof workflow. Use /lemma-proof --property \"<property>\" --target \"<path|url>\" or `lemma pro proof --property ... --target ...`.");
          }
          const { runPropertyProof } = await import("@lemma/pro");
          const result = await runPropertyProof({
            property,
            target,
            license: null,
            cwd: this.options.cwd,
            root: this.options.cwd,
          } as any);
          this.state.run_ids = Array.from(new Set([...(this.state.run_ids ?? []), result.run_id]));
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: `Pro proof ${result.status} (proof ${result.proof_id}, run ${result.run_id}).`,
            generated_at: deterministicNow(),
            step: this.state.step,
            run_ids: [...this.state.run_ids],
            details: { proof_id: result.proof_id, run_id: result.run_id, status: result.status, report: result.report, evidence_refs: result.evidence_refs },
          } as any);
        } catch (err: any) {
          const msg = err && typeof err.message === "string" ? err.message : String(err);
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: msg,
            generated_at: deterministicNow(),
            step: this.state.step,
            details: { error: { type: err?.name || "Error", code: err?.errorCode, message: msg } },
            ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
          } as any);
        }
        await persistManagerState(this.state);
        return this.getState();
      }

      const proSpecialist = (d as any).pro_specialist as string | undefined;
      if (proSpecialist) {
        this.state.status = "running";
        await emitAndRecord(this.state, this.options.sink, {
          type: "progress",
          text: `Running Pro specialist investigation: ${proSpecialist} (entitlement-gated).`,
          generated_at: deterministicNow(),
          step: this.state.step,
          details: { command: d.command, intent: d.intent, specialist: proSpecialist },
        } as any);
        try {
          const { runSpecialistCommand } = await import("@lemma/pro");
          const targetArg = String((d as any).pro_target || d.parsed?.named?.["target_or_args"] || d.args.join(" ") || ".").trim() || ".";
          const result = await runSpecialistCommand({
            specialist: proSpecialist,
            target: targetArg,
            cwd: this.options.cwd,
            root: this.options.cwd,
            ...(this.options.personasDir ? { personasDir: this.options.personasDir } : {}),
            license: null,
          } as any);
          this.state.run_ids = Array.from(new Set([...(this.state.run_ids ?? []), result.run_id]));
          this.state.status = "completed";
          const summary = (result.report as any) || result;
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: `Pro ${proSpecialist} investigation complete (run ${result.run_id}, status ${result.status}).`,
            generated_at: deterministicNow(),
            step: this.state.step,
            run_ids: [...this.state.run_ids],
            details: { specialist: proSpecialist, run_id: result.run_id, status: result.status, report: summary, evidence_refs: result.evidence_refs },
          } as any);
        } catch (err: any) {
          const msg = err && typeof err.message === "string" ? err.message : String(err);
          this.state.status = "completed";
          await emitAndRecord(this.state, this.options.sink, {
            type: "summary",
            text: msg,
            generated_at: deterministicNow(),
            step: this.state.step,
            details: { specialist: proSpecialist, error: { type: err?.name || "Error", code: err?.errorCode, message: msg } },
            ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
          } as any);
        }
        await persistManagerState(this.state);
        return this.getState();
      }

      if (d.target === "dashboard") {
        const route = d.dashboard_route || "/";
        this.state.status = "completed";
        const textMsg = routed.message && (d.command === "/lemma-pro" || d.intent === "dashboard.pro")
          ? routed.message
          : [
              `Dashboard requested via ${d.command}.`,
              `Route: ${route}`,
              "A token-protected URL is provided via the manager/host UI channel (token never shown in transcript).",
            ].join("\n");
        await emitAndRecord(this.state, this.options.sink, {
          type: "summary",
          text: textMsg,
          generated_at: deterministicNow(),
          step: this.state.step,
          details: { dashboard_route: route, command: d.command, intent: d.intent },
          ...(this.state.run_ids.length ? { run_ids: [...this.state.run_ids] } : {}),
        } as any);
        await persistManagerState(this.state);
        return this.getState();
      }
      // For manager/catalog slash commands, continue into loop-driven flow with routed goal semantics handled by loop
    }

    const det = this.options.determinism ? makeDeterminism(this.options.determinism) : null;
    const prev = det ? setDeterminism(det) : null;
    try {
      if (!this.state.plan_text) {
        this.state.step = Math.max(this.state.step, 0);
        await emitAndRecord(this.state, this.options.sink, buildPlanMessage(this.options.goal, this.state.step));
        await persistManagerState(this.state);
      }

      this.state.status = "running";
      await persistManagerState(this.state);

      const wrappedDeps: AgentDeps = {
        runHarness: deps.runHarness,
        askLlm: deps.askLlm,
        ...(deps.listMcpResources ? { listMcpResources: deps.listMcpResources } : {}),
        ...(deps.requestUserInput ? { requestUserInput: deps.requestUserInput } : {}),
        progress: async (message: string) => {
          const msg = buildProgressMessage(message, this.state.step, this.state.run_ids);
          await emitAndRecord(this.state, this.options.sink, msg);
          if (deps.progress) await deps.progress(message);
          await persistManagerState(this.state);
        },
        sendFinal: async (text: string) => {
          const agentState = this.state.agent_state;
          const isQuestion = /##\s*(Context requested|How would you like to provide)/i.test(text) || Boolean(agentState?.pending);
          const runIds = [...(this.state.run_ids ?? []), ...extractRunIdsFromText(text)].filter((v, i, a) => a.indexOf(v) === i);
          const msg = isQuestion
            ? buildQuestionMessage(text, agentState?.pending ?? null, this.state.step, runIds)
            : {
                ...buildSummaryMessage(text, agentState ?? null, this.state.step),
                ...(runIds.length ? { run_ids: runIds } : {}),
              };
          await emitAndRecord(this.state, this.options.sink, msg);
          if (isQuestion) this.state.status = "awaiting_input";
          await persistManagerState(this.state);
          if (deps.sendFinal) await deps.sendFinal(text);
        },
      };

      const loopOptions: AgentOptions = {
        goal: this.options.goal,
        ...(this.options.personasDir ? { personasDir: this.options.personasDir } : {}),
        ...(this.options.initialArgs ? { initialArgs: this.options.initialArgs } : {}),
        ...(this.options.initialEnv ? { initialEnv: this.options.initialEnv } : {}),
        ...(this.options.maxIterations !== undefined ? { maxIterations: this.options.maxIterations } : {}),
        ...(this.options.minHarnessRuns !== undefined ? { minHarnessRuns: this.options.minHarnessRuns } : {}),
        cwd: this.options.cwd,
        ...(this.options.stateKey ? { stateKey: this.options.stateKey } : {}),
        ...(this.options.sessionID ? { sessionID: this.options.sessionID } : {}),
        ...(this.options.userInput ? { userInput: this.options.userInput } : {}),
        ...(this.options.interactive ? { interactive: this.options.interactive } : {}),
      };

      // We need agent state updates visible to sendFinal wrapper for question/summary classification.
      // Run loop and then sync final state.
      const { runStrictJudgeLoop, buildExecutionSummary } = await import("./index.js");
      const finalAgentState = await runStrictJudgeLoop(loopOptions, wrappedDeps);
      this.state.agent_state = sanitizeAgentStateForPersistence(finalAgentState);
      this.state.iteration = finalAgentState.iteration;
      this.state.step = Math.max(this.state.step, finalAgentState.step);
      this.state.run_ids = Array.isArray(finalAgentState.runIds) ? [...finalAgentState.runIds].map((x) => redactString(x)) : [...this.state.run_ids];
      this.state.updated_at = deterministicNow();

      if (finalAgentState.pending) {
        // Ensure a question message exists/is marked awaiting input.
        this.state.status = "awaiting_input";
      } else {
        this.state.status = "completed";
        // Ensure a summary exists if loop ended without one emitted via sink classification.
        if (!this.state.last_summary) {
          const summaryText = `Assessment complete.${buildExecutionSummary(finalAgentState)}`;
          await emitAndRecord(this.state, this.options.sink, buildSummaryMessage(summaryText, finalAgentState, this.state.step));
        }
      }
      await persistManagerState(this.state);
      return this.getState();
    } finally {
      if (prev) resetDeterminism(prev);
    }
  }
}
