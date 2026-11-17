import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTEXT_PROTOCOL,
  buildBrowserAgentPrompt,
  commandSignature,
  commandToArgs,
  isAllowedCommand,
  parseDecision,
  runStrictJudgeLoop,
  shellQuote,
} from "../src/index.js";

const PROMPT_INPUT = {
  url: "https://testradius.dev",
  args: [
    "run",
    "--target",
    "https://testradius.dev",
    "--personas-dir",
    "/repo/personas",
    "--intent",
    "Assay browser assessment",
    "--crawl",
    "--max-pages",
    "8",
    "--mobile",
    "--headed",
    "--active",
  ],
  projectDirectory: "/work/project",
  repoRoot: "/repo",
  python: "/usr/local/bin/python3.11",
  ssrfAllowlist: "127.0.0.0/8,::1,localhost",
};

describe("LEM-096 agent-loop and prompt-contract tests", () => {
  it("prompt contract preserves context protocol invariants and browser prompt embedding", () => {
    expect(CONTEXT_PROTOCOL).toMatch(/native `question` tool/);
    expect(CONTEXT_PROTOCOL).toMatch(/Never run `echo`/);
    expect(CONTEXT_PROTOCOL).toMatch(/Never ask for or accept a raw token/);
    expect(CONTEXT_PROTOCOL).toMatch(/Skip/);
    expect(CONTEXT_PROTOCOL).toMatch(/Paste/);
    expect(CONTEXT_PROTOCOL).toMatch(/MCP/);
    expect(CONTEXT_PROTOCOL).toMatch(/Secure env\/secret ref/);
    expect(CONTEXT_PROTOCOL).toMatch(/Jira form/);
    expect(CONTEXT_PROTOCOL).toMatch(/lemma_jira_context/);
    expect(CONTEXT_PROTOCOL).toMatch(/assay_jira_context/);
    expect(CONTEXT_PROTOCOL).toMatch(/site, issue key, email, API token/);
    expect(CONTEXT_PROTOCOL).toMatch(/token is consumed by the tool in memory/i);
    expect(CONTEXT_PROTOCOL).toMatch(/Do not ask for or repeat raw tokens in prose/i);

    const prompt = buildBrowserAgentPrompt(PROMPT_INPUT);
    expect(prompt).toMatch(/https:\/\/testradius\.dev/);
    expect(prompt).toMatch(/python3\.11 -P -m harness/);
    expect(prompt).toMatch(/--crawl/);
    expect(prompt).toMatch(/--max-pages/);
    expect(prompt).toMatch(/--mobile/);
    expect(prompt).toMatch(/--headed/);
    expect(prompt).toMatch(/--active/);
    expect(prompt).toMatch(/Context gathering UX/);
    expect(prompt).toMatch(/native `question` tool/);
    expect(prompt).toMatch(/Fixed phases\/order/i);
    expect(prompt).toMatch(/Deterministic harness owns execution\/evidence\/scoring/i);
    expect(prompt).toMatch(/no repeated commands/i);
    expect(prompt).toMatch(/coverage gaps, never passes/i);
    expect(prompt).toMatch(/never ask for or persist raw credentials/i);
    expect(prompt).toMatch(/Testing-environment behavior/i);
    expect(prompt).toMatch(/Scenario execution/i);
    expect(prompt).toMatch(/Iteration flow/i);

    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("agent-loop contract: decision parsing, allowlist, args/signatures, dedupe and cap", async () => {
    expect(parseDecision('{"command":"run --target .","reason":"x"}')).toMatchObject({
      type: "command",
      command: "run --target .",
    });
    expect(parseDecision('{"done":true,"summary":"ok","fixes":["a"]}')).toMatchObject({
      type: "done",
      summary: "ok",
      fixes: ["a"],
    });
    expect(parseDecision('{"need_user_context":{"type":"jira","question":"q"},"reason":"r"}')).toMatchObject({
      type: "need_user_context",
    });
    expect(parseDecision("not json").type).toBe("invalid");

    expect(isAllowedCommand("run --target .")).toBe(true);
    expect(isAllowedCommand("report")).toBe(true);
    expect(isAllowedCommand("status")).toBe(true);
    expect(isAllowedCommand("abort")).toBe(true);
    expect(isAllowedCommand("assay-browser https://example.test")).toBe(true);
    expect(isAllowedCommand("assay-demo")).toBe(true);
    expect(isAllowedCommand("rm -rf /")).toBe(false);

    expect(commandToArgs("run --target . --max-checks 1", "/tmp/personas").args).toEqual([
      "run",
      "--target",
      ".",
      "--max-checks",
      "1",
    ]);
    expect(commandToArgs("assay-browser http://localhost:3000", "/tmp/personas").args).not.toContain("--no-browser");
    expect(commandSignature(["run", "--target", "."])).toBe("run --target .");
    expect(commandSignature(["run", "--target", "."], { QH_SSRF_ALLOWLIST: "127.0.0.0/8" })).toContain(
      "QH_SSRF_ALLOWLIST",
    );

    const calls: string[] = [];
    let asks = 0;
    const finals: string[] = [];
    const progress: string[] = [];
    const state = await runStrictJudgeLoop(
      { goal: "g", initialArgs: ["run", "--target", "."], maxIterations: 99, minHarnessRuns: 1 },
      {
        progress: (m) => progress.push(m),
        runHarness: (args) => {
          calls.push(args.join(" "));
          return Promise.resolve(JSON.stringify({ run_id: `run-${calls.length}`, status: "completed", decision: "hold", checks: [] }));
        },
        askLlm: () => {
          asks += 1;
          if (asks === 1) return Promise.resolve('{"command":"rm -rf /","reason":"bad"}');
          return Promise.resolve('{"command":"status","reason":"dup-after-first-exec"}');
        },
        sendFinal: (t) => {
          finals.push(t);
          return Promise.resolve();
        },
      },
    );

    // capped at 7 total harness executions including initial; duplicates/disallowed not executed
    expect(calls).toEqual(["run --target .", "status"]);
    expect(state.executedCommands).toEqual(["run --target .", "status"]);
    expect(state.runSummaries.some((s) => s.includes("rejected disallowed command"))).toBe(true);
    expect(state.runSummaries.some((s) => s.includes("duplicate skipped"))).toBe(true);
    expect(progress.some((m) => m.includes("Rejected disallowed command"))).toBe(true);
    expect(progress.some((m) => m.includes("Skipping duplicate command"))).toBe(true);
    expect(finals.some((t) => t.includes("iteration cap") && t.includes("## Run IDs"))).toBe(true);
  });

  it("agent-loop contract: need-context pause/resume, interactive wait, min runs, and final narrative hooks", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lemma-loop-prompt-"));
    try {
      const calls: string[] = [];
      const finals: string[] = [];
      let asks = 0;

      const paused = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "k1", initialArgs: ["run", "--target", "."], minHarnessRuns: 2, maxIterations: 7 },
        {
          runHarness: (args) => {
            calls.push(args.join(" "));
            return Promise.resolve(
              JSON.stringify({ run_id: `run-${calls.length}`, status: "completed", decision: "hold", checks: [] }),
            );
          },
          askLlm: () => {
            asks += 1;
            if (asks === 1) {
              return Promise.resolve('{"need_user_context":{"type":"github","question":"need issue"},"reason":"ctx"}');
            }
            if (asks === 2) {
              return Promise.resolve('{"command":"status","reason":"more evidence"}');
            }
            return Promise.resolve('{"done":true,"summary":"complete","fixes":["f1"]}');
          },
          sendFinal: (t) => {
            finals.push(t);
            return Promise.resolve();
          },
          listMcpResources: () => Promise.resolve(["resource: gh/issues"]),
        },
      );
      expect(paused.pending?.kind).toBe("need_context");
      expect(calls).toEqual(["run --target ."]);
      expect(
        finals.some((t) => t.includes("Context requested") && t.includes("resource: gh/issues") && t.includes("## Run IDs")),
      ).toBe(true);

      // Resume with context reply: loop should execute next unique step, then (with minHarnessRuns satisfied)
      // accept completion and include final narrative/execution summary.
      const done = await runStrictJudgeLoop(
        {
          goal: "g",
          cwd,
          stateKey: "k1",
          userInput: "[source:github method:mcp server:gh id:123]",
          initialArgs: ["run", "--target", "."],
          minHarnessRuns: 2,
          maxIterations: 7,
        },
        {
          runHarness: (args) => {
            calls.push(args.join(" "));
            return Promise.resolve(
              JSON.stringify({ run_id: `run-${calls.length}`, status: "completed", decision: "hold", checks: [] }),
            );
          },
          askLlm: () => {
            asks += 1;
            if (asks === 2) {
              return Promise.resolve('{"command":"status","reason":"more evidence"}');
            }
            return Promise.resolve('{"done":true,"summary":"complete","fixes":["f1"]}');
          },
          sendFinal: (t) => {
            finals.push(t);
            return Promise.resolve();
          },
        },
      );
      expect(calls).toEqual(["run --target .", "status"]);
      expect(done.pending == null).toBe(true);
      expect(done.runIds).toEqual(["run-1", "run-2"]);
      expect((done.contextLog ?? []).some((l) => l.includes("via MCP"))).toBe(true);
      expect(finals.at(-1)).toContain("complete");
      expect(finals.at(-1)).toContain("## What was executed (all runs/checks)");
      expect(finals.at(-1)).toContain("## Run IDs");
      expect(finals.at(-1)).toContain("run-1, run-2");
      expect(finals.at(-1)).toContain("## Suggested fixes");

      // interactive wait resolves pending in-session
      const waits: string[] = [];
      const interactive = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "k2", initialArgs: ["run", "--target", "."], maxIterations: 7, interactive: true },
        {
          runHarness: () =>
            Promise.resolve(JSON.stringify({ run_id: "run-i", status: "completed", decision: "hold", checks: [] })),
          askLlm: () => Promise.resolve('{"need_user_context":{"type":"jira","question":"need ac"},"reason":"ctx"}'),
          sendFinal: () => Promise.resolve(),
          requestUserInput: (p) => {
            waits.push(p);
            return Promise.resolve("[context:skip]");
          },
        },
      );
      expect(waits.length).toBeGreaterThan(0);
      expect(interactive.pending == null).toBe(true);
      expect((interactive.contextLog ?? []).some((l) => l.includes("skipped"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
