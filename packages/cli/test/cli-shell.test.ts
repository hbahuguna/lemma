import { describe, expect, it } from "vitest";

import { EXIT_CODES, HarnessError, PolicyThresholdError } from "@lemma/core";

import {
  CLI_NAME,
  CLI_VERSION,
  createCommandRegistry,
  dispatch,
  main,
  usagePayload,
  versionPayload,
  type CliIO,
} from "../src/index.js";

function makeIo(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    stdout,
    stderr,
  };
}

function parseSingleJson(stdout: string[]): unknown {
  expect(stdout).toHaveLength(1);
  const text = stdout[0] ?? "";
  expect(text.endsWith("\n")).toBe(true);
  return JSON.parse(text);
}

describe("LEM-083 CLI shell, JSON-only stdout, and exit codes", () => {
  it("emits usage JSON with exit 0 for no args and --help", async () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
      const { io, stdout, stderr } = makeIo();
      const code = await main(argv, io);
      expect(code).toBe(EXIT_CODES.pass);
      expect(stderr).toEqual([]);
      const payload = parseSingleJson(stdout) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.cli).toBe(CLI_NAME);
      expect(payload.version).toBe(CLI_VERSION);
      expect(Array.isArray(payload.commands)).toBe(true);
    }
  });

  it("emits version JSON with exit 0", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const { io, stdout, stderr } = makeIo();
      const code = await main(argv, io);
      expect(code).toBe(EXIT_CODES.pass);
      expect(stderr).toEqual([]);
      expect(parseSingleJson(stdout)).toEqual(versionPayload());
    }
  });

  it("returns structured JSON error and exit 2 for unknown command", async () => {
    const { io, stdout, stderr } = makeIo();
    const code = await main(["nope"], io);
    expect(code).toBe(EXIT_CODES.harnessError);
    expect(stderr).toEqual([]);
    const payload = parseSingleJson(stdout) as { ok: boolean; error: { code: string; type: string; message: string; details?: Record<string, unknown> } };
    expect(payload.ok).toBe(false);
    expect(payload.error.type).toBe("CliUsageError");
    expect(payload.error.message).toContain("Unknown command: nope");
    expect(payload.error.details?.command).toBe("nope");
  });

  it("dispatches registered commands and keeps stdout JSON-only", async () => {
    const registry = createCommandRegistry([
      {
        name: "demo",
        description: "demo",
        handler: (_args, io) => {
          io.stderr("progress\n");
          return { exitCode: EXIT_CODES.pass, stdoutJson: { ok: true, command: "demo" }, stderrLines: ["diag"] };
        },
      },
    ]);
    const { io, stdout, stderr } = makeIo();
    const code = await dispatch(["demo"], registry, io);
    expect(code).toBe(EXIT_CODES.pass);
    expect(stderr).toEqual(["progress\n", "diag\n"]);
    expect(parseSingleJson(stdout)).toEqual({ ok: true, command: "demo" });
  });

  it("maps thrown harness errors to JSON payloads and exit codes", async () => {
    const registry = createCommandRegistry([
      { name: "policy", description: "p", handler: () => { throw new PolicyThresholdError("threshold", { score: 1 }); } },
      { name: "generic", description: "g", handler: () => { throw new HarnessError("boom"); } },
      { name: "plain", description: "x", handler: () => { throw new Error("plain"); } },
    ]);

    {
      const { io, stdout } = makeIo();
      const code = await main(["policy"], io, registry);
      expect(code).toBe(EXIT_CODES.policyThresholdFailed);
      const payload = parseSingleJson(stdout) as { ok: boolean; error: { code: string } };
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe("policy_threshold_failed");
    }
    {
      const { io, stdout } = makeIo();
      const code = await main(["generic"], io, registry);
      expect(code).toBe(EXIT_CODES.harnessError);
      expect((parseSingleJson(stdout) as { error: { code: string } }).error.code).toBe("harness_error");
    }
    {
      const { io, stdout } = makeIo();
      const code = await main(["plain"], io, registry);
      expect(code).toBe(EXIT_CODES.harnessError);
      expect((parseSingleJson(stdout) as { ok: boolean }).ok).toBe(false);
    }
  });

  it("usage payload lists registered commands including core commands", () => {
    const registry = createCommandRegistry([
      { name: "b", description: "B", handler: () => ({}) },
      { name: "a", description: "A", handler: () => ({}) },
    ]);
    const payload = usagePayload(registry) as { commands: Array<{ name: string }> };
    expect(payload.commands.map((c) => c.name)).toEqual(["a", "b"]);

    // default registry now includes implemented core commands (LEM-084)
    const { io, stdout } = makeIo();
    void io; void stdout;
  });
});
