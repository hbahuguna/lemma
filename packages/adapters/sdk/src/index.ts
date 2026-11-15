/**
 * @lemma/adapters-sdk — shared host-neutral AgentHost adapter contract.
 *
 * Defines capability-negotiated interfaces used by host adapters. This package
 * contains no host SDK imports and no product/scoring logic.
 */

export const HOST_IDS = [
  "opencode",
  "claude-code",
  "codex",
  "antigravity",
  "cursor",
] as const;

export type HostId = (typeof HOST_IDS)[number];

export interface HostCapabilities {
  commands: boolean;
  tools: boolean;
  questionUi: boolean;
  nativeForms: boolean;
  mcpResources: boolean;
  sessionEvents: boolean;
  progressStream: boolean;
  modelInvoke: boolean;
  backgroundTasks: boolean;
  worktrees: boolean;
}

export const DEFAULT_HOST_CAPABILITIES: HostCapabilities = {
  commands: false,
  tools: false,
  questionUi: false,
  nativeForms: false,
  mcpResources: false,
  sessionEvents: false,
  progressStream: false,
  modelInvoke: false,
  backgroundTasks: false,
  worktrees: false,
};

export type CommandMode = "static" | "browser" | "demo" | "agent";

export type ArgumentSpec =
  | {
      kind: "none";
    }
  | {
      kind: "raw";
      name?: string;
      description?: string;
      required?: boolean;
    }
  | {
      kind: "positional";
      name: string;
      description?: string;
      required?: boolean;
      variadic?: boolean;
    }
  | {
      kind: "options";
      options: Array<{
        name: string;
        description?: string;
        required?: boolean;
        type?: "string" | "boolean" | "number";
      }>;
    };

export interface CommandDescriptor {
  /** Host-visible command name (adapter decides spelling, e.g. assay-browser). */
  name: string;
  description: string;
  arguments?: ArgumentSpec;
  intent: string;
  /** Allowed CLI/agent subcommands (e.g. run, report, status, abort). */
  allowedSubcommands: string[];
  mode: CommandMode;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON-schema-like or host-specific parameter description; kept opaque to SDK. */
  parameters?: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  value?: string;
  description?: string;
}

