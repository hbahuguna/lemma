import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ManagerSession,
  formatHelpMessage,
  getSlashCommandCatalog,
  isSlashCommand,
  listSlashCommandHints,
  routeSlashCommand,
  runStrictJudgeLoop,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-154 slash command router", () => {
  it("loads versioned catalog and routes every documented command", () => {
    const catalog = getSlashCommandCatalog();
    expect(catalog.schema_version).toBe("lemma.agent.slash_commands/v1");
    const required = [
      "/lemma",
      "/lemma-test",
      "/lemma-issues",
      "/lemma-accessibility",
      "/lemma-map",
      "/lemma-help",
      "/lemma-settings",
      "/jay",
      "/full",
      "/lemma-background",
      "/lemma-pro",
    ];
    for (const cmd of required) {
      const res = routeSlashCommand(cmd, catalog);
      expect(res.decision.kind).toBe("known");
      expect(res.decision.command === cmd || (cmd === "/jay" && res.decision.command === "/jay") || (cmd === "/full" && res.decision.command === "/full")).toBe(true);
      expect(["manager", "catalog", "dashboard"]).toContain(res.decision.target);
    }
  });

  it("parses arguments, maps intents/targets, and handles aliases", () => {
    const test = routeSlashCommand('/lemma-test "https://example.com/app"');
    expect(test.decision.kind).toBe("known");
    if (test.decision.kind === "known") {
      expect(test.decision.target).toBe("catalog");
      expect(test.decision.intent).toContain("test");
      expect(test.decision.args.join(" ")).toContain("https://example.com/app");
    }

    const map = routeSlashCommand("/lemma-map run_123");
    expect(map.decision.kind).toBe("known");
    if (map.decision.kind === "known") {
      expect(map.decision.target).toBe("dashboard");
      expect(map.decision.dashboard_route).toBe("/dashboard/map");
      expect(map.decision.parsed.positional[0]).toBe("run_123");
    }

    const jay = routeSlashCommand("/jay assess checkout");
    expect(jay.decision.kind).toBe("known");
    if (jay.decision.kind === "known") {
      expect(jay.decision.target).toBe("manager");
      expect(jay.decision.intent).toBe("manager.assess");
    }

    const full = routeSlashCommand("/full https://example.com");
    expect(full.decision.kind).toBe("known");
    if (full.decision.kind === "known") {
      expect(full.decision.target).toBe("catalog");
      expect(full.decision.intent).toContain("full");
    }
  });

  it("returns typed unknown-command response with helpful hints and never silent/fabricated execution", () => {
    const res = routeSlashCommand("/lemma-does-not-exist --flag");
    expect(res.decision.kind).toBe("unknown");
    expect(res.decision.target).toBe("unknown");
    if (res.decision.kind === "unknown") {
      expect(res.decision.error.type).toBe("unknown_command");
      expect(res.decision.error.hints.length).toBeGreaterThan(0);
      expect(res.decision.error.hints.some((h) => h.includes("/lemma-help"))).toBe(true);
      expect(res.decision.error.hints.some((h) => h.includes("/lemma-test"))).toBe(true);
    }
    expect(res.message).toContain("Unknown slash command");
    expect(res.message).toContain("/lemma-help");
  });

  it("is redaction-safe for argument echoing and error messages", () => {
    const secret = "Bearer super-secret-token";
    const res = routeSlashCommand(`/lemma-unknown ${secret} token=abc123apikey`);
    expect(res.decision.kind).toBe("unknown");
    expect(JSON.stringify(res.decision)).not.toContain("super-secret-token");
    expect(res.message ?? "").not.toContain("super-secret-token");
  });

  it("help command surfaces hint list and manager help formatting is redacted", () => {
    const help = routeSlashCommand("/lemma-help");
    expect(help.decision.kind).toBe("known");
    if (help.decision.kind === "known") {
      expect(help.decision.target).toBe("manager");
      expect(help.decision.intent).toBe("manager.help");
    }
    const hints = listSlashCommandHints();
    expect(hints.length).toBeGreaterThanOrEqual(11);
    const msg = formatHelpMessage();
    expect(msg).toContain("/lemma-test");
    expect(msg).toContain("/lemma-map");
  });

  it("manager-flow integration: slash help and dashboard routes flow through manager narration without exposing token", async () => {
    const cwd = await mkdtemp("lemma-slash-mgr-");
    tempDirs.push(cwd);
    const messages: string[] = [];
    const manager = new ManagerSession({
      cwd,
      goal: "/lemma-help",
      sink: (m) => { messages.push(`${m.type}:${m.text}`); },
      determinism: { seed: 1, clockMode: "frozen", frozenClock: "2026-11-16T00:00:00Z" },
    });
    const state = await manager.run({
      runHarness: async () => JSON.stringify({ ok: true }),
      askLlm: async () => JSON.stringify({ done: true, summary: "done" }),
      sendFinal: async () => {},
    });
    const joined = state.messages.map((m) => m.text).join("\n");
    expect(joined).toContain("/lemma-test");
    expect(joined).toContain("Available lemma slash commands");
    expect(joined).not.toContain("token=");

    const cwd2 = await mkdtemp("lemma-slash-map-");
    tempDirs.push(cwd2);
    const manager2 = new ManagerSession({
      cwd: cwd2,
      goal: "/lemma-map run_abc",
      sink: () => {},
      determinism: { seed: 1, clockMode: "frozen", frozenClock: "2026-11-16T00:00:00Z" },
    });
    const state2 = await manager2.run({
      runHarness: async () => JSON.stringify({ ok: true }),
      askLlm: async () => JSON.stringify({ done: true, summary: "done" }),
      sendFinal: async () => {},
    });
    const joined2 = state2.messages.map((m) => m.text).join("\n");
    expect(joined2).toMatch(/dashboard|\/dashboard\/map/i);
    expect(joined2).not.toMatch(/token=[^&\s]+/i);
  });

  it("dashboard-route integration (mock): known dashboard command returns dashboard routing decision", () => {
    const res = routeSlashCommand("/lemma-pro");
    expect(res.decision.kind).toBe("known");
    if (res.decision.kind === "known") {
      expect(res.decision.target).toBe("dashboard");
      expect(res.decision.dashboard_route).toBe("/dashboard/pro");
    }
  });

  it("agent-loop honors router decisions for slash-command goals (help/unknown routed without fabricated harness execution)", async () => {
    const cwd = await mkdtemp("lemma-slash-loop-");
    tempDirs.push(cwd);
    let harnessCalls = 0;
    const finals: string[] = [];
    const state = await runStrictJudgeLoop(
      {
        goal: "/lemma-help",
        cwd,
        interactive: false,
      },
      {
        runHarness: async () => { harnessCalls += 1; return JSON.stringify({ ok: true }); },
        askLlm: async () => JSON.stringify({ done: true, summary: "done" }),
        sendFinal: async (t) => { finals.push(t); },
      },
    );
    const out = finals.join("\n") + "\n" + (state.currentReport ?? "");
    expect(out).toContain("/lemma-test");
    expect(harnessCalls).toBe(0);

    const cwd2 = await mkdtemp("lemma-slash-unknown-");
    tempDirs.push(cwd2);
    let harnessCalls2 = 0;
    const finals2: string[] = [];
    await runStrictJudgeLoop(
      {
        goal: "/totally-unknown-cmd",
        cwd: cwd2,
        interactive: false,
      },
      {
        runHarness: async () => { harnessCalls2 += 1; return JSON.stringify({ ok: true }); },
        askLlm: async () => JSON.stringify({ done: true, summary: "done" }),
        sendFinal: async (t) => { finals2.push(t); },
      },
    );
    expect(finals2.join("\n")).toContain("Unknown slash command");
    expect(finals2.join("\n")).toContain("/lemma-help");
    expect(harnessCalls2).toBe(0);

    expect(isSlashCommand("/lemma-test")).toBe(true);
  });
});
