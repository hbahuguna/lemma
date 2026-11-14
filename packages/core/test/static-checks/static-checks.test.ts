import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  Severity,
  SourceInspector,
  StaticCheckRunner,
  Strength,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-static-checks-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(file: string, content = "") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

async function readEvidenceJson(root: string, relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relPath), "utf8")) as Record<string, unknown>;
}

describe("LEM-029 inventory, tests, CI, and dependency checks", () => {
  it("runs static.inventory and saves source inventory evidence with assay-compatible outcome", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      await touch(path.join(root, "tests", "app.test.ts"), "test('x',()=>{});\n");
      await touch(path.join(root, "package.json"), '{"name":"x"}\n');
      await touch(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-inv");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.inventory" });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.evidence).toHaveLength(1);
      expect(outcome.evidence[0]).toMatch(/source-inventory\.json$/);
      const languages = Object.keys(inventory.languages).sort().join(", ") || "none";
      expect(outcome.actual).toBe(
        `${inventory.total_files} files, ${inventory.total_bytes} bytes; languages: ${languages}; manifests: ${inventory.manifests.length}; tests: ${inventory.test_files.length}; CI: ${inventory.ci_files.length}`,
      );
      expect((outcome.metadata as { inventory?: unknown }).inventory).toBeDefined();

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.total_files).toBe(inventory.total_files);
      expect(payload.manifests).toEqual(expect.arrayContaining(["package.json"]));
      expect(payload.test_files).toEqual(expect.arrayContaining(["tests/app.test.ts"]));

      const entries = evidence.getEntries();
      expect(entries[0]?.kind).toBe("static_analysis");
      expect(entries[0]?.description).toBe(
        "Source inventory: file counts, languages, manifests, tests, and CI configuration.",
      );
      expect(entries[0]?.check_id).toBe("static.inventory");
    });
  });

  it("runs static.tests and reports missing automated tests with assay-compatible finding", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-tests");
      const runner = new StaticCheckRunner(root, inventory, evidence);

      const outcome = await runner.run({ id: "static.tests" });
      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe("0 test file(s) found; frameworks: not detected");
      expect(outcome.evidence[0]).toMatch(/test-inventory\.json$/);
      expect(outcome.findings).toHaveLength(1);
      const f = outcome.findings[0]!;
      expect(f.title).toBe("No automated tests detected in the release");
      expect(f.severity).toBe(Severity.MEDIUM);
      expect(f.domain).toBe("functional");
      expect(f.strength).toBe(Strength.SOURCE_PROVEN);
      expect(f.consequence).toBe(
        "Change safety depends on unrecorded manual exploration, so regressions can ship silently.",
      );
      expect(f.location).toBe("repository root");
      expect(f.reproduction).toBe(
        "Search the source tree for test/spec files and a runnable test command.",
      );
      expect(f.remediation).toBe(
        "Add a focused test suite around the highest-risk customer outcome and run it in CI.",
      );
      expect(f.verification).toBe(
        "Confirm the suite fails on a seeded regression and passes after the fix.",
      );
      expect(f.tags).toEqual(["coverage-gap"]);
      expect(f.evidence).toEqual(outcome.evidence);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.test_files).toEqual([]);
      expect(payload.test_frameworks).toEqual([]);
    });
  });

  it("runs static.tests with discovered tests/frameworks and passes without findings", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "tests", "app.test.ts"), "test('x',()=>{});\n");
      await touch(path.join(root, "package.json"), '{"devDependencies":{"vitest":"1.0.0"}}\n');
      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-tests-ok");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.tests" });
      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual).toContain("1 test file(s) found");
      expect(outcome.actual).toContain("vitest");
    });
  });

  it("runs static.ci and reports missing CI with assay-compatible finding", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export {}\n");
      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-ci");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.ci" });
      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe("CI files: none");
      expect(outcome.findings).toHaveLength(1);
      const f = outcome.findings[0]!;
      expect(f.title).toBe("No continuous integration configuration detected");
      expect(f.severity).toBe(Severity.LOW);
      expect(f.domain).toBe("reliability");
      expect(f.consequence).toBe(
        "Test evidence is not refreshed automatically and can drift from the release.",
      );
      expect(f.location).toBe("repository root");
      expect(f.reproduction).toBe(
        "Inspect for .github/workflows, .gitlab-ci.yml, Jenkinsfile, or another CI config.",
      );
      expect(f.remediation).toBe("Run the test suite and this harness on pull requests.");
      expect(f.verification).toBe("Open a pull request and confirm the checks execute and report.");
      expect(f.tags).toEqual(["coverage-gap"]);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.ci_files).toEqual([]);
    });
  });

  it("runs static.dependencies for manifests without lockfile and committed env files (filesystem fallback)", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "package.json"), '{"name":"x"}\n');
      await touch(path.join(root, ".env"), "SECRET=1\n");
      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-deps");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.dependencies" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe("Manifests: 1; lockfiles: 0; committed env files: 1");
      expect(outcome.metadata).toMatchObject({
        env_files_tracked: 0,
        env_files_ignored: 0,
        tracked_available: false,
      });
      expect(outcome.evidence[0]).toMatch(/dependency-and-env-inventory\.json$/);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.manifests).toEqual(expect.arrayContaining(["package.json"]));
      expect(payload.env_files).toEqual(expect.arrayContaining([".env"]));
      expect(payload.tracked_available).toBe(false);

      expect(outcome.findings.length).toBe(2);
      const envFinding = outcome.findings.find((f) => f.title === "Local environment file is present in the repository")!;
      expect(envFinding.severity).toBe(Severity.HIGH);
      expect(envFinding.domain).toBe("data_integrity");
      expect(envFinding.location).toBe(".env");
      expect(envFinding.tags).toEqual(["secrets", "configuration"]);
      const lockFinding = outcome.findings.find((f) => f.title === "Package manifests exist without a lockfile")!;
      expect(lockFinding.severity).toBe(Severity.LOW);
      expect(lockFinding.domain).toBe("data_integrity");
      expect(lockFinding.location).toBe("package.json");
      expect(lockFinding.tags).toEqual(["reproducibility"]);
      expect(lockFinding.reproduction).toBe("Compare the manifest inventory with the lockfile inventory.");
      expect(lockFinding.verification).toBe(
        "Run two clean installs and confirm the resolved dependency set is identical.",
      );
    });
  });

  it("runs static.dependencies with git-aware tracked/ignored env reporting", async () => {
    await withTempDir(async (root) => {
      try {
        execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
      } catch {
        return; // git unavailable
      }

      await touch(path.join(root, "package.json"), '{"name":"x"}\n');
      await touch(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      await touch(path.join(root, ".env"), "A=1\n");
      await touch(path.join(root, ".env.local"), "B=2\n");
      await writeFile(path.join(root, ".gitignore"), ".env.local\n", "utf8");

      try {
        execFileSync("git", ["add", "package.json", "pnpm-lock.yaml", ".env", ".gitignore"], { cwd: root, stdio: "ignore" });
      } catch {
        return;
      }

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-deps-git");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.dependencies" });

      expect(inventory.tracked_available).toBe(true);
      expect(outcome.metadata).toMatchObject({ tracked_available: true });
      expect((outcome.metadata as { env_files_tracked?: number }).env_files_tracked ?? 0).toBeGreaterThanOrEqual(1);
      expect(outcome.actual).toContain("committed env files:");
      if (inventory.env_files_ignored.length > 0) {
        expect(outcome.actual).toContain("ignored/untracked env file(s) excluded from the committed claim");
      }
      // only tracked env files should be reported as committed findings
      const envFindingLocations = outcome.findings
        .filter((f) => f.title === "Local environment file is present in the repository")
        .map((f) => f.location);
      expect(envFindingLocations).toContain(".env");
      expect(envFindingLocations).not.toContain(".env.local");
      expect(outcome.findings.some((f) => f.title === "Package manifests exist without a lockfile")).toBe(false);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.tracked_available).toBe(true);
      expect(payload.env_files_tracked).toEqual(expect.arrayContaining([".env"]));
    });
  });
});