export interface QuestionRequest {
  id?: string;
  question: string;
  options?: QuestionOption[];
  allowFreeform?: boolean;
  /** Optional source/type hint (e.g. jira, slack, github, doc, url, text). */
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

export interface QuestionAnswer {
  /** Selected option value/label or freeform text, depending on host/UI. */
  value: string;
  optionValue?: string;
  text?: string;
  /** Raw host payload for adapter-specific handling (must be redacted before persistence). */
  raw?: unknown;
}

export interface FormField {
  id: string;
  label: string;
  type?: "text" | "secret" | "select" | "textarea" | "boolean";
  required?: boolean;
  description?: string;
  options?: QuestionOption[];
  defaultValue?: string;
}

export interface FormRequest {
  id?: string;
  title?: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  cancelLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface FormAnswer {
  /** Field id -> value. Secrets/tokens must be handled as sensitive by adapters. */
  values: Record<string, string>;
  submitted: boolean;
  raw?: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** MCP server identifier when known. */
  server?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionContext {
  sessionId?: string;
  cwd?: string;
  workspaceRoot?: string;
  host: HostId;
  /** Host-specific session metadata; treat as non-secret unless explicitly marked. */
  metadata?: Record<string, unknown>;
}

export interface SecretRef {
  /** Reference kind, e.g. env, keychain, token-ref, or host-specific source. */
  kind: string;
  id?: string;
  /** Environment variable name when kind is env. */
  env?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentHost {
  readonly id: HostId;
  readonly capabilities: HostCapabilities;

  registerCommands(commands: CommandDescriptor[]): Promise<void>;
  registerTools(tools: ToolDescriptor[]): Promise<void>;

  sendProgress(message: string): Promise<void>;
  sendFinal(message: string): Promise<void>;

  askQuestion(request: QuestionRequest): Promise<QuestionAnswer>;
  collectForm?(request: FormRequest): Promise<FormAnswer | null>;
  listMcpResources?(): Promise<McpResource[]>;

  getSession(): SessionContext;
  resolveSecret?(ref: SecretRef): Promise<string>;
}

export function isHostId(value: unknown): value is HostId {
  return typeof value === "string" && (HOST_IDS as readonly string[]).includes(value);
}

export function createCapabilities(
  overrides: Partial<HostCapabilities> = {},
): HostCapabilities {
  return { ...DEFAULT_HOST_CAPABILITIES, ...overrides };
}

export type CapabilityKey = keyof HostCapabilities;

export type LimitationCode =
  | "question_ui_unavailable"
  | "native_form_unavailable"
  | "mcp_unavailable"
  | "session_events_unavailable"
  | "model_invocation_unavailable"
  | "progress_stream_unavailable";

export interface CapabilityLimitation {
  capability: CapabilityKey;
  code: LimitationCode;
  message: string;
  /** Required degradation behavior per architecture contract. */
  behavior: string;
  /** Never emulate missing capability as success. */
  blocking: false;
}

export interface DegradationFlags {
  usePlainChatForQuestions: boolean;
  usePasteOrEnvSecretRefForForms: boolean;
  allowMcpPasteOrSkip: boolean;
  interactiveResumeDisabled: boolean;
  persistedStateResumeEnabled: boolean;
  stopAgentLoopAfterDeterministicRun: boolean;
  bufferProgressAtPhaseBoundaries: boolean;
}

export interface CapabilityNegotiationResult {
  declared: HostCapabilities;
  effective: HostCapabilities;
  limitations: CapabilityLimitation[];
  degradation: DegradationFlags;
}

export interface NegotiateCapabilitiesOptions {
  required?: Partial<HostCapabilities>;
}

function toCapabilityMap(value: HostCapabilities): Record<CapabilityKey, boolean> {
  return value as Record<CapabilityKey, boolean>;
}

export function negotiateCapabilities(
  declared: Partial<HostCapabilities> | HostCapabilities,
  options: NegotiateCapabilitiesOptions = {},
): CapabilityNegotiationResult {
  const declaredFull = createCapabilities(declared);
  const required = options.required ?? {};
  const effective: HostCapabilities = { ...declaredFull };
  const declaredMap = toCapabilityMap(declaredFull);
  const effectiveMap = toCapabilityMap(effective);

  for (const key of Object.keys(DEFAULT_HOST_CAPABILITIES) as CapabilityKey[]) {
    if (required[key]) {
      effectiveMap[key] = Boolean(declaredMap[key]);
    } else {
      effectiveMap[key] = Boolean(declaredMap[key]);
    }
  }

  const limitations: CapabilityLimitation[] = [];

  if (!effective.questionUi) {
    limitations.push({
      capability: "questionUi",
      code: "question_ui_unavailable",
      message: "Host question UI is unavailable.",
      behavior: "Ask in plain chat, record limitation, and never block the run.",
      blocking: false,
    });
  }
  if (!effective.nativeForms) {
    limitations.push({
      capability: "nativeForms",
      code: "native_form_unavailable",
      message: "Host native form UI is unavailable.",
      behavior:
        "Fall back to paste or secure env reference; never ask for a raw token in prose.",
      blocking: false,
    });
  }
  if (!effective.mcpResources) {
    limitations.push({
      capability: "mcpResources",
      code: "mcp_unavailable",
      message: "Host MCP resource discovery is unavailable.",
      behavior: "Record limitation and continue with paste or skip.",
      blocking: false,
    });
  }
  if (!effective.sessionEvents) {
    limitations.push({
      capability: "sessionEvents",
      code: "session_events_unavailable",
      message: "Host session event stream is unavailable.",
      behavior: "Disable interactive resume but keep persisted-state resume.",
      blocking: false,
    });
  }
  if (!effective.modelInvoke) {
    limitations.push({
      capability: "modelInvoke",
      code: "model_invocation_unavailable",
      message: "Host model invocation from adapter/agent context is unavailable.",
      behavior: "Stop the agent loop after the deterministic run and report the limitation.",
      blocking: false,
    });
  }
  if (!effective.progressStream) {
    limitations.push({
      capability: "progressStream",
      code: "progress_stream_unavailable",
      message: "Host progress streaming is unavailable.",
      behavior: "Buffer progress and emit it at phase boundaries.",
      blocking: false,
    });
  }

  return {
    declared: declaredFull,
    effective,
    limitations,
    degradation: {
      usePlainChatForQuestions: !effective.questionUi,
      usePasteOrEnvSecretRefForForms: !effective.nativeForms,
      allowMcpPasteOrSkip: !effective.mcpResources,
      interactiveResumeDisabled: !effective.sessionEvents,
      persistedStateResumeEnabled: true,
      stopAgentLoopAfterDeterministicRun: !effective.modelInvoke,
      bufferProgressAtPhaseBoundaries: !effective.progressStream,
    },
  };
}

export interface PhaseProgressBuffer {
  push(message: string): void;
  /** Flush buffered messages for a phase boundary and clear the buffer. */
  flushPhase(): string[];
  /** Peek buffered messages without clearing. */
  peek(): string[];
  size(): number;
  clear(): void;
}

export function createPhaseProgressBuffer(): PhaseProgressBuffer {
  let buffer: string[] = [];
  return {
    push(message: string): void {
      buffer.push(message);
    },
    flushPhase(): string[] {
      const out = buffer;
      buffer = [];
      return out;
    },
    peek(): string[] {
      return [...buffer];
    },
    size(): number {
      return buffer.length;
    },
    clear(): void {
      buffer = [];
    },
  };
}

export async function emitProgress(
  host: Pick<AgentHost, "sendProgress">,
  capabilities: Pick<HostCapabilities, "progressStream"> | HostCapabilities,
  message: string,
  buffer?: PhaseProgressBuffer,
): Promise<void> {
  if (capabilities.progressStream) {
    await host.sendProgress(message);
    return;
  }
  if (buffer) {
    buffer.push(message);
    return;
  }
}

export async function flushBufferedProgress(
  host: Pick<AgentHost, "sendProgress">,
  buffer: PhaseProgressBuffer,
): Promise<string[]> {
  const messages = buffer.flushPhase();
  for (const message of messages) {
    await host.sendProgress(message);
  }
  return messages;
}
