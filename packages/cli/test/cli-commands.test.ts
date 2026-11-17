import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "@lemma/core";

import { main, type CliIO } from "../src/index.js";
import { legacyBrowserRunArgs } from "../src/commands.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
  return JSON.parse(text) as unknown;
}

function asObj(v: unknown): Record<string, unknown> {
  expect(v && typeof v === "object" && !Array.isArray(v)).toBe(true);
  return v as Record<string, unknown>;
}

describe("LEM-084 core CLI commands", () => {
  it("normalizes legacy browser-intent `run` flags to a real browser invocation", () => {
    // Exact shape emitted by older /lemma-browser implementations.
    expect(
      legacyBrowserRunArgs({
        target: "https://testradius.dev",
        "personas-dir": "personas",
        intent: "Lemma browser assessment",
        crawl: true,
        "max-pages": "8",
        mobile: true,
        headed: true,
        active: true,
        "active-interactions": true,
      }),
    ).toEqual(["https://testradius.dev", "--max-pages", "8", "--timeout-ms", "120000"]);
    expect(legacyBrowserRunArgs({ target: "https://example.test" })).toBeNull();
    expect(legacyBrowserRunArgs({ target: ".", crawl: true })).toBeNull();
    expect(legacyBrowserRunArgs({ target: "https://example.test", crawl: true, "no-browser": true })).toBeNull();
  });

  it("status returns no_run when no progress exists", async () => {
    await withTempDir(async (root) => {
      const { io, stdout, stderr } = makeIo();
      const code = await main(["status", "--root", root], io);
      expect(code).toBe(EXIT_CODES.pass);
      expect(stderr).toEqual([]);
      const payload = asObj(parseSingleJson(stdout));
      expect(payload.status).toBe("no_run");
      expect(payload.root).toBe(path.resolve(root));
    });
  });

  it("run emits JSON report to stdout, can write --output, and status/report/abort/prune operate on state", async () => {
    await withTempDir(async (root) => {
      const outPath = path.join(root, "report-out.json");

      // run
      const runIo = makeIo();
      const runCode = await main([
        "run", "--target", root, "--root", root, "--intent", "cli test",
        "--max-checks", "1", "--seed", "123", "--clock-mode", "frozen", "--frozen-clock", "2026-11-15T00:00:00Z",
        "--output", outPath,
      ], runIo.io);
      expect([EXIT_CODES.pass, EXIT_CODES.policyThresholdFailed, EXIT_CODES.killSwitchHalt, EXIT_CODES.harnessError]).toContain(runCode);
      const runStderr = runIo.stderr.join("");
      expect(runStderr).toContain("[lemma]");
      const report = asObj(parseSingleJson(runIo.stdout));
      expect(report.schema_version).toBe("quality-harness.report/v1");
      expect(typeof report.run_id).toBe("string");
      expect((report.run_id as string).length).toBeGreaterThan(0);
      const target = asObj(report.target);
      const resolved = typeof target.resolved === "string" ? target.resolved : "";
      const raw = typeof target.raw === "string" ? target.raw : "";
      expect((resolved || raw).length).toBeGreaterThan(0);
      const written = asObj(JSON.parse(await readFile(outPath, "utf8")) as unknown);
      expect(written.run_id).toBe(report.run_id);

      // status
      const statusIo = makeIo();
      const statusCode = await main(["status", "--root", root], statusIo.io);
      expect(statusCode).toBe(EXIT_CODES.pass);
      const status = asObj(parseSingleJson(statusIo.stdout));
      expect(status.run_id).toBe(report.run_id);
      expect(typeof status.status).toBe("string");
      expect(typeof status.checks_by_status).toBe("object");
      expect(typeof status.findings_by_severity).toBe("object");
      expect(String(status.progress_path)).toContain(".lemma");

      // status --all
      const allIo = makeIo();
      const allCode = await main(["status", "--root", root, "--all"], allIo.io);
      expect(allCode).toBe(EXIT_CODES.pass);
      const all = asObj(parseSingleJson(allIo.stdout));
      expect(all.status).toBe("ok");
      expect(typeof all.count).toBe("number");
      expect(Array.isArray(all.runs)).toBe(true);

      // report
      const reportIo = makeIo();
      const reportCode = await main(["report", "--root", root], reportIo.io);
      expect(reportCode).toBe(EXIT_CODES.pass);
      const latestReport = asObj(parseSingleJson(reportIo.stdout));
      expect(latestReport.run_id).toBe(report.run_id);
      expect(latestReport.schema_version).toBe("quality-harness.report/v1");

      // abort (requests kill for any future/ongoing run; emits confirmation)
      const abortIo = makeIo();
      const abortCode = await main(["abort", "--root", root, "--reason", "test abort"], abortIo.io);
      expect(abortCode).toBe(EXIT_CODES.pass);
      const abort = asObj(parseSingleJson(abortIo.stdout));
      expect(abort.status).toBe("kill_requested");
      expect(abort.reason).toBe("test abort");
      expect(String(abort.kill_path)).toContain("KILL");

      // prune
      const pruneIo = makeIo();
      const pruneCode = await main(["prune", "--root", root, "--dry-run", "--keep-runs", "1"], pruneIo.io);
      expect(pruneCode).toBe(EXIT_CODES.pass);
      const pruned = asObj(parseSingleJson(pruneIo.stdout));
      expect(pruned.status).toBe("dry_run");
      expect(Array.isArray(pruned.removed)).toBe(true);
      expect(Array.isArray(pruned.retained)).toBe(true);
      expect(typeof pruned.count).toBe("number");
    });
  }, 60000);

  it("report returns structured JSON error when no progress exists", async () => {
    await withTempDir(async (root) => {
      const { io, stdout, stderr } = makeIo();
      const code = await main(["report", "--root", root], io);
      expect(code).toBe(EXIT_CODES.harnessError);
      expect(stderr).toEqual([]);
      const payload = asObj(parseSingleJson(stdout));
      expect(payload.ok).toBe(false);
      expect(payload.error).toBeTruthy();
    });
  });

  it("run requires --target and reports usage error as JSON", async () => {
    await withTempDir(async (root) => {
      const { io, stdout, stderr } = makeIo();
      const code = await main(["run", "--root", root], io);
      expect(code).toBe(EXIT_CODES.harnessError);
      expect(stderr).toEqual([]);
      const payload = asObj(parseSingleJson(stdout));
      expect(payload.ok).toBe(false);
      const err = asObj(payload.error);
      expect(err.type).toBe("CliUsageError");
    });
  });
});
