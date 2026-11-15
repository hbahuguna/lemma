import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST_CAPABILITIES,
  HOST_IDS,
  createCapabilities,
  isHostId,
  type AgentHost,
  type CommandDescriptor,
  type FormAnswer,
  type FormRequest,
  type HostCapabilities,
  type McpResource,
  type QuestionAnswer,
  type QuestionRequest,
  type SecretRef,
  type SessionContext,
  type ToolDescriptor,
} from "../src/index.js";

class FakeHost implements AgentHost {
  readonly id = "opencode" as const;
  readonly capabilities: HostCapabilities = createCapabilities({
    commands: true,
    tools: true,
    questionUi: true,
    nativeForms: true,
    mcpResources: true,
    sessionEvents: true,
    progressStream: true,
    modelInvoke: true,
  });

  commands: CommandDescriptor[] = [];
  tools: ToolDescriptor[] = [];
  progress: string[] = [];
  finals: string[] = [];

  async registerCommands(commands: CommandDescriptor[]): Promise<void> {
    this.commands.push(...commands);
  }

  async registerTools(tools: ToolDescriptor[]): Promise<void> {
    this.tools.push(...tools);
  }

  async sendProgress(message: string): Promise<void> {
    this.progress.push(message);
  }

  async sendFinal(message: string): Promise<void> {
    this.finals.push(message);
  }

  async askQuestion(request: QuestionRequest): Promise<QuestionAnswer> {
    return { value: request.options?.[0]?.value ?? request.options?.[0]?.label ?? "skip" };
  }

  async collectForm(request: FormRequest): Promise<FormAnswer | null> {
    return { values: Object.fromEntries(request.fields.map((f) => [f.id, ""])), submitted: true };
  }

  async listMcpResources(): Promise<McpResource[]> {
    return [{ uri: "mcp://server/resource", name: "resource", server: "test" }];
  }

  getSession(): SessionContext {
    return { host: this.id, sessionId: "ses_test", cwd: "/tmp" };
  }

  async resolveSecret(ref: SecretRef): Promise<string> {
    return ref.env ?? ref.id ?? "resolved";
  }
}

describe("adapters-sdk AgentHost contract", () => {
  it("exports host ids and capability helpers", () => {
    expect(HOST_IDS).toEqual(["opencode", "claude-code", "codex", "antigravity", "cursor"]);
    expect(isHostId("claude-code")).toBe(true);
    expect(isHostId("unknown-host")).toBe(false);
    expect(DEFAULT_HOST_CAPABILITIES.nativeForms).toBe(false);
    expect(createCapabilities({ questionUi: true, progressStream: true })).toMatchObject({
      questionUi: true,
      progressStream: true,
      nativeForms: false,
      worktrees: false,
    });
  });

  it("models command/tool descriptors and optional host capabilities", async () => {
    const host = new FakeHost();
    const command: CommandDescriptor = {
      name: "assay-browser",
      description: "Live browser assessment",
      arguments: { kind: "raw", name: "url", required: true },
      intent: "Browser assessment",
      allowedSubcommands: ["run", "report", "status", "abort"],
      mode: "browser",
    };
    const tool: ToolDescriptor = {
      name: "assay_jira_context",
      description: "Collect Jira context",
      parameters: { type: "object", properties: { issue: { type: "string" } } },
    };

    await host.registerCommands([command]);
    await host.registerTools([tool]);
    await host.sendProgress("working");
    await host.sendFinal("done");

    expect(host.commands[0]).toMatchObject({
      name: "assay-browser",
      mode: "browser",
      allowedSubcommands: ["run", "report", "status", "abort"],
    });
    expect(host.tools[0]?.name).toBe("assay_jira_context");
    expect(host.capabilities.mcpResources).toBe(true);
    expect(typeof host.collectForm).toBe("function");
    expect(typeof host.listMcpResources).toBe("function");
    expect(typeof host.resolveSecret).toBe("function");

    const answer = await host.askQuestion({ question: "Pick one", options: [{ label: "Skip", value: "skip" }] });
    expect(answer.value).toBe("skip");

    const form = await host.collectForm?.({ fields: [{ id: "token", label: "Token", type: "secret" }] });
    expect(form).toEqual({ values: { token: "" }, submitted: true });

    const resources = await host.listMcpResources?.();
    expect(resources?.[0]).toMatchObject({ uri: "mcp://server/resource", server: "test" });
    expect(host.getSession()).toMatchObject({ host: "opencode", sessionId: "ses_test" });
    await expect(host.resolveSecret?.({ kind: "env", env: "TOKEN_REF" })).resolves.toBe("TOKEN_REF");
  });
});
