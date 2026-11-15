import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHECK_CATALOG,
  CheckRegistry,
  PluginError,
  buildRegistry,
  catalogIds,
  loadTrustKeys,
  registryFingerprint,
  signPlugin,
  signaturePayload,
  type CheckDefinition,
  type PluginEntryPoint,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-plugins-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sampleDefinition(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "example.package_metadata",
    title: "Package metadata exists",
    domain: "functional",
    persona: "functional",
    kind: "plugin",
    intent: "Ensure package metadata is present.",
    expected: "A package manifest is present.",
    base_weight: 1.0,
    requires: "source",
    ...overrides,
  };
}

function entry(name: string, value: string, loader: () => unknown): PluginEntryPoint {
  return { name, value, load: loader };
}

describe("LEM-075 signed plugin registry", () => {
  it("registers built-ins through the registry and exposes deterministic catalog/fingerprint", async () => {
    await withTempDir(async (root) => {
      const registry = await buildRegistry({ root, entryPoints: [] });
      expect(new Set(registry.ids())).toEqual(new Set(catalogIds()));
      expect(registry.source("static.secrets")).toBe("builtin");
      expect(registry.builtinCount()).toBe(CHECK_CATALOG.length);
      expect(registry.pluginCount()).toBe(0);
      expect(registry.blockedCount()).toBe(0);

      const fp1 = registryFingerprint(registry);
      const fp2 = registryFingerprint(await buildRegistry({ root, entryPoints: [] }));
      expect(fp1).toBe(fp2);
      expect(typeof fp1).toBe("string");
      expect(fp1.length).toBeGreaterThan(20);
    });
  });

  it("loads trust keys and signs/verifies plugin definitions with HMAC-SHA256", async () => {
    await withTempDir(async (root) => {
      const trustPath = path.join(root, ".lemma", "plugins", "trusted_keys.json");
      await mkdir(path.dirname(trustPath), { recursive: true });
      await writeFile(trustPath, JSON.stringify({ keys: { "test-key": "synthetic-secret" } }), "utf8");

      const keys = loadTrustKeys(trustPath);
      expect(keys).toEqual({ "test-key": "synthetic-secret" });

      const def = sampleDefinition();
      const sig = signPlugin(def, "sample_check:PLUGIN", "test-key", "synthetic-secret");
      expect(sig.startsWith("hmac-sha256:test-key:")).toBe(true);
      expect(signaturePayload(def, "sample_check:PLUGIN")).toBeInstanceOf(Buffer);

      const plugin = { definition: def, evaluate: () => ({ status: "passed", actual: "ok" }), signature: sig };
      const registry = await buildRegistry({
        root,
        entryPoints: [entry("sample_check", "sample_check:PLUGIN", () => plugin)],
      });
      expect(registry.pluginCount()).toBe(1);
      expect(registry.blockedReason("example.package_metadata")).toBe("");
      expect(registry.source("example.package_metadata")).toBe("plugin:sample_check:PLUGIN");
      expect(typeof registry.evaluator("example.package_metadata")).toBe("function");
    });
  });

  it("blocks unsigned, unknown-key, and invalid-signature plugins as coverage gaps", async () => {
    await withTempDir(async (root) => {
      const trustPath = path.join(root, ".lemma", "plugins", "trusted_keys.json");
      await mkdir(path.dirname(trustPath), { recursive: true });
      await writeFile(trustPath, JSON.stringify({ keys: { "test-key": "synthetic-secret" } }), "utf8");

      const def = sampleDefinition();
      const unsigned = { definition: def, evaluate: () => ({ status: "passed" }), signature: "" };
      let registry = await buildRegistry({ root, entryPoints: [entry("unsigned", "unsigned:PLUGIN", () => unsigned)] });
      expect(registry.pluginCount()).toBe(0);
      expect(registry.ids()).toContain(def.id);
      expect(registry.blockedReason(def.id).toLowerCase()).toContain("unsigned");
      expect(registry.source(def.id)).toBe("plugin-blocked");

      const wrongKey = {
        definition: sampleDefinition({ id: "example.unknown_key" }),
        evaluate: () => ({ status: "passed" }),
        signature: signPlugin(sampleDefinition({ id: "example.unknown_key" }), "bad:PLUGIN", "missing-key", "x"),
      };
      registry = await buildRegistry({ root, entryPoints: [entry("badkey", "bad:PLUGIN", () => wrongKey)] });
      expect(registry.blockedReason("example.unknown_key")).toContain("unknown signing key");

      const wrongSecret = {
        definition: sampleDefinition({ id: "example.bad_sig" }),
        evaluate: () => ({ status: "passed" }),
        signature: signPlugin(sampleDefinition({ id: "example.bad_sig" }), "badsig:PLUGIN", "test-key", "wrong-secret"),
      };
      registry = await buildRegistry({ root, entryPoints: [entry("badsig", "badsig:PLUGIN", () => wrongSecret)] });
      expect(registry.blockedReason("example.bad_sig").toLowerCase()).toContain("did not verify");
    });
  });

  it("rejects invalid/duplicate definitions and blocks import failures without failing the build", async () => {
    await withTempDir(async (root) => {
      const registry = new CheckRegistry();
      registry.registerBuiltins();
      const baseline = CHECK_CATALOG[0];
      if (!baseline) throw new Error("missing baseline");
      expect(() => registry.register(baseline, { trusted: true })).toThrow(PluginError);
      expect(() => registry.register({ ...baseline, id: "plugin.unknown_input", requires: "database" }, { trusted: true })).toThrow(PluginError);
      expect(() => registry.register({ ...baseline, id: "plugin.zero_weight", base_weight: 0 }, { trusted: true })).toThrow(PluginError);

      // import/load failure becomes blocked synthetic check
      const failing = entry("broken_plugin", "broken_plugin:PLUGIN", () => {
        throw new Error("synthetic missing dependency");
      });
      const built = await buildRegistry({ root, entryPoints: [failing] });
      expect(built.hasPluginFailures()).toBe(true);
      const blockedIds = built.ids().filter((id) => id.startsWith("plugin.load.broken"));
      expect(blockedIds).toHaveLength(1);
      expect(built.blockedReason(blockedIds[0] ?? "").toLowerCase()).toContain("could not be imported");
      expect(built.source(blockedIds[0] ?? "")).toBe("plugin-blocked");

      // discovery failure also blocks (synthetic)
      const discovered = await buildRegistry({
        root,
        entryPoints: {
          [Symbol.iterator]() {
            throw new Error("boom");
          },
        } as unknown as Iterable<PluginEntryPoint>,
      });
      expect(discovered.hasPluginFailures()).toBe(true);
      expect(discovered.ids().some((id) => id.startsWith("plugin.load.entry-point-discovery"))).toBe(true);
    });
  });
});
