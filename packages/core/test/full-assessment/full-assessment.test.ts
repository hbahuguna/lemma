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
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-full-"));
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

describe("LEM-034 full-assessment markers", () => {
  it("records full-assessment scope marker with assay-compatible evidence, payload, actual, and metadata", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      await touch(path.join(root, "src", "view.tsx"), "export const V = () => null;\n");
      await touch(path.join(root, "tests", "app.test.ts"), "test('x',()=>{});\n");
      await touch(path.join(root, "package.json"), '{"name":"x"}\n');

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-full");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({
        id: "static.full_assessment",
        intent: "Assay full assessment",
        expected: "Record full scope",
      });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual).toBe(
        `Full category assessment recorded for ${inventory.source_files.length} source file(s).`,
      );
      expect(outcome.metadata).toEqual({ category: "full" });
      expect(outcome.evidence).toHaveLength(1);
      expect(outcome.evidence[0]).toMatch(/full-assessment-scope\.json$/);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload).toEqual({
        category: "full",
        intent: "Assay full assessment",
        expected: "Record full scope",
        source_available: inventory.available,
        source_files: inventory.source_files.length,
        test_files: inventory.test_files.length,
        markup_files: inventory.markup_files.length,
        manifests: inventory.manifests.length,
      });

      const entries = evidence.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "static_analysis",
        description: "Full category assessment scope and inventory summary.",
        check_id: "static.full_assessment",
        path: outcome.evidence[0],
      });
      expect(typeof entries[0]?.sha256).toBe("string");
      expect((entries[0]?.sha256 ?? "").length).toBeGreaterThan(0);
    });
  });
});
