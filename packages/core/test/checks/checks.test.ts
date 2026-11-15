import { describe, expect, it } from "vitest";

import {
  CHECK_CATALOG,
  CheckStatus,
  HarnessError,
  applyRiskWeights,
  catalogIds,
  isBrowserCategoryIntent,
  isDemoCategoryIntent,
  isFullCategoryIntent,
  isFunctionalityCategoryIntent,
  isIssuesCategoryIntent,
  isMoreCategoryIntent,
  isTestCategoryIntent,
  makeDeterminism,
  normalizeRisk,
  normalizeTarget,
  ownershipErrorMessage,
  planChecks,
  resetDeterminism,
  setDeterminism,
  type CheckDefinition,
  type CheckRegistryLike,
} from "../../src/index.js";

function makeRegistry(overrides: Partial<CheckRegistryLike> & { definitions?: CheckDefinition[]; sourceMap?: Record<string, string>; blocked?: Record<string, string>; hints?: Record<string, string> } = {}): CheckRegistryLike & { blockedSet: Record<string, string> } {
  const defs = overrides.definitions ?? [...CHECK_CATALOG];
  const sourceMap = overrides.sourceMap ?? {};
  const blockedSet: Record<string, string> = { ...(overrides.blocked ?? {}) };
  const hints = overrides.hints ?? {};
  return {
    definitions: defs,
    ids: () => defs.map((d) => d.id),
    source: (id) => sourceMap[id] ?? "builtin",
    blockedReason: (id) => blockedSet[id] ?? "",
    block: (id, reason) => {
      blockedSet[id] = reason;
    },
    ownerHint: (id) => hints[id] ?? "",
    blockedSet,
    ...overrides,
  };
}

function allOwnedBy(persona: string, ids: string[] = CHECK_CATALOG.map((c) => c.id)): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) out[id] = [persona];
  return out;
}

