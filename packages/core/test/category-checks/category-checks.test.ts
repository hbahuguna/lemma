import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  SourceInspector,
  StaticCheckRunner,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cats-"));
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

function check(id: string, intent = "intent", expected = "expected") {
  return { id, intent, expected };
}

describe("LEM-033 baseline category checks", () => {
  it("records test category scope with assay-compatible payload, actual, and metadata", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x=1;\n");
      await touch(path.join(root, "tests", "app.test.ts"), "test('x',()=>{});\n");
      await touch(path.join(root, "package.json"), '{"devDependencies":{"vitest":"1.0.0"}}\n');

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-cat-test");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run(check("static.test_category", "Assay test assessment", "Record test scope"));

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual).toBe(`Test category assessment recorded with ${inventory.test_files.length} test file(s).`);
      expect(outcome.metadata).toEqual({ category: "test" });
      expect(outcome.evidence[0]).toMatch(/test-category-scope\.json$/);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload).toMatchObject({
        category: "test",
        intent: "Assay test assessment",
        expected: "Record test scope",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        test_files: inventory.test_files.length,
        manifests: inventory.manifests.length,
      });
      expect(payload.test_frameworks).toEqual(inventory.test_frameworks);
      const entries = evidence.getEntries();
      expect(entries[0]?.kind).toBe("static_analysis");
      expect(entries[0]?.description).toBe("Test category assessment scope and test inventory summary.");
      expect(entries[0]?.check_id).toBe("static.test_category");
    });
  });

  it("records functionality and browser category scopes with assay-compatible outputs", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x=1;\n");
      await touch(path.join(root, "src", "view.tsx"), "export const V=()=>null;\n");
      await touch(path.join(root, "package.json"), '{"name":"x"}\n');

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-cat-fb");
      const runner = new StaticCheckRunner(root, inventory, evidence);

      const fn = await runner.run(check("static.functionality_category", "fn intent", "fn expected"));
      expect(fn.status).toBe(CheckStatus.PASSED);
      expect(fn.actual).toBe(`Functionality category assessment recorded for ${inventory.source_files.length} source file(s).`);
      expect(fn.metadata).toEqual({ category: "functionality" });
      const fnPayload = await readEvidenceJson(root, fn.evidence[0]!);
      expect(fnPayload).toMatchObject({
        category: "functionality",
        intent: "fn intent",
        expected: "fn expected",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        test_files: inventory.test_files.length,
        manifests: inventory.manifests.length,
      });
      expect(fnPayload.test_frameworks).toEqual(inventory.test_frameworks);
      expect(evidence.getEntries().find((e) => e.check_id === "static.functionality_category")?.description)
        .toBe("Functionality category assessment scope and inventory summary.");

      const br = await runner.run(check("static.browser_category", "br intent", "br expected"));
      expect(br.status).toBe(CheckStatus.PASSED);
      expect(br.actual).toBe(`Browser category assessment recorded for ${inventory.source_files.length} source file(s).`);
      expect(br.metadata).toEqual({ category: "browser" });
      const brPayload = await readEvidenceJson(root, br.evidence[0]!);
      expect(brPayload).toMatchObject({
        category: "browser",
        intent: "br intent",
        expected: "br expected",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        markup_files: inventory.markup_files.length,
        manifests: inventory.manifests.length,
      });
      expect(evidence.getEntries().find((e) => e.check_id === "static.browser_category")?.description)
        .toBe("Browser category assessment scope and inventory summary.");
    });
  });

  it("records issues category with deterministic marker counts/files and metadata", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "a.ts"), "// TODO: one\n// FIXME later\nconst x=1;\n");
      await touch(path.join(root, "src", "b.ts"), "// HACK temp\n// XXX note\n// TODO again\n");
      await touch(path.join(root, "README.md"), "TODO in docs should not count\n"); // not in CODE_EXTENSIONS scan

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-cat-issues");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run(check("static.issues_category", "issues intent", "issues expected"));

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const markerCounts = payload.issue_markers as Record<string, number>;
      const markerTotal = Object.values(markerCounts).reduce((a, b) => a + b, 0);
      const markerFiles = payload.files_with_issue_markers as string[];

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toBe(
        `Issues category assessment recorded with ${markerTotal} issue marker(s) in ${markerFiles.length} file(s).`,
      );
      expect(outcome.metadata).toEqual({
        category: "issues",
        issue_markers: markerTotal,
        files_with_issue_markers: markerFiles.length,
      });
      expect(payload).toMatchObject({
        category: "issues",
        intent: "issues intent",
        expected: "issues expected",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        test_files: inventory.test_files.length,
        manifests: inventory.manifests.length,
      });
      expect(markerCounts.TODO).toBe(2);
      expect(markerCounts.FIXME).toBe(1);
      expect(markerCounts.HACK).toBe(1);
      expect(markerCounts.XXX).toBe(1);
      expect(markerFiles).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
      expect(evidence.getEntries()[0]?.description)
        .toBe("Issues category assessment scope and issue-marker inventory summary.");
    });
  });

  it("records demo category inventory, entrypoints, quickstart docs, and limitation metadata", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export {}\n");
      await touch(path.join(root, "demo", "index.js"), "console.log('demo')\n");
      await touch(path.join(root, "package.json"), JSON.stringify({ scripts: { demo: "node demo/index.js", test: "jest" } }, null, 2));
      await touch(path.join(root, "README.md"), "# Sample\n\nQuickstart: run `npm run demo`.\n");
      await touch(path.join(root, "Makefile"), "demo:\n\tnode demo/index.js\n");

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-cat-demo");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run(check("static.demo_category", "demo intent", "demo expected"));

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const demoPaths = payload.demo_paths as string[];
      const demoEntrypoints = payload.demo_entrypoints as string[];
      const quickstartDocs = payload.quickstart_docs as string[];
      const limitation = "Demo surface inventory only; no behavioral demo evidence was collected because no URL was provided.";

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toBe(
        `Demo surface inventory recorded with ${demoPaths.length} demo path(s), ${demoEntrypoints.length} entry point(s), and ${quickstartDocs.length} documentation reference(s). No demo was launched or rendered.`,
      );
      expect(outcome.metadata).toEqual({
        category: "demo",
        demo_paths: demoPaths.length,
        demo_entrypoints: demoEntrypoints.length,
        quickstart_docs: quickstartDocs.length,
        behavioral_evidence: false,
        limitation,
      });
      expect(payload).toMatchObject({
        category: "demo",
        intent: "demo intent",
        expected: "demo expected",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        manifests: inventory.manifests.length,
        behavioral_evidence: false,
        limitation,
      });
      expect(demoPaths).toContain("demo/index.js");
      expect(demoEntrypoints).toContain("script:demo");
      expect(demoEntrypoints).toContain("make:demo");
      expect(quickstartDocs).toContain("README.md");
      // entrypoint names only, not command bodies
      expect(JSON.stringify(demoEntrypoints)).not.toContain("node demo/index.js");
      expect(evidence.getEntries()[0]?.description)
        .toBe("Demo category assessment scope, demo assets, and entry-point summary.");
    });
  });

  it("records more category extended surfaces with deterministic counts and sorted payloads", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.py"), "print('ok')\n");
      await touch(path.join(root, "tests", "test_app.py"), "def test_ok():\n  assert True\n");
      await touch(path.join(root, "examples", "demo.py"), "print('demo')\n");
      await touch(path.join(root, "docs", "guide.md"), "# Guide\n");
      await touch(path.join(root, "README.md"), "# Sample\n");
      await touch(path.join(root, "CONTRIBUTING.md"), "# Contributing\n");
      await touch(path.join(root, "Makefile"), "test:\n\tpytest\n");
      await touch(path.join(root, "docker-compose.yml"), "services: {}\n");
      await touch(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "jest" } }, null, 2));

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-cat-more");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run(check("static.more_category", "more intent", "more expected"));

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const docs = payload.docs as string[];
      const examples = payload.examples as string[];
      const configs = payload.configs as string[];
      const scripts = payload.scripts as string[];

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toBe(
        `More category assessment recorded with ${docs.length} doc(s), ${examples.length} example path(s), ${new Set(configs).size} config file(s), and ${scripts.length} script/task entry point(s).`,
      );
      expect(outcome.metadata).toEqual({
        category: "more",
        docs: docs.length,
        examples: examples.length,
        configs: new Set(configs).size,
        scripts: scripts.length,
      });
      expect(payload).toMatchObject({
        category: "more",
        intent: "more intent",
        expected: "more expected",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        test_files: inventory.test_files.length,
      });
      expect(docs).toEqual(expect.arrayContaining(["README.md", "CONTRIBUTING.md", "docs/guide.md"]));
      expect(examples).toEqual(expect.arrayContaining(["examples/demo.py"]));
      expect(configs).toEqual(expect.arrayContaining(["docker-compose.yml", "Makefile", "package.json"]));
      expect(scripts).toEqual(expect.arrayContaining(["script:lint", "script:test", "task:test"]));
      expect([...scripts].sort()).toEqual(scripts);
      expect([...configs].sort()).toEqual(configs);
      expect(payload.ci_files).toEqual([...inventory.ci_files].sort().slice(0, 20));
      expect(payload.manifests).toEqual(inventory.manifests.slice(0, 20));
      expect(evidence.getEntries()[0]?.description)
        .toBe("Extended 'more' category assessment scope and additional surface inventory.");
    });
  });
});
