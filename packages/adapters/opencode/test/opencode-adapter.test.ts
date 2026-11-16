import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance, assertValidHostPackagingManifest, negotiateCapabilities } from "@lemma/adapters-sdk";

import {
  OPENCODE_ADAPTER_MANIFEST,
  OPENCODE_PACKAGING_MANIFEST,
  buildOpenCodeBrowserAgentPrompt,
  createOpenCodeAdapterManifest,
  createOpenCodeCommandDescriptors,
  createOpenCodeHost,
  describeOpenCodeCapabilities,
  registerOpenCodeCommands,
  resolveOpenCodeCatalogInvocation,
} from "../src/index.js";

describe("LEM-101 OpenCode adapter", () => {
  it("exports a valid OpenCode manifest and host that passes conformance", async () => {
    const registered: { commands: unknown[]; tools: unknown[] } = { commands: [], tools: [] };
    const host = createOpenCodeHost({
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
          resources: [{ uri: "mcp://jira/issues", name: "issues", server: "jira" }],
        }),
        getSession: () => ({ host: "opencode", sessionId: "ses_oc", cwd: "/tmp/repo" }),
      },
    });

    expect(OPENCODE_ADAPTER_MANIFEST.id).toBe("opencode");
    expect(OPENCODE_ADAPTER_MANIFEST.packageName).toBe("@lemma/adapters-opencode");
    expect(OPENCODE_ADAPTER_MANIFEST.capabilities.commands).toBe(true);

    const negotiation = await assertAdapterConformance({
      host,
      manifest: OPENCODE_ADAPTER_MANIFEST,
    });
    expect(negotiation.limitations.some((l) => l.code === "native_form_unavailable")).toBe(true);
    expect(negotiateCapabilities(OPENCODE_ADAPTER_MANIFEST.capabilities).degradation.usePasteOrEnvSecretRefForForms).toBe(true);

    const resources = await host.listMcpResources?.();
    expect(resources?.[0]).toMatchObject({ uri: "mcp://jira/issues", server: "jira" });
    expect(host.getSession()).toMatchObject({ host: "opencode", sessionId: "ses_oc" });
    expect(registered.commands.length).toBeGreaterThan(0);
    expect(registered.tools.length).toBeGreaterThan(0);
  });

  it("maps catalog commands and browser prompt/helpers via @lemma/agent primitives", async () => {
    const descriptors = createOpenCodeCommandDescriptors();
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

    const browser = resolveOpenCodeCatalogInvocation("assay-browser", "https://example.com", "/personas");
    expect(browser?.kind).toBe("browser");
    expect(browser?.invocation.args).toContain("https://example.com");

    const demo = resolveOpenCodeCatalogInvocation("assay-demo", "", "/personas");
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
    expect(buildOpenCodeBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));

    const host = createOpenCodeHost();
    await registerOpenCodeCommands(host);
  });

  it("supports capability overrides and honest degradation for limited host configs", async () => {
    const manifest = createOpenCodeAdapterManifest({
      questionUi: false,
      mcpResources: false,
      sessionEvents: false,
      modelInvoke: false,
      progressStream: false,
    });
    const host = createOpenCodeHost({
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
    expect(describeOpenCodeCapabilities(manifest.capabilities).limitations.map((l) => l.code).sort()).toEqual([
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
    expect(OPENCODE_PACKAGING_MANIFEST.host).toBe("opencode");
    expect(OPENCODE_PACKAGING_MANIFEST.packageName).toBe("@lemma/adapters-opencode");
    expect(OPENCODE_PACKAGING_MANIFEST.layout).toEqual({
      commandsDir: ".opencode/commands",
      skillPath: ".opencode/skills/lemma/SKILL.md",
    });
    expect(OPENCODE_PACKAGING_MANIFEST.commands.catalogCount).toBe(ASSAY_COMMAND_CATALOG.length);
    expect(OPENCODE_PACKAGING_MANIFEST.commands.catalogNames).toEqual(ASSAY_COMMAND_CATALOG.map((c) => c.name));
    expect(OPENCODE_PACKAGING_MANIFEST.commands.operationalNames).toEqual([
      "assay",
      "assay-status",
      "assay-report",
      "assay-abort",
      "assay-verify-evidence",
    ]);
    expect(OPENCODE_PACKAGING_MANIFEST.skill).toEqual({ name: "lemma", path: ".opencode/skills/lemma/SKILL.md" });
    expect(() => assertValidHostPackagingManifest(OPENCODE_PACKAGING_MANIFEST, { catalogCount: 60 })).not.toThrow();
  });
});
