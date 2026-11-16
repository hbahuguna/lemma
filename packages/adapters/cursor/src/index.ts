/**
 * @lemma/adapters-cursor — Cursor host adapter.
 *
 * Provides a capability-honest Cursor adapter surface on top of the shared
 * AgentHost/manifest contract and @lemma/agent primitives. Host-specific I/O is
 * injected so this package does not depend on Cursor host SDKs at build/test time.
 */

import {
  ASSAY_COMMAND_CATALOG,
  assayIntent,
  buildBrowserAgentPrompt,
  buildCatalogInvocation,
  getCatalogCommandKind,
  normalizeMcpResourceEntries,
  type BrowserAgentPromptInput,
  type CatalogInvocationResult,
} from "@lemma/agent";
import {
  createAdapterManifest,
  createCapabilities,
  createHostPackagingManifest,
  negotiateCapabilities,
  type AdapterManifest,
  type AgentHost,
  type CommandDescriptor,
  type FormAnswer,
  type FormRequest,
  type HostCapabilities,
  type HostPackagingManifest,
  type McpResource,
  type QuestionAnswer,
  type QuestionRequest,
  type SecretRef,
  type SessionContext,
  type ToolDescriptor,
} from "@lemma/adapters-sdk";

export const PACKAGE_NAME = "@lemma/adapters-cursor" as const;

export const CURSOR_DEFAULT_CAPABILITIES: HostCapabilities = createCapabilities({
  commands: true,
  tools: true,
  questionUi: false, // partial/unverified -> unavailable by default for honest degradation
  nativeForms: false,
  mcpResources: true,
  sessionEvents: false, // limited/unverified
  progressStream: true,
  modelInvoke: true,
  backgroundTasks: false,
  worktrees: false,
});

export const CURSOR_ADAPTER_MANIFEST: AdapterManifest = createAdapterManifest(
  "cursor",
  CURSOR_DEFAULT_CAPABILITIES,
  {
    name: "Cursor",
    packageName: PACKAGE_NAME,
    description:
      "Lemma adapter for Cursor using shared AgentHost contract and host-neutral agent primitives.",
  },
);


export const CURSOR_PACKAGING_MANIFEST: HostPackagingManifest = createHostPackagingManifest({
  host: "cursor",
  packageName: PACKAGE_NAME,
  catalogCommandNames: ASSAY_COMMAND_CATALOG.map((c) => c.name),
});

export interface CursorHostPrimitives {
  registerCommands?: (commands: CommandDescriptor[]) => Promise<void> | void;
  registerTools?: (tools: ToolDescriptor[]) => Promise<void> | void;
  sendProgress?: (message: string) => Promise<void> | void;
  sendFinal?: (message: string) => Promise<void> | void;
  askQuestion?: (request: QuestionRequest) => Promise<QuestionAnswer> | QuestionAnswer;
  collectForm?: (request: FormRequest) => Promise<FormAnswer | null> | FormAnswer | null;
  listMcpResources?: () => Promise<unknown> | unknown;
  getSession?: () => SessionContext | Promise<SessionContext>;
  resolveSecret?: (ref: SecretRef) => Promise<string> | string;
}

export interface CreateCursorHostOptions {
  capabilities?: Partial<HostCapabilities>;
  session?: Partial<SessionContext>;
  primitives?: CursorHostPrimitives;
}

