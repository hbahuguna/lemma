import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckOutcome,
  CheckStatus,
  EvidenceStore,
  PluginCheckRunner,
  PluginError,
  buildRegistry,
  definePlugin,
  definePluginDefinition,
  signPlugin,
  normalizeCheck,
  normalizeTarget,
  type PluginContext,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-plugin-api-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-078 TypeScript plugin authoring API", () => {
  it("defines and normalizes a registry-compatible plugin definition and plugin object", () => {
    const definition = definePluginDefinition({
      id: "example.authored",
      name: "Authored check",
      domain: "functional",
      description: "Ensures authored plugin API works.",
      expected: "Plugin definition is normalized.",
      base_weight: 1.2,
      requires: "source",
      kind: "plugin",
    });

    expect(definition).toMatchObject({
      id: "example.authored",
      title: "Authored check",
      domain: "functional",
      intent: "Ensures authored plugin API works.",
      expected: "Plugin definition is normalized.",
      base_weight: 1.2,
      requires: "source",
      kind: "plugin",
    });

    const plugin = definePlugin({
      definition: {
        id: "example.authored",
        name: "Authored check",
        domain: "functional",
        description: "Ensures authored plugin API works.",
        expected: "Plugin definition is normalized.",
        base_weight: 1.2,
        requires: "source",
        kind: "plugin",
      },
      evaluate: () => new CheckOutcome({ status: CheckStatus.PASSED, actual: "ok" }),
      signature: "",
    });

    expect(plugin.definition.id).toBe("example.authored");
    expect(typeof plugin.evaluate).toBe("function");
    expect(plugin.signature ?? "").toBe("");
  });

  it("rejects invalid authoring shapes deterministically", () => {
    expect(() => definePluginDefinition({ id: "Bad.Id", domain: "functional", expected: "x" })).toThrow(PluginError);
    expect(() =>
      definePluginDefinition({ id: "example.missing_title", domain: "functional", expected: "x", kind: "plugin" }),
    ).toThrow(/needs a non-empty title/);
    expect(() =>
      definePluginDefinition({
        id: "example.bad_kind",
        title: "Bad kind",
        domain: "functional",
        expected: "x",
        kind: "browser",
      }),
    ).not.toThrow();
    expect(() =>
      definePluginDefinition({
        id: "example.unknown_kind",
        title: "Unknown kind",
        domain: "functional",
        expected: "x",
        kind: "weird",
      }),
    ).toThrow(/unknown kind/);
    expect(() =>
      definePluginDefinition({
        id: "example.bad_requires",
        title: "Bad requires",
        domain: "functional",
        expected: "x",
        requires: "database",
      }),
    ).toThrow(/unknown input requirement/);
    expect(() =>
      definePluginDefinition({
        id: "example.bad_weight",
        title: "Bad weight",
        domain: "functional",
        expected: "x",
        base_weight: 0,
      }),
    ).toThrow(/base_weight/);

    expect(() => definePlugin({ definition: { id: "example.no_eval", title: "x", domain: "functional", expected: "x" }, evaluate: null as never })).toThrow(PluginError);
  });

  it("supports end-to-end authoring: sign, register, and execute with PluginCheckRunner/context.saveJson", async () => {
    await withTempDir(async (root) => {
      const trustPath = path.join(root, ".lemma", "plugins", "trusted_keys.json");
      await mkdir(path.dirname(trustPath), { recursive: true });
      await writeFile(trustPath, JSON.stringify({ keys: { "test-key": "synthetic-secret" } }), "utf8");

      const plugin = definePlugin({
        definition: {
          id: "example.authored_runtime",
          title: "Authored runtime check",
          domain: "functional",
          intent: "Verify end-to-end authoring compatibility.",
          expected: "Plugin saves evidence and passes.",
          base_weight: 1,
          requires: "source",
          kind: "plugin",
        },
        evaluate: async (ctx: PluginContext) => {
          const ref = await ctx.saveJson("authored", { ok: true }, "authored evidence", "plugin");
          return new CheckOutcome({
            status: CheckStatus.PASSED,
            actual: `saw ${ctx.check.id}`,
            evidence: [ref],
            metadata: { source: "authored-api" },
          });
        },
      });

      const signature = signPlugin(plugin.definition, "authored:PLUGIN", "test-key", "synthetic-secret");
      const signed = definePlugin({ ...plugin, signature });

      const registry = await buildRegistry({
        root,
        entryPoints: [{ name: "authored", value: "authored:PLUGIN", load: () => signed }],
      });

      expect(registry.blockedReason("example.authored_runtime")).toBe("");
      expect(registry.source("example.authored_runtime")).toBe("plugin:authored:PLUGIN");
      const evaluator = registry.evaluator("example.authored_runtime");
      expect(typeof evaluator).toBe("function");

      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_authored");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, {}, evidence);
      const check = normalizeCheck({
        id: "example.authored_runtime",
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

      const outcome = await runner.run(check, evaluator!);
      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toContain("example.authored_runtime");
      expect(outcome.evidence).toHaveLength(1);
      expect(outcome.metadata).toMatchObject({ source: "authored-api" });
    });
  });
});
