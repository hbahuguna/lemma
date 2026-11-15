/**
 * @lemma/adapters-opencode — OpenCode host adapter.
 *
 * Provides a capability-honest OpenCode adapter surface on top of the shared
 * AgentHost/manifest contract and @lemma/agent primitives. Host-specific I/O is
 * injected so this package does not depend on @opencode/plugin at build/test time.
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

export const PACKAGE_NAME = "@lemma/adapters-opencode" as const;

export const OPENCODE_DEFAULT_CAPABILITIES: HostCapabilities = createCapabilities({
  commands: true,
  tools: true,
  questionUi: true,
  nativeForms: false, // token-safe context flows prefer paste/env-ref; native forms may be host/tool specific
  mcpResources: true,
  sessionEvents: true,
  progressStream: true,
  modelInvoke: true,
  backgroundTasks: true,
  worktrees: true,
});

export const OPENCODE_ADAPTER_MANIFEST: AdapterManifest = createAdapterManifest(
  "opencode",
  OPENCODE_DEFAULT_CAPABILITIES,
  {
    name: "OpenCode",
    packageName: PACKAGE_NAME,
    description:
      "Lemma adapter for OpenCode using shared AgentHost contract and host-neutral agent primitives.",
  },
);


export const OPENCODE_PACKAGING_MANIFEST: HostPackagingManifest = createHostPackagingManifest({
  host: "opencode",
  packageName: PACKAGE_NAME,
  catalogCommandNames: ASSAY_COMMAND_CATALOG.map((c) => c.name),
});

export interface OpenCodeHostPrimitives {
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

export interface CreateOpenCodeHostOptions {
  capabilities?: Partial<HostCapabilities>;
  session?: Partial<SessionContext>;
  primitives?: OpenCodeHostPrimitives;
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
        // nested container inside array item (rare)
        for (const key of ["resources", "resourceTemplates", "templates", "items", "data"] as const) {
          const nested = obj[key];
          if (nested !== undefined) {
            const inner = collect(nested);
            if (inner.length) out.push(...inner);
          }
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
      // single resource-like object
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
  // fallback: normalize display entries into resource records
  return normalizeMcpResourceEntries(value, 30).map((name) => ({ uri: name, name }));
}

export function createOpenCodeHost(options: CreateOpenCodeHostOptions = {}): AgentHost {
  const capabilities = createCapabilities({ ...OPENCODE_DEFAULT_CAPABILITIES, ...options.capabilities });
  const primitives = options.primitives ?? {};
  const sessionBase: SessionContext = {
    host: "opencode",
    ...(options.session?.sessionId !== undefined ? { sessionId: options.session.sessionId } : {}),
    ...(options.session?.cwd !== undefined ? { cwd: options.session.cwd } : {}),
    ...(options.session?.workspaceRoot !== undefined ? { workspaceRoot: options.session.workspaceRoot } : {}),
    ...(options.session?.metadata !== undefined ? { metadata: options.session.metadata } : {}),
  };

  const host: AgentHost = {
    id: "opencode",
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
        return { ...s, host: "opencode" };
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

export function createOpenCodeAdapterManifest(
  capabilities: Partial<HostCapabilities> = {},
): AdapterManifest {
  return createAdapterManifest(
    "opencode",
    { ...OPENCODE_DEFAULT_CAPABILITIES, ...capabilities },
    {
      packageName: PACKAGE_NAME,
      ...(OPENCODE_ADAPTER_MANIFEST.name !== undefined ? { name: OPENCODE_ADAPTER_MANIFEST.name } : {}),
      ...(OPENCODE_ADAPTER_MANIFEST.description !== undefined
        ? { description: OPENCODE_ADAPTER_MANIFEST.description }
        : {}),
    },
  );
}

export function describeOpenCodeCapabilities(capabilities: HostCapabilities = OPENCODE_DEFAULT_CAPABILITIES) {
  return negotiateCapabilities(capabilities);
}

export function createOpenCodeCommandDescriptors(
  catalog: readonly { name: string; label: string }[] = ASSAY_COMMAND_CATALOG,
): CommandDescriptor[] {
  return catalog.map((command) => {
    const kind = getCatalogCommandKind(command.name);
    const mode = kind === "browser" ? "browser" : kind === "demo" ? "demo" : "static";
    const allowedSubcommands = kind === "browser" || kind === "demo"
      ? ["run", "report", "status", "abort"]
      : ["run", "report", "status", "abort"];
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

export function resolveOpenCodeCatalogInvocation(
  commandName: string,
  text: string,
  personasDir: string,
): CatalogInvocationResult | null {
  return buildCatalogInvocation(commandName, text, personasDir);
}

export function buildOpenCodeBrowserAgentPrompt(input: BrowserAgentPromptInput): string {
  return buildBrowserAgentPrompt(input);
}

export async function registerOpenCodeCommands(
  host: Pick<AgentHost, "registerCommands">,
  commands: CommandDescriptor[] = createOpenCodeCommandDescriptors(),
): Promise<void> {
  await host.registerCommands(commands);
}
