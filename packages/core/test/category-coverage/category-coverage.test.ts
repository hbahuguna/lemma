import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASSAY_CATEGORY_INTENTS,
  ASSAY_CATEGORY_LABELS,
  CHECK_CATALOG,
  EvidenceStore,
  SourceInspector,
  StaticCheckRunner,
  assayCategoryIntent,
  categoryCheckIdForIntent,
  categoryCheckIdForLabel,
  CheckStatus,
  normalizeTarget,
  planChecks,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-catcov-"));
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

function allOwnedBy(persona: string, ids: string[] = CHECK_CATALOG.map((c) => c.id)): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) out[id] = [persona];
  return out;
}

async function readEvidenceJson(root: string, relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relPath), "utf8")) as Record<string, unknown>;
}

describe("LEM-037 category command coverage and documented no-ops", () => {
  it("defines canonical 59 assay category labels/intents with deterministic mapping", () => {
    expect(ASSAY_CATEGORY_LABELS).toHaveLength(59);
    expect(ASSAY_CATEGORY_INTENTS).toHaveLength(59);
    expect(new Set(ASSAY_CATEGORY_LABELS).size).toBe(59);
    for (const label of ASSAY_CATEGORY_LABELS) {
      const intent = assayCategoryIntent(label);
      expect(intent).toBe(`Assay ${label} assessment`);
      expect(ASSAY_CATEGORY_INTENTS).toContain(intent);
      const checkId = categoryCheckIdForIntent(intent);
      expect(checkId).toBeTruthy();
      expect(categoryCheckIdForLabel(label)).toBe(checkId);
      expect(CHECK_CATALOG.some((c) => c.id === checkId)).toBe(true);
    }
    // specialized mappings preserved
    expect(categoryCheckIdForLabel("full")).toBe("static.full_assessment");
    expect(categoryCheckIdForLabel("test")).toBe("static.test_category");
    expect(categoryCheckIdForLabel("functionality")).toBe("static.functionality_category");
    expect(categoryCheckIdForLabel("browser")).toBe("static.browser_category");
    expect(categoryCheckIdForLabel("issues")).toBe("static.issues_category");
    expect(categoryCheckIdForLabel("demo")).toBe("static.demo_category");
    expect(categoryCheckIdForLabel("more")).toBe("static.more_category");
    expect(categoryCheckIdForLabel("security")).toBe("static.category.security");
    expect(categoryCheckIdForLabel("help")).toBe("static.category.help");
  });

  it("plans an owned deterministic scope check for every assay category intent (intent-gated)", () => {
    const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
    const inventory = { available: true, has_markup: true, has_manifest: true };
    const ownership = allOwnedBy("functional");

    for (const label of ASSAY_CATEGORY_LABELS) {
      const intent = assayCategoryIntent(label);
      const planned = planChecks({
        target,
        inventory,
        selectedPersonas: ["functional"],
        ownership,
        maxChecks: 0,
        intent,
        noBrowser: true,
      });
      const ids = planned.map((c) => c.id);
      const expectedId = categoryCheckIdForLabel(label)!;
      expect(ids).toContain(expectedId);
      // only the matching category scope check should be planned (no unrelated category scopes)
      const categoryScopeIds = ids.filter(
        (id) => id.startsWith("static.category.") || id.endsWith("_category") || id === "static.full_assessment",
      );
      expect(categoryScopeIds).toEqual([expectedId]);
      const check = planned.find((c) => c.id === expectedId)!;
      expect(check.status).toBe(CheckStatus.PLANNED);
      expect(check.persona).toBe("functional");
    }
  });

  it("executes generic category scope checks as documented no-ops with deterministic evidence", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      await touch(path.join(root, "package.json"), '{"name":"x"}\n');
      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-catcov");
      const runner = new StaticCheckRunner(root, inventory, evidence);

      for (const label of ["security", "help", "confidence-plan", "bias"]) {
        const checkId = `static.category.${label}`;
        const intent = assayCategoryIntent(label);
        const def = CHECK_CATALOG.find((c) => c.id === checkId)!;
        const outcome = await runner.run({ id: checkId, intent, expected: def.expected });

        expect(outcome.status).toBe(CheckStatus.PASSED);
        expect(outcome.findings).toEqual([]);
        expect(outcome.metadata).toEqual({ category: label, documented_noop: true });
        expect(outcome.actual).toBe(
          `${label} category assessment scope recorded (${inventory.source_files.length} source file(s) inventoried).`,
        );
        expect(outcome.evidence).toHaveLength(1);
        expect(outcome.evidence[0]).toMatch(/category-scope(?:-\d+)?\.json$/);

        const payload = await readEvidenceJson(root, outcome.evidence[0]!);
        expect(payload).toMatchObject({
          category: label,
          intent,
          expected: def.expected,
          source_available: inventory.available,
          source_files: inventory.source_files.length,
          test_files: inventory.test_files.length,
          markup_files: inventory.markup_files.length,
          manifests: inventory.manifests.length,
          mode: "scope_only",
          documented_noop: true,
        });
        expect(typeof payload.rationale).toBe("string");

        const entries = evidence.getEntries().filter((e) => e.path === outcome.evidence[0]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          kind: "static_analysis",
          check_id: checkId,
          description: `${label} category assessment scope and rationale.`,
        });
      }
    });
  });
});
