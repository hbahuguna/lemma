import { describe, expect, it } from "vitest";
import type { SourceFeature } from "@lemma/core";

import {
  CdpInteractionPage,
  buildFillExpr,
  buildFindExpr,
  discoverInteractionPlan,
} from "../src/interactions.js";

function isParsableJs(expression: string): boolean {
  try {
    // Only parse; browser globals (document/window/CSS) are intentionally unresolved.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(expression);
    return true;
  } catch {
    return false;
  }
}

const pricingFeatures: SourceFeature[] = [
  { id: "route-pricing", kind: "route", label: "/pricing", selector_hint: "", route_hint: "/pricing", source: { path: "src/App.tsx", line: 10 } },
  { id: "toggle-annual", kind: "toggle", label: "Annual billing", selector_hint: '[aria-label="Annual billing"]', route_hint: "/pricing", routes: ["/pricing"], source: { path: "src/pages/Pricing.tsx", line: 12 } },
  { id: "slider-seats", kind: "slider", label: "Team size", selector_hint: '[aria-label="Team size"]', route_hint: "/pricing", routes: ["/pricing"], source: { path: "src/pages/Pricing.tsx", line: 13 } },
  { id: "input-seats", kind: "input", label: "Developer seats", selector_hint: "#seats", route_hint: "/pricing", routes: ["/pricing"], input_type: "number", placeholder: "Seats", required: true, source: { path: "src/pages/Pricing.tsx", line: 11 } },
  { id: "select-region", kind: "select", label: "Region", selector_hint: "#region", route_hint: "/pricing", routes: ["/pricing"], option_hint: "EU", source: { path: "src/pages/Pricing.tsx", line: 18 } },
  { id: "button-pro", kind: "button", label: "Choose Pro", selector_hint: "#choose-pro", route_hint: "/pricing", routes: ["/pricing"], source: { path: "src/components/PricingCard.tsx", line: 3 } },
  { id: "tab-overview", kind: "tab", label: "Overview", selector_hint: "#tab-overview", route_hint: "/pricing", routes: ["/pricing"], source: { path: "src/pages/Pricing.tsx", line: 14 } },
  { id: "accordion-faq", kind: "accordion", label: "Is annual billing cheaper?", selector_hint: "#faq", route_hint: "/pricing", routes: ["/pricing"], source: { path: "src/pages/Pricing.tsx", line: 15 } },
];

function richPage(url = "https://example.test/pricing"): any {
  return {
    refreshUrl: async () => {},
    evaluate: async (expression: string) => {
      const s = String(expression);
      if (s.includes("const buttons =")) {
        return {
          liveDom: true,
          url,
          title: "Pricing",
          buttons: [
            { text: "Choose Pro", selector: "#choose-pro", type: "button", inChrome: false, isSubmit: false },
            { text: "Get started", selector: "#get-started", type: "button", inChrome: false, isSubmit: false },
          ],
          links: [{ text: "Docs", href: "/docs", selector: "#docs", inChrome: false }],
          inputs: [{ type: "number", label: "Developer seats", selector: "#seats", placeholder: "Seats", required: true }],
          selects: [{ name: "region", label: "Region", selector: "#region", options: ["EU", "US"] }],
          toggles: [{ text: "Annual billing", selector: '#annual', type: "switch", inChrome: false }],
          sliders: [{ text: "Team size", selector: "#slider" }],
          tabs: [{ text: "Overview", selector: "#tab-overview" }],
          accordions: [{ text: "Is annual billing cheaper?", selector: "#faq" }],
          forms: [],
          scrollHeight: 2400,
          innerHeight: 900,
        };
      }
      if (s.includes("scrollHeight")) return { sh: 2400, ih: 900 };
      return url;
    },
  };
}

describe("CDP interaction expressions", () => {
  it("emits valid JavaScript (no embedded TypeScript syntax) for find and fill", () => {
    for (const mode of ["find", "scroll", "click"] as const) {
      const expr = buildFindExpr("label", "Email", undefined, mode);
      expect(isParsableJs(expr)).toBe(true);
      expect(expr).not.toContain(":any");
      expect(expr).not.toContain(": any");
    }
    const fill = buildFillExpr("label", "Email", undefined, "qa-check@example.invalid");
    expect(isParsableJs(fill)).toBe(true);
    expect(fill).not.toContain(":any");
    expect(fill).not.toContain(": any");
    // React controlled inputs need the native prototype value setter.
    expect(fill).toContain("HTMLInputElement.prototype");
    expect(fill).toContain("Object.getOwnPropertyDescriptor");
    expect(fill).toContain("desc.set.call");
    expect(fill).toContain("dispatchEvent(new Event('input'");
    expect(fill).toContain("dispatchEvent(new Event('change'");
  });

  it("emits valid JavaScript for select and slider evaluation through the page adapter", async () => {
    const captured: string[] = [];
    const page = new CdpInteractionPage({ call: async () => ({}) });
    (page as any).evaluate = async (expression: string) => {
      captured.push(expression);
      return true;
    };
    await page._select("css", "#region", "EU");
    await page.adjustSlider("#slider", "30");
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const expr of captured) {
      expect(isParsableJs(expr)).toBe(true);
      expect(expr).not.toContain(":any");
    }
  });
});

