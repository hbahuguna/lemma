import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "@lemma/core";

import { main, type CliIO } from "../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-install-"));
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

describe("LEM-107 install command", () => {
  it("installs deterministic host assets for opencode and reports JSON result", async () => {
    await withTempDir(async (dir) => {
      const { io, stdout, stderr } = makeIo();
      const code = await main(["install", "opencode", "--dir", dir, "--cli", "lemma"], io);
      expect(code).toBe(EXIT_CODES.pass);
      expect(stderr).toEqual([]);
      const payload = parseSingleJson(stdout);
      expect(payload.status).toBe("installed");
      expect(payload.command).toBe("install");
      expect(payload.host).toBe("opencode");
      expect(payload.dir).toBe(path.resolve(dir));
      expect(payload.dry_run).toBe(false);
      expect(payload.force).toBe(false);
      expect(payload.planned).toBe(66); // 60 catalog + 5 operational + 1 skill
      expect(payload.written).toBe(65);
      expect(payload.skipped).toBe(0);

      const commandsDir = path.join(dir, ".opencode", "commands");
      const files = await readdir(commandsDir);
      expect(files).toContain("assay-browser.md");
      expect(files).toContain("assay-security.md");
      expect(files).toContain("assay-demo.md");
      expect(files).toContain("assay.md");
      expect(files).toContain("assay-status.md");
      expect(files).toContain("assay-report.md");
      expect(files).toContain("assay-abort.md");
      expect(files).toContain("assay-verify-evidence.md");
      expect(files.length).toBe(64);

      const browser = await readFile(path.join(commandsDir, "assay-browser.md"), "utf8");
      expect(browser).toContain("Require a reachable `http(s)` URL");
      expect(browser).not.toContain("/Users/");
      const demo = await readFile(path.join(commandsDir, "assay-demo.md"), "utf8");
      expect(demo).toContain("static");
      expect(demo).toContain("live browser");
      const status = await readFile(path.join(commandsDir, "assay-status.md"), "utf8");
      expect(status).toContain("lemma status --root .lemma");

      const skill = await readFile(path.join(dir, ".opencode", "skills", "lemma", "SKILL.md"), "utf8");
      expect(skill).toContain("name: lemma");
      expect(skill).toContain("60 assay-style commands");
      expect(skill).toContain("Deterministic harness owns execution, evidence, and scoring");
    });
  });

  it("supports dry-run and skip/force overwrite behavior", async () => {
    await withTempDir(async (dir) => {
      const dry = makeIo();
      const dryCode = await main(["install", "opencode", "--dir", dir, "--dry-run"], dry.io);
      expect(dryCode).toBe(EXIT_CODES.pass);
      const dryPayload = parseSingleJson(dry.stdout);
      expect(dryPayload.status).toBe("dry_run");
      expect(dryPayload.written).toBe(65);
      expect(dryPayload.skipped).toBe(0);
      await expect(stat(path.join(dir, ".opencode"))).rejects.toBeTruthy();

      const first = makeIo();
      await main(["install", "opencode", "--dir", dir], first.io);
      const cmdPath = path.join(dir, ".opencode", "commands", "assay.md");
      const before = await readFile(cmdPath, "utf8");

      const skip = makeIo();
      const skipCode = await main(["install", "opencode", "--dir", dir], skip.io);
      expect(skipCode).toBe(EXIT_CODES.pass);
      const skipPayload = parseSingleJson(skip.stdout);
      expect(skipPayload.status).toBe("installed");
      expect(skipPayload.written).toBe(0);
      expect(skipPayload.skipped).toBe(65);
      expect(await readFile(cmdPath, "utf8")).toBe(before);

      const forced = makeIo();
      const forcedCode = await main(["install", "opencode", "--dir", dir, "--force"], forced.io);
      expect(forcedCode).toBe(EXIT_CODES.pass);
      const forcedPayload = parseSingleJson(forced.stdout);
      expect(forcedPayload.written).toBe(65);
      expect(forcedPayload.skipped).toBe(0);
    });
  });

  it("rejects unsupported hosts as structured usage errors", async () => {
    await withTempDir(async (dir) => {
      const { io, stdout } = makeIo();
      const code = await main(["install", "unknown-host", "--dir", dir], io);
      expect(code).toBe(EXIT_CODES.harnessError);
      const payload = parseSingleJson(stdout);
      expect(payload.ok).toBe(false);
      const err = payload.error as Record<string, unknown>;
      expect(err.type).toBe("CliUsageError");
      expect(String(err.message)).toContain("Unsupported install host");
    });
  });
});
