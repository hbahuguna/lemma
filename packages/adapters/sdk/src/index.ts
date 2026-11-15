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

export interface AdapterManifest {
  id: HostId;
  capabilities: HostCapabilities;
  name?: string;
  version?: string;
  packageName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateAdapterManifest(manifest: AdapterManifest): ManifestValidationResult {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (!isHostId(manifest.id)) {
    errors.push(`manifest.id must be one of: ${HOST_IDS.join(", ")}`);
  }
  if (!manifest.capabilities || typeof manifest.capabilities !== "object") {
    errors.push("manifest.capabilities must be an object");
  } else {
    for (const key of Object.keys(DEFAULT_HOST_CAPABILITIES) as CapabilityKey[]) {
      if (typeof manifest.capabilities[key] !== "boolean") {
        errors.push(`manifest.capabilities.${key} must be boolean`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidAdapterManifest(manifest: AdapterManifest): void {
  const result = validateAdapterManifest(manifest);
  if (!result.ok) {
    throw new Error(`Invalid adapter manifest: ${result.errors.join("; ")}`);
  }
}

export interface FakeHostOptions {
  id?: HostId;
  capabilities?: Partial<HostCapabilities>;
  session?: Partial<SessionContext>;
  mcpResources?: McpResource[];
  answerQuestion?: (request: QuestionRequest) => Promise<QuestionAnswer> | QuestionAnswer;
  answerForm?: (request: FormRequest) => Promise<FormAnswer | null> | FormAnswer | null;
  resolveSecret?: (ref: SecretRef) => Promise<string> | string;
}

export interface FakeHostRecords {
  commands: CommandDescriptor[][];
  tools: ToolDescriptor[][];
  progress: string[];
  finals: string[];
  questions: QuestionRequest[];
  forms: FormRequest[];
  mcpResourceRequests: number;
  secretRequests: SecretRef[];
}

export class FakeAgentHost implements AgentHost {
  readonly id: HostId;
  readonly capabilities: HostCapabilities;
  readonly records: FakeHostRecords = {
    commands: [],
    tools: [],
    progress: [],
    finals: [],
    questions: [],
    forms: [],
    mcpResourceRequests: 0,
    secretRequests: [],
  };

  private readonly session: SessionContext;
  private readonly mcpResources: McpResource[];
  private readonly questionHandler?: FakeHostOptions["answerQuestion"];
  private readonly formHandler?: FakeHostOptions["answerForm"];
  private readonly secretHandler?: FakeHostOptions["resolveSecret"];

  collectForm?: (request: FormRequest) => Promise<FormAnswer | null>;
  listMcpResources?: () => Promise<McpResource[]>;
  resolveSecret?: (ref: SecretRef) => Promise<string>;

  constructor(options: FakeHostOptions = {}) {
    this.id = options.id ?? "opencode";
    this.capabilities = createCapabilities(options.capabilities);
    this.session = {
      host: this.id,
      sessionId: options.session?.sessionId ?? "ses_fake",
      ...(options.session?.cwd !== undefined ? { cwd: options.session.cwd } : {}),
      ...(options.session?.workspaceRoot !== undefined
        ? { workspaceRoot: options.session.workspaceRoot }
        : {}),
      ...(options.session?.metadata !== undefined ? { metadata: options.session.metadata } : {}),
    };
    this.mcpResources = options.mcpResources ? [...options.mcpResources] : [];
    this.questionHandler = options.answerQuestion;
    this.formHandler = options.answerForm;
    this.secretHandler = options.resolveSecret;

    if (this.capabilities.nativeForms) {
      this.collectForm = async (request: FormRequest): Promise<FormAnswer | null> => {
        this.records.forms.push(request);
        if (this.formHandler) {
          return await this.formHandler(request);
        }
        return {
          values: Object.fromEntries(request.fields.map((f) => [f.id, f.defaultValue ?? ""])),
          submitted: true,
        };
      };
    } else {
      delete this.collectForm;
    }

    if (this.capabilities.mcpResources) {
      this.listMcpResources = async (): Promise<McpResource[]> => {
        this.records.mcpResourceRequests += 1;
        return [...this.mcpResources];
      };
    } else {
      delete this.listMcpResources;
    }

    this.resolveSecret = async (ref: SecretRef): Promise<string> => {
      this.records.secretRequests.push(ref);
      if (this.secretHandler) {
        return await this.secretHandler(ref);
      }
      return ref.env ?? ref.id ?? "resolved";
    };
  }

  async registerCommands(commands: CommandDescriptor[]): Promise<void> {
    this.records.commands.push([...commands]);
  }

  async registerTools(tools: ToolDescriptor[]): Promise<void> {
    this.records.tools.push([...tools]);
  }

  async sendProgress(message: string): Promise<void> {
    this.records.progress.push(message);
  }

  async sendFinal(message: string): Promise<void> {
    this.records.finals.push(message);
  }

  async askQuestion(request: QuestionRequest): Promise<QuestionAnswer> {
    this.records.questions.push(request);
    if (this.questionHandler) {
      return await this.questionHandler(request);
    }
    const first = request.options?.[0];
    const value = first?.value ?? first?.label ?? "skip";
    return first?.value !== undefined ? { value, optionValue: first.value } : { value };
  }

  getSession(): SessionContext {
    return {
      host: this.session.host,
      ...(this.session.sessionId !== undefined ? { sessionId: this.session.sessionId } : {}),
      ...(this.session.cwd !== undefined ? { cwd: this.session.cwd } : {}),
      ...(this.session.workspaceRoot !== undefined
        ? { workspaceRoot: this.session.workspaceRoot }
        : {}),
      ...(this.session.metadata !== undefined ? { metadata: { ...this.session.metadata } } : {}),
    };
  }
}

export function createFakeHost(options: FakeHostOptions = {}): FakeAgentHost {
  return new FakeAgentHost(options);
}

export interface AdapterConformanceInput {
  host: AgentHost;
  manifest: AdapterManifest;
}

export interface AdapterConformanceOptions {
  /** Optional command/tool samples to exercise registration. */
  sampleCommands?: CommandDescriptor[];
  sampleTools?: ToolDescriptor[];
  sampleQuestion?: QuestionRequest;
  sampleForm?: FormRequest;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameCapabilities(a: HostCapabilities, b: HostCapabilities): boolean {
  return (Object.keys(DEFAULT_HOST_CAPABILITIES) as CapabilityKey[]).every((k) => a[k] === b[k]);
}

export async function assertAdapterConformance(
  input: AdapterConformanceInput,
  options: AdapterConformanceOptions = {},
): Promise<CapabilityNegotiationResult> {
  const { host, manifest } = input;
  assertValidAdapterManifest(manifest);
  assert(host.id === manifest.id, `manifest.id (${manifest.id}) must match host.id (${host.id})`);
  assert(
    sameCapabilities(host.capabilities, manifest.capabilities),
    "manifest.capabilities must match host.capabilities",
  );

  const negotiation = negotiateCapabilities(manifest.capabilities);
  assert(
    sameCapabilities(negotiation.effective, manifest.capabilities),
    "effective capabilities must match declared capabilities (no silent emulation)",
  );

  const session = host.getSession();
  assert(session && session.host === host.id, "getSession().host must match host.id");

  const sampleCommands = options.sampleCommands ?? [
    {
      name: "assay-run",
      description: "Run assessment",
      intent: "Run assessment",
      allowedSubcommands: ["run", "status", "report"],
      mode: "static",
    },
  ];
  const sampleTools = options.sampleTools ?? [
    { name: "assay_jira_context", description: "Collect Jira context" },
  ];
  await host.registerCommands(sampleCommands);
  await host.registerTools(sampleTools);
  await host.sendProgress("conformance:progress");
  await host.sendFinal("conformance:final");

  const question = options.sampleQuestion ?? {
    question: "Need context?",
    options: [{ label: "Skip", value: "skip" }],
    allowFreeform: true,
  };
  const answer = await host.askQuestion(question);
  assert(answer && typeof answer.value === "string", "askQuestion must return an answer with string value");

  if (host.capabilities.nativeForms) {
    assert(typeof host.collectForm === "function", "nativeForms capability requires collectForm");
    const form = await host.collectForm(
      options.sampleForm ?? { fields: [{ id: "note", label: "Note", type: "text" }] },
    );
    assert(form === null || (form && typeof form.submitted === "boolean" && form.values && typeof form.values === "object"),
      "collectForm must return a form answer or null",
    );
  } else {
    assert(
      typeof host.collectForm !== "function",
      "nativeForms unavailable must not expose collectForm (no silent emulation)",
    );
    assert(
      negotiation.limitations.some((l) => l.code === "native_form_unavailable"),
      "nativeForms unavailable must produce native_form_unavailable limitation",
    );
  }

  if (host.capabilities.mcpResources) {
    assert(typeof host.listMcpResources === "function", "mcpResources capability requires listMcpResources");
    const resources = await host.listMcpResources();
    assert(Array.isArray(resources), "listMcpResources must return an array");
  } else {
    assert(
      typeof host.listMcpResources !== "function",
      "mcpResources unavailable must not expose listMcpResources (no silent emulation)",
    );
    assert(
      negotiation.limitations.some((l) => l.code === "mcp_unavailable"),
      "mcpResources unavailable must produce mcp_unavailable limitation",
    );
  }

  if (!host.capabilities.questionUi) {
    assert(
      negotiation.limitations.some((l) => l.code === "question_ui_unavailable") &&
        negotiation.degradation.usePlainChatForQuestions,
      "questionUi unavailable must produce question_ui_unavailable limitation and plain-chat degradation",
    );
  }
  if (!host.capabilities.sessionEvents) {
    assert(
      negotiation.limitations.some((l) => l.code === "session_events_unavailable") &&
        negotiation.degradation.interactiveResumeDisabled &&
        negotiation.degradation.persistedStateResumeEnabled,
      "sessionEvents unavailable must disable interactive resume but keep persisted-state resume",
    );
  }
  if (!host.capabilities.modelInvoke) {
    assert(
      negotiation.limitations.some((l) => l.code === "model_invocation_unavailable") &&
        negotiation.degradation.stopAgentLoopAfterDeterministicRun,
      "modelInvoke unavailable must stop agent loop after deterministic run",
    );
  }
  if (!host.capabilities.progressStream) {
    assert(
      negotiation.limitations.some((l) => l.code === "progress_stream_unavailable") &&
        negotiation.degradation.bufferProgressAtPhaseBoundaries,
      "progressStream unavailable must buffer progress at phase boundaries",
    );
  }

  return negotiation;
}

export function createAdapterManifest(
  id: HostId,
  capabilities: Partial<HostCapabilities> | HostCapabilities,
  extra: Omit<Partial<AdapterManifest>, "id" | "capabilities"> = {},
): AdapterManifest {
  return {
    id,
    capabilities: createCapabilities(capabilities),
    ...extra,
  };
}
