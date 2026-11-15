import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ITERATIONS,
  commandSignature,
  commandToArgs,
  isAllowedCommand,
  parseDecision,
  runStrictJudgeLoop,
} from "../src/index.js";

describe("LEM-086 strict-judge agent loop core", () => {
  it("parses strict judge decisions", () => {
    expect(parseDecision('{"command":"run --target .","reason":"x"}')).toMatchObject({ type: "command", command: "run --target ." });
    expect(parseDecision('{"done":true,"summary":"ok","fixes":["a"]}')).toMatchObject({ type: "done", summary: "ok", fixes: ["a"] });
    expect(parseDecision('{"need_user_context":{"question":"q"},"reason":"r"}').type).toBe("need_user_context");
    expect(parseDecision("no json").type).toBe("invalid");
  });

  it("enforces command allowlist", () => {
    expect(isAllowedCommand("run --target .")).toBe(true);
    expect(isAllowedCommand("report")).toBe(true);
    expect(isAllowedCommand("status")).toBe(true);
    expect(isAllowedCommand("abort")).toBe(true);
    expect(isAllowedCommand("assay-browser https://example.test")).toBe(true);
    expect(isAllowedCommand("assay-demo")).toBe(true);
    expect(isAllowedCommand("rm -rf /")).toBe(false);
    expect(isAllowedCommand("sarif")).toBe(false);
  });

  it("builds command args and dedupe signatures", () => {
    expect(commandToArgs("run --target . --max-checks 1").args).toEqual(["run", "--target", ".", "--max-checks", "1"]);
    expect(commandToArgs("assay https://example.test", "personas").args[0]).toBe("run");
    expect(commandSignature(["run", "--target", "."])).toBe("run --target .");
    expect(commandSignature(["run", "--target", "."], { QH_SSRF_ALLOWLIST: "127.0.0.0/8" })).toContain("QH_SSRF_ALLOWLIST");
  });

  it("dedupes executed commands and does not rerun duplicates", async () => {
    const calls: string[] = [];
    const decisions = [
      '{"command":"report","reason":"check report"}',
      '{"command":"report","reason":"duplicate should be skipped"}',
      '{"command":"status","reason":"new"}',
      '{"done":true,"summary":"done","fixes":[]}',
    ];
    let i = 0;
    const finals: string[] = [];
    const state = await runStrictJudgeLoop(
      { goal: "g", initialArgs: ["run", "--target", "."], maxIterations: 7, minHarnessRuns: 1 },
      {
        runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve(JSON.stringify({ ok: true, args })); },
        askLlm: () => Promise.resolve(decisions[i++] ?? '{"done":true,"summary":"done","fixes":[]}'),
        sendFinal: (t) => { finals.push(t); return Promise.resolve(); },
      },
    );
    expect(calls).toEqual(["run --target .", "report", "status"]);
    expect(state.executedCommands).toEqual(["run --target .", "report", "status"]);
    expect(state.runSummaries.some((s) => s.includes("duplicate skipped"))).toBe(true);
    expect(finals.length).toBeGreaterThan(0);
  });

  it("caps iterations at 7 (including initial run) and rejects disallowed commands", async () => {
    const calls: string[] = [];
    let asks = 0;
    const finals: string[] = [];
    await runStrictJudgeLoop(
      { goal: "g", initialArgs: ["run", "--target", "."], maxIterations: 99, minHarnessRuns: 1 },
      {
        runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve("out"); },
        askLlm: () => {
          asks += 1;
          if (asks === 1) return Promise.resolve('{"command":"rm -rf /","reason":"bad"}');
          // always same command => deduped after first execution; loop must still terminate by cap
          return Promise.resolve('{"command":"status","reason":"step"}');
        },
        sendFinal: (t) => { finals.push(t); return Promise.resolve(); },
      },
    );
    expect(DEFAULT_MAX_ITERATIONS).toBe(7);
    // total harness executions (including initial) capped at 7 and duplicates not rerun
    expect(calls.length).toBeLessThanOrEqual(7);
    expect(calls).toEqual(["run --target .", "status"]);
    expect(asks).toBeLessThanOrEqual(6); // bounded consultations within cap
    expect(finals.some((t) => t.includes("cap") || t.includes("7"))).toBe(true);
  });
});
