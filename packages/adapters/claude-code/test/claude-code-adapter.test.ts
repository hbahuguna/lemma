import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance, assertValidHostPackagingManifest, negotiateCapabilities } from "@lemma/adapters-sdk";

import {
  CLAUDE_CODE_ADAPTER_MANIFEST,
  CLAUDE_CODE_PACKAGING_MANIFEST,
  buildClaudeCodeBrowserAgentPrompt,
  createClaudeCodeAdapterManifest,
  createClaudeCodeCommandDescriptors,
  createClaudeCodeHost,
  describeClaudeCodeCapabilities,
  registerClaudeCodeCommands,
  resolveClaudeCodeCatalogInvocation,
} from "../src/index.js";

describe("LEM-102 Claude Code adapter", () => {
  it("exports a valid Claude Code manifest and host that passes conformance", async () => {
    const registered: { commands: unknown[]; tools: unknown[] } = { commands: [], tools: [] };
    const host = createClaudeCodeHost({
      primitives: {
        registerCommands: async (commands) => {
          registered.commands.push(...commands);
        },
        registerTools: async (tools) => {
          registered.tools.push(...tools);
        },
        sendProgress: async () => {},
        sendFinal: async () => {},
        askQuestion: async () => ({ value: "skip" }),
        listMcpResources: async () => ({
          resources: [{ uri: "mcp://docs/spec", name: "spec", server: "docs" }],
        }),
        getSession: () => ({ host: "claude-code", sessionId: "ses_cc", cwd: "/tmp/repo" }),
      },
    });

    expect(CLAUDE_CODE_ADAPTER_MANIFEST.id).toBe("claude-code");
    expect(CLAUDE_CODE_ADAPTER_MANIFEST.packageName).toBe("@lemma/adapters-claude-code");
    expect(CLAUDE_CODE_ADAPTER_MANIFEST.capabilities.nativeForms).toBe(false);
    expect(CLAUDE_CODE_ADAPTER_MANIFEST.capabilities.backgroundTasks).toBe(false);
    expect(CLAUDE_CODE_ADAPTER_MANIFEST.capabilities.worktrees).toBe(false);

    const negotiation = await assertAdapterConformance({
      host,
      manifest: CLAUDE_CODE_ADAPTER_MANIFEST,
    });
    expect(negotiation.limitations.map((l) => l.code)).toContain("native_form_unavailable");
    expect(negotiateCapabilities(CLAUDE_CODE_ADAPTER_MANIFEST.capabilities).degradation.usePasteOrEnvSecretRefForForms).toBe(true);

    const resources = await host.listMcpResources?.();
    expect(resources?.[0]).toMatchObject({ uri: "mcp://docs/spec", server: "docs" });
    expect(host.getSession()).toMatchObject({ host: "claude-code", sessionId: "ses_cc" });
    expect(registered.commands.length).toBeGreaterThan(0);
    expect(registered.tools.length).toBeGreaterThan(0);
  });

  it("maps catalog commands and browser prompt/helpers via @lemma/agent primitives", async () => {
    const descriptors = createClaudeCodeCommandDescriptors();
    expect(descriptors).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(descriptors.find((c) => c.name === "assay-browser")).toMatchObject({
      mode: "browser",
      arguments: { kind: "raw", required: true },
      allowedSubcommands: ["run", "report", "status", "abort"],
    });
    expect(descriptors.find((c) => c.name === "assay-demo")).toMatchObject({
      mode: "demo",
      arguments: { kind: "raw", required: false },
    });
    expect(descriptors.find((c) => c.name === "assay-security")).toMatchObject({
      mode: "static",
      intent: "Assay security assessment",
    });

    const browser = resolveClaudeCodeCatalogInvocation("assay-browser", "https://example.com", "/personas");
    expect(browser?.kind).toBe("browser");
    expect(browser?.invocation.args).toContain("https://example.com");

    const demo = resolveClaudeCodeCatalogInvocation("assay-demo", "", "/personas");
    expect(demo?.kind).toBe("demo");
    expect(demo?.invocation.args).toContain("--no-browser");

    const promptInput = {
      url: "https://example.com",
      args: ["run", "--target", "https://example.com", "--browser"],
      projectDirectory: "/repo",
      repoRoot: "/repo",
      python: "python3",
      ssrfAllowlist: "127.0.0.0/8,::1,localhost",
    };
    expect(buildClaudeCodeBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));

    const host = createClaudeCodeHost();
    await registerClaudeCodeCommands(host);
  });

  it("supports capability overrides and honest degradation for limited host configs", async () => {
    const manifest = createClaudeCodeAdapterManifest({
      questionUi: false,
      mcpResources: false,
      sessionEvents: false,
      modelInvoke: false,
      progressStream: false,
    });
    const host = createClaudeCodeHost({
      capabilities: manifest.capabilities,
      primitives: {
        registerCommands: async () => {},
        registerTools: async () => {},
        sendProgress: async () => {},
        sendFinal: async () => {},
        askQuestion: async () => ({ value: "plain-chat" }),
      },
    });

    const negotiation = await assertAdapterConformance({ host, manifest });
    expect(describeClaudeCodeCapabilities(manifest.capabilities).limitations.map((l) => l.code).sort()).toEqual([
      "mcp_unavailable",
      "model_invocation_unavailable",
      "native_form_unavailable",
      "progress_stream_unavailable",
      "question_ui_unavailable",
      "session_events_unavailable",
    ]);
    expect(negotiation.degradation.persistedStateResumeEnabled).toBe(true);
    expect(typeof host.listMcpResources).toBe("undefined");
  });

  it("exports a validated host packaging manifest", () => {
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.host).toBe("claude-code");
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.packageName).toBe("@lemma/adapters-claude-code");
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.layout).toEqual({
      commandsDir: ".claude/commands",
      skillPath: ".claude/skills/lemma/SKILL.md",
    });
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.commands.catalogCount).toBe(ASSAY_COMMAND_CATALOG.length);
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.commands.catalogNames).toEqual(ASSAY_COMMAND_CATALOG.map((c) => c.name));
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.commands.operationalNames).toEqual(["assay", "assay-status", "assay-report", "assay-abort", "assay-verify-evidence"]);
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.skill).toEqual({ name: "lemma", path: ".claude/skills/lemma/SKILL.md" });
    expect(() => assertValidHostPackagingManifest(CLAUDE_CODE_PACKAGING_MANIFEST, { catalogCount: 59 })).not.toThrow();
  });
});
