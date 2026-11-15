import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  PluginCheckRunner,
  buildRegistry,
  normalizeCheck,
  normalizeTarget,
  saveTrustKeys,
  signPlugin,
} from "../../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const sampleDir = path.join(repoRoot, "examples", "plugins");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-sample-plugin-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-080 sample plugin and authoring docs", () => {
  it("publishes sample plugin files and authoring docs with expected lemma contracts", async () => {
    expect(existsSync(path.join(sampleDir, "sample-check.ts"))).toBe(true);
    expect(existsSync(path.join(sampleDir, "package.json"))).toBe(true);
    expect(existsSync(path.join(sampleDir, "README.md"))).toBe(true);

    const source = await readFile(path.join(sampleDir, "sample-check.ts"), "utf8");
    expect(source).toContain("definePlugin");
    expect(source).toContain("example.package_metadata");
    expect(source).toContain("signature: \"\"");
    expect(source).toContain("context.saveJson");

    const pkg = JSON.parse(await readFile(path.join(sampleDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg.name).toBe("lemma-sample-check-plugin");
    expect(pkg.type).toBe("module");

    const readme = await readFile(path.join(sampleDir, "README.md"), "utf8");
    expect(readme).toContain(".lemma/plugins/trusted_keys.json");
    expect(readme).toContain("signPlugin");
    expect(readme).toContain("coverage gap");
    expect(readme).toContain("checks:");
  });

  it("loads, signs, registers, and executes the sample plugin successfully", async () => {
    await withTempDir(async (root) => {
      const trustFile = path.join(root, ".lemma", "plugins", "trusted_keys.json");
      saveTrustKeys(trustFile, { "example-key": "synthetic-secret" });

      const samplePath = path.join(sampleDir, "sample-check.ts");
      const mod = (await import(pathToFileURL(samplePath).href)) as Record<string, unknown>;
      const plugin = (mod.PLUGIN ?? mod.default) as {
        definition: { id: string; title: string; domain: string; kind: string; intent: string; expected: string; base_weight: number; requires: string; persona?: string };
        evaluate: (ctx: unknown) => unknown;
        signature?: string;
      };
      expect(plugin?.definition?.id).toBe("example.package_metadata");
      expect(plugin.signature ?? "").toBe("");

      const signature = signPlugin(plugin.definition as never, "sample_check:PLUGIN", "example-key", "synthetic-secret");
      const signed = { ...plugin, signature };

      const registry = await buildRegistry({
        root,
        trustFile,
        entryPoints: [{ name: "sample_check", value: "sample_check:PLUGIN", load: () => signed }],
      });
      expect(registry.blockedReason("example.package_metadata")).toBe("");

      const evaluator = registry.evaluator("example.package_metadata");
      expect(typeof evaluator).toBe("function");

      const evidence = new EvidenceStore(root, "run_sample_plugin");
      await evidence.init();
      const inventory = { manifests: ["package.json", "pnpm-lock.yaml"], available: true };
      const target = normalizeTarget({ raw: root, kind: "directory", resolved: root });
      const runner = new PluginCheckRunner(target, root, inventory, evidence);
      const check = normalizeCheck({
        id: plugin.definition.id,
        title: plugin.definition.title,
        domain: plugin.definition.domain,
        persona: "functional",
        kind: plugin.definition.kind,
        intent: plugin.definition.intent,
        expected: plugin.definition.expected,
        base_weight: plugin.definition.base_weight,
        weight: plugin.definition.base_weight,
        status: CheckStatus.PLANNED,
      });

      const outcome = await runner.run(check, evaluator as never);
      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toContain("2 package manifest(s)");
      expect(outcome.evidence.length).toBeGreaterThan(0);
      expect(outcome.metadata).toMatchObject({ manifests: ["package.json", "pnpm-lock.yaml"] });
    });
  });
});
