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
