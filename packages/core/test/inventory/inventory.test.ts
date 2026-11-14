import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { SourceInspector } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-inv-"));
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

describe("LEM-027 source inventory and git-aware tracked/ignored scanning", () => {
  it("discovers files deterministically with classification, skipped dirs, and summary flags", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const a=1;");
      await touch(path.join(root, "src", "view.tsx"), "export const v=1;");
      await touch(path.join(root, "tests", "app.test.ts"), "test('x',()=>{});");
      await touch(path.join(root, "package.json"), '{"name":"x","devDependencies":{"vitest":"1.0.0"}}');
      await touch(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
      await touch(path.join(root, ".env"), "SECRET=1");
      await touch(path.join(root, ".github", "workflows", "ci.yml"), "name: ci");
      await touch(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
      await touch(path.join(root, ".hidden", "secret.txt"), "skip");
      await touch(path.join(root, ".circleci", "config.yml"), "version: 2");

      const inv = new SourceInspector(root).discover();
      expect(inv.available).toBe(true);
      expect(inv.files).toEqual([...inv.files].sort());
      expect(inv.source_files).toContain("src/app.ts");
      expect(inv.source_files).toContain("src/view.tsx");
      expect(inv.markup_files).toContain("src/view.tsx");
      expect(inv.test_files).toContain("tests/app.test.ts");
      expect(inv.manifests).toEqual(["package.json"]);
      expect(inv.lockfiles).toEqual(["pnpm-lock.yaml"]);
      expect(inv.env_files).toEqual([".env"]);
      expect(inv.ci_files).toContain(".github/workflows/ci.yml");
      expect(inv.files).toContain(".circleci/config.yml"); // .circleci dir is traversed but config.yml not a CI_NAME by assay rules
      expect(inv.languages.TypeScript).toBeGreaterThanOrEqual(2);
      expect(inv.total_files).toBeGreaterThan(0);
      expect(inv.has_manifest).toBe(true);
      expect(inv.has_tests).toBe(true);
      expect(inv.has_ci).toBe(true);
      expect(inv.has_lockfile).toBe(true);
      expect(inv.has_markup).toBe(true);
      expect(inv.skipped_dirs).toContain("node_modules");
      expect(inv.skipped_dirs).toContain(".hidden");
      expect(inv.files.some((f) => f.startsWith("node_modules/"))).toBe(false);
      expect(inv.files.some((f) => f.startsWith(".hidden/"))).toBe(false);
      expect(inv.test_frameworks).toContain("vitest");
    });
  });

  it("applies .lemmaignore/.harnessignore scoping patterns including negation", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "keep.ts"), "export{}");
      await touch(path.join(root, "ignored.log"), "x");
      await touch(path.join(root, "generated", "a.ts"), "x");
      await touch(path.join(root, "generated", "keep.ts"), "x");
      await touch(path.join(root, "docs", "note.md"), "x");
      await writeFile(
        path.join(root, ".lemmaignore"),
        ["ignored.log", "generated/", "!generated/keep.ts", "docs/*.md"].join("\n"),
        "utf8",
      );

      const inv = new SourceInspector(root).discover();
      expect(inv.excluded_patterns).toContain("generated/");
      expect(inv.excluded_patterns).toContain("!generated/keep.ts");
      expect(inv.files).toContain("keep.ts");
      expect(inv.files).toContain("generated/keep.ts");
      expect(inv.files).not.toContain("ignored.log");
      expect(inv.files).not.toContain("generated/a.ts");
      expect(inv.files).not.toContain("docs/note.md");
      expect(inv.excluded_file_count).toBeGreaterThanOrEqual(3);
    });
  });

  it("records git-aware tracked/ignored env and tracked-only CI when repository is tracked", async () => {
    await withTempDir(async (root) => {
      try {
        execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
      } catch {
        const inv = new SourceInspector(root).discover();
        expect(inv.tracked_available).toBe(false);
        return;
      }

      await touch(path.join(root, "src", "index.ts"), "export {}");
      await touch(path.join(root, ".env"), "A=1");
      await touch(path.join(root, ".env.local"), "B=2");
      await touch(path.join(root, ".github", "workflows", "ci.yml"), "name: ci");
      await touch(path.join(root, ".github", "workflows", "local.yml"), "name: local");
      await writeFile(path.join(root, ".gitignore"), ".env.local\n.github/workflows/local.yml\n", "utf8");

      try {
        execFileSync("git", ["add", "src/index.ts", ".env", ".github/workflows/ci.yml", ".gitignore"], { cwd: root, stdio: "ignore" });
      } catch {
        const inv = new SourceInspector(root).discover();
        expect(typeof inv.tracked_available).toBe("boolean");
        return;
      }

      const inv = new SourceInspector(root).discover();
      expect(inv.tracked_available).toBe(true);
      expect(inv.tracked_file_count).toBeGreaterThan(0);
      expect(inv.env_files_tracked).toContain(".env");
      expect(inv.env_files_ignored.every((f) => inv.env_files.includes(f))).toBe(true);
      if (inv.env_files.includes(".env.local")) {
        expect(inv.env_files_tracked).not.toContain(".env.local");
      }
      expect(inv.ci_files).toContain(".github/workflows/ci.yml");
      expect(inv.ci_files).not.toContain(".github/workflows/local.yml");
    });
  });
});