function toMcpResources(value: unknown): McpResource[] {
  const collect = (v: unknown): McpResource[] => {
    if (Array.isArray(v)) {
      const out: McpResource[] = [];
      for (const item of v) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const uri =
          typeof obj.uri === "string"
            ? obj.uri
            : typeof obj.uriTemplate === "string"
              ? obj.uriTemplate
              : undefined;
        if (uri) {
          const res: McpResource = { uri };
          if (typeof obj.name === "string") res.name = obj.name;
          if (typeof obj.title === "string") res.title = obj.title;
          if (typeof obj.description === "string") res.description = obj.description;
          if (typeof obj.mimeType === "string") res.mimeType = obj.mimeType;
          if (typeof obj.server === "string") res.server = obj.server;
          out.push(res);
          continue;
        }
        for (const key of ["resources", "resourceTemplates", "templates", "items", "data"] as const) {
          const nested = obj[key];
          if (nested !== undefined) out.push(...collect(nested));
        }
      }
      return out;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: McpResource[] = [];
      for (const key of ["resources", "resourceTemplates", "templates", "items", "data"] as const) {
        if (obj[key] !== undefined) out.push(...collect(obj[key]));
      }
      if (out.length === 0) {
        const uri =
          typeof obj.uri === "string"
            ? obj.uri
            : typeof obj.uriTemplate === "string"
              ? obj.uriTemplate
              : undefined;
        if (uri) {
          const res: McpResource = { uri };
          if (typeof obj.name === "string") res.name = obj.name;
          if (typeof obj.title === "string") res.title = obj.title;
          if (typeof obj.description === "string") res.description = obj.description;
          if (typeof obj.mimeType === "string") res.mimeType = obj.mimeType;
          if (typeof obj.server === "string") res.server = obj.server;
          return [res];
        }
      }
      return out;
    }
    if (typeof v === "string" && v.trim()) return [{ uri: v.trim(), name: v.trim() }];
    return [];
  };

  const structured = collect(value);
  if (structured.length > 0) return structured;
  return normalizeMcpResourceEntries(value, 30).map((name) => ({ uri: name, name }));
}

export function createCursorHost(options: CreateCursorHostOptions = {}): AgentHost {
  const capabilities = createCapabilities({ ...CURSOR_DEFAULT_CAPABILITIES, ...options.capabilities });
  const primitives = options.primitives ?? {};
  const sessionBase: SessionContext = {
    host: "cursor",
    ...(options.session?.sessionId !== undefined ? { sessionId: options.session.sessionId } : {}),
    ...(options.session?.cwd !== undefined ? { cwd: options.session.cwd } : {}),
    ...(options.session?.workspaceRoot !== undefined ? { workspaceRoot: options.session.workspaceRoot } : {}),
    ...(options.session?.metadata !== undefined ? { metadata: options.session.metadata } : {}),
  };

  const host: AgentHost = {
    id: "cursor",
    capabilities,
    async registerCommands(commands: CommandDescriptor[]): Promise<void> {
      if (primitives.registerCommands) await primitives.registerCommands(commands);
    },
    async registerTools(tools: ToolDescriptor[]): Promise<void> {
      if (primitives.registerTools) await primitives.registerTools(tools);
    },
    async sendProgress(message: string): Promise<void> {
      if (primitives.sendProgress) await primitives.sendProgress(message);
    },
    async sendFinal(message: string): Promise<void> {
      if (primitives.sendFinal) await primitives.sendFinal(message);
    },
    async askQuestion(request: QuestionRequest): Promise<QuestionAnswer> {
      if (primitives.askQuestion) return await primitives.askQuestion(request);
      const first = request.options?.[0];
      const value = first?.value ?? first?.label ?? "skip";
      return first?.value !== undefined ? { value, optionValue: first.value } : { value };
    },
    getSession(): SessionContext {
      if (primitives.getSession) {
        const s = primitives.getSession() as SessionContext;
        return { ...s, host: "cursor" };
      }
      return { ...sessionBase };
    },
  };

  if (capabilities.nativeForms) {
    host.collectForm = async (request: FormRequest): Promise<FormAnswer | null> => {
      if (primitives.collectForm) return await primitives.collectForm(request);
      return null;
    };
  }
  if (capabilities.mcpResources) {
    host.listMcpResources = async (): Promise<McpResource[]> => {
      if (primitives.listMcpResources) return toMcpResources(await primitives.listMcpResources());
      return [];
    };
  }
  if (primitives.resolveSecret) {
    host.resolveSecret = async (ref: SecretRef): Promise<string> => primitives.resolveSecret!(ref);
  }

  return host;
}

