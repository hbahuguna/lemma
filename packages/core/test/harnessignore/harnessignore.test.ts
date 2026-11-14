import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SourceInspector } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-ignore-"));
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

describe("LEM-028 .harnessignore-equivalent scoping", () => {
  it("uses .lemmaignore as canonical target-root scoping and excludes vendored paths from inventory", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "bad.py"), "import os\nos.system('x')\n");
      await touch(path.join(root, "artifacts", "vendor", "bad.py"), "import os\nos.system('y')\n");
      await touch(path.join(root, "artifacts", "keep", "note.txt"), "ok");
      await touch(path.join(root, "ignored.log"), "x");
      await writeFile(
        path.join(root, ".lemmaignore"),
        "# vendor artifacts\nignored.log\nartifacts/\n!artifacts/keep/\n",
        "utf8",
      );

      const inv = new SourceInspector(root).discover();
      expect(inv.excluded_patterns).toEqual(["ignored.log", "artifacts/", "!artifacts/keep/"]);
      expect(inv.source_files).toContain("src/bad.py");
      expect(inv.source_files).not.toContain("artifacts/vendor/bad.py");
      expect(inv.files).toContain("artifacts/keep/note.txt");
      expect(inv.files).not.toContain("artifacts/vendor/bad.py");
      expect(inv.files).not.toContain("ignored.log");
      expect(inv.excluded_paths).toContain("artifacts");
      // individually excluded file counted; directory-level exclusion/negation recorded
      expect(inv.excluded_file_count).toBeGreaterThanOrEqual(1);
      expect(inv.excluded_paths).toEqual(expect.arrayContaining(["artifacts", "ignored.log"]));
    });
  });

  it("accepts .harnessignore as equivalent compatibility alias when canonical file is absent", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "keep.ts"), "export {}");
      await touch(path.join(root, "generated", "a.ts"), "x");
      await touch(path.join(root, "generated", "keep.ts"), "x");
      await writeFile(path.join(root, ".harnessignore"), "generated/\n!generated/keep.ts\n", "utf8");

      const inv = new SourceInspector(root).discover();
      expect(inv.excluded_patterns).toEqual(["generated/", "!generated/keep.ts"]);
      expect(inv.files).toContain("keep.ts");
      expect(inv.files).toContain("generated/keep.ts");
      expect(inv.files).not.toContain("generated/a.ts");
      expect(inv.excluded_file_count).toBeGreaterThanOrEqual(1);
    });
  });

  it("prefers canonical .lemmaignore over .harnessignore alias when both exist", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "a.ts"), "x");
      await touch(path.join(root, "b.ts"), "x");
      await writeFile(path.join(root, ".lemmaignore"), "a.ts\n", "utf8");
      await writeFile(path.join(root, ".harnessignore"), "b.ts\n", "utf8");

      const inv = new SourceInspector(root).discover();
      expect(inv.excluded_patterns).toEqual(["a.ts"]);
      expect(inv.files).not.toContain("a.ts");
      expect(inv.files).toContain("b.ts");
    });
  });

  it("supports explicit ignore-file overrides for deterministic scoping", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "a.ts"), "x");
      await touch(path.join(root, "vendor", "a.ts"), "x");
      const custom = path.join(root, "custom.ignore");
      await writeFile(custom, "vendor/\n", "utf8");
      // canonical file exists but override should win
      await writeFile(path.join(root, ".lemmaignore"), "src/\n", "utf8");

      const inv = new SourceInspector(root, { ignoreFiles: [custom] }).discover();
      expect(inv.excluded_patterns).toEqual(["vendor/"]);
      expect(inv.files).toContain("src/a.ts");
      expect(inv.files).not.toContain("vendor/a.ts");
    });
  });
});
