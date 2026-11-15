import { describe, expect, it } from "vitest";

import {
  buildExecutionSummary,
  extractRunIds,
  runStrictJudgeLoop,
  summarizeRunOutput,
} from "../src/index.js";

describe("LEM-094 progress, run summaries, and final narrative", () => {
  it("extracts run IDs and summarizes JSON harness output with redaction/fallback", () => {
    const json = JSON.stringify({
      run_id: "run_123",
      status: "completed",
      decision: { decision: "hold" },
      confidence: { score: 0.42, coverage: 0.5 },
      checks: [
        { id: "a", status: "passed", evidence: [1, 2], metadata: { routes: ["/", "/x"], page_count: 2 } },
        { id: "b", status: "skipped", skip_reason: "token=secret123", actual: "Authorization: Bearer abc" },
      ],
      findings: [{ severity: "high", title: "Issue", check_id: "b" }],
      evidence: { directory: "/tmp/.lemma/evidence/run_123" },
      limitations: ["needs auth token=leaked"],
    });

    expect(extractRunIds(json)).toEqual(["run_123"]);
    const summary = summarizeRunOutput(json);
    expect(summary).toContain("Run run_123: status=completed, decision=hold");
    expect(summary).toContain("confidence=0.42 coverage=0.5");
    expect(summary).toContain("checks=2");
    expect(summary).toContain("passed:1");
    expect(summary).toContain("skipped:1");
    expect(summary).toContain("routes=2");
    expect(summary).toContain("findings=1");
    expect(summary).toContain("evidence_dir=/tmp/.lemma/evidence/run_123");
    expect(summary).not.toContain("secret123");
    expect(summary).not.toContain("abc");
    expect(summary).not.toContain("leaked");

    const fallback = summarizeRunOutput("plain output token=secret123");
    expect(fallback).toContain("plain output");
    expect(fallback).not.toContain("secret123");
  });

  it("builds a redacted execution summary from state", () => {
    const summary = buildExecutionSummary({
      testPlan: "Plan token=secret123",
      executedCommands: [],
      runSummaries: ["Command: run --target .\nRun run_1: status=completed, decision=hold"],
      currentReport: "",
      iteration: 1,
      step: 1,
      runIds: ["run_1"],
      contextLog: ["step 1: jira context via token/secret-ref (ENV_REF, id provided)"],
      pending: null,
    });
    expect(summary).toContain("## Test plan");
    expect(summary).toContain("## What was executed (all runs/checks)");
    expect(summary).toContain("Run run_1: status=completed, decision=hold");
    expect(summary).toContain("## Context decisions");
    expect(summary).toContain("## Run IDs");
    expect(summary).toContain("run_1");
    expect(summary).not.toContain("secret123");
  });

  it("emits progress, records structured run summaries/run IDs, and includes final narrative", async () => {
    const progress: string[] = [];
    const finals: string[] = [];
    const runOutput = JSON.stringify({
      run_id: "run_abc",
      status: "completed",
      decision: { decision: "ship" },
      confidence: { score: 0.9, coverage: 1 },
      checks: [{ id: "static.repo_manifest", status: "passed" }],
      findings: [],
    });

    const state = await runStrictJudgeLoop(
      {
        goal: "Assess repo",
        initialArgs: ["run", "--target", ".", "--no-browser"],
        maxIterations: 7,
      },
      {
        progress: (m) => progress.push(m),
        runHarness: () => Promise.resolve(runOutput),
        askLlm: () => Promise.resolve('{"done":true,"summary":"All good","fixes":["none needed"]}'),
        sendFinal: (t) => {
          finals.push(t);
          return Promise.resolve();
        },
      },
    );

    expect(progress.some((m) => m.includes("Iteration 1: running initial assessment"))).toBe(true);
    expect(progress.some((m) => m.includes("consulting strict judge"))).toBe(true);
    expect(progress.some((m) => m.includes("Agent decided it is done"))).toBe(true);

    expect(state.runIds).toEqual(["run_abc"]);
    expect(state.runSummaries.length).toBe(1);
    expect(state.runSummaries[0]).toContain("Command: run --target . --no-browser");
    expect(state.runSummaries[0]).toContain("Run run_abc: status=completed, decision=ship");
    expect(state.runSummaries[0]).toContain("confidence=0.9 coverage=1");

    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain("All good");
    expect(finals[0]).toContain("## What was executed (all runs/checks)");
    expect(finals[0]).toContain("## Run IDs");
    expect(finals[0]).toContain("run_abc");
    expect(finals[0]).toContain("## Suggested fixes");
  });

  it("includes execution summary when iteration cap is reached", async () => {
    const finals: string[] = [];
    let askCount = 0;
    const state = await runStrictJudgeLoop(
      {
        goal: "Assess repo",
        initialArgs: ["run", "--target", ".", "--no-browser"],
        maxIterations: 1,
        minHarnessRuns: 1,
      },
      {
        runHarness: () => Promise.resolve(JSON.stringify({ run_id: "run_cap", status: "completed", decision: "hold", checks: [] })),
        askLlm: () => {
          askCount += 1;
          return Promise.resolve('{"command":"status","reason":"more"}');
        },
        sendFinal: (t) => {
          finals.push(t);
          return Promise.resolve();
        },
      },
    );

    expect(askCount).toBe(0); // initial done consumes step 1 == maxIterations, so loop body not entered
    expect(state.runIds).toEqual(["run_cap"]);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain("Agent reached iteration cap (1).");
    expect(finals[0]).toContain("## Run IDs");
    expect(finals[0]).toContain("run_cap");
  });
});
