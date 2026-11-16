import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance, assertValidHostPackagingManifest } from "@lemma/adapters-sdk";
import { main as cliMain, type CliIO } from "../../../cli/src/index.js";

import {
  CODEX_ADAPTER_MANIFEST,
  CODEX_PACKAGING_MANIFEST,
  buildCodexBrowserAgentPrompt,
  createCodexCommandDescriptors,
  createCodexCommandPack,
  createCodexHost,
  registerCodexCommands,
  resolveCodexCatalogInvocation,
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

describe("LEM-111 Codex smoke suite", () => {
  it("installs Codex assets matching packaging manifest", async () => {
    await withTempDir("lemma-codex-smoke-", async (dir) => {
      const { io, stdout, stderr } = makeIo();
      const code = await cliMain(["install", "codex", "--dir", dir], io);
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      const payload = parseSingleJson(stdout);
      expect(payload).toMatchObject({ status: "installed", host: "codex", planned: 65, written: 65, skipped: 0 });
      expect(CODEX_PACKAGING_MANIFEST.layout).toEqual({
        commandsDir: ".codex/commands",
        skillPath: ".codex/skills/lemma/SKILL.md",
      });
      expect(() => assertValidHostPackagingManifest(CODEX_PACKAGING_MANIFEST, { catalogCount: 60 })).not.toThrow();

      const commandsDir = path.join(dir, ".codex/commands");
      const files = await readdir(commandsDir);
      expect(files).toHaveLength(64);
      expect(files).toContain("assay-browser.md");
      expect(files).toContain("assay-demo.md");
      expect(files).toContain("assay.md");
      expect(files).toContain("assay-status.md");
      expect(files).toContain("assay-verify-evidence.md");
      const browser = await readFile(path.join(commandsDir, "assay-browser.md"), "utf8");
      expect(browser).toContain("Require a reachable `http(s)` URL");
      expect(browser).not.toContain("/Users/");
      const demo = await readFile(path.join(commandsDir, "assay-demo.md"), "utf8");
      expect(demo).toContain("--no-browser");
      const status = await readFile(path.join(commandsDir, "assay-status.md"), "utf8");
      expect(status).toContain("lemma status --root .lemma");
      const skill = await readFile(path.join(dir, ".codex/skills/lemma/SKILL.md"), "utf8");
      expect(skill).toContain("name: lemma");
      expect(skill).toContain("Deterministic harness owns execution, evidence, and scoring");
    });
  });

  it("exposes capability-honest adapter/host and command mapping smoke behavior", async () => {
    expect(CODEX_ADAPTER_MANIFEST.id).toBe("codex");
    expect(CODEX_PACKAGING_MANIFEST.host).toBe("codex");
    expect(CODEX_ADAPTER_MANIFEST.capabilities).toMatchObject({
      commands: true,
      tools: false,
      questionUi: true,
      nativeForms: false,
      mcpResources: true,
      sessionEvents: false,
      progressStream: true,
      modelInvoke: true,
      backgroundTasks: false,
      worktrees: false,
    });

    const registered: { commands: unknown[] } = { commands: [] };
    const host = createCodexHost({
      primitives: {
        registerCommands: async (commands) => { registered.commands.push(...commands); },
        sendProgress: async () => {},
        sendFinal: async () => {},
        askQuestion: async () => ({ value: "skip" }),
        listMcpResources: async () => ({ resources: [{ uri: "mcp://repo/readme", name: "readme", server: "repo" }] }),
        getSession: () => ({ host: "codex", sessionId: "ses_cx_smoke", cwd: "/tmp/repo" }),
      },
    });

    const negotiation = await assertAdapterConformance({ host, manifest: CODEX_ADAPTER_MANIFEST });
    expect(negotiation.degradation.interactiveResumeDisabled).toBe(true);
    expect(negotiation.degradation.persistedStateResumeEnabled).toBe(true);

    const descriptors = createCodexCommandDescriptors();
    expect(descriptors).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(descriptors.find((c) => c.name === "assay-browser")).toMatchObject({ mode: "browser", arguments: { kind: "raw", required: true } });
    expect(descriptors.find((c) => c.name === "assay-demo")).toMatchObject({ mode: "demo", arguments: { kind: "raw", required: false } });

    const pack = createCodexCommandPack(descriptors);
    expect(pack).toMatchObject({ host: "codex", format: "lemma.codex-command-pack/provisional" });
    expect(pack.commands).toHaveLength(ASSAY_COMMAND_CATALOG.length);

    await registerCodexCommands(host, descriptors);
    expect(registered.commands.length).toBeGreaterThanOrEqual(ASSAY_COMMAND_CATALOG.length);

    expect(resolveCodexCatalogInvocation("assay-browser", "https://example.com", "/personas")?.invocation.args).toContain("https://example.com");
    expect(resolveCodexCatalogInvocation("assay-demo", "", "/personas")?.invocation.args).toContain("--no-browser");
    const promptInput = {
      url: "https://example.com",
      args: ["run", "--target", "https://example.com", "--browser"],
      projectDirectory: "/repo",
      repoRoot: "/repo",
      python: "python3",
      ssrfAllowlist: "127.0.0.0/8,::1,localhost",
    };
    expect(buildCodexBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));
  });
});
