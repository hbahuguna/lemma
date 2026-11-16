import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance, assertValidHostPackagingManifest, negotiateCapabilities } from "@lemma/adapters-sdk";

import {
  CURSOR_ADAPTER_MANIFEST,
  CURSOR_PACKAGING_MANIFEST,
  buildCursorBrowserAgentPrompt,
  createCursorAdapterManifest,
  createCursorCommandDescriptors,
  createCursorHost,
  describeCursorCapabilities,
  registerCursorCommands,
  resolveCursorCatalogInvocation,
} from "../src/index.js";

describe("LEM-105 Cursor adapter", () => {
  it("exports a valid Cursor manifest and host that passes conformance", async () => {
    const registered: { commands: unknown[]; tools: unknown[] } = { commands: [], tools: [] };
    const host = createCursorHost({
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
          resources: [{ uri: "mcp://cursor/notes", name: "notes", server: "cursor" }],
        }),
        getSession: () => ({ host: "cursor", sessionId: "ses_cur", cwd: "/tmp/repo" }),
      },
    });

    expect(CURSOR_ADAPTER_MANIFEST.id).toBe("cursor");
    expect(CURSOR_ADAPTER_MANIFEST.packageName).toBe("@lemma/adapters-cursor");
    expect(CURSOR_ADAPTER_MANIFEST.capabilities.questionUi).toBe(false);
    expect(CURSOR_ADAPTER_MANIFEST.capabilities.sessionEvents).toBe(false);
    expect(CURSOR_ADAPTER_MANIFEST.capabilities.nativeForms).toBe(false);
    expect(CURSOR_ADAPTER_MANIFEST.capabilities.backgroundTasks).toBe(false);
    expect(CURSOR_ADAPTER_MANIFEST.capabilities.worktrees).toBe(false);

    const negotiation = await assertAdapterConformance({ host, manifest: CURSOR_ADAPTER_MANIFEST });
    expect(negotiation.limitations.map((l) => l.code).sort()).toEqual([
      "native_form_unavailable",
      "question_ui_unavailable",
      "session_events_unavailable",
    ]);
    expect(negotiateCapabilities(CURSOR_ADAPTER_MANIFEST.capabilities).degradation.usePlainChatForQuestions).toBe(true);

    const resources = await host.listMcpResources?.();
    expect(resources?.[0]).toMatchObject({ uri: "mcp://cursor/notes", server: "cursor" });
    expect(host.getSession()).toMatchObject({ host: "cursor", sessionId: "ses_cur" });
    expect(registered.commands.length).toBeGreaterThan(0);
    expect(registered.tools.length).toBeGreaterThan(0);
  });

  it("maps catalog commands and browser prompt/helpers via @lemma/agent primitives", async () => {
    const descriptors = createCursorCommandDescriptors();
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

    const browser = resolveCursorCatalogInvocation("assay-browser", "https://example.com", "/personas");
    expect(browser?.kind).toBe("browser");
    expect(browser?.invocation.args).toContain("https://example.com");

    const demo = resolveCursorCatalogInvocation("assay-demo", "", "/personas");
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
    expect(buildCursorBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));

    const host = createCursorHost();
    await registerCursorCommands(host);
  });

  it("supports capability overrides and honest degradation for limited host configs", async () => {
    const manifest = createCursorAdapterManifest({
      mcpResources: false,
      modelInvoke: false,
      progressStream: false,
      tools: false,
      commands: false,
    });
    const host = createCursorHost({
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
    expect(describeCursorCapabilities(manifest.capabilities).limitations.map((l) => l.code).sort()).toEqual([
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
    expect(CURSOR_PACKAGING_MANIFEST.host).toBe("cursor");
    expect(CURSOR_PACKAGING_MANIFEST.packageName).toBe("@lemma/adapters-cursor");
    expect(CURSOR_PACKAGING_MANIFEST.layout).toEqual({
      commandsDir: ".cursor/commands",
      skillPath: ".cursor/skills/lemma/SKILL.md",
    });
    expect(CURSOR_PACKAGING_MANIFEST.commands.catalogCount).toBe(ASSAY_COMMAND_CATALOG.length);
    expect(CURSOR_PACKAGING_MANIFEST.commands.catalogNames).toEqual(ASSAY_COMMAND_CATALOG.map((c) => c.name));
    expect(CURSOR_PACKAGING_MANIFEST.commands.operationalNames).toEqual(["assay", "assay-status", "assay-report", "assay-abort", "assay-verify-evidence"]);
    expect(CURSOR_PACKAGING_MANIFEST.skill).toEqual({ name: "lemma", path: ".cursor/skills/lemma/SKILL.md" });
    expect(() => assertValidHostPackagingManifest(CURSOR_PACKAGING_MANIFEST, { catalogCount: 60 })).not.toThrow();
  });

});
