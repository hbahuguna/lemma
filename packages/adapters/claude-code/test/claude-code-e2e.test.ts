import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, buildBrowserAgentPrompt } from "@lemma/agent";
import { assertAdapterConformance } from "@lemma/adapters-sdk";
import { main as cliMain, type CliIO } from "../../../cli/src/index.js";

import {
  CLAUDE_CODE_ADAPTER_MANIFEST,
  CLAUDE_CODE_PACKAGING_MANIFEST,
  buildClaudeCodeBrowserAgentPrompt,
  createClaudeCodeCommandDescriptors,
  createClaudeCodeHost,
  registerClaudeCodeCommands,
  resolveClaudeCodeCatalogInvocation,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SAMPLE_REPO = path.join(REPO_ROOT, "examples", "sample-repo");

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
  const text = stdout[0] ?? "";
  expect(text.endsWith("\n")).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

function asObj(v: unknown): Record<string, unknown> {
  expect(v && typeof v === "object" && !Array.isArray(v)).toBe(true);
  return v as Record<string, unknown>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("LEM-110 Claude Code end-to-end suite", () => {
  it("installs Claude Code assets with packaging/template parity", async () => {
    await withTempDir("lemma-cc-install-", async (dir) => {
      const { io, stdout, stderr } = makeIo();
      const code = await cliMain(["install", "claude-code", "--dir", dir], io);
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      const payload = parseSingleJson(stdout);
      expect(payload).toMatchObject({
        schema_version: "quality-harness.report/v1",
        status: "installed",
        command: "install",
        host: "claude-code",
        dry_run: false,
        force: false,
      });
      expect(payload.planned).toBe(65);
      expect(payload.written).toBe(65);
      expect(payload.skipped).toBe(0);
      expect(payload.dir).toBe(path.resolve(dir));

      const { layout, commands, skill } = CLAUDE_CODE_PACKAGING_MANIFEST;
      expect(layout).toEqual({ commandsDir: ".claude/commands", skillPath: ".claude/skills/lemma/SKILL.md" });
      expect(commands.catalogCount).toBe(ASSAY_COMMAND_CATALOG.length);
      expect(commands.catalogNames).toEqual(ASSAY_COMMAND_CATALOG.map((c) => c.name));
      expect(commands.operationalNames).toEqual(["assay", "assay-status", "assay-report", "assay-abort", "assay-verify-evidence"]);
      expect(skill).toEqual({ name: "lemma", path: ".claude/skills/lemma/SKILL.md" });

      const commandsDir = path.join(dir, layout.commandsDir);
      const files = (await readdir(commandsDir)).sort();
      expect(files).toHaveLength(commands.catalogCount + commands.operationalNames.length);
      for (const name of [...commands.catalogNames, ...commands.operationalNames]) {
        expect(files).toContain(`${name}.md`);
      }

      const browser = await readFile(path.join(commandsDir, "assay-browser.md"), "utf8");
      expect(browser).toContain("Require a reachable `http(s)` URL");
      expect(browser).toContain("live browser assessment");
      expect(browser).not.toContain("/Users/");
      const demo = await readFile(path.join(commandsDir, "assay-demo.md"), "utf8");
      expect(demo).toContain("static");
      expect(demo).toContain("live browser");
      expect(demo).toContain("--no-browser");
      const security = await readFile(path.join(commandsDir, "assay-security.md"), "utf8");
      expect(security).toContain("Assay security");
      expect(security).toContain("```bash");
      expect(security).toContain("lemma run");
      const assay = await readFile(path.join(commandsDir, "assay.md"), "utf8");
      expect(assay).toContain("$ARGUMENTS");
      const statusCmd = await readFile(path.join(commandsDir, "assay-status.md"), "utf8");
      expect(statusCmd).toContain("lemma status --root .lemma");
      const verify = await readFile(path.join(commandsDir, "assay-verify-evidence.md"), "utf8");
      expect(verify).toContain("lemma verify-evidence --root .lemma");

      const skillPath = path.join(dir, layout.skillPath);
      expect(await exists(skillPath)).toBe(true);
      const skillContent = await readFile(skillPath, "utf8");
      expect(skillContent).toContain("name: lemma");
      expect(skillContent).toContain("60 assay-style commands");
      expect(skillContent).toContain("Deterministic harness owns execution, evidence, and scoring");
      expect(skillContent).not.toContain("/Users/");
    });
  });

  it("provides adapter/host/command/prompt parity without a live Claude Code runtime", async () => {
    expect(CLAUDE_CODE_ADAPTER_MANIFEST.id).toBe("claude-code");
    expect(CLAUDE_CODE_ADAPTER_MANIFEST.packageName).toBe("@lemma/adapters-claude-code");
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.host).toBe("claude-code");
    expect(CLAUDE_CODE_PACKAGING_MANIFEST.packageName).toBe("@lemma/adapters-claude-code");

    const registered: { commands: unknown[]; tools: unknown[]; progress: string[]; finals: string[] } = {
      commands: [],
      tools: [],
      progress: [],
      finals: [],
    };
    const host = createClaudeCodeHost({
      primitives: {
        registerCommands: async (commands) => {
          registered.commands.push(...commands);
        },
        registerTools: async (tools) => {
          registered.tools.push(...tools);
        },
        sendProgress: async (m) => {
          registered.progress.push(m);
        },
        sendFinal: async (m) => {
          registered.finals.push(m);
        },
        askQuestion: async () => ({ value: "skip" }),
        listMcpResources: async () => ({ resources: [{ uri: "mcp://docs/spec", name: "spec", server: "docs" }] }),
        getSession: () => ({ host: "claude-code", sessionId: "ses_cc_e2e", cwd: "/tmp/repo" }),
      },
    });

    const negotiation = await assertAdapterConformance({ host, manifest: CLAUDE_CODE_ADAPTER_MANIFEST });
    expect(negotiation.limitations.map((l) => l.code)).toContain("native_form_unavailable");
    expect(typeof host.collectForm).toBe("undefined");

    const descriptors = createClaudeCodeCommandDescriptors();
    expect(descriptors).toHaveLength(ASSAY_COMMAND_CATALOG.length);
    expect(descriptors.find((c) => c.name === "assay-browser")).toMatchObject({
      mode: "browser",
      intent: "Assay browser assessment",
      arguments: { kind: "raw", required: true },
      allowedSubcommands: ["run", "report", "status", "abort"],
    });
    expect(descriptors.find((c) => c.name === "assay-demo")).toMatchObject({
      mode: "demo",
      intent: "Assay demo assessment",
      arguments: { kind: "raw", required: false },
    });
    expect(descriptors.find((c) => c.name === "assay-security")).toMatchObject({
      mode: "static",
      intent: "Assay security assessment",
    });

    const commandsBefore = (registered.commands as unknown[]).length;
    await registerClaudeCodeCommands(host, descriptors);
    const registeredCommandNames = (registered.commands as Array<{ name?: string }>).map((c) => c?.name).filter(Boolean);
    expect(registered.commands.length - commandsBefore).toBe(descriptors.length);
    for (const cmd of ASSAY_COMMAND_CATALOG) {
      expect(registeredCommandNames).toContain(cmd.name);
    }
    expect(registered.tools.length).toBeGreaterThan(0);
    expect(host.getSession()).toMatchObject({ host: "claude-code", sessionId: "ses_cc_e2e" });
    const resources = await host.listMcpResources?.();
    expect(resources?.[0]).toMatchObject({ uri: "mcp://docs/spec", server: "docs" });

    const browser = resolveClaudeCodeCatalogInvocation("assay-browser", "https://example.com", "/personas");
    expect(browser?.kind).toBe("browser");
    expect(browser?.invocation.args).toContain("https://example.com");
    const demo = resolveClaudeCodeCatalogInvocation("assay-demo", "", "/personas");
    expect(demo?.kind).toBe("demo");
    expect(demo?.invocation.args).toContain("--no-browser");
    const security = resolveClaudeCodeCatalogInvocation("assay-security", "", "/personas");
    expect(security?.kind).toBe("static");
    expect(security?.invocation.args).toEqual(expect.arrayContaining(["--no-browser", "--intent"]));

    const promptInput = {
      url: "https://example.com",
      args: ["run", "--target", "https://example.com", "--browser"],
      projectDirectory: "/repo",
      repoRoot: "/repo",
      python: "python3",
      ssrfAllowlist: "127.0.0.0/8,::1,localhost",
    };
    expect(buildClaudeCodeBrowserAgentPrompt(promptInput)).toBe(buildBrowserAgentPrompt(promptInput));
  });

  it("runs deterministic CLI assessment and preserves status/report parity", async () => {
    expect(await exists(SAMPLE_REPO)).toBe(true);
    await withTempDir("lemma-cc-run-", async (root) => {
      const outputPath = path.join(root, "report.json");
      const runIo = makeIo();
      const runCode = await cliMain([
        "run",
        "--target", SAMPLE_REPO,
        "--root", root,
        "--intent", "Claude Code e2e deterministic assessment",
        "--seed", "1337",
        "--clock-mode", "frozen",
        "--frozen-clock", "2026-11-14T00:00:00Z",
        "--output", outputPath,
      ], runIo.io);

      expect([0, 1, 2, 3]).toContain(runCode);
      expect(runIo.stderr.join("")).toContain("[lemma]");
      const report = parseSingleJson(runIo.stdout);
      expect(report.schema_version).toBe("quality-harness.report/v1");
      expect(typeof report.run_id).toBe("string");
      expect((report.run_id as string).length).toBeGreaterThan(0);
      expect(typeof report.status).toBe("string");
      expect(typeof report.intent).toBe("string");

      const target = asObj(report.target);
      expect(typeof target.resolved === "string" || typeof target.raw === "string").toBe(true);
      const coverage = asObj(report.coverage);
      expect(typeof coverage.total_checks).toBe("number");
      expect(typeof coverage.executed).toBe("number");
      expect(typeof coverage.passed).toBe("number");
      expect(typeof coverage.failed).toBe("number");
      expect(typeof coverage.blocked).toBe("number");
      expect(typeof coverage.skipped).toBe("number");
      expect(Array.isArray(report.checks)).toBe(true);
      expect(Array.isArray(report.findings)).toBe(true);
      expect(Array.isArray(report.blockers)).toBe(true);
      expect(report.confidence && typeof report.confidence === "object").toBe(true);
      expect(report.decision && typeof report.decision === "object").toBe(true);

      const written = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
      expect(written.run_id).toBe(report.run_id);
      expect(written.schema_version).toBe("quality-harness.report/v1");

      const statusIo = makeIo();
      const statusCode = await cliMain(["status", "--root", root], statusIo.io);
      expect(statusCode).toBe(0);
      expect(statusIo.stderr).toEqual([]);
      const status = parseSingleJson(statusIo.stdout);
      expect(status.run_id).toBe(report.run_id);
      expect(typeof status.status).toBe("string");
      expect(status.checks_by_status && typeof status.checks_by_status === "object").toBe(true);
      expect(status.findings_by_severity && typeof status.findings_by_severity === "object").toBe(true);
      expect(String(status.progress_path)).toContain(".lemma");
      expect(await exists(path.join(root, ".lemma", "progress.json"))).toBe(true);

      const reportIo = makeIo();
      const reportCode = await cliMain(["report", "--root", root], reportIo.io);
      expect(reportCode).toBe(0);
      expect(reportIo.stderr).toEqual([]);
      const latest = parseSingleJson(reportIo.stdout);
      expect(latest.run_id).toBe(report.run_id);
      expect(latest.schema_version).toBe("quality-harness.report/v1");
    });
  }, 120000);
});
