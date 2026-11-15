import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckOutcome,
  CheckStatus,
  EvidenceStore,
  PersonaError,
  PluginCheckRunner,
  PluginError,
  Severity,
  Strength,
  blockedPluginOutcome,
  buildRegistry,
  definePlugin,
  definePluginDefinition,
  normalizeCheck,
  normalizeTarget,
  registryFingerprint,
  saveTrustKeys,
  signPlugin,
  type BlockerDraft,
  type Check,
  type FindingDraft,
  type PluginContext,
  type PluginEntryPoint,
  CheckRegistry,
  CHECK_CATALOG,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-plugin-conf-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function persona(id: string, checks: string[]) {
  return { id, checks };
}

function baseCheck(overrides: Partial<Check> = {}): Check {
  return normalizeCheck({
    id: "example.conformance",
    title: "Conformance plugin check",
    domain: "functional",
    persona: "functional",
    kind: "plugin",
    intent: "Exercise plugin conformance.",
    expected: "Plugin behaves per contract.",
    base_weight: 1,
    weight: 1,
    status: CheckStatus.PLANNED,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    started_at: null,
    completed_at: null,
    metadata: {},
    ...overrides,
  });
}

function entry(name: string, value: string, loader: () => unknown): PluginEntryPoint {
  return { name, value, load: loader };
}

