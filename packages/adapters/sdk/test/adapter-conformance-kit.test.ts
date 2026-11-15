import { describe, expect, it } from "vitest";

import {
  assertAdapterConformance,
  assertValidAdapterManifest,
  createAdapterManifest,
  createCapabilities,
  createFakeHost,
  negotiateCapabilities,
  validateAdapterManifest,
  type AgentHost,
  type HostCapabilities,
} from "../src/index.js";

function fullCaps(): HostCapabilities {
  return createCapabilities({
    commands: true,
    tools: true,
    questionUi: true,
    nativeForms: true,
    mcpResources: true,
    sessionEvents: true,
    progressStream: true,
    modelInvoke: true,
    backgroundTasks: true,
    worktrees: true,
  });
}

describe("adapter conformance kit and fake host", () => {
  it("validates manifests and creates fake hosts with recorded interactions", async () => {
    const manifest = createAdapterManifest("opencode", fullCaps(), { name: "fake-opencode" });
    expect(validateAdapterManifest(manifest)).toEqual({ ok: true, errors: [] });
    expect(() => assertValidAdapterManifest(manifest)).not.toThrow();

    const bad = validateAdapterManifest({ id: "nope" as any, capabilities: {} as any });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("manifest.id");

    const host = createFakeHost({
      id: "opencode",
      capabilities: fullCaps(),
      mcpResources: [{ uri: "mcp://s/r", server: "s" }],
    });
    await host.registerCommands([
      {
        name: "assay",
        description: "Run",
        intent: "Run",
        allowedSubcommands: ["run"],
        mode: "static",
      },
    ]);
    await host.registerTools([{ name: "t", description: "tool" }]);
    await host.sendProgress("p");
    await host.sendFinal("f");
    await host.askQuestion({ question: "q?" });
    await host.collectForm?.({ fields: [{ id: "token", label: "Token", type: "secret" }] });
    await host.listMcpResources?.();
    await host.resolveSecret?.({ kind: "env", env: "X" });

    expect(host.records.commands[0]?.[0]?.name).toBe("assay");
    expect(host.records.tools[0]?.[0]?.name).toBe("t");
    expect(host.records.progress).toEqual(["p"]);
    expect(host.records.finals).toEqual(["f"]);
    expect(host.records.questions).toHaveLength(1);
    expect(host.records.forms).toHaveLength(1);
    expect(host.records.mcpResourceRequests).toBe(1);
    expect(host.records.secretRequests).toEqual([{ kind: "env", env: "X" }]);
    expect(host.getSession().host).toBe("opencode");
  });

  it("passes conformance for a conformant fake host and reports degradation honestly", async () => {
    const caps = createCapabilities({
      commands: true,
      tools: true,
      questionUi: false,
      nativeForms: false,
      mcpResources: false,
      sessionEvents: false,
      progressStream: false,
      modelInvoke: false,
    });
    const host = createFakeHost({ id: "cursor", capabilities: caps });
    const manifest = createAdapterManifest("cursor", caps, { packageName: "@lemma/adapters-cursor" });

    const negotiation = await assertAdapterConformance({ host, manifest });
    expect(typeof host.collectForm).toBe("undefined");
    expect(typeof host.listMcpResources).toBe("undefined");
    expect(negotiation.limitations.map((l) => l.code).sort()).toEqual([
      "mcp_unavailable",
      "model_invocation_unavailable",
      "native_form_unavailable",
      "progress_stream_unavailable",
      "question_ui_unavailable",
      "session_events_unavailable",
    ]);
    expect(negotiation.degradation).toMatchObject({
      usePlainChatForQuestions: true,
      usePasteOrEnvSecretRefForForms: true,
      allowMcpPasteOrSkip: true,
      interactiveResumeDisabled: true,
      persistedStateResumeEnabled: true,
      stopAgentLoopAfterDeterministicRun: true,
      bufferProgressAtPhaseBoundaries: true,
    });
    expect(negotiateCapabilities(caps).limitations).toHaveLength(6);
  });

  it("rejects non-conformant manifest/host cases with actionable failures", async () => {
    const caps = fullCaps();
    const host = createFakeHost({ id: "opencode", capabilities: caps });

    await expect(
      assertAdapterConformance({
        host,
        manifest: createAdapterManifest("claude-code", caps),
      }),
    ).rejects.toThrow(/manifest\.id .* must match host\.id/);

    await expect(
      assertAdapterConformance({
        host,
        manifest: createAdapterManifest("opencode", createCapabilities({ ...caps, questionUi: false })),
      }),
    ).rejects.toThrow(/manifest\.capabilities must match host\.capabilities/);

    const dishonest: AgentHost = {
      id: "opencode",
      capabilities: createCapabilities({ ...caps, nativeForms: false }),
      registerCommands: async (commands) => host.registerCommands(commands),
      registerTools: async (tools) => host.registerTools(tools),
      sendProgress: async (message) => host.sendProgress(message),
      sendFinal: async (message) => host.sendFinal(message),
      askQuestion: async (request) => host.askQuestion(request),
      getSession: () => host.getSession(),
      // incorrectly exposes form method despite unavailable capability
      collectForm: async () => ({ values: {}, submitted: true }),
    };
    await expect(
      assertAdapterConformance({
        host: dishonest,
        manifest: createAdapterManifest("opencode", createCapabilities({ ...caps, nativeForms: false })),
      }),
    ).rejects.toThrow(/nativeForms unavailable must not expose collectForm/);
  });
});
