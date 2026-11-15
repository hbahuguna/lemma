import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_STATE_VERSION,
  agentStateKey,
  agentStatePath,
  loadAgentState,
  runStrictJudgeLoop,
  saveAgentState,
} from "../src/index.js";

describe("LEM-087 agent state persistence and in-session resume", () => {
  it("derives deterministic state path/key and safely handles missing/corrupt/incompatible state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lemma-agent-state-"));
    try {
      const key = agentStateKey({ goal: "g", initialArgs: ["run", "--target", "."] });
      const p1 = agentStatePath(cwd, key);
      const p2 = agentStatePath(cwd, key);
      expect(p1).toBe(p2);
      expect(p1).toContain(path.join(".lemma", "agent"));

      expect(await loadAgentState(cwd, key)).toBeNull();

      await rm(path.dirname(p1), { recursive: true, force: true });
      await (await import("node:fs/promises")).mkdir(path.dirname(p1), { recursive: true });
      await writeFile(p1, "{not-json", "utf8");
      expect(await loadAgentState(cwd, key)).toBeNull();

      await writeFile(p1, JSON.stringify({ version: 999, key, goal: "g" }), "utf8");
      expect(await loadAgentState(cwd, key)).toBeNull();

      await writeFile(p1, JSON.stringify({ version: AGENT_STATE_VERSION, key: "other", goal: "g" }), "utf8");
      expect(await loadAgentState(cwd, key)).toBeNull();

      const saved = await saveAgentState(cwd, {
        version: 1,
        key,
        goal: "g",
        testPlan: "",
        executedCommands: ["run --target ."],
        runSummaries: ["ok"],
        currentReport: "report",
        iteration: 1,
        step: 1,
        pending: null,
        contextLog: [],
        initialArgs: ["run", "--target", "."],
        initialDone: true,
        updatedAt: new Date().toISOString(),
      });
      expect(saved).toBe(p1);
      const loaded = await loadAgentState(cwd, key);
      expect(loaded?.executedCommands).toEqual(["run --target ."]);
      expect(loaded?.initialDone).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("persists and resumes progress without rerunning executed steps", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lemma-agent-resume-"));
    try {
      const calls: string[] = [];
      let i = 0;
      const decisions = [
        '{"command":"report","reason":"r"}',
        '{"need_user_context":{"question":"need info"},"reason":"ctx"}',
      ];
      const finals1: string[] = [];
      const state1 = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "k1", initialArgs: ["run", "--target", "."], maxIterations: 7, minHarnessRuns: 1 },
        {
          runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve("out"); },
          askLlm: () => Promise.resolve(decisions[i++] ?? '{"done":true,"summary":"d","fixes":[]}'),
          sendFinal: (t) => { finals1.push(t); return Promise.resolve(); },
        },
      );
      expect(calls).toEqual(["run --target .", "report"]);
      expect(state1.pending).toBeTruthy();
      expect(finals1.some((t) => t.includes("Context requested"))).toBe(true);

      // resume same key with user input; should apply pending context and continue without rerunning executed commands
      const finals2: string[] = [];
      const state2 = await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "k1", userInput: "skip", initialArgs: ["run", "--target", "."], maxIterations: 7, minHarnessRuns: 1 },
        {
          runHarness: (args) => { calls.push(args.join(" ")); return Promise.resolve("out2"); },
          askLlm: () => Promise.resolve('{"done":true,"summary":"done","fixes":[]}'),
          sendFinal: (t) => { finals2.push(t); return Promise.resolve(); },
        },
      );
      expect(calls).toEqual(["run --target .", "report"]); // no reruns
      expect(state2.pending == null).toBe(true);
      expect((state2.contextLog ?? []).some((l) => l.includes("skipped"))).toBe(true);
      expect(finals2.some((t) => t.includes("done") || t.includes("Assessment"))).toBe(true);

      const savedPath = agentStatePath(cwd, "k1");
      const raw = await readFile(savedPath, "utf8");
      expect(raw).toContain("\"version\": 1");
      expect(raw).toContain("\"key\": \"k1\"");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("redacts secrets from persisted agent state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lemma-agent-redact-"));
    try {
      const finals: string[] = [];
      await runStrictJudgeLoop(
        { goal: "g", cwd, stateKey: "k2", initialArgs: ["run", "--target", "."], maxIterations: 2, minHarnessRuns: 1 },
        {
          runHarness: () => Promise.resolve("authorization: Bearer supersecret token=abc123"),
          askLlm: () => Promise.resolve('{"need_user_context":{"question":"provide token=abc123"},"reason":"ctx"}'),
          sendFinal: (t) => { finals.push(t); return Promise.resolve(); },
        },
      );
      const raw = await readFile(agentStatePath(cwd, "k2"), "utf8");
      expect(raw).not.toContain("supersecret");
      expect(raw).not.toContain("abc123");
      expect(raw).toContain("[REDACTED]");
      expect(finals.length).toBeGreaterThan(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
