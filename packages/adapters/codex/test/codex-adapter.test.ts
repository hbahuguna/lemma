import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance } from "@lemma/adapters-sdk";

import {
  CODEX_ADAPTER_MANIFEST,
  buildCodexBrowserAgentPrompt,
  createCodexAdapterManifest,
  createCodexCommandDescriptors,
  createCodexCommandPack,
  createCodexHost,
  describeCodexCapabilities,
  registerCodexCommands,
  resolveCodexCatalogInvocation,
} from "../src/index.js";

describe("LEM-103 Codex adapter", () => {
  it("exports a valid Codex manifest and host that passes conformance", async () => {
    const registered: { commands: unknown[] } = { commands: [] };
    const host = createCodexHost({
      primitives: {
        registerCommands: async (commands) => {
          registered.commands.push(...commands);
        },
        sendProgress: async () => {},
        sendFinal: async () => {},
        askQuestion: async () => ({ value: "skip" }),
        listMcpResources: async () => ({
          resources: [{ uri: "mcp://repo/readme", name: "readme", server: "repo" }],
        }),
        getSession: () => ({ host: "codex", sessionId: "ses_cx", cwd: "/tmp/repo" }),
      },
    });

    expect(CODEX_ADAPTER_MANIFEST.id).toBe("codex");
    expect(CODEX_ADAPTER_MANIFEST.packageName).toBe("@lemma/adapters-codex");
    expect(CODEX_ADAPTER_MANIFEST.capabilities.tools).toBe(false);
    expect(CODEX_ADAPTER_MANIFEST.capabilities.sessionEvents).toBe(false);
    expect(CODEX_ADAPTER_MANIFEST.capabilities.backgroundTasks).toBe(false);
    expect(CODEX_ADAPTER_MANIFEST.capabilities.nativeForms).toBe(false);
    expect(CODEX_ADAPTER_MANIFEST.capabilities.worktrees).toBe(false);

    const negotiation = await assertAdapterConformance({ host, manifest: CODEX_ADAPTER_MANIFEST });
    expect(negotiation.degradation.interactiveResumeDisabled).toBe(true);
    expect(negotiation.degradation.persistedStateResumeEnabled).toBe(true);

    const resources = await host.listMcpResources?.();
    expect(resources?.[0]).toMatchObject({ uri: "mcp://repo/readme", server: "repo" });
    expect(host.getSession()).toMatchObject({ host: "codex", sessionId: "ses_cx" });
    expect(registered.commands.length).toBeGreaterThan(0);
  });

  it("maps catalog commands, command pack, and browser prompt/helpers via @lemma/agent primitives", async () => {
    const descriptors = createCodexCommandDescriptors();
    expect(descriptors).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(descriptors.find((c) => c.name === "assay-browser")).toMatchObject({
      mode: "browser",
      arguments: { kind: "raw", required: true },
    });
    expect(descriptors.find((c) => c.name === "assay-demo")).toMatchObject({
      mode: "demo",
      arguments: { kind: "raw", required: false },
    });
    expect(descriptors.find((c) => c.name === "assay-security")).toMatchObject({
      mode: "static",
      intent: "Assay security assessment",
    });

    const pack = createCodexCommandPack(descriptors);
    expect(pack).toMatchObject({ host: "codex", format: "lemma.codex-command-pack/provisional" });
    expect(pack.commands).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(pack.commands[0]).toHaveProperty("name");
    expect(pack.commands.find((c) => c.name === "assay-browser")?.allowedSubcommands).toEqual([
      "run",
      "report",
      "status",
      "abort",
    ]);

    const browser = resolveCodexCatalogInvocation("assay-browser", "https://example.com", "/personas");
    expect(browser?.kind).toBe("browser");
    expect(browser?.invocation.args).toContain("https://example.com");

    const demo = resolveCodexCatalogInvocation("assay-demo", "", "/personas");
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
    expect(buildCodexBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));

    const host = createCodexHost();
    await registerCodexCommands(host);
  });

  it("supports capability overrides and honest degradation for limited host configs", async () => {
    const manifest = createCodexAdapterManifest({
      questionUi: false,
      mcpResources: false,
      progressStream: false,
      modelInvoke: false,
    });
    const host = createCodexHost({
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
    expect(describeCodexCapabilities(manifest.capabilities).limitations.map((l) => l.code).sort()).toEqual([
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
});