describe("deep per-route interaction planning", () => {
  it("builds rich toggle/slide/tab/accordion/form/click steps from live DOM + source features", async () => {
    const plan = await discoverInteractionPlan(richPage(), "https://example.test/pricing", pricingFeatures, new Set(), {
      multiTargetRun: true,
    });
    const actions = new Set(plan.steps.map((s) => s.action));
    for (const action of ["screenshot", "scroll", "toggle", "slide", "click", "fill", "select", "assert_no_errors"]) {
      expect(actions.has(action)).toBe(true);
    }
    const names = plan.steps.map((s) => s.name);
    expect(names.some((n) => n.includes("Annual billing"))).toBe(true);
    expect(names.some((n) => n.includes("Team size"))).toBe(true);
    expect(names.some((n) => n.includes("Developer seats"))).toBe(true);
    expect(names.some((n) => n.includes("Region"))).toBe(true);
    expect(names.some((n) => n.includes("Choose Pro"))).toBe(true);
    expect(names.some((n) => n.includes("Overview"))).toBe(true);
    expect(names.some((n) => n.includes("annual billing cheaper"))).toBe(true);

    // In-page CTAs must restore the route so subsequent checks stay on the page.
    const cta = plan.steps.find((s) => s.name.includes("Choose Pro"));
    expect((cta?.options as any)?.stayOnPageUrl).toBe("https://example.test/pricing");
  });

  it("does not add redundant link-bounce or source-route navigation loops during multi-route runs", async () => {
    const plan = await discoverInteractionPlan(richPage(), "https://example.test/pricing", pricingFeatures, new Set(), {
      multiTargetRun: true,
    });
    const names = plan.steps.map((s) => s.name);
    expect(names.some((n) => n.includes("Navigate via link"))).toBe(false);
    expect(names.some((n) => n.includes("Return to base page"))).toBe(false);
    expect(names.some((n) => n.startsWith("Source route:"))).toBe(false);

    // Standalone (single-target) runs still probe public source routes.
    const standaloneFeatures: SourceFeature[] = [
      ...pricingFeatures,
      { id: "route-careers", kind: "route", label: "/careers", selector_hint: "", route_hint: "/careers", source: { path: "src/App.tsx", line: 20 } },
    ];
    const single = await discoverInteractionPlan(richPage(), "https://example.test/pricing", standaloneFeatures, new Set(), {
      multiTargetRun: false,
    });
    expect(single.steps.some((s) => s.name.startsWith("Source route:"))).toBe(true);
  });

  it("does not skip pricing toggles whose label contains 'Pay monthly / Pay annually'", async () => {
    const page: any = {
      refreshUrl: async () => {},
      evaluate: async (expression: string) => {
        if (String(expression).includes("const buttons =")) {
          return {
            liveDom: true,
            url: "https://example.test/pricing",
            title: "Pricing",
            buttons: [],
            links: [],
            inputs: [],
            selects: [],
            toggles: [{ text: "Pay monthly Pay annually Save 17%", selector: '[role="switch"]', type: "switch", inChrome: false }],
            sliders: [],
            tabs: [],
            accordions: [],
            forms: [],
            scrollHeight: 500,
            innerHeight: 900,
          };
        }
        if (String(expression).includes("scrollHeight")) return { sh: 500, ih: 900 };
        return "https://example.test/pricing";
      },
    };
    const plan = await discoverInteractionPlan(page, "https://example.test/pricing", pricingFeatures, new Set(), {
      multiTargetRun: true,
    });
    expect(plan.steps.some((s) => s.action === "toggle" && s.target === '[role="switch"]')).toBe(true);
    // Genuine transaction CTAs are still skipped.
    const destructivePage = { ...page, evaluate: async (expression: string) => {
      const base = await page.evaluate(expression);
      if (base && typeof base === "object" && Array.isArray((base as any).buttons)) {
        (base as any).toggles = [];
        (base as any).buttons = [{ text: "Pay now", selector: "#pay", inChrome: false, isSubmit: true }];
        (base as any).inputs = [{ type: "text", label: "Card", selector: "#card", required: true }];
      }
      return base;
    } };
    const destructivePlan = await discoverInteractionPlan(destructivePage, "https://example.test/pricing", [], new Set(), {
      multiTargetRun: true,
    });
    expect(destructivePlan.steps.some((s) => /Pay now/i.test(s.name))).toBe(false);
  });

  it("does not repeat route-matched source features across different routes", async () => {
    const dedupe = new Set<string>();
    const first = await discoverInteractionPlan(richPage("https://example.test/pricing"), "https://example.test/pricing", pricingFeatures, dedupe, { multiTargetRun: true });
    const careersFeatures: SourceFeature[] = [
      { id: "route-careers", kind: "route", label: "/careers", selector_hint: "", route_hint: "/careers", source: { path: "src/App.tsx", line: 20 } },
      { id: "input-email", kind: "input", label: "Email", selector_hint: "#email", route_hint: "/careers", source: { path: "src/pages/Careers.tsx", line: 5 } },
    ];
    const second = await discoverInteractionPlan(richPage("https://example.test/careers"), "https://example.test/careers", careersFeatures, dedupe, { multiTargetRun: true });
    const firstFeatureSteps = first.steps.filter((s) => s.name.startsWith("Source "));
    const secondFeatureSteps = second.steps.filter((s) => s.name.startsWith("Source "));
    expect(firstFeatureSteps.length).toBeGreaterThan(0);
    expect(secondFeatureSteps.length).toBe(0);
  });
});
