import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import {
  discoverRoutes,
  evaluateBrowserCheckAcrossViews,
  runBrowserChecks,
  type BrowserPageView,
} from "../src/index.js";

function makeCheck(id: string, title = id): Check {
  return {
    id,
    title,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "test",
    expected: "test",
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

function makeView(url: string, overrides: Partial<BrowserPageView> = {}): BrowserPageView {
  return {
    navigation: { url, finalUrl: url, status: 200, headers: {}, error: undefined },
    snapshot: { title: "OK", bodyTextLength: 100, h1s: ["H"], links: [] },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    evidenceRefs: { screenshot: `${url}-shot.png`, navigation: `${url}-nav.json` },
    label: "landing",
    ...overrides,
  };
}

describe("LEM-054 bounded same-origin route discovery", () => {
  it("returns at most maxPages-1 routes, normalized, same-origin only, deduped, excluding seed/unsafe/asset links", () => {
    const seed = "https://example.test/start?ref=1#hero";
    const snapshot = {
      links: [
        { href: "/page-a", selector: "a1" },
        { href: "/page-a#section", selector: "a1b" }, // dup after fragment strip
        { href: "https://example.test/page-b?x=1", selector: "a2" },
        { href: "https://other.test/page-c", selector: "ext" }, // external
        { href: "mailto:a@example.test", selector: "m" },
        { href: "tel:+123", selector: "t" },
        { href: "javascript:void(0)", selector: "j" },
        { href: "data:text/plain,hi", selector: "d" },
        { href: "blob:https://example.test/x", selector: "b" },
        { href: "#local", selector: "frag" },
        { href: "", selector: "empty" },
        { href: "/download.pdf", selector: "pdf" },
        { href: "/image.PNG", selector: "img" },
        { href: "/bundle.js", selector: "js" },
        { href: "/style.css", selector: "css" },
        { href: "/logout", selector: "logout" },
        { href: "/account/sign-out", selector: "signout" },
        { href: "/item/delete", selector: "del" },
        { href: "/api/users", selector: "api" },
        { href: "/file", selector: "dl", download: true },
        { href: "/page-c", selector: "a3" },
        { href: "/page-d", selector: "a4" }, // beyond limit
      ],
    };

    const routes = discoverRoutes(seed, snapshot, 4);
    expect(routes).toEqual([
      "https://example.test/page-a",
      "https://example.test/page-b?x=1",
      "https://example.test/page-c",
    ]);
    // seed normalized not included
    expect(routes).not.toContain("https://example.test/start?ref=1");
  });

  it("returns empty when maxPages <= 1 or seed is not http(s)", () => {
    const snapshot = { links: [{ href: "/a" }] };
    expect(discoverRoutes("https://example.test", snapshot, 1)).toEqual([]);
    expect(discoverRoutes("https://example.test", snapshot, 0)).toEqual([]);
    expect(discoverRoutes("file:///tmp/a.html", snapshot, 5)).toEqual([]);
  });
});

describe("LEM-054 multi-route merged evaluation", () => {
  it("evaluates browser.load across routes and merges findings/metadata including a crawled 404 route", () => {
    const landing = makeView("https://example.test/", {
      label: "landing",
      navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200, headers: {} },
      snapshot: { title: "Home", bodyTextLength: 120, h1s: ["Home"], links: [] },
      evidenceRefs: { screenshot: "landing.png", navigation: "landing-nav.json", snapshot: "landing-snap.json" },
    });
    const missing = makeView("https://example.test/missing", {
      label: "route-1-missing",
      navigation: { url: "https://example.test/missing", finalUrl: "https://example.test/missing", status: 404, headers: {} },
      snapshot: { title: "Not found", bodyTextLength: 10, h1s: [], links: [] },
      evidenceRefs: { screenshot: "missing.png", navigation: "missing-nav.json", snapshot: "missing-snap.json" },
    });

    const outcome = evaluateBrowserCheckAcrossViews(makeCheck("browser.load", "Page load"), [landing, missing]);
    expect(outcome.status).toBe(CheckStatus.FAILED);
    expect(outcome.metadata.crawled).toBe(true);
    expect(outcome.metadata.page_count).toBe(2);
    expect(Array.isArray(outcome.metadata.routes)).toBe(true);
    expect((outcome.metadata.routes as unknown[]).length).toBe(2);
    expect(outcome.actual).toMatch(/2 route\(s\):/);
    expect(outcome.actual).toContain("failed");
    expect(outcome.findings.some((f) => /404/.test(f.title) || /Page load/i.test(f.title))).toBe(true);
    expect(outcome.evidence).toContain("landing.png");
    expect(outcome.evidence).toContain("missing.png");
  });

  it("keeps browser.load evaluable on navigation-failed route while skipping other checks and reporting routes_not_evaluated", () => {
    const landing = makeView("https://example.test/", {
      label: "landing",
      navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200, headers: {} },
      snapshot: { title: "Home", bodyTextLength: 120, h1s: ["Home"], links: [] },
      consoleMessages: [],
    });
    const failed = makeView("https://example.test/broken", {
      label: "route-1-broken",
      navigation: { url: "https://example.test/broken", finalUrl: "https://example.test/broken", error: "net::ERR_CONNECTION_REFUSED" },
      snapshot: {},
      consoleMessages: [],
    });

    const load = evaluateBrowserCheckAcrossViews(makeCheck("browser.load", "Page load"), [landing, failed]);
    expect(load.status).toBe(CheckStatus.FAILED);
    expect(load.metadata.crawled).toBe(true);
    expect(load.metadata.page_count).toBe(2);

    const consoleOutcome = evaluateBrowserCheckAcrossViews(makeCheck("browser.console", "Console"), [landing, failed]);
    // landing passes, failed route not evaluable for non-load -> merged over landing only but reports unevaluated
    expect(consoleOutcome.status).toBe(CheckStatus.PASSED);
    expect(consoleOutcome.metadata.routes_not_evaluated).toEqual(["https://example.test/broken"]);
    expect(consoleOutcome.metadata.crawled).toBe(true);
  });
});

describe("LEM-054 runBrowserChecks crawl integration (injected views)", () => {
  it("evaluates checks across injected crawled views and emits merged outcomes", async () => {
    const landing = makeView("https://example.test/", {
      label: "landing",
      navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200, headers: {} },
      snapshot: { title: "Home", bodyTextLength: 120, h1s: ["Home"], links: [{ href: "/missing" }] },
    });
    const missing = makeView("https://example.test/missing", {
      label: "route-1-missing",
      navigation: { url: "https://example.test/missing", finalUrl: "https://example.test/missing", status: 404, headers: {} },
      snapshot: { title: "Missing", bodyTextLength: 5, h1s: [], links: [] },
    });
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load", "Page load"), makeCheck("browser.console", "Console"), makeCheck("browser.steps")],
      options: {
        crawl: true,
        maxPages: 5,
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageViews: [landing, missing],
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    const load = outcomes.get("browser.load");
    expect(load?.status).toBe(CheckStatus.FAILED);
    expect(load?.metadata.crawled).toBe(true);
    expect(load?.metadata.page_count).toBe(2);

    const consoleOut = outcomes.get("browser.console");
    expect(consoleOut?.status).toBe(CheckStatus.PASSED);
    expect(consoleOut?.metadata.crawled).toBe(true);

    const unsupported = outcomes.get("browser.steps");
    expect(unsupported?.status).toBe(CheckStatus.BLOCKED);
    expect(String(unsupported?.metadata?.not_implemented)).toBe("true");
  });
});
