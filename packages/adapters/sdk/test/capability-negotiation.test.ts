import { describe, expect, it, vi } from "vitest";

import {
  createCapabilities,
  createPhaseProgressBuffer,
  emitProgress,
  flushBufferedProgress,
  negotiateCapabilities,
  type AgentHost,
} from "../src/index.js";

describe("capability negotiation and graceful degradation", () => {
  it("negotiates full capabilities with no limitations", () => {
    const declared = createCapabilities({
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

    const result = negotiateCapabilities(declared);
    expect(result.effective).toEqual(declared);
    expect(result.limitations).toEqual([]);
    expect(result.degradation).toEqual({
      usePlainChatForQuestions: false,
      usePasteOrEnvSecretRefForForms: false,
      allowMcpPasteOrSkip: false,
      interactiveResumeDisabled: false,
      persistedStateResumeEnabled: true,
      stopAgentLoopAfterDeterministicRun: false,
      bufferProgressAtPhaseBoundaries: false,
    });
  });

  it("records architecture-defined degradation for missing capabilities", () => {
    const result = negotiateCapabilities(createCapabilities());

    const byCode = Object.fromEntries(result.limitations.map((l) => [l.code, l]));
    expect(byCode.question_ui_unavailable).toMatchObject({
      capability: "questionUi",
      blocking: false,
      behavior: "Ask in plain chat, record limitation, and never block the run.",
    });
    expect(byCode.native_form_unavailable).toMatchObject({
      capability: "nativeForms",
      blocking: false,
      behavior:
        "Fall back to paste or secure env reference; never ask for a raw token in prose.",
    });
    expect(byCode.mcp_unavailable).toMatchObject({
      capability: "mcpResources",
      blocking: false,
      behavior: "Record limitation and continue with paste or skip.",
    });
    expect(byCode.session_events_unavailable).toMatchObject({
      capability: "sessionEvents",
      blocking: false,
      behavior: "Disable interactive resume but keep persisted-state resume.",
    });
    expect(byCode.model_invocation_unavailable).toMatchObject({
      capability: "modelInvoke",
      blocking: false,
      behavior: "Stop the agent loop after the deterministic run and report the limitation.",
    });
    expect(byCode.progress_stream_unavailable).toMatchObject({
      capability: "progressStream",
      blocking: false,
      behavior: "Buffer progress and emit it at phase boundaries.",
    });

    expect(result.degradation).toEqual({
      usePlainChatForQuestions: true,
      usePasteOrEnvSecretRefForForms: true,
      allowMcpPasteOrSkip: true,
      interactiveResumeDisabled: true,
      persistedStateResumeEnabled: true,
      stopAgentLoopAfterDeterministicRun: true,
      bufferProgressAtPhaseBoundaries: true,
    });
  });

  it("keeps effective capabilities honest for required/requested negotiation input", () => {
    const declared = createCapabilities({ questionUi: false, progressStream: true, modelInvoke: true });
    const result = negotiateCapabilities(declared, {
      required: { questionUi: true, progressStream: true },
    });

    expect(result.declared.questionUi).toBe(false);
    expect(result.effective.questionUi).toBe(false);
    expect(result.effective.progressStream).toBe(true);
    expect(result.limitations.some((l) => l.code === "question_ui_unavailable")).toBe(true);
    expect(result.limitations.some((l) => l.code === "progress_stream_unavailable")).toBe(false);
  });

  it("buffers progress without streaming and flushes at phase boundaries", async () => {
    const sendProgress = vi.fn(async (_message: string) => {});
    const host = { sendProgress } as Pick<AgentHost, "sendProgress">;
    const buffer = createPhaseProgressBuffer();

    await emitProgress(host, { progressStream: false }, "risk: start", buffer);
    await emitProgress(host, { progressStream: false }, "risk: done", buffer);
    expect(sendProgress).not.toHaveBeenCalled();
    expect(buffer.peek()).toEqual(["risk: start", "risk: done"]);

    const flushed = await flushBufferedProgress(host, buffer);
    expect(flushed).toEqual(["risk: start", "risk: done"]);
    expect(sendProgress).toHaveBeenNthCalledWith(1, "risk: start");
    expect(sendProgress).toHaveBeenNthCalledWith(2, "risk: done");
    expect(buffer.size()).toBe(0);

    await emitProgress(host, { progressStream: true }, "live", buffer);
    expect(sendProgress).toHaveBeenNthCalledWith(3, "live");
    expect(buffer.size()).toBe(0);
  });
});