describe("LEM-082 plugin conformance suite", () => {
  it("conforms: signed plugin authoring, loading, registration, and execution with evidence", async () => {
    await withTempDir(async (root) => {
      saveTrustKeys(path.join(root, ".lemma", "plugins", "trusted_keys.json"), { "k1": "secret" });
      const plugin = definePlugin({
        definition: {
          id: "example.conformance_ok",
          title: "Conformance OK",
          domain: "functional",
          intent: "Prove signed plugin contract.",
          expected: "Plugin saves evidence and passes.",
          base_weight: 1,
          requires: "source",
          kind: "plugin",
        },
        evaluate: async (ctx: PluginContext) => {
          const ref = await ctx.saveJson("conformance", { ok: true, check: ctx.check.id }, "conformance evidence", "plugin");
          return new CheckOutcome({ status: CheckStatus.PASSED, actual: "ok", evidence: [ref] });
        },
      });
      const signature = signPlugin(plugin.definition, "ok:PLUGIN", "k1", "secret");
      const signed = { ...plugin, signature };

      const registry = await buildRegistry({ root, entryPoints: [entry("ok", "ok:PLUGIN", () => signed)] });
      expect(registry.blockedReason("example.conformance_ok")).toBe("");
      expect(registry.source("example.conformance_ok")).toBe("plugin:ok:PLUGIN");
      expect(typeof registry.evaluator("example.conformance_ok")).toBe("function");
      expect(registry.pluginCount()).toBe(1);

      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_conf_ok");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, { available: true }, evidence);
      const outcome = await runner.run(baseCheck({ id: "example.conformance_ok" }), registry.evaluator("example.conformance_ok")!);
      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.actual).toBe("ok");
      expect(outcome.evidence).toHaveLength(1);
    });
  });

  it("conforms: unsigned, unknown-key, invalid-signature, and tampered plugins are blocked coverage gaps", async () => {
    await withTempDir(async (root) => {
      saveTrustKeys(path.join(root, ".lemma", "plugins", "trusted_keys.json"), { "k1": "secret" });

      const unsigned = definePlugin({
        definition: { id: "example.unsigned", title: "Unsigned", domain: "functional", intent: "i", expected: "e", base_weight: 1, requires: "any", kind: "plugin" },
        evaluate: () => new CheckOutcome({ status: CheckStatus.PASSED }),
      });
      const unsignedRegistry = await buildRegistry({ root, entryPoints: [entry("u", "u:PLUGIN", () => unsigned)] });
      expect(unsignedRegistry.source("example.unsigned")).toBe("plugin-blocked");
      expect(unsignedRegistry.blockedReason("example.unsigned").toLowerCase()).toContain("unsigned");

      const unknownKey = definePlugin({
        definition: { id: "example.unknown_key", title: "Unknown key", domain: "functional", intent: "i", expected: "e", base_weight: 1, requires: "any", kind: "plugin" },
        evaluate: () => new CheckOutcome({ status: CheckStatus.PASSED }),
        signature: signPlugin(definePluginDefinition({ id: "example.unknown_key", title: "Unknown key", domain: "functional", intent: "i", expected: "e", base_weight: 1, requires: "any", kind: "plugin" }), "uk:PLUGIN", "missing", "x"),
      });
      const unknownKeyRegistry = await buildRegistry({ root, entryPoints: [entry("uk", "uk:PLUGIN", () => unknownKey)] });
      expect(unknownKeyRegistry.blockedReason("example.unknown_key")).toContain("unknown signing key");

      const badSig = definePlugin({
        definition: { id: "example.bad_sig", title: "Bad sig", domain: "functional", intent: "i", expected: "e", base_weight: 1, requires: "any", kind: "plugin" },
        evaluate: () => new CheckOutcome({ status: CheckStatus.PASSED }),
        signature: signPlugin(definePluginDefinition({ id: "example.bad_sig", title: "Bad sig", domain: "functional", intent: "i", expected: "e", base_weight: 1, requires: "any", kind: "plugin" }), "bs:PLUGIN", "k1", "wrong"),
      });
      const badSigRegistry = await buildRegistry({ root, entryPoints: [entry("bs", "bs:PLUGIN", () => badSig)] });
      expect(badSigRegistry.blockedReason("example.bad_sig").toLowerCase()).toContain("did not verify");

      // tampered definition after signing
      const base = definePlugin({
        definition: { id: "example.tampered", title: "Tampered", domain: "functional", intent: "i", expected: "e", base_weight: 1, requires: "any", kind: "plugin" },
        evaluate: () => new CheckOutcome({ status: CheckStatus.PASSED }),
      });
      const sig = signPlugin(base.definition, "t:PLUGIN", "k1", "secret");
      const tampered = { ...base, definition: { ...base.definition, title: "Tampered changed" }, signature: sig };
      const tamperedRegistry = await buildRegistry({ root, entryPoints: [entry("t", "t:PLUGIN", () => tampered)] });
      expect(tamperedRegistry.blockedReason("example.tampered").toLowerCase()).toContain("did not verify");
      expect(tamperedRegistry.pluginCount()).toBe(0);
    });
  });

  it("conforms: import/discovery/load failures are blocked coverage gaps, not fatal", async () => {
    await withTempDir(async (root) => {
      const failing = entry("broken_plugin", "broken_plugin:PLUGIN", () => {
        throw new Error("synthetic missing dependency");
      });
      const registry = await buildRegistry({ root, entryPoints: [failing] });
      expect(registry.hasPluginFailures()).toBe(true);
      const blockedId = registry.ids().find((id) => id.startsWith("plugin.load.broken"));
      expect(blockedId).toBeTruthy();
      expect(registry.blockedReason(blockedId ?? "")).toContain("could not be imported");
      expect(registry.source(blockedId ?? "")).toBe("plugin-blocked");

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

  it("conforms: definition/registry contracts, deterministic fingerprint, and counts/sources", async () => {
    await withTempDir(async (root) => {
      // definition validation
      expect(() => definePluginDefinition({ id: "Bad", title: "x", domain: "d", expected: "e", kind: "plugin", requires: "any", base_weight: 1 })).toThrow(PluginError);
      expect(() => definePluginDefinition({ id: "ok.id", title: "", domain: "d", expected: "e", kind: "plugin", requires: "any", base_weight: 1 })).toThrow(PluginError);
      expect(() => definePluginDefinition({ id: "ok.id", title: "t", domain: "d", expected: "e", kind: "weird", requires: "any", base_weight: 1 })).toThrow(PluginError);
      expect(() => definePluginDefinition({ id: "ok.id", title: "t", domain: "d", expected: "e", kind: "plugin", requires: "db", base_weight: 1 })).toThrow(PluginError);
      expect(() => definePluginDefinition({ id: "ok.id", title: "t", domain: "d", expected: "e", kind: "plugin", requires: "any", base_weight: 0 })).toThrow(PluginError);

      const a = await buildRegistry({ root, entryPoints: [] });
      const b = await buildRegistry({ root, entryPoints: [] });
      expect(registryFingerprint(a)).toBe(registryFingerprint(b));
      expect(a.builtinCount()).toBe(CHECK_CATALOG.length);
      expect(a.pluginCount()).toBe(0);
      expect(a.blockedCount()).toBe(0);
      expect(a.source("static.secrets")).toBe("builtin");

      // duplicate registration rejected
      const reg = new CheckRegistry();
      reg.registerBuiltins();
      const base = CHECK_CATALOG[0];
      if (!base) throw new Error("missing builtin");
      expect(() => reg.register(base, { trusted: true })).toThrow(PluginError);
    });
  });

  it("conforms: runner context/validation and blocked plugin outcome helper semantics", async () => {
    await withTempDir(async (root) => {
      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_conf_runner");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, {}, evidence);
      const check = baseCheck();

      // crash -> ERROR
      let out = await runner.run(check, () => {
        throw new Error("boom");
      });
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("Plugin check crashed");

      // invalid return/status/drafts
      const badEvaluator: Parameters<PluginCheckRunner["run"]>[1] = (() => "nope") as never;
      out = await runner.run(check, badEvaluator);
      expect(out.status).toBe(CheckStatus.ERROR);
      const badStatus = "weird" as unknown as CheckStatus;
      out = await runner.run(check, () => new CheckOutcome({ status: badStatus }));
      expect(out.status).toBe(CheckStatus.ERROR);
      out = await runner.run(check, () => new CheckOutcome({ status: CheckStatus.FAILED, findings: [{} as FindingDraft] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      out = await runner.run(check, () => new CheckOutcome({ status: CheckStatus.BLOCKED, blocker: {} as BlockerDraft }));
      expect(out.status).toBe(CheckStatus.ERROR);

      // unsafe/missing evidence and finding-evidence rules
      out = await runner.run(check, () => new CheckOutcome({ status: CheckStatus.PASSED, evidence: ["../escape.json"] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      out = await runner.run(check, () => new CheckOutcome({ status: CheckStatus.PASSED, evidence: [path.join(evidence.runDir, "missing.json")] }));
      expect(out.status).toBe(CheckStatus.ERROR);

      const ref = await evidence.saveJson("ok", { ok: true }, "plugin", "d", check.id);
      const badFinding: FindingDraft = {
        title: "f", severity: Severity.MEDIUM, domain: "functional", strength: Strength.SOURCE_PROVEN,
        consequence: "c", location: "", reproduction: "", evidence: ["other.json"], remediation: "", verification: "", tags: [],
      };
      out = await runner.run(check, () => new CheckOutcome({ status: CheckStatus.FAILED, evidence: [ref], findings: [badFinding] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      const emptyEvidenceFinding: FindingDraft = { ...badFinding, evidence: [] };
      out = await runner.run(check, () => new CheckOutcome({ status: CheckStatus.FAILED, evidence: [], findings: [emptyEvidenceFinding] }));
      expect(out.status).toBe(CheckStatus.ERROR);

      // blocked plugin outcome helper
      const blocked = blockedPluginOutcome(baseCheck({ id: "plugin.load.x", title: "Plugin 'x' could not be loaded" }), "failed to verify");
      expect(blocked.status).toBe(CheckStatus.BLOCKED);
      expect(blocked.findings).toHaveLength(0);
      expect(blocked.blocker?.boundary).toContain("failed to verify");
      expect((blocked.blocker?.unblock_evidence.length ?? 0) > 0).toBe(true);
    });
  });

  it("conforms: ownership validation throws for builtins and blocks plugin ownership gaps", () => {
    // builtin zero/multi-owner -> PersonaError
    const b = new CheckRegistry();
    const base = CHECK_CATALOG[0];
    if (!base) throw new Error("missing builtin");
    b.register({ ...base, id: "static.inventory", kind: "static" }, { trusted: true });
    expect(() => b.validateOwnership([persona("functional", [])])).toThrow(PersonaError);
    const b2 = new CheckRegistry();
    b2.register({ ...base, id: "static.inventory", kind: "static" }, { trusted: true });
    expect(() => b2.validateOwnership([persona("a", ["static.inventory"]), persona("c", ["static.inventory"])])).toThrow(PersonaError);

    // plugin ownership failures become blocked coverage gaps
    const p = new CheckRegistry();
    p.register({ id: "example.owned_plugin", title: "P", domain: "functional", persona: "", kind: "plugin", intent: "i", expected: "e", base_weight: 1, requires: "any" }, {
      source: "plugin:example.owned_plugin:PLUGIN",
      evaluator: () => new CheckOutcome({ status: CheckStatus.PASSED }),
      trusted: true,
    });
    p.validateOwnership([persona("functional", [])]);
    expect(p.source("example.owned_plugin")).toBe("plugin:example.owned_plugin:PLUGIN");
    expect(p.blockedReason("example.owned_plugin")).toContain("no declared persona owner");

    // already-blocked plugin keeps reason; singly-owned blocked plugin gets hint
    const p2 = new CheckRegistry();
    p2.register({ id: "example.hint", title: "P", domain: "functional", persona: "", kind: "plugin", intent: "i", expected: "e", base_weight: 1, requires: "any" }, {
      source: "plugin:example.hint:PLUGIN",
      evaluator: () => new CheckOutcome({ status: CheckStatus.PASSED }),
      trusted: true,
    });
    p2.block("example.hint", "pre-blocked");
    p2.validateOwnership([persona("functional", ["example.hint"])]);
    expect(p2.blockedReason("example.hint")).toBe("pre-blocked");
    expect(p2.ownerHint("example.hint")).toBe("functional");

    const p3 = new CheckRegistry();
    p3.blockFailure("broken", "import failed", "functional");
    const blockedId = p3.ids().find((id) => id.startsWith("plugin.load.broken"));
    expect(blockedId).toBeTruthy();
    if (!blockedId) return;
    p3.validateOwnership([persona("security", [])]);
    expect(p3.blockedReason(blockedId)).toContain("import failed");
  });
});
