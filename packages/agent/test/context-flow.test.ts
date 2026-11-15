import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyContextResponse,
  formatContextRequest,
  isContextReply,
  parseContextReply,
  runStrictJudgeLoop,
  type PersistedAgentState,
} from "../src/index.js";

function baseState(pending: PersistedAgentState["pending"]): PersistedAgentState {
  return {
    version: 1,
    key: "k",
    goal: "g",
    testPlan: "",
    executedCommands: [],
    runSummaries: [],
    currentReport: "",
    iteration: 1,
    step: 1,
    pending: pending ?? null,
    contextLog: [],
    initialDone: true,
    updatedAt: new Date().toISOString(),
  };
}

describe("LEM-091 context protocol and question flow", () => {
  it("parses and detects tagged/freeform context replies with redaction-safe fields", () => {
    expect(isContextReply("[context:skip]")).toBe(true);
    expect(isContextReply("skip")).toBe(true);
    expect(isContextReply("[source:jira method:paste] hello")).toBe(true);
    expect(isContextReply("regular text")).toBe(false);

    expect(parseContextReply("[context:skip]")).toMatchObject({ skip: true });
    expect(parseContextReply("[source:slack] [method:mcp] [server:s1] [id:t1] note")).toMatchObject({
      source: "slack",
      method: "mcp",
      server: "s1",
      id: "t1",
      text: "note",
    });
    expect(parseContextReply("[source:jira method:token env:MY_SECRET_REF id:ABC-1]")).toMatchObject({
      source: "jira",
      method: "token",
      envRef: "MY_SECRET_REF",
      id: "ABC-1",
    });
  });

  it("formats requests and applies need_context -> need_method -> resolved/skip transitions", () => {
    const needCtx = formatContextRequest(
      { kind: "need_context", type: "jira", question: "Q?", requested: ["AC"], reason: "R" },
      "goal",
      ["resource: s/r1"],
    );
    expect(needCtx).toContain("Context requested");
    expect(needCtx).toContain("[source:jira");
    expect(needCtx).toContain("Available MCP resources");
    expect(needCtx).toContain("resource: s/r1");

    const st1 = baseState({ kind: "need_context", type: "jira", question: "Q?" });
    const r1 = applyContextResponse(st1, "[source:jira]");
    expect(r1.progressed).toBe(true);
    expect(st1.pending?.kind).toBe("need_method");

    const r2 = applyContextResponse(st1, "[method:paste] AC text token=secret123");
    expect(r2.progressed).toBe(true);
    expect(st1.pending).toBeNull();
    expect((st1.contextLog ?? []).some((l) => l.includes("via paste"))).toBe(true);
    expect((st1.contextLog ?? []).join("\n")).not.toContain("secret123");

    const st2 = baseState({ kind: "need_context", type: "slack" });
    applyContextResponse(st2, "[context:skip]");
    expect(st2.pending).toBeNull();
    expect((st2.contextLog ?? []).some((l) => l.includes("skipped"))).toBe(true);
  });

  it("integrates with loop: need_user_context pauses/resumes via userInput and interactive wait", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lemma-ctx-flow-"));
    try {
      const calls: string[] = [];
      let asks = 0;
      const finals: string[] = [];
      const waits: string[] = [];

      // non-interactive pause on need_user_context
      const s1 = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "ctx1", initialArgs: ["run", "--target", "."], maxIterations: 7 },
        {
          runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve("out"); },
          askLlm: () => {
            asks += 1;
            if (asks === 1) return Promise.resolve('{"need_user_context":{"type":"github","question":"need issue"},"reason":"ctx"}');
            return Promise.resolve('{"done":true,"summary":"done","fixes":[]}');
          },
          sendFinal: (t) => { finals.push(t); return Promise.resolve(); },
          listMcpResources: () => Promise.resolve(["resource: gh/issues"]),
        },
      );
      expect(calls).toEqual(["run --target ."]);
      expect(s1.pending?.kind).toBe("need_context");
      expect(finals.some((t) => t.includes("Context requested"))).toBe(true);

      // resume with tagged reply that provides source+method together
      const s2 = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "ctx1", userInput: "[source:github method:mcp server:gh id:123]", initialArgs: ["run", "--target", "."], maxIterations: 7 },
        {
          runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve("out2"); },
          askLlm: () => Promise.resolve('{"done":true,"summary":"done","fixes":[]}'),
          sendFinal: (t) => { finals.push(t); return Promise.resolve(); },
        },
      );
      expect(calls).toEqual(["run --target ."]); // no rerun
      expect(s2.pending == null).toBe(true);
      expect((s2.contextLog ?? []).some((l) => l.includes("via MCP"))).toBe(true);

      // interactive in-session wait resolves pending without new initial execution
      calls.length = 0;
      const s3 = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "ctx2", initialArgs: ["run", "--target", "."], maxIterations: 7, interactive: true },
        {
          runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve("out"); },
          askLlm: () => Promise.resolve('{"need_user_context":{"type":"jira","question":"need ac"},"reason":"ctx"}'),
          sendFinal: () => Promise.resolve(),
          requestUserInput: (p) => { waits.push(p); return Promise.resolve("[context:skip]"); },
        },
      );
      expect(calls).toEqual(["run --target ."]);
      expect(waits.length).toBeGreaterThan(0);
      expect(s3.pending == null).toBe(true);
      expect((s3.contextLog ?? []).some((l) => l.includes("skipped"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
