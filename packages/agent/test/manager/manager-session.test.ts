import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { lintPersonas, loadPersonas, parseFrontmatter, readPersonaDocument } from "@lemma/core";

import {
  ManagerSession,
  loadManagerSessionState,
  redactManagerMessage,
  type ManagerMessage,
} from "../../src/manager-session.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function repoPath(...parts: string[]): string {
  // packages/agent/test/manager -> repo root
  return path.resolve(__dirname, "../../../../", ...parts);
}

describe("LEM-141 manager persona", () => {
  it("parses manager frontmatter, owns no checks, and passes lint", async () => {
    const personasDir = repoPath("packages", "personas");
    const managerPath = path.join(personasDir, "manager.md");
    const doc = await readPersonaDocument(managerPath);
    const fm = parseFrontmatter(await fs.readFile(managerPath, "utf8"));
    expect(fm.id).toBe("manager");
    expect(Array.isArray(fm.checks)).toBe(true);
    expect((fm.checks as unknown[]).length).toBe(0);

    const loaded = await loadPersonas(personasDir, { requireMinimum: 1 });
    const manager = loaded.find((p) => p.id === "manager");
    expect(manager).toBeTruthy();
    expect(manager?.checks).toEqual([]);
    expect(doc.sections["role"]).toBeTruthy();

    const knownChecks = Array.from(
      new Set(loaded.flatMap((p) => p.checks)),
    );
    const lint = await lintPersonas(personasDir, knownChecks);
    expect(lint.status).toBe("valid");
    expect(lint.errors).toEqual([]);
    const lintManager = lint.personas.find((p) => p.id === "manager");
    expect(lintManager?.checks).toEqual([]);
  });
});

describe("LEM-141 manager session", () => {
  it("routes plan/progress/summary messages to a host-neutral sink and redacts emitted/persisted content", async () => {
    const cwd = await mkdtemp("lemma-manager-route-");
    tempDirs.push(cwd);
    const sinkMessages: ManagerMessage[] = [];
    const session = new ManagerSession({
      cwd,
      goal: "Assess token=secret123 handling",
      determinism: { seed: 7, clockMode: "frozen", frozenClock: "2026-11-16T00:00:00Z" },
      sink: (m) => {
        sinkMessages.push(m);
      },
      initialArgs: ["run", "--target", ".", "--no-browser"],
      maxIterations: 2,
      minHarnessRuns: 1,
    });

    const runOutput = JSON.stringify({
      run_id: "run_mgr_1",
      status: "completed",
      decision: { decision: "hold" },
      confidence: { score: 0.5, coverage: 0.6 },
      checks: [{ id: "static.repo_manifest", status: "passed" }],
      findings: [],
    });

    const state = await session.run({
      runHarness: async () => runOutput,
      askLlm: async () => '{"done":true,"summary":"Done with token=secret123","fixes":["rotate token=secret123"]}',
    });

    expect(sinkMessages.map((m) => m.type)).toEqual(expect.arrayContaining(["plan", "progress", "summary"]));
    expect(sinkMessages[0]?.type).toBe("plan");
    const summary = sinkMessages.find((m) => m.type === "summary");
    expect(summary).toBeTruthy();
    expect(summary?.run_ids).toContain("run_mgr_1");

    const allText = JSON.stringify(sinkMessages);
    expect(allText).not.toContain("secret123");

    expect(state.status).toBe("completed");
    expect(state.run_ids).toContain("run_mgr_1");
    expect(state.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain("secret123");

    const persisted = await fs.readFile(path.join(cwd, ".lemma", "agent", "manager.json"), "utf8");
    expect(persisted).not.toContain("secret123");
    const loaded = await loadManagerSessionState(cwd);
    expect(loaded?.status).toBe("completed");
  });

  it("emits a redacted question message when context is requested and persists awaiting state", async () => {
    const cwd = await mkdtemp("lemma-manager-question-");
    tempDirs.push(cwd);
    const sinkMessages: ManagerMessage[] = [];
    const session = new ManagerSession({
      cwd,
      goal: "Need context",
      determinism: { seed: 11, clockMode: "frozen", frozenClock: "2026-11-16T00:00:00Z" },
      sink: (m) => {
        sinkMessages.push(m);
      },
      initialArgs: ["run", "--target", ".", "--no-browser"],
      maxIterations: 3,
    });

    let askCount = 0;
    const state = await session.run({
      runHarness: async () => JSON.stringify({ run_id: "run_mgr_q1", status: "completed", checks: [], findings: [] }),
      askLlm: async () => {
        askCount += 1;
        if (askCount === 1) {
          return JSON.stringify({
            need_user_context: { type: "jira", question: "Provide AC token=secret123", requested: ["AC"] },
            reason: "missing context token=secret123",
          });
        }
        return '{"done":true,"summary":"later","fixes":[]}';
      },
    });

    expect(state.status).toBe("awaiting_input");
    const question = sinkMessages.find((m) => m.type === "question");
    expect(question).toBeTruthy();
    expect(question?.text).toContain("Context requested");
    expect(JSON.stringify(question)).not.toContain("secret123");

    const persisted = await loadManagerSessionState(cwd);
    expect(persisted?.status).toBe("awaiting_input");
    expect(persisted?.last_question?.type).toBe("question");
    expect(JSON.stringify(persisted)).not.toContain("secret123");
  });

  it("is deterministic and resumable with same seed/frozen clock and same assessment (manager state/messages replay)", async () => {
    const cwd = await mkdtemp("lemma-manager-det-");
    tempDirs.push(cwd);

    const runAssessment = async () => {
      const sink: ManagerMessage[] = [];
      const session = new ManagerSession({
        cwd,
        goal: "Deterministic assessment",
        determinism: { seed: 42, clockMode: "frozen", frozenClock: "2026-11-16T00:00:00Z" },
        sink: (m) => sink.push(m),
        stateKey: "mgr-det",
        initialArgs: ["run", "--target", ".", "--no-browser"],
        maxIterations: 2,
      });
      const state = await session.run({
        runHarness: async () => JSON.stringify({ run_id: "run_det", status: "completed", decision: "ship", checks: [], findings: [] }),
        askLlm: async () => '{"done":true,"summary":"Stable summary","fixes":[]}',
      });
      const file = await fs.readFile(path.join(cwd, ".lemma", "agent", "manager.json"), "utf8");
      return { sink, state, file };
    };

    const a = await runAssessment();
    const b = await runAssessment(); // idempotent resume/replay over same persisted session

    expect(a.state.status).toBe("completed");
    expect(b.state.status).toBe("completed");
    expect(a.state.run_ids).toEqual(b.state.run_ids);
    expect(a.state.messages.map((m) => m.type)).toEqual(
      expect.arrayContaining(["plan", "progress", "summary"]),
    );
    expect(b.state.messages).toEqual(a.state.messages);
    expect(b.file).toBe(a.file); // byte-identical persisted manager state replay
    expect(a.sink.length).toBeGreaterThan(0);
  });

  it("redactManagerMessage removes secret values", () => {
    const msg = redactManagerMessage({
      type: "progress",
      text: "Authorization: Bearer secret123 token=abc",
      generated_at: "2026-11-16T00:00:00Z",
      details: { token: "abc", note: "password=hunter2" },
    });
    const text = JSON.stringify(msg);
    expect(text).not.toContain("secret123");
    expect(text).not.toContain("hunter2");
  });
});
