import { describe, expect, it } from "vitest";

import {
  CHECK_CATALOG,
  CheckRegistry,
  PersonaError,
  type CheckDefinition,
} from "../../src/index.js";

function persona(id: string, checks: string[]) {
  return { id, checks };
}

function pluginDef(id: string, overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id,
    title: `Plugin ${id}`,
    domain: "functional",
    persona: "",
    kind: "plugin",
    intent: "Plugin check",
    expected: "Plugin runs",
    base_weight: 1,
    requires: "any",
    ...overrides,
  };
}

describe("LEM-077 plugin ownership validation", () => {
  it("succeeds for exactly-one-owner builtins and sets owner hint on blocked checks when missing", () => {
    const registry = new CheckRegistry();
    const base = CHECK_CATALOG[0];
    if (!base) throw new Error("missing builtin");
    registry.register({ ...base, id: "static.inventory", kind: "static" }, { trusted: true });
    registry.block("static.inventory", "temporarily blocked");
    expect(registry.blockedReason("static.inventory")).toBe("temporarily blocked");
    expect(registry.ownerHint("static.inventory")).toBe("");

    registry.validateOwnership([persona("functional", ["static.inventory"])]);
    expect(registry.blockedReason("static.inventory")).toBe("temporarily blocked");
    expect(registry.ownerHint("static.inventory")).toBe("functional");
  });

  it("throws PersonaError for zero or multiple owners of builtin/non-plugin checks", () => {
    const base = CHECK_CATALOG[0];
    if (!base) throw new Error("missing builtin");

    const unowned = new CheckRegistry();
    unowned.register({ ...base, id: "static.inventory", kind: "static" }, { trusted: true });
    expect(() => unowned.validateOwnership([persona("functional", [])])).toThrow(PersonaError);
    try {
      unowned.validateOwnership([persona("functional", [])]);
    } catch (e) {
      expect((e as Error).message).toContain("has no declared persona owner");
      expect((e as Error).message).toContain("static.inventory");
    }

    const multi = new CheckRegistry();
    multi.register({ ...base, id: "static.inventory", kind: "static" }, { trusted: true });
    expect(() =>
      multi.validateOwnership([persona("functional", ["static.inventory"]), persona("security", ["static.inventory"])]),
    ).toThrow(PersonaError);
    try {
      multi.validateOwnership([persona("functional", ["static.inventory"]), persona("security", ["static.inventory"])]);
    } catch (e) {
      expect((e as Error).message).toContain("claimed by multiple personas");
      expect((e as Error).message).toContain("functional, security");
    }
  });

  it("blocks plugin checks on ownership failures instead of throwing (coverage gap)", () => {
    const registry = new CheckRegistry();
    const def = pluginDef("example.pkg");
    // register as plugin source via trusted path but set source semantics: register stores source arg
    (registry as unknown as { register: (d: CheckDefinition, o: Record<string, unknown>) => void }).register(def, {
      source: "plugin:example.pkg:PLUGIN",
      evaluator: () => ({ status: "passed" }),
      trusted: true,
    });
    expect(registry.source("example.pkg")).toBe("plugin:example.pkg:PLUGIN");

    // no owner -> blocked, not thrown (coverage gap)
    registry.validateOwnership([persona("functional", [])]);
    expect(registry.blockedReason("example.pkg")).toContain("no declared persona owner");
    expect(registry.blockedCount()).toBeGreaterThan(0);

    // multiple owners on a fresh plugin -> blocked
    const registry2 = new CheckRegistry();
    (registry2 as unknown as { register: (d: CheckDefinition, o: Record<string, unknown>) => void }).register(pluginDef("example.multi"), {
      source: "plugin:example.multi:PLUGIN",
      evaluator: () => ({ status: "passed" }),
      trusted: true,
    });
    registry2.validateOwnership([
      persona("functional", ["example.multi"]),
      persona("security", ["example.multi"]),
    ]);
    expect(registry2.blockedReason("example.multi")).toContain("claimed by multiple personas");
    expect(registry2.source("example.multi")).toBe("plugin:example.multi:PLUGIN");
  });

  it("keeps already-blocked plugin checks blocked and preserves/sets hints; treats plugin-blocked sources as plugin", () => {
    const registry = new CheckRegistry();
    // synthetic load-failure placeholder (plugin-blocked source)
    registry.blockFailure("broken", "could not be imported", "functional");
    const blockedId = registry.ids().find((id) => id.startsWith("plugin.load.broken"));
    expect(blockedId).toBeTruthy();
    if (!blockedId) return;
    expect(registry.source(blockedId)).toBe("plugin-blocked");
    expect(registry.blockedReason(blockedId)).toContain("could not be imported");
    expect(registry.ownerHint(blockedId)).toBe("functional");

    // ownership failure must not throw and must not replace existing blocked reason
    registry.validateOwnership([persona("security", [])]);
    expect(registry.blockedReason(blockedId)).toContain("could not be imported");
    expect(registry.source(blockedId)).toBe("plugin-blocked");

    // when owner exists for a blocked plugin check missing hint, hint is set
    const registry2 = new CheckRegistry();
    (registry2 as unknown as { register: (d: CheckDefinition, o: Record<string, unknown>) => void }).register(pluginDef("example.owned"), {
      source: "plugin:example.owned:PLUGIN",
      evaluator: () => ({ status: "passed" }),
      trusted: true,
    });
    registry2.block("example.owned", "pre-blocked");
    registry2.validateOwnership([persona("accessibility", ["example.owned"])]);
    expect(registry2.blockedReason("example.owned")).toBe("pre-blocked");
    expect(registry2.ownerHint("example.owned")).toBe("accessibility");
  });
});
