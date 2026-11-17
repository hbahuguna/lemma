import { describe, expect, it } from "vitest";

import { discoverInteractionPlan } from "../src/interactions.js";
import type { SourceFeature } from "@lemma/core";

const features: SourceFeature[] = [
  { id: "route-dashboard", kind: "route", label: "/dashboard", selector_hint: "", route_hint: "/dashboard", source: { path: "src/App.tsx", line: 2 } },
  { id: "button-save", kind: "button", label: "Save changes", selector_hint: '[data-testid="save-btn"]', route_hint: "", source: { path: "src/App.tsx", line: 3 } },
  { id: "toggle-dark", kind: "toggle", label: "Dark mode", selector_hint: '[role="switch"]', route_hint: "", source: { path: "src/App.tsx", line: 6 } },
  { id: "input-search", kind: "input", label: "Search", selector_hint: '[aria-label="Search"]', route_hint: "", source: { path: "src/App.tsx", line: 4 } },
  { id: "select-region", kind: "select", label: "Region", selector_hint: '[name="region"]', route_hint: "", option_hint: "EU", source: { path: "src/App.tsx", line: 5 } },
];

function fakePage(): any {
  return {
    refreshUrl: async () => {},
    evaluate: async (expression: string) => {
      if (String(expression).includes("const buttons =")) {
        return {
          url: "https://example.test/",
          title: "Example",
          // Generic DOM controls intentionally differ from source features.
          buttons: [{ text: "Generic button", selector: "#generic" }],
          links: [],
          inputs: [{ type: "text", label: "Generic field", selector: "#generic-input" }],
          selects: [],
          toggles: [],
          forms: [],
          scrollHeight: 500,
          innerHeight: 900,
        };
      }
      return false;
    },
  };
}

describe("source-backed interaction planning", () => {
  it("uses source features as dedicated, named steps", async () => {
    const plan = await discoverInteractionPlan(fakePage(), "https://example.test", features, new Set());
    const names = plan.steps.map((s) => s.name);
    expect(names.some((n) => n.includes("Source route: /dashboard"))).toBe(true);
    expect(names.some((n) => n.includes("Source button: Save changes"))).toBe(true);
    expect(names.some((n) => n.includes("Source toggle: Dark mode"))).toBe(true);
    expect(names.some((n) => n.includes("Source input: Search"))).toBe(true);
    expect(names.some((n) => n.includes("Source select: Region"))).toBe(true);
    expect(names.some((n) => n.includes("Generic button"))).toBe(false);
    expect(names.some((n) => n.includes("Generic field"))).toBe(false);
    expect(plan.source).toBe("source-backed+cdp-auto");
  });

  it("does not repeat the same feature across crawled pages", async () => {
    const dedupe = new Set<string>();
    const first = await discoverInteractionPlan(fakePage(), "https://example.test", features, dedupe);
    const second = await discoverInteractionPlan(fakePage(), "https://example.test/about", features, dedupe);
    const key = (s: { action: string; target: string; value: string }) => `${s.action}|${s.target}|${s.value}`;
    const firstFeatureSteps = first.steps.filter((s) => s.name.startsWith("Source "));
    const secondFeatureSteps = second.steps.filter((s) => s.name.startsWith("Source "));
    expect(firstFeatureSteps.length).toBeGreaterThan(0);
    expect(secondFeatureSteps.length).toBe(0);
    expect(new Set(firstFeatureSteps.map(key)).size).toBe(firstFeatureSteps.length);
  });
});