export function createCursorAdapterManifest(
  capabilities: Partial<HostCapabilities> = {},
): AdapterManifest {
  return createAdapterManifest(
    "cursor",
    { ...CURSOR_DEFAULT_CAPABILITIES, ...capabilities },
    {
      packageName: PACKAGE_NAME,
      ...(CURSOR_ADAPTER_MANIFEST.name !== undefined ? { name: CURSOR_ADAPTER_MANIFEST.name } : {}),
      ...(CURSOR_ADAPTER_MANIFEST.description !== undefined
        ? { description: CURSOR_ADAPTER_MANIFEST.description }
        : {}),
    },
  );
}

export function describeCursorCapabilities(capabilities: HostCapabilities = CURSOR_DEFAULT_CAPABILITIES) {
  return negotiateCapabilities(capabilities);
}

export function createCursorCommandDescriptors(
  catalog: readonly { name: string; label: string }[] = ASSAY_COMMAND_CATALOG,
): CommandDescriptor[] {
  return catalog.map((command) => {
    const kind = getCatalogCommandKind(command.name);
    const mode = kind === "browser" ? "browser" : kind === "demo" ? "demo" : "static";
    const allowedSubcommands = ["run", "report", "status", "abort"];
    const args = kind === "browser"
      ? { kind: "raw" as const, name: "url-and-flags", description: "Target URL and optional flags", required: true }
      : kind === "demo"
        ? { kind: "raw" as const, name: "url-and-flags", description: "Optional target URL and flags", required: false }
        : { kind: "raw" as const, name: "goal-and-flags", description: "Optional goal/flags", required: false };
    return {
      name: command.name,
      description:
        kind === "browser"
          ? "Run quality-harness live browser assessment (requires a URL)"
          : kind === "demo"
            ? "Run quality-harness demo assessment (optional URL for live checks)"
            : `Run quality-harness ${command.label} assessment`,
      arguments: args,
      intent: assayIntent(command.label),
      allowedSubcommands,
      mode,
    };
  });
}

export function resolveCursorCatalogInvocation(
  commandName: string,
  text: string,
  personasDir: string,
): CatalogInvocationResult | null {
  return buildCatalogInvocation(commandName, text, personasDir);
}

export function buildCursorBrowserAgentPrompt(input: BrowserAgentPromptInput): string {
  return buildBrowserAgentPrompt(input);
}

export async function registerCursorCommands(
  host: Pick<AgentHost, "registerCommands">,
  commands: CommandDescriptor[] = createCursorCommandDescriptors(),
): Promise<void> {
  await host.registerCommands(commands);
}

// --- Native MCP server compatibility (LEM-151) ---
// Cursor adapter migrates MCP tool execution to lemma's native MCP server handlers
// exposed by @lemma/core/mcp. This preserves the shared AgentHost contract while
// allowing Cursor-hosted flows to invoke lemma tools through the canonical server.
import { handleMcpRequest, MCP_PROTOCOL_REVISION, getMcpToolDefinitions } from "@lemma/core";

export interface LemmaMcpCallResult {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  raw?: unknown;
}

export function getLemmaMcpProtocolRevision(): string {
  return MCP_PROTOCOL_REVISION;
}

export function listLemmaMcpTools() {
  return getMcpToolDefinitions();
}

export async function callLemmaMcpTool(name: string, args: Record<string, unknown> = {}): Promise<LemmaMcpCallResult> {
  const req = { jsonrpc: "2.0" as const, id: `cursor-mcp-${Date.now()}`, method: "tools/call", params: { name, arguments: args } };
  const res = await handleMcpRequest(req);
  const r = res as any;
  if (r?.error) return { ok: false, error: r.error, raw: r };
  const result = r?.result;
  if (result?.isError) return { ok: false, error: result.structuredContent ?? result, result, raw: r };
  return { ok: true, result: result?.structuredContent ?? result, raw: r };
}

export async function initializeLemmaMcpSession(): Promise<unknown> {
  return handleMcpRequest({ jsonrpc: "2.0", id: "cursor-init", method: "initialize", params: {} });
}
