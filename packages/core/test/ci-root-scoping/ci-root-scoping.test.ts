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
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-ci-root-"));
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

describe("LEM-035 CI root-scoping precision", () => {
  it("counts only root-scoped CI config filenames and root workflows, excluding nested copies", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      // root-scoped CI configs
      await touch(path.join(root, "Jenkinsfile"), "pipeline {}\n");
      await touch(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
      // nested copies must not count
      await touch(path.join(root, "vendor", "pkg", "Jenkinsfile"), "pipeline {}\n");
      await touch(path.join(root, "packages", "foo", ".travis.yml"), "language: node_js\n");
      await touch(path.join(root, "examples", "azure-pipelines.yml"), "steps: []\n");

      const inventory = new SourceInspector(root).discover();
      expect(inventory.ci_files).toEqual([".github/workflows/ci.yml", "Jenkinsfile"]);

      const evidence = new EvidenceStore(root, "run-ci-root");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.ci" });
      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toBe("CI files: .github/workflows/ci.yml, Jenkinsfile");
      expect(outcome.findings).toEqual([]);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload).toEqual({ ci_files: [".github/workflows/ci.yml", "Jenkinsfile"] });
    });
  });

  it("reports no CI when only nested CI-name configs exist", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      await touch(path.join(root, "vendor", "pkg", "Jenkinsfile"), "pipeline {}\n");
      await touch(path.join(root, "subdir", ".gitlab-ci.yml"), "stages: []\n");

      const inventory = new SourceInspector(root).discover();
      expect(inventory.ci_files).toEqual([]);
      expect(inventory.has_ci).toBe(false);

      const evidence = new EvidenceStore(root, "run-ci-nested-only");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.ci" });
      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe("CI files: none");
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0]).toMatchObject({
        title: "No continuous integration configuration detected",
        severity: Severity.LOW,
        domain: "reliability",
      });
    });
  });

  it("preserves git-aware tracked-file precision for root-scoped CI files", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      await touch(path.join(root, "Jenkinsfile"), "pipeline {}\n"); // untracked/ignored
      await touch(path.join(root, ".gitlab-ci.yml"), "stages: []\n"); // tracked

      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
      await touch(path.join(root, ".gitignore"), "Jenkinsfile\n");
      execFileSync("git", ["add", "src/app.ts", ".gitlab-ci.yml", ".gitignore"], {
        cwd: root,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

      const inventory = new SourceInspector(root).discover();
      expect(inventory.tracked_available).toBe(true);
      expect(inventory.ci_files).toEqual([".gitlab-ci.yml"]);

      const evidence = new EvidenceStore(root, "run-ci-tracked");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.ci" });
      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toBe("CI files: .gitlab-ci.yml");
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload).toEqual({ ci_files: [".gitlab-ci.yml"] });
    });
  });
});
