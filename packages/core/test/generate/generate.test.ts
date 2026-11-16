import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runGenerate } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-generate-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function isBrowserStepsCompatibleScenario(s: any): boolean {
  return !!s && typeof s.title === "string" && Array.isArray(s.steps) && s.steps.length > 0 &&
    s.steps.every((st: any) => st && typeof st.step_number === "number" && typeof st.name === "string" && typeof st.action === "string" && typeof st.target === "string" && typeof st.value === "string") &&
    typeof s.source === "string" && typeof s.target_url === "string";
}

describe("LEM-170 test generation workflow", () => {
  for (const source of ["code", "page", "requirements", "recording", "custom"] as const) {
    it(`generates prioritized, browser.steps-compatible intents for source=${source}`, async () => {
      await withTempDir(async (root) => {
        const scope = source === "requirements" ? { items: ["Req A", "Req B"], url: "https://example.test" }
          : source === "recording" ? { items: ["Open home", "Click login"], url: "https://example.test" }
          : source === "custom" ? { items: ["Custom A", "Custom B"], url: "https://example.test" }
          : { url: "https://example.test", feature: "checkout", input: "https://example.test" };
        const result = await runGenerate({ source, scope, root, seed: "seed-1" });
        expect(result.generated.length).toBeGreaterThan(0);
        expect(result.output_dir).toBe(".lemma/tests/generated");
        // priority ordering (highest-value first)
        for (let i = 1; i < result.generated.length; i++) {
          expect(result.generated[i - 1].priority).toBeLessThanOrEqual(result.generated[i].priority);
        }
        for (const intent of result.generated) {
          expect(intent.reviewed).toBe(false);
          expect(intent.path.startsWith(".lemma/tests/generated/")).toBe(true);
          expect(isBrowserStepsCompatibleScenario(intent.scenario)).toBe(true);
          const abs = path.join(root, intent.path);
          const raw = JSON.parse(await fs.readFile(abs, "utf8"));
          expect(isBrowserStepsCompatibleScenario(raw.scenario)).toBe(true);
          expect(raw.reviewed).toBe(false);
        }
      });
    });
  }

  it("enforces maxTests and surfaces overflow as explicit not_generated list (never silently dropped)", async () => {
    await withTempDir(async (root) => {
      const result = await runGenerate({
        source: "requirements",
        scope: { items: ["R1", "R2", "R3", "R4"], url: "https://example.test" },
        maxTests: 2,
        root,
        seed: "s",
      });
      expect(result.counts.generated).toBe(2);
      expect(result.counts.not_generated).toBe(2);
      expect(result.not_generated).toHaveLength(2);
      expect(result.not_generated.every((n) => /maxTests cap/i.test(n.reason))).toBe(true);
      // generated files only for selected
      const files = await fs.readdir(path.join(root, ".lemma", "tests", "generated"));
      expect(files.filter(f => f.startsWith("requirements-")).length).toBe(2);
    });
  });

  it("is deterministic for same source + scope + seed (ordering and file contents stable)", async () => {
    await withTempDir(async (rootA) => {
      await withTempDir(async (rootB) => {
        const params = { source: "code" as const, scope: { url: "https://example.test", feature: "billing" }, root: "", seed: 42, maxTests: 3 };
        const a = await runGenerate({ ...params, root: rootA });
        const b = await runGenerate({ ...params, root: rootB });
        const norm = (r: any) => ({
          ...r,
          generated_at: "T",
          generated: r.generated.map((g: any) => g),
        });
        expect(norm(a).generated).toEqual(norm(b).generated);
        expect(norm(a).not_generated).toEqual(norm(b).not_generated);
        expect(a.deterministic.seed).toBe(b.deterministic.seed);
        // file contents stable (excluding generated_at timestamp in payload we wrote? we included it; compare stable fields)
        for (let i = 0; i < a.generated.length; i++) {
          const fa = JSON.parse(await fs.readFile(path.join(rootA, a.generated[i].path), "utf8"));
          const fb = JSON.parse(await fs.readFile(path.join(rootB, b.generated[i].path), "utf8"));
          expect({ ...fa, generated_at: "T" }).toEqual({ ...fb, generated_at: "T" });
        }
      });
    });
  });

  it("does not mark generated intents as reviewed", async () => {
    await withTempDir(async (root) => {
      const result = await runGenerate({ source: "page", scope: { url: "https://example.test" }, root, seed: 1 });
      expect(result.generated.every((g) => g.reviewed === false)).toBe(true);
      const f = JSON.parse(await fs.readFile(path.join(root, result.generated[0].path), "utf8"));
      expect(f.reviewed).toBe(false);
    });
  });
});
