import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyContextResponse,
  discoverMcpResources,
  formatContextRequest,
  isContextReply,
  normalizeMcpResourceEntries,
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

describe("LEM-093 MCP resource discovery and secret references", () => {
  it("normalizes heterogeneous MCP resource listings into bounded redacted entries", () => {
    const entries = normalizeMcpResourceEntries(
      {
        resources: [
          { server: "jira", name: "issue", uri: "mcp://jira/issue" },
          "resource: gh/search",
        ],
        resourceTemplates: [
          { server: "slack", uriTemplate: "mcp://slack/{id}" },
          { server: "docs", name: "page token=secret123", uriTemplate: "mcp://docs/{id}" },
        ],
      },
      10,
    );

    expect(entries).toEqual([
      "resource: jira/issue",
      "resource: gh/search",
      "template: slack/mcp://slack/{id}",
      "template: docs/page token=[REDACTED]",
    ]);

    expect(normalizeMcpResourceEntries({ data: { resources: [{ server: "a", uri: "u" }] } })).toEqual([
      "resource: a/u",
    ]);
    expect(normalizeMcpResourceEntries(["one", "two", "three"], 2)).toEqual(["one", "two"]);
  });

  it("discovers MCP resources via hook and tolerates raw shapes/failures", async () => {
    await expect(
      discoverMcpResources({
        listMcpResources: () =>
          Promise.resolve({
            resources: [{ server: "gh", name: "issues" }],
            templates: [{ server: "gh", name: "issue-template" }],
          }),
      }),
    ).resolves.toEqual(["resource: gh/issues", "template: gh/issue-template"]);

    await expect(discoverMcpResources(() => Promise.resolve(["resource: x"]))).resolves.toEqual([
      "resource: x",
    ]);

    await expect(
      discoverMcpResources({
        listMcpResources: () => Promise.reject(new Error("boom")),
      }),
    ).resolves.toEqual([]);
  });

  it("parses and applies secret-reference replies without capturing/persisting raw secrets", () => {
    expect(isContextReply("[method:secret-ref] [env:MY_SECRET]")).toBe(true);

    const token = parseContextReply(
      "[source:jira method:token env:JIRA_TOKEN_REF id:ABC-1] token=raw-secret-value",
    );
    expect(token).toMatchObject({
      source: "jira",
      method: "token",
      envRef: "JIRA_TOKEN_REF",
      id: "ABC-1",
    });
    expect(JSON.stringify(token)).not.toContain("raw-secret-value");

    const alias = parseContextReply("[source:slack method:secret_ref secret-ref:SLACK_REF]");
    expect(alias).toMatchObject({ source: "slack", method: "token", envRef: "SLACK_REF" });

    const st = baseState({ kind: "need_context", type: "jira" });
    const progressed = applyContextResponse(
      st,
      "[source:jira method:token env:JIRA_TOKEN_REF id:ABC-1] token=raw-secret-value",
    );
    expect(progressed.progressed).toBe(true);
    expect(st.pending).toBeNull();
    expect(st.contextLog?.[0]).toContain("via token/secret-ref");
    expect(st.contextLog?.[0]).toContain("JIRA_TOKEN_REF");
    expect(st.contextLog?.join("\n")).not.toContain("raw-secret-value");

    const prompt = formatContextRequest({ kind: "need_method", type: "jira" }, "goal", [
      "resource: gh/issues token=leaked",
    ]);
    expect(prompt).toMatch(/env\/secret ref|do \*\*not\*\* paste tokens\/secrets/i);
    expect(prompt).toContain("resource: gh/issues token=[REDACTED]");
    expect(prompt).not.toContain("leaked");
  });

  it("includes normalized MCP resources in loop context prompts", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lemma-mcp-secret-"));
    try {
      let asks = 0;
      const finals: string[] = [];
      const state = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "mcp1", initialArgs: ["run", "--target", "."], maxIterations: 7 },
        {
          runHarness: () => Promise.resolve("out"),
          askLlm: () => {
            asks += 1;
            if (asks === 1) {
              return Promise.resolve(
                '{"need_user_context":{"type":"github","question":"need issue"},"reason":"ctx"}',
              );
            }
            return Promise.resolve('{"done":true,"summary":"done","fixes":[]}');
          },
          sendFinal: (t) => {
            finals.push(t);
            return Promise.resolve();
          },
          listMcpResources: () =>
            Promise.resolve({
              resources: [{ server: "gh", name: "issues" }],
              resourceTemplates: [{ server: "gh", uriTemplate: "mcp://gh/issues/{id}" }],
            }),
        },
      );

      expect(state.pending?.kind).toBe("need_context");
      expect(finals.some((t) => t.includes("resource: gh/issues"))).toBe(true);
      expect(finals.some((t) => t.includes("template: gh/mcp://gh/issues/{id}"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
