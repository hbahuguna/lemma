import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import { evaluateBrowserCheck, evaluateBrowserCheckAcrossViews, runBrowserChecks, type BrowserPageView } from "../src/index.js";

function makeCheck(id: string, title = id): Check {
  return {
    id,
    title,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "viewport metadata contract",
    expected: "metadata.viewport recorded",
    base_weight: 1,
    status: CheckStatus.PLANNED,
    weight: 1,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
  };
}

function baseView(overrides: Partial<BrowserPageView> = {}): BrowserPageView {
  return {
    navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
    snapshot: { title: "Example", bodyTextLength: 200, h1s: ["H1"] },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    evidenceRefs: { screenshot: "evidence/shot.png", console: "evidence/console.json", navigation: "evidence/nav.json" },
    label: "landing",
    ...overrides,
  };
}

describe("LEM-062 viewport and check metadata contracts", () => {
  it("attaches metadata.viewport to every evaluated browser check outcome from runBrowserChecks (injected views)", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    const checks = [
      makeCheck("browser.load"),
      makeCheck("browser.console"),
      makeCheck("browser.network"),
      makeCheck("browser.content"),
      makeCheck("browser.links"),
      makeCheck("browser.security"),
      makeCheck("browser.accessibility"),
      makeCheck("browser.overflow"),
      makeCheck("browser.focus_order"),
      makeCheck("browser.steps"),
      makeCheck("browser.unknown_custom"),
    ];
    await runBrowserChecks({
      url: "https://example.test/",
      checks,
      options: {
        viewport: "390x844",
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: baseView({ viewport: "390x844", snapshot: { title: "Example", bodyTextLength: 200, h1s: ["H1"], viewportWidth: 390, documentScrollWidth: 390, overflowingElements: [], positiveTabindex: 0, focusOrderMatchesDom: true } }),
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    for (const check of checks) {
      const out = outcomes.get(check.id);
      expect(out, `missing outcome for ${check.id}`).toBeTruthy();
      expect(out?.metadata?.viewport, `${check.id} viewport`).toBe("390x844");
    }
    // not implemented check still blocked but has viewport contract metadata
    expect(outcomes.get("browser.unknown_custom")?.status).toBe(CheckStatus.BLOCKED);
    expect(outcomes.get("browser.overflow")?.metadata?.viewport_width).toBe(390);
    expect(outcomes.get("browser.focus_order")?.metadata?.positive_tabindex_count).toBe(0);
  });

  it("preserves viewport and crawl metadata contracts on merged multi-route outcomes", async () => {
    const landing = baseView({
      label: "landing",
      viewport: "1440x900",
      navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
      snapshot: { title: "Home", bodyTextLength: 120, h1s: ["Home"] },
    });
    const route = baseView({
      label: "route-1-about",
      viewport: "1440x900",
      navigation: { url: "https://example.test/about", finalUrl: "https://example.test/about", status: 200 },
      snapshot: { title: "About", bodyTextLength: 120, h1s: ["About"] },
      evidenceRefs: { screenshot: "about-shot.png", navigation: "about-nav.json" },
    });
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: { viewport: "1440x900", crawl: true, maxPages: 5, playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }) },
      pageViews: [landing, route],
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    const load = outcomes.get("browser.load");
    expect(load?.metadata?.viewport).toBe("1440x900");
    expect(load?.metadata?.crawled).toBe(true);
    expect(load?.metadata?.page_count).toBe(2);
    expect(Array.isArray(load?.metadata?.routes)).toBe(true);
  });

  it("direct evaluators include viewport metadata when available from view", () => {
    const view = baseView({
      viewport: "1024x768",
      snapshot: { title: "T", bodyTextLength: 200, h1s: ["H"], viewportWidth: 1024, documentScrollWidth: 1024, overflowingElements: [], positiveTabindex: 0, focusOrderMatchesDom: true },
    });
    const load = evaluateBrowserCheck("browser.load", view);
    expect(load.metadata.viewport).toBe("1024x768");
    const overflow = evaluateBrowserCheck("browser.overflow", view);
    expect(overflow.metadata.viewport).toBe("1024x768");
    expect(overflow.metadata.viewport_width).toBe(1024);
    const focus = evaluateBrowserCheck("browser.focus_order", view);
    expect(focus.metadata.viewport).toBe("1024x768");

    const routeView: BrowserPageView = { ...view, label: "route-2", navigation: { url: "https://example.test/b", finalUrl: "https://example.test/b", status: 200 } };
    const merged = evaluateBrowserCheckAcrossViews(makeCheck("browser.load"), [view, routeView]);
    expect(merged.metadata.viewport).toBe("1024x768");
    expect(merged.metadata.crawled).toBe(true);
  });

  it("resolves viewport from options when input viewport not provided and records it on blocked outcomes", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: { viewport: { width: 800, height: 600 }, disabled: true },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.BLOCKED);
    expect(outcomes.get("browser.load")?.metadata?.viewport).toBe("800x600");
  });
});