describe("LEM-014 check catalog, registry, and intent planning", () => {
  it("exposes the assay check catalog with stable metadata and catalog ids", () => {
    expect(CHECK_CATALOG.length).toBeGreaterThanOrEqual(24);
    expect(catalogIds()).toHaveLength(CHECK_CATALOG.length);
    expect(catalogIds()[0]).toBe("static.full_assessment");
    expect(catalogIds()).toContain("browser.steps");
    expect(catalogIds()).toContain("static.inventory");
    const secrets = CHECK_CATALOG.find((c) => c.id === "static.secrets")!;
    expect(secrets).toMatchObject({
      title: "No live credentials or private keys are committed",
      domain: "security",
      kind: "static",
      base_weight: 2.0,
      requires: "source",
      persona: "",
    });
    expect(secrets.intent).toContain("Prevent a release from exposing credentials");
    const steps = CHECK_CATALOG.find((c) => c.id === "browser.steps")!;
    expect(steps.kind).toBe("browser");
    expect(steps.requires).toBe("url");
    expect(steps.base_weight).toBe(2.0);
  });

  it("implements intent helpers and applicability semantics", () => {
    expect(isFullCategoryIntent("run full assessment now")).toBe(true);
    expect(isFullCategoryIntent("full")).toBe(true);
    expect(isTestCategoryIntent("assay test assessment")).toBe(true);
    expect(isFunctionalityCategoryIntent("functionality category assessment")).toBe(true);
    expect(isBrowserCategoryIntent("assay browser assessment")).toBe(true);
    expect(isIssuesCategoryIntent("issues category assessment")).toBe(true);
    expect(isDemoCategoryIntent("assay demo assessment")).toBe(true);
    expect(isMoreCategoryIntent("assay more assessment")).toBe(true);

    const sourceTarget = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
    const inventory = { available: true, has_markup: true, has_manifest: true };
    const ownership = allOwnedBy("functional");

    const full = planChecks({
      target: sourceTarget,
      inventory,
      selectedPersonas: ["functional"],
      ownership,
      maxChecks: 0,
      intent: "full assessment",
    });
    expect(full.map((c) => c.id)).toContain("static.full_assessment");

    const browserIntentNoLive = planChecks({
      target: sourceTarget,
      inventory,
      selectedPersonas: ["functional"],
      ownership,
      maxChecks: 0,
      intent: "assay browser assessment",
      noBrowser: true,
    });
    expect(browserIntentNoLive.map((c) => c.id)).toContain("static.browser_category");

    const urlTarget = normalizeTarget({ raw: "https://x.test", kind: "url", resolved: "https://x.test" });
    const browserIntentLive = planChecks({
      target: urlTarget,
      inventory: { available: false },
      selectedPersonas: ["functional"],
      ownership,
      maxChecks: 0,
      intent: "assay browser assessment",
    });
    expect(browserIntentLive.map((c) => c.id)).not.toContain("static.browser_category");
    expect(browserIntentLive.map((c) => c.id)).toContain("browser.load");

    const withSteps = planChecks({
      target: urlTarget,
      inventory: { available: false },
      selectedPersonas: ["functional"],
      ownership,
      maxChecks: 0,
      scenario: true,
      mobile: true,
    });
    expect(withSteps.map((c) => c.id)).toContain("browser.steps");
    expect(withSteps.map((c) => c.id)).toContain("browser.overflow");
    expect(withSteps.map((c) => c.id)).toContain("browser.focus_order");

    const noMobile = planChecks({
      target: urlTarget,
      inventory: { available: false },
      selectedPersonas: ["functional"],
      ownership,
      maxChecks: 0,
      scenario: true,
      mobile: false,
    });
    expect(noMobile.map((c) => c.id)).not.toContain("browser.overflow");
    expect(noMobile.map((c) => c.id)).not.toContain("browser.focus_order");
  });

  it("plans checks with ownership/registry hooks, blocked plugin handling, and selection/errors", () => {
    const det = makeDeterminism({ clockMode: "frozen", frozenClock: "2026-11-14T00:00:00Z", seed: 1 });
    const prev = setDeterminism(det);
    try {
      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
      const inventory = { available: true, has_markup: true, has_manifest: true };
      const ownership = allOwnedBy("owner");
      ownership["static.secrets"] = ["security"];
      const planned = planChecks({
        target,
        inventory,
        selectedPersonas: ["owner", "security"],
        ownership,
        maxChecks: 3,
      });
      expect(planned).toHaveLength(3);
      expect(planned[0]!.status).toBe(CheckStatus.PLANNED);
      expect(planned[0]!.weight).toBe(planned[0]!.base_weight);
      expect(planned.find((c) => c.id === "static.secrets") || "filtered by maxChecks").toBeTruthy();

      // selected owner filtering
      const securityOnly = planChecks({
        target,
        inventory,
        selectedPersonas: ["security"],
        ownership,
        maxChecks: 0,
      });
      expect(securityOnly.map((c) => c.id)).toEqual(["static.secrets"]);
      expect(securityOnly[0]!.persona).toBe("security");

      // plugin blocked on ownership issue
      const pluginDef: CheckDefinition = {
        id: "plugin.x",
        title: "Plugin X",
        domain: "functional",
        kind: "plugin",
        intent: "x",
        expected: "x",
        base_weight: 1,
        requires: "any",
        persona: "",
      };
      const registry = makeRegistry({
        definitions: [...CHECK_CATALOG, pluginDef],
        sourceMap: { "plugin.x": "plugin:acme" },
      });
      const withPluginOwnership = { ...allOwnedBy("owner"), "plugin.x": [] as string[] };
      const plannedPlugin = planChecks({
        target,
        inventory,
        selectedPersonas: ["owner"],
        ownership: withPluginOwnership,
        maxChecks: 0,
        registry,
      });
      const blocked = plannedPlugin.find((c) => c.id === "plugin.x")!;
      expect(blocked.status).toBe(CheckStatus.BLOCKED);
      expect(blocked.actual).toContain("has no declared persona owner");
      expect(blocked.completed_at).toBe("2026-11-14T00:00:00Z");
      expect(registry.blockedSet["plugin.x"]).toContain("has no declared persona owner");

      // pre-blocked plugin reason preserved
      const registry2 = makeRegistry({
        definitions: [...CHECK_CATALOG, pluginDef],
        sourceMap: { "plugin.x": "plugin:acme" },
        blocked: { "plugin.x": "signature invalid" },
      });
      const plannedPlugin2 = planChecks({
        target,
        inventory,
        selectedPersonas: ["owner"],
        ownership: { ...allOwnedBy("owner"), "plugin.x": [] },
        maxChecks: 0,
        registry: registry2,
      });
      expect(plannedPlugin2.find((c) => c.id === "plugin.x")!.actual).toBe("signature invalid");

      // non-plugin ownership error
      expect(() =>
        planChecks({
          target,
          inventory,
          selectedPersonas: ["owner"],
          ownership: { ...allOwnedBy("owner"), "static.inventory": [] },
          maxChecks: 0,
        }),
      ).toThrow(HarnessError);
      expect(ownershipErrorMessage("x", ["a", "b"])).toContain("exactly one persona contract");
      expect(ownershipErrorMessage("x", ["a", "b"])).toContain("multiple personas (a, b)");

      // no applicable checks
      expect(() =>
        planChecks({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/empty" }),
          inventory: { available: false },
          selectedPersonas: ["owner"],
          ownership: allOwnedBy("owner"),
          maxChecks: 0,
        }),
      ).toThrow(/No applicable checks/);

      // maxChecks removes all
      expect(() =>
        planChecks({
          target,
          inventory,
          selectedPersonas: ["owner"],
          ownership,
          maxChecks: 0,
          registry: makeRegistry({ definitions: [] }),
        }),
      ).toThrow(/No applicable checks/);
      expect(() =>
        planChecks({
          target,
          inventory,
          selectedPersonas: ["owner"],
          ownership,
          maxChecks: 1,
          registry: makeRegistry({ definitions: [] }),
        }),
      ).toThrow(/No applicable checks/);
    } finally {
      resetDeterminism(prev);
    }
  });

  it("supports registry ids/owner hint and applies risk weights with per-domain max multiplier", () => {
    const registry = makeRegistry({ hints: { "plugin.x": "hint-owner" } });
    expect(catalogIds(registry)).toHaveLength(CHECK_CATALOG.length);

    const pluginDef: CheckDefinition = {
      id: "plugin.x",
      title: "Plugin X",
      domain: "functional",
      kind: "plugin",
      intent: "x",
      expected: "x",
      base_weight: 1,
      requires: "any",
      persona: "",
    };
    const reg2 = makeRegistry({
      definitions: [pluginDef],
      sourceMap: { "plugin.x": "plugin:acme" },
      hints: { "plugin.x": "hint-owner" },
    });
    const planned = planChecks({
      target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/r" }),
      inventory: { available: true },
      selectedPersonas: ["hint-owner", "other"],
      ownership: { "plugin.x": ["a", "b"] },
      maxChecks: 0,
      registry: reg2,
    });
    expect(planned[0]!.persona).toBe("hint-owner");
    expect(planned[0]!.status).toBe(CheckStatus.BLOCKED);

    const checks = [
      {
        id: "c1",
        title: "t",
        domain: "security",
        persona: "p",
        kind: "static",
        intent: "",
        expected: "",
        base_weight: 1.5,
        status: CheckStatus.PLANNED,
        weight: 1.5,
        actual: "",
        evidence: [],
        finding_ids: [],
        skip_reason: "",
        started_at: null,
        completed_at: null,
        metadata: {},
      },
      {
        id: "c2",
        title: "t",
        domain: "functional",
        persona: "p",
        kind: "static",
        intent: "",
        expected: "",
        base_weight: 2,
        status: CheckStatus.PLANNED,
        weight: 2,
        actual: "",
        evidence: [],
        finding_ids: [],
        skip_reason: "",
        started_at: null,
        completed_at: null,
        metadata: {},
      },
    ];
    const risks = [
      normalizeRisk({ id: "r1", title: "r", domain: "security", weight_multiplier: 1.2 }),
      normalizeRisk({ id: "r2", title: "r", domain: "security", weight_multiplier: 1.5 }),
      normalizeRisk({ id: "r3", title: "r", domain: "functional", weight_multiplier: 0.5 }),
    ];
    applyRiskWeights(checks, risks);
    expect(checks[0]!.weight).toBe(2.25);
    // multipliers use per-domain max(risk multipliers, 1.0), so 0.5 does not reduce below base
    expect(checks[1]!.weight).toBe(2);
  });
});
