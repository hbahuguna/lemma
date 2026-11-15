import { describe, expect, it } from "vitest";

import { CheckStatus, Severity, type Check, type CheckOutcome } from "@lemma/core";
import {
  discoverRoutes,
  evaluateBrowserCheck,
  evaluateBrowserCheckAcrossViews,
  runBrowserChecks,
  type BrowserPageView,
} from "../src/index.js";

function makeCheck(id: string, domain = "functional", persona = domain): Check {
  return {
    id,
    title: id,
    domain,
    persona,
    kind: "browser",
    intent: "regression",
    expected: "regression contract",
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

const evidenceRefs = {
  screenshot: "evidence/shot.png",
  headers: "evidence/headers.json",
  console: "evidence/console.json",
  network: "evidence/network.json",
  snapshot: "evidence/snapshot.json",
  cookies: "evidence/cookies.json",
  navigation: "evidence/navigation.json",
};

function baseView(overrides: Partial<BrowserPageView> = {}): BrowserPageView {
  return {
    navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
    snapshot: {
      title: "Example Home",
      bodyTextLength: 140,
      h1s: ["Welcome"],
      links: [
        { selector: "a.nav", href: "/about", target: "", rel: "" },
        { selector: "a.docs", href: "https://docs.example.test/page", target: "", rel: "" },
      ],
    },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [
      { url: "https://example.test/", status: 200, failed: false, method: "GET" },
      { url: "https://example.test/app.js", status: 200, failed: false, method: "GET" },
    ],
    cookies: [],
    evidenceRefs,
    label: "landing",
    viewport: "1440x900",
    ...overrides,
  };
}

const dummyPlaywright = {
  chromium: {
    launch: () => Promise.resolve({ newContext: () => Promise.resolve({}), close: () => Promise.resolve() }),
  },
};

describe("LEM-064 browser regression suite", () => {
  describe("LEM-051 core browser checks", () => {
    it("regresses load/console/network/content/links pass and representative failure outcomes", () => {
      const okView = baseView();
      expect(evaluateBrowserCheck("browser.load", okView).status).toBe(CheckStatus.PASSED);
      expect(evaluateBrowserCheck("browser.console", okView).status).toBe(CheckStatus.PASSED);
      expect(evaluateBrowserCheck("browser.network", okView).status).toBe(CheckStatus.PASSED);
      expect(evaluateBrowserCheck("browser.content", okView).status).toBe(CheckStatus.PASSED);
      expect(evaluateBrowserCheck("browser.links", okView).status).toBe(CheckStatus.PASSED);

      const navBlockedForNonLoad = evaluateBrowserCheck(
        "browser.console",
        baseView({
          navigation: { url: "https://bad.test/", finalUrl: "https://bad.test/", error: "net::ERR_NAME_NOT_RESOLVED" },
          snapshot: { title: "", bodyTextLength: 0, h1s: [], links: [] },
        }),
      );
      expect(navBlockedForNonLoad.status).toBe(CheckStatus.BLOCKED);

      const consoleFail = evaluateBrowserCheck(
        "browser.console",
        baseView({ consoleMessages: [{ type: "error", text: "boom" }], pageErrors: [{ text: "ReferenceError" }] }),
      );
      expect(consoleFail.status).toBe(CheckStatus.FAILED);
      expect(consoleFail.findings.length).toBeGreaterThan(0);

      const networkFail = evaluateBrowserCheck(
        "browser.network",
        baseView({
          networkEntries: [
            { url: "https://example.test/api", status: 500, failed: false, method: "GET" },
            { url: "https://example.test/missing.js", status: 404, failed: false, method: "GET" },
          ],
        }),
      );
      expect(networkFail.status).toBe(CheckStatus.FAILED);
      expect(networkFail.findings.some((f) => f.severity === Severity.HIGH)).toBe(true);

      const contentFail = evaluateBrowserCheck(
        "browser.content",
        baseView({ snapshot: { title: "Hi", bodyTextLength: 40, h1s: ["A", "B"], links: [] } }),
      );
      expect(contentFail.status).toBe(CheckStatus.FAILED);

      const linksFail = evaluateBrowserCheck(
        "browser.links",
        baseView({
          navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
          snapshot: {
            title: "T",
            bodyTextLength: 30,
            h1s: ["H"],
            links: [
              { selector: "a.empty", href: "#", target: "", rel: "" },
              { selector: "a.insecure", href: "http://evil.test/x", target: "", rel: "" },
              { selector: "a.blank", href: "https://other.test/", target: "_blank", rel: "" },
            ],
          },
        }),
      );
      expect(linksFail.status).toBe(CheckStatus.FAILED);
      expect(linksFail.findings.some((f) => f.domain === "security" || f.domain === "content")).toBe(true);
    });

    it("regresses runtime-integrated injected evaluation and evidence/viewport metadata linkage", async () => {
      const outcomes = new Map<string, CheckOutcome>();
      await runBrowserChecks({
        url: "https://example.test/",
        checks: [makeCheck("browser.load"), makeCheck("browser.content"), makeCheck("browser.unsupported_custom")],
        options: { playwrightLoader: () => Promise.resolve(dummyPlaywright), viewport: "1440x900" },
        pageView: baseView(),
        onOutcome: (c, o) => outcomes.set(c.id, o),
      });

      const load = outcomes.get("browser.load");
      expect(load?.status).toBe(CheckStatus.PASSED);
      expect(load?.metadata?.viewport).toBe("1440x900");
      expect((load?.evidence ?? []).length).toBeGreaterThan(0);

      expect(outcomes.get("browser.content")?.status).toBe(CheckStatus.PASSED);

      const unsupported = outcomes.get("browser.unsupported_custom");
      expect(unsupported?.status).toBe(CheckStatus.BLOCKED);
      expect(unsupported?.findings ?? []).toEqual([]);
      expect(unsupported?.metadata?.viewport).toBe("1440x900");
    });
  });

  describe("LEM-054 crawl regression", () => {
    it("regresses deterministic bounded same-origin route discovery", () => {
      const seed = "https://example.test/start";
      const snapshot = {
        links: [
          { href: "/about" },
          { href: "https://example.test/about#team" },
          { href: "https://other.test/x" },
          { href: "/pricing?plan=pro" },
          { href: "/pricing?plan=basic" },
          { href: "/api/data" },
          { href: "/logout" },
          { href: "/file.pdf" },
          { href: "mailto:test@example.test" },
          { href: "javascript:void(0)" },
          { href: "/contact" },
        ],
      };
      const routes = discoverRoutes(seed, snapshot, 4);
      expect(routes.length).toBeLessThanOrEqual(3);
      expect(routes).toContain("https://example.test/about");
      expect(routes.some((r) => r.startsWith("https://example.test/pricing"))).toBe(true);
      expect(routes.every((r) => r.startsWith("https://example.test/"))).toBe(true);
      expect(routes.some((r) => r.includes("/api/") || r.includes("logout") || r.endsWith(".pdf"))).toBe(false);
    });

    it("regresses multi-route merge metadata and route aggregation/failure handling", async () => {
      const landing = baseView({ label: "landing", navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 } });
      const about = baseView({
        label: "route-1-about",
        viewport: "1440x900",
        navigation: { url: "https://example.test/about", finalUrl: "https://example.test/about", status: 200 },
        snapshot: { title: "About", bodyTextLength: 120, h1s: ["About"], links: [] },
        evidenceRefs: { ...evidenceRefs, screenshot: "evidence/about-shot.png", navigation: "evidence/about-nav.json" },
      });
      const broken = baseView({
        label: "route-2-broken",
        viewport: "1440x900",
        navigation: { url: "https://example.test/broken", finalUrl: "https://example.test/broken", error: "net::ERR_FAILED" },
        snapshot: { title: "", bodyTextLength: 0, h1s: [], links: [] },
        evidenceRefs: { ...evidenceRefs, screenshot: "evidence/broken-shot.png", navigation: "evidence/broken-nav.json" },
      });

      const outcomes = new Map<string, CheckOutcome>();
      await runBrowserChecks({
        url: "https://example.test/",
        checks: [makeCheck("browser.load"), makeCheck("browser.console")],
        options: { crawl: true, maxPages: 5, viewport: "1440x900", playwrightLoader: () => Promise.resolve(dummyPlaywright) },
        pageViews: [landing, about, broken],
        onOutcome: (c, o) => outcomes.set(c.id, o),
      });

      const load = outcomes.get("browser.load");
      expect(load?.status).toBe(CheckStatus.FAILED);
      expect(load?.metadata?.crawled).toBe(true);
      expect(load?.metadata?.page_count).toBe(3);
      expect(Array.isArray(load?.metadata?.routes)).toBe(true);
      expect(load?.metadata?.viewport).toBe("1440x900");
      expect((load?.evidence ?? []).some((p) => p.includes("broken-shot.png"))).toBe(true);

      const consoleOut = outcomes.get("browser.console");
      expect(consoleOut?.metadata?.crawled).toBe(true);
      expect(Array.isArray(consoleOut?.metadata?.routes_not_evaluated)).toBe(true);

      const directMerged = evaluateBrowserCheckAcrossViews(makeCheck("browser.load"), [landing, about]);
      expect(directMerged.status).toBe(CheckStatus.PASSED);
      expect(directMerged.metadata.crawled).toBe(true);
      expect(directMerged.metadata.page_count).toBe(2);
    });
  });

  describe("LEM-055 responsive/mobile pack regression", () => {
    it("regresses browser.overflow pass/fail with viewport metadata contracts", () => {
      const pass = evaluateBrowserCheck(
        "browser.overflow",
        baseView({
          viewport: "390x844",
          snapshot: { title: "M", bodyTextLength: 100, h1s: ["M"], viewportWidth: 390, documentScrollWidth: 390, overflowingElements: [] },
        }),
      );
      expect(pass.status).toBe(CheckStatus.PASSED);
      expect(pass.metadata.viewport).toBe("390x844");
      expect(pass.metadata.viewport_width).toBe(390);
      expect(pass.metadata.scroll_width).toBe(390);

      const fail = evaluateBrowserCheck(
        "browser.overflow",
        baseView({
          viewport: "390x844",
          snapshot: {
            title: "M",
            bodyTextLength: 100,
            h1s: ["M"],
            viewportWidth: 390,
            documentScrollWidth: 520,
            overflowingElements: [{ selector: "div.hero", right: 520, width: 520 }],
          },
        }),
      );
      expect(fail.status).toBe(CheckStatus.FAILED);
      expect(fail.metadata.viewport).toBe("390x844");
      expect(fail.metadata.viewport_width).toBe(390);
      expect(fail.metadata.scroll_width).toBe(520);
      expect(fail.metadata.offending_element).toBeTruthy();
    });

    it("regresses browser.focus_order pass/fail with focus metadata contracts", async () => {
      const pass = evaluateBrowserCheck(
        "browser.focus_order",
        baseView({
          viewport: "390x844",
          snapshot: { title: "M", bodyTextLength: 100, h1s: ["M"], positiveTabindex: 0, focusOrderMatchesDom: true },
        }),
      );
      expect(pass.status).toBe(CheckStatus.PASSED);
      expect(pass.metadata.viewport).toBe("390x844");
      expect(pass.metadata.positive_tabindex_count).toBe(0);

      const fail = evaluateBrowserCheck(
        "browser.focus_order",
        baseView({
          viewport: "390x844",
          snapshot: { title: "M", bodyTextLength: 100, h1s: ["M"], positiveTabindex: 2, focusOrderMatchesDom: false },
        }),
      );
      expect(fail.status).toBe(CheckStatus.FAILED);
      expect(fail.metadata.viewport).toBe("390x844");
      expect(fail.metadata.positive_tabindex_count).toBe(2);

      const outcomes = new Map<string, CheckOutcome>();
      await runBrowserChecks({
        url: "https://example.test/",
        checks: [makeCheck("browser.overflow", "accessibility", "accessibility"), makeCheck("browser.focus_order", "accessibility", "accessibility")],
        options: { playwrightLoader: () => Promise.resolve(dummyPlaywright), viewport: "390x844" },
        pageView: baseView({
          viewport: "390x844",
          snapshot: { title: "M", bodyTextLength: 100, h1s: ["M"], viewportWidth: 390, documentScrollWidth: 390, overflowingElements: [], positiveTabindex: 0, focusOrderMatchesDom: true },
        }),
        onOutcome: (c, o) => outcomes.set(c.id, o),
      });
      expect(outcomes.get("browser.overflow")?.status).toBe(CheckStatus.PASSED);
      expect(outcomes.get("browser.focus_order")?.status).toBe(CheckStatus.PASSED);
      expect(outcomes.get("browser.overflow")?.metadata?.viewport).toBe("390x844");
    });
  });

  describe("LEM-058 scenarios/browser.steps regression", () => {
    it("regresses deterministic browser.steps outcomes (pass/fail/blocked) without live browser execution", async () => {
      const outcomes = new Map<string, CheckOutcome>();
      const baseInput = {
        url: "https://example.test/",
        checks: [makeCheck("browser.steps")],
        pageView: baseView(),
        options: { playwrightLoader: () => Promise.resolve(dummyPlaywright) },
        onOutcome: (c: Check, o: CheckOutcome) => outcomes.set(c.id, o),
      };

      await runBrowserChecks({
        ...baseInput,
        options: {
          ...baseInput.options,
          scenarioExecution: {
            title: "ok",
            target_url: "https://example.test/",
            passed: true,
            total_steps: 2,
            passed_steps: 2,
            failed_steps: 0,
            skipped_steps: 0,
            duration_ms: 5,
            results: [],
            evidence_refs: { scenario_results: "evidence/scenario-results.json" },
            error: "",
          },
        },
      });
      expect(outcomes.get("browser.steps")?.status).toBe(CheckStatus.PASSED);
      expect(outcomes.get("browser.steps")?.evidence).toContain("evidence/scenario-results.json");
      expect(outcomes.get("browser.steps")?.metadata?.viewport).toBe("1440x900");

      outcomes.clear();
      await runBrowserChecks({
        ...baseInput,
        options: {
          ...baseInput.options,
          scenarioExecution: {
            title: "bad",
            target_url: "https://example.test/",
            passed: false,
            total_steps: 2,
            passed_steps: 1,
            failed_steps: 1,
            skipped_steps: 0,
            duration_ms: 5,
            results: [],
            evidence_refs: { scenario_results: "evidence/scenario-fail.json" },
            error: "Step 2 failed",
          },
        },
      });
      expect(outcomes.get("browser.steps")?.status).toBe(CheckStatus.FAILED);
      expect((outcomes.get("browser.steps")?.evidence ?? []).length).toBeGreaterThan(0);

      outcomes.clear();
      await runBrowserChecks({
        url: "https://example.test/",
        checks: [makeCheck("browser.steps")],
        options: { disabled: true },
        onOutcome: (c, o) => outcomes.set(c.id, o),
      });
      expect(outcomes.get("browser.steps")?.status).toBe(CheckStatus.BLOCKED);
      expect(outcomes.get("browser.steps")?.findings ?? []).toEqual([]);
    });
  });
});
