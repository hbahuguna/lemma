import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance, assertValidHostPackagingManifest } from "@lemma/adapters-sdk";
import { main as cliMain, type CliIO } from "../../../cli/src/index.js";

import {
  CURSOR_ADAPTER_MANIFEST,
  CURSOR_PACKAGING_MANIFEST,
  buildCursorBrowserAgentPrompt,
  createCursorCommandDescriptors,
  createCursorHost,
  registerCursorCommands,
  resolveCursorCatalogInvocation,
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

describe("LEM-111 Cursor smoke suite", () => {
  it("installs Cursor assets matching packaging manifest", async () => {
    await withTempDir("lemma-cursor-smoke-", async (dir) => {
      const { io, stdout, stderr } = makeIo();
      const code = await cliMain(["install", "cursor", "--dir", dir], io);
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      const payload = parseSingleJson(stdout);
      expect(payload).toMatchObject({ status: "installed", host: "cursor", planned: 65, written: 65, skipped: 0 });
      expect(CURSOR_PACKAGING_MANIFEST.layout).toEqual({
        commandsDir: ".cursor/commands",
        skillPath: ".cursor/skills/lemma/SKILL.md",
      });
      expect(() => assertValidHostPackagingManifest(CURSOR_PACKAGING_MANIFEST, { catalogCount: 60 })).not.toThrow();

      const commandsDir = path.join(dir, ".cursor/commands");
      const files = await readdir(commandsDir);
      expect(files).toHaveLength(64);
      expect(files).toContain("assay-browser.md");
      expect(files).toContain("assay-demo.md");
      expect(files).toContain("assay.md");
      expect(files).toContain("assay-abort.md");
      const browser = await readFile(path.join(commandsDir, "assay-browser.md"), "utf8");
      expect(browser).toContain("Require a reachable `http(s)` URL");
      expect(browser).not.toContain("/Users/");
      const demo = await readFile(path.join(commandsDir, "assay-demo.md"), "utf8");
      expect(demo).toContain("--no-browser");
      const abortCmd = await readFile(path.join(commandsDir, "assay-abort.md"), "utf8");
      expect(abortCmd).toContain("lemma abort --root .lemma");
      const skill = await readFile(path.join(dir, ".cursor/skills/lemma/SKILL.md"), "utf8");
      expect(skill).toContain("name: lemma");
      expect(skill).toContain("Deterministic harness owns execution, evidence, and scoring");
    });
  });

  it("exposes capability-honest adapter/host and command mapping smoke behavior", async () => {
    expect(CURSOR_ADAPTER_MANIFEST.id).toBe("cursor");
    expect(CURSOR_PACKAGING_MANIFEST.host).toBe("cursor");
    expect(CURSOR_ADAPTER_MANIFEST.capabilities).toMatchObject({
      commands: true,
      tools: true,
      questionUi: false,
      nativeForms: false,
      mcpResources: true,
      sessionEvents: false,
      progressStream: true,
      modelInvoke: true,
      backgroundTasks: false,
      worktrees: false,
    });

    const registered: { commands: unknown[]; tools: unknown[] } = { commands: [], tools: [] };
    const host = createCursorHost({
      primitives: {
        registerCommands: async (commands) => { registered.commands.push(...commands); },
        registerTools: async (tools) => { registered.tools.push(...tools); },
        sendProgress: async () => {},
        sendFinal: async () => {},
        askQuestion: async () => ({ value: "skip" }),
        listMcpResources: async () => ({ resources: [{ uri: "mcp://cursor/notes", name: "notes", server: "cursor" }] }),
        getSession: () => ({ host: "cursor", sessionId: "ses_cur_smoke", cwd: "/tmp/repo" }),
      },
    });

    const negotiation = await assertAdapterConformance({ host, manifest: CURSOR_ADAPTER_MANIFEST });
    expect(negotiation.degradation.persistedStateResumeEnabled).toBe(true);
    expect(negotiation.degradation.usePlainChatForQuestions).toBe(true);
    expect(negotiation.limitations.map((l) => l.code).sort()).toEqual([
      "native_form_unavailable",
      "question_ui_unavailable",
      "session_events_unavailable",
    ]);

    const descriptors = createCursorCommandDescriptors();
    expect(descriptors).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(descriptors.find((c) => c.name === "assay-browser")).toMatchObject({ mode: "browser", arguments: { kind: "raw", required: true } });
    expect(descriptors.find((c) => c.name === "assay-demo")).toMatchObject({ mode: "demo", arguments: { kind: "raw", required: false } });

    await registerCursorCommands(host, descriptors);
    expect(registered.commands.length).toBeGreaterThanOrEqual(ASSAY_COMMAND_CATALOG.length);
    expect(registered.tools.length).toBeGreaterThan(0);

    expect(resolveCursorCatalogInvocation("assay-browser", "https://example.com", "/personas")?.invocation.args).toContain("https://example.com");
    expect(resolveCursorCatalogInvocation("assay-demo", "", "/personas")?.invocation.args).toContain("--no-browser");
    const promptInput = {
      url: "https://example.com",
      args: ["run", "--target", "https://example.com", "--browser"],
      projectDirectory: "/repo",
      repoRoot: "/repo",
      python: "python3",
      ssrfAllowlist: "127.0.0.0/8,::1,localhost",
    };
    expect(buildCursorBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));
  });
});
