import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "@lemma/core";

import { main, type CliIO } from "../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cli-ext-"));
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

async function seedRun(root: string): Promise<{ runId: string; report: Record<string, unknown> }> {
  const { io, stdout } = makeIo();
  const code = await main([
    "run", "--target", root, "--root", root, "--intent", "ext cli test",
    "--max-checks", "1", "--seed", "321", "--clock-mode", "frozen", "--frozen-clock", "2026-11-15T00:00:00Z",
  ], io);
  expect([EXIT_CODES.pass, EXIT_CODES.policyThresholdFailed, EXIT_CODES.killSwitchHalt, EXIT_CODES.harnessError]).toContain(code);
  const report = asObj(parseSingleJson(stdout));
  return { runId: String(report.run_id), report };
}

describe("LEM-085 extended CLI commands", () => {
  it("personas scaffold and lint work on a temp personas dir", async () => {
    await withTempDir(async (root) => {
      const personasDir = path.join(root, "personas");
      await mkdir(personasDir, { recursive: true });

      // scaffold
      const scIo = makeIo();
      const scCode = await main(["personas", "scaffold", "sample_persona", "--root", root, "--personas-dir", personasDir, "--name", "Sample Persona"], scIo.io);
      expect(scCode).toBe(EXIT_CODES.pass);
      const sc = asObj(parseSingleJson(scIo.stdout));
      expect(["created", "overwritten"]).toContain(String(sc.status));

      // list
      const lsIo = makeIo();
      const lsCode = await main(["personas", "list", "--root", root, "--personas-dir", personasDir], lsIo.io);
      expect(lsCode).toBe(EXIT_CODES.pass);
      const ls = asObj(parseSingleJson(lsIo.stdout));
      expect(typeof ls.count).toBe("number");
      expect(Array.isArray(ls.personas)).toBe(true);

      // lint (may be valid or have issues depending on registry checks; command must return JSON + 0/1)
      const lintIo = makeIo();
      const lintCode = await main(["personas", "lint", "--root", root, "--personas-dir", personasDir], lintIo.io);
      expect([EXIT_CODES.pass, EXIT_CODES.policyThresholdFailed]).toContain(lintCode);
      const lint = asObj(parseSingleJson(lintIo.stdout));
      expect(typeof lint.status).toBe("string");
    });
  }, 60000);

  it("sarif, junit, sign-report, and verify-report operate on latest report", async () => {
    await withTempDir(async (root) => {
      await seedRun(root);
      const sarifOut = path.join(root, "out.sarif.json");
      const junitOut = path.join(root, "out.junit.xml");
      const sigOut = path.join(root, "report.sig");
      const key = "synthetic-test-key";

      // sarif to stdout
      const sarifIo = makeIo();
      expect(await main(["sarif", "--root", root], sarifIo.io)).toBe(EXIT_CODES.pass);
      const sarif = asObj(parseSingleJson(sarifIo.stdout));
      expect(sarif.version || sarif.$schema || sarif.runs).toBeTruthy();

      // sarif to file
      const sarifFileIo = makeIo();
      expect(await main(["sarif", "--root", root, "--output", sarifOut], sarifFileIo.io)).toBe(EXIT_CODES.pass);
      const sarifStatus = asObj(parseSingleJson(sarifFileIo.stdout));
      expect(sarifStatus.status).toBe("written");
      expect((JSON.parse(await readFile(sarifOut, "utf8")) as Record<string, unknown>).runs).toBeTruthy();

      // junit to stdout (wrapped JSON)
      const junitIo = makeIo();
      expect(await main(["junit", "--root", root], junitIo.io)).toBe(EXIT_CODES.pass);
      const junit = asObj(parseSingleJson(junitIo.stdout));
      expect(junit.format).toBe("junit");
      expect(String(junit.xml)).toContain("<");

      // junit to file
      const junitFileIo = makeIo();
      expect(await main(["junit", "--root", root, "--output", junitOut], junitFileIo.io)).toBe(EXIT_CODES.pass);
      expect(asObj(parseSingleJson(junitFileIo.stdout)).status).toBe("written");
      expect(await readFile(junitOut, "utf8")).toContain("<");

      // sign-report
      const signIo = makeIo();
      expect(await main(["sign-report", "--root", root, "--key", key, "--output", sigOut], signIo.io)).toBe(EXIT_CODES.pass);
      const signed = asObj(parseSingleJson(signIo.stdout));
      expect(signed.status).toBe("signed");
      expect(typeof signed.signature).toBe("string");

      // verify-report valid
      const verifyIo = makeIo();
      expect(await main(["verify-report", "--root", root, "--key", key, "--signature", sigOut], verifyIo.io)).toBe(EXIT_CODES.pass);
      expect(asObj(parseSingleJson(verifyIo.stdout)).verified).toBe(true);

      // verify-report invalid
      const badIo = makeIo();
      expect(await main(["verify-report", "--root", root, "--key", "wrong-key", "--signature", sigOut], badIo.io)).toBe(EXIT_CODES.policyThresholdFailed);
      expect(asObj(parseSingleJson(badIo.stdout)).verified).toBe(false);
    });
  }, 60000);

  it("suppress add/list/remove works", async () => {
    await withTempDir(async (root) => {
      const expires = "2099-01-01T00:00:00Z";
      const addIo = makeIo();
      expect(await main(["suppress", "add", "--root", root, "--fingerprint", "fp-1", "--owner", "team", "--reason", "known", "--expires", expires], addIo.io)).toBe(EXIT_CODES.pass);
      expect(asObj(parseSingleJson(addIo.stdout)).status).toBe("added");

      const listIo = makeIo();
      expect(await main(["suppressions", "list", "--root", root], listIo.io)).toBe(EXIT_CODES.pass);
      const listed = asObj(parseSingleJson(listIo.stdout));
      expect(listed.count).toBe(1);

      const rmIo = makeIo();
      expect(await main(["suppress", "remove", "--root", root, "--fingerprint", "fp-1"], rmIo.io)).toBe(EXIT_CODES.pass);
      expect(asObj(parseSingleJson(rmIo.stdout)).status).toBe("removed");

      const list2Io = makeIo();
      expect(await main(["suppress", "list", "--root", root], list2Io.io)).toBe(EXIT_CODES.pass);
      expect(asObj(parseSingleJson(list2Io.stdout)).count).toBe(0);
    });
  });

  it("calibrate runs fixtures and writes/emits report", async () => {
    await withTempDir(async (root) => {
      const fixturesDir = path.join(root, "fixtures");
      const out = path.join(root, "calibration.json");
      await mkdir(fixturesDir, { recursive: true });
      // minimal labeled fixture compatible with core calibration loader
      await writeFile(path.join(fixturesDir, "ship.json"), JSON.stringify({
        label: "ship",
        expected_decision: "ship",
        checks: [{ id: "c1", status: "passed", weight: 1 }],
        findings: [],
      }, null, 2));

      const io = makeIo();
      const code = await main(["calibrate", "--root", root, "--fixtures-dir", fixturesDir, "--output", out], io.io);
      expect(code).toBe(EXIT_CODES.pass);
      const report = asObj(parseSingleJson(io.stdout));
      expect(typeof report.schema_version).toBe("string");
      expect((JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>).schema_version).toBe(report.schema_version);
    });
  });

  it("verify-evidence resolves latest run and emits result", async () => {
    await withTempDir(async (root) => {
      const { runId } = await seedRun(root);
      const io = makeIo();
      const code = await main(["verify-evidence", "--root", root], io.io);
      // should succeed (not tampered) for a fresh run
      expect(code).toBe(EXIT_CODES.pass);
      const result = asObj(parseSingleJson(io.stdout));
      expect(result.run_id).toBe(runId);
      expect(result.command).toBe("verify-evidence");
      expect(result.tampered).toBe(false);
    });
  }, 60000);
});
