import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance, assertValidHostPackagingManifest } from "@lemma/adapters-sdk";
import { main as cliMain, type CliIO } from "../../../cli/src/index.js";

import {
  ANTIGRAVITY_ADAPTER_MANIFEST,
  ANTIGRAVITY_PACKAGING_MANIFEST,
  buildAntigravityBrowserAgentPrompt,
  createAntigravityCommandDescriptors,
  createAntigravityHost,
  registerAntigravityCommands,
  resolveAntigravityCatalogInvocation,
} from "../src/index.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeIo(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) }, stdout, stderr };
}

function parseSingleJson(stdout: string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "{}") as Record<string, unknown>;
}

describe("LEM-111 Antigravity smoke suite", () => {
  it("installs Antigravity assets matching packaging manifest", async () => {
    await withTempDir("lemma-ag-smoke-", async (dir) => {
      const { io, stdout, stderr } = makeIo();
      const code = await cliMain(["install", "antigravity", "--dir", dir], io);
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      const payload = parseSingleJson(stdout);
      expect(payload).toMatchObject({ status: "installed", host: "antigravity", planned: 65, written: 65, skipped: 0 });
      expect(ANTIGRAVITY_PACKAGING_MANIFEST.layout).toEqual({
        commandsDir: ".antigravity/commands",
        skillPath: ".antigravity/skills/lemma/SKILL.md",
      });
      expect(() => assertValidHostPackagingManifest(ANTIGRAVITY_PACKAGING_MANIFEST, { catalogCount: 59 })).not.toThrow();

      const commandsDir = path.join(dir, ".antigravity/commands");
      const files = await readdir(commandsDir);
      expect(files).toHaveLength(64);
      expect(files).toContain("assay-browser.md");
      expect(files).toContain("assay-demo.md");
      expect(files).toContain("assay.md");
      expect(files).toContain("assay-report.md");
      const browser = await readFile(path.join(commandsDir, "assay-browser.md"), "utf8");
      expect(browser).toContain("Require a reachable `http(s)` URL");
      expect(browser).not.toContain("/Users/");
      const demo = await readFile(path.join(commandsDir, "assay-demo.md"), "utf8");
      expect(demo).toContain("--no-browser");
      const reportCmd = await readFile(path.join(commandsDir, "assay-report.md"), "utf8");
      expect(reportCmd).toContain("lemma report --root .lemma");
      const skill = await readFile(path.join(dir, ".antigravity/skills/lemma/SKILL.md"), "utf8");
      expect(skill).toContain("name: lemma");
      expect(skill).toContain("Deterministic harness owns execution, evidence, and scoring");
    });
  });

  it("exposes capability-honest adapter/host and command mapping smoke behavior", async () => {
    expect(ANTIGRAVITY_ADAPTER_MANIFEST.id).toBe("antigravity");
    expect(ANTIGRAVITY_PACKAGING_MANIFEST.host).toBe("antigravity");
    expect(ANTIGRAVITY_ADAPTER_MANIFEST.capabilities).toMatchObject({
      commands: true,
      tools: true,
      questionUi: true,
      nativeForms: false,
      mcpResources: true,
      sessionEvents: false,
      progressStream: true,
      modelInvoke: true,
      backgroundTasks: false,
      worktrees: false,
    });

    const registered: { commands: unknown[]; tools: unknown[] } = { commands: [], tools: [] };
    const host = createAntigravityHost({
      primitives: {
        registerCommands: async (commands) => { registered.commands.push(...commands); },
        registerTools: async (tools) => { registered.tools.push(...tools); },
        sendProgress: async () => {},
        sendFinal: async () => {},
        askQuestion: async () => ({ value: "skip" }),
        listMcpResources: async () => ({ resources: [{ uri: "mcp://ag/resource", name: "resource", server: "ag" }] }),
        getSession: () => ({ host: "antigravity", sessionId: "ses_ag_smoke", cwd: "/tmp/repo" }),
      },
    });

    const negotiation = await assertAdapterConformance({ host, manifest: ANTIGRAVITY_ADAPTER_MANIFEST });
    expect(negotiation.degradation.persistedStateResumeEnabled).toBe(true);
    expect(negotiation.limitations.map((l) => l.code).sort()).toEqual([
      "native_form_unavailable",
      "session_events_unavailable",
    ]);

    const descriptors = createAntigravityCommandDescriptors();
    expect(descriptors).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(descriptors.find((c) => c.name === "assay-browser")).toMatchObject({ mode: "browser", arguments: { kind: "raw", required: true } });
    expect(descriptors.find((c) => c.name === "assay-demo")).toMatchObject({ mode: "demo", arguments: { kind: "raw", required: false } });

    await registerAntigravityCommands(host, descriptors);
    expect(registered.commands.length).toBeGreaterThanOrEqual(ASSAY_COMMAND_CATALOG.length);
    expect(registered.tools.length).toBeGreaterThan(0);

    expect(resolveAntigravityCatalogInvocation("assay-browser", "https://example.com", "/personas")?.invocation.args).toContain("https://example.com");
    expect(resolveAntigravityCatalogInvocation("assay-demo", "", "/personas")?.invocation.args).toContain("--no-browser");
    const promptInput = {
      url: "https://example.com",
      args: ["run", "--target", "https://example.com", "--browser"],
      projectDirectory: "/repo",
      repoRoot: "/repo",
      python: "python3",
      ssrfAllowlist: "127.0.0.0/8,::1,localhost",
    };
    expect(buildAntigravityBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));
  });
});
