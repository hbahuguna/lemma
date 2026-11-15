import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import {
  DEFAULT_CRAWL_MAX_PAGES,
  DEFAULT_MOBILE_VIEWPORT,
  resolveActiveDefaults,
  resolveBrowserMaxPages,
  resolveBrowserViewport,
  resolveHeadless,
  resolveMobileEnabled,
  runBrowserChecks,
  type BrowserPageView,
} from "../src/index.js";

function makeCheck(id: string): Check {
  return {
    id,
    title: id,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "defaults",
    expected: "defaults",
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

function makeView(viewport = "1440x900"): BrowserPageView {
  return {
    navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
    snapshot: { title: "Example", bodyTextLength: 200, h1s: ["H1"] },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    evidenceRefs: { screenshot: "shot.png", navigation: "nav.json" },
    viewport,
  };
}

describe("LEM-063 browser defaults (crawl, mobile, headed, active)", () => {
  it("crawl defaults: disabled by default semantics, max pages defaults to 5 when crawl enabled and unset, explicit maxPages override", () => {
    expect(resolveBrowserMaxPages({})).toBe(1);
    expect(resolveBrowserMaxPages({ crawl: false })).toBe(1);
    expect(resolveBrowserMaxPages({ crawl: true })).toBe(DEFAULT_CRAWL_MAX_PAGES);
    expect(resolveBrowserMaxPages({ crawl: true, maxPages: 3 })).toBe(3);
    expect(resolveBrowserMaxPages({ crawl: true, max_pages: 2 })).toBe(2);
    expect(resolveBrowserMaxPages({ crawl: true, maxPages: 0 })).toBe(1);
  });

  it("mobile defaults: mobile mode defaults viewport to 390x844 unless explicit viewport provided; mobileViewport/explicit viewport override", () => {
    expect(resolveMobileEnabled({ mobile: true })).toBe(true);
    expect(resolveMobileEnabled({ mobilePack: true })).toBe(true);
    expect(resolveBrowserViewport({ mobile: true })).toEqual({ width: 390, height: 844, label: DEFAULT_MOBILE_VIEWPORT });
    expect(resolveBrowserViewport({ mobile: true, mobileViewport: "360x800" })).toEqual({ width: 360, height: 800, label: "360x800" });
    expect(resolveBrowserViewport({ mobile: true, mobile_viewport: { width: 412, height: 915 } })).toEqual({ width: 412, height: 915, label: "412x915" });
    expect(resolveBrowserViewport({ mobile: true, viewport: "1024x768" })).toEqual({ width: 1024, height: 768, label: "1024x768" });
    expect(resolveBrowserViewport({})).toEqual({ width: 1440, height: 900, label: "1440x900" });
  });

  it("headed defaults: headless by default, headed requests visible browser, explicit headless true forces headless", () => {
    expect(resolveHeadless({})).toBe(true);
    expect(resolveHeadless({ headless: false })).toBe(false);
    expect(resolveHeadless({ headed: true })).toBe(false);
    expect(resolveHeadless({ headed: true, headless: false })).toBe(false);
    expect(resolveHeadless({ headed: true, headless: true })).toBe(true);
  });

  it("active defaults: active false and activeInteractions true by default, options normalized without breaking runs", async () => {
    expect(resolveActiveDefaults({})).toEqual({ active: false, activeInteractions: true });
    expect(resolveActiveDefaults({ active: true })).toEqual({ active: true, activeInteractions: true });
    expect(resolveActiveDefaults({ active: true, activeInteractions: false })).toEqual({ active: true, activeInteractions: false });
    expect(resolveActiveDefaults({ active_interactions: false })).toEqual({ active: false, activeInteractions: false });

    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: {
        active: false,
        activeInteractions: true,
        crawl: false,
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: makeView(),
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.PASSED);
  });

  it("applies resolved mobile/headed/viewport defaults to Playwright capture context and records metadata.viewport", async () => {
    let launchOpts: Record<string, unknown> | undefined;
    let contextOpts: Record<string, unknown> | undefined;

    const fakePage = {
      on() {},
      goto: () => Promise.resolve({ status: () => 200, url: () => "https://example.test/", headers: () => ({}) }),
      url: () => "https://example.test/",
      screenshot: () => Promise.resolve(Buffer.from("x")),
      content: () => Promise.resolve("<html><head><title>T</title></head><body><h1>H</h1><p>content</p></body></html>"),
      evaluate: () => Promise.resolve({ title: "T", bodyTextLength: 200, h1s: ["H"], viewportWidth: 390, viewportHeight: 844, documentScrollWidth: 390, overflowingElements: [], focusOrderMatchesDom: true, positiveTabindex: 0 }),
      context: () => ({ cookies: () => Promise.resolve([]) }),
    };
    const fakeContext = {
      newPage: () => Promise.resolve(fakePage),
      close: () => Promise.resolve(),
      tracing: { start: () => Promise.resolve(), stop: () => Promise.resolve() },
    };
    const fakeBrowser = {
      newContext: (opts?: Record<string, unknown>) => {
        contextOpts = opts;
        return Promise.resolve(fakeContext);
      },
      close: () => Promise.resolve(),
    };
    const playwright = {
      chromium: {
        launch: (opts?: Record<string, unknown>) => {
          launchOpts = opts;
          return Promise.resolve(fakeBrowser);
        },
      },
    };

    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: { mobile: true, headed: true, playwrightLoader: () => Promise.resolve(playwright) },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    expect(launchOpts?.headless).toBe(false);
    const viewport = contextOpts?.viewport as { width?: unknown; height?: unknown } | undefined;
    expect(viewport?.width).toBe(390);
    expect(viewport?.height).toBe(844);
    expect(contextOpts?.isMobile).toBe(true);
    expect(contextOpts?.hasTouch).toBe(true);
    expect(outcomes.get("browser.load")?.metadata?.viewport).toBe("390x844");
  });
});
