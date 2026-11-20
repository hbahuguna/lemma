import { describe, expect, it } from "vitest";

import { CheckStatus, Severity, type Check, type CheckOutcome } from "@lemma/core";
import {
  evaluateBrowserCheck,
  runBrowserChecks,
  type BrowserPageView,
} from "../src/index.js";

function check(id: string, title = id): Check {
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
      bodyTextLength: 120,
      h1s: ["Welcome"],
      links: [
        { selector: "a.nav", href: "/about", target: "", rel: "" },
        { selector: "a.docs", href: "https://docs.example.test/", target: "", rel: "" },
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
    ...overrides,
  };
}

describe("LEM-051 browser check evaluators", () => {
  it("browser.load passes on healthy navigation and fails on navigation/HTTP/title/content issues", () => {
    const ok = evaluateBrowserCheck("browser.load", baseView());
    expect(ok.status).toBe(CheckStatus.PASSED);
    expect(ok.findings).toEqual([]);
    expect(ok.actual).toContain("HTTP 200");
    expect(ok.actual).toContain('title "Example Home"');
    expect(ok.actual).toContain("visible text length 120");
    expect(ok.evidence).toContain(evidenceRefs.screenshot);

    const navError = evaluateBrowserCheck(
      "browser.load",
      baseView({
        navigation: { url: "https://bad.test/", finalUrl: "https://bad.test/", error: "net::ERR_NAME_NOT_RESOLVED" },
        snapshot: { title: "", bodyTextLength: 0, h1s: [], links: [] },
      }),
    );
    expect(navError.status).toBe(CheckStatus.FAILED);
    expect(navError.actual).toContain("Navigation failed");
    expect(navError.findings.some((f) => f.title === "The live target could not be loaded")).toBe(true);
    expect(navError.findings[0]?.domain).toBe("functional");
    expect(navError.findings[0]?.severity).toBe(Severity.HIGH);
    expect(navError.findings[0]?.tags).toContain("navigation");

    const degraded = evaluateBrowserCheck(
      "browser.load",
      baseView({
        navigation: { url: "https://x.test/", finalUrl: "https://x.test/", status: 503 },
        snapshot: { title: "", bodyTextLength: 5, h1s: [], links: [] },
      }),
    );
    expect(degraded.status).toBe(CheckStatus.FAILED);
    expect(degraded.findings.some((f) => f.title === "The live target returned HTTP 503" && f.severity === Severity.HIGH)).toBe(true);
    expect(degraded.findings.some((f) => f.title === "The rendered page has no title")).toBe(true);
    expect(degraded.findings.some((f) => f.title === "The rendered page has little or no visible content")).toBe(true);
  });

  it("browser.console reports console and page errors", () => {
    const ok = evaluateBrowserCheck("browser.console", baseView());
    expect(ok.status).toBe(CheckStatus.PASSED);
    expect(ok.actual).toBe("No console errors or unhandled page errors were observed.");

    const failed = evaluateBrowserCheck(
      "browser.console",
      baseView({
        consoleMessages: [
          { type: "error", text: "TypeError: cannot read properties of undefined" },
          { type: "log", text: "ignored" },
        ],
        pageErrors: [{ text: "ReferenceError: boom is not defined" }],
      }),
    );
    expect(failed.status).toBe(CheckStatus.FAILED);
    expect(failed.actual).toBe("2 actionable console/page error(s) observed.");
    expect(failed.findings.length).toBe(2);
    expect(failed.findings[0]?.title).toContain("Runtime console error");
    expect(failed.findings[0]?.domain).toBe("reliability");
    expect(failed.findings[0]?.strength).toBe("observed");
    expect(failed.findings[0]?.tags).toEqual(["console", "runtime"]);
  });

  it("browser.network filters favicon 404 and aborted requests and reports failures", () => {
    const ok = evaluateBrowserCheck(
      "browser.network",
      baseView({
        networkEntries: [
          { url: "https://example.test/", status: 200, failed: false, method: "GET" },
          { url: "https://example.test/favicon.ico", status: 404, failed: false, method: "GET" },
          { url: "https://example.test/old.js", status: null, failed: true, failure: "net::ERR_ABORTED", method: "GET" },
        ],
      }),
    );
    expect(ok.status).toBe(CheckStatus.PASSED);
    expect(ok.actual).toBe("3 request(s); no failed or unexpected 4xx/5xx responses.");

    const failed = evaluateBrowserCheck(
      "browser.network",
      baseView({
        networkEntries: [
          { url: "https://example.test/api/data", status: 500, failed: false, method: "GET" },
          { url: "https://example.test/app.js", status: 404, failed: false, method: "GET" },
          { url: "https://example.test/ws", status: null, failed: true, failure: "net::ERR_FAILED", method: "GET" },
        ],
      }),
    );
    expect(failed.status).toBe(CheckStatus.FAILED);
    expect(failed.actual).toBe("3 request(s); 3 failed or non-success response(s).");
    expect(failed.findings.length).toBe(3);
    expect(failed.findings.find((f) => f.title.includes("/api/data"))?.severity).toBe(Severity.HIGH);
    expect(failed.findings.find((f) => f.title.includes("/app.js"))?.severity).toBe(Severity.MEDIUM);
    expect(failed.findings.find((f) => f.title.includes("/ws"))?.severity).toBe(Severity.HIGH);
  });

  it("classifies third-party telemetry and intentional fixture errors as non-blocking evidence", () => {
    const telemetryUrl = "https://298279967.log.optimizely.com/event?a=298279967";
    const network = evaluateBrowserCheck(
      "browser.network",
      baseView({
        navigation: { url: "https://the-internet.herokuapp.com/abtest", finalUrl: "https://the-internet.herokuapp.com/abtest", status: 200 },
        networkEntries: [
          { url: "https://the-internet.herokuapp.com/abtest", status: 200, failed: false, method: "GET" },
          { url: telemetryUrl, status: null, failed: true, failure: "net::ERR_NAME_NOT_RESOLVED", method: "GET" },
        ],
      }),
    );
    expect(network.status).toBe(CheckStatus.PASSED);
    expect(network.findings).toEqual([]);
    expect(network.metadata.classified_non_blocking).toEqual([
      expect.objectContaining({ kind: "third_party_telemetry" }),
    ]);

    const consoleTelemetry = evaluateBrowserCheck(
      "browser.console",
      baseView({
        navigation: { url: "https://the-internet.herokuapp.com/abtest", finalUrl: "https://the-internet.herokuapp.com/abtest", status: 200 },
        consoleMessages: [{ type: "error", text: "Failed to load resource: net::ERR_NAME_NOT_RESOLVED", url: telemetryUrl }],
      }),
    );
    expect(consoleTelemetry.status).toBe(CheckStatus.PASSED);
    expect(consoleTelemetry.findings).toEqual([]);

    const favicon404 = evaluateBrowserCheck(
      "browser.console",
      baseView({
        consoleMessages: [{ type: "error", text: "Failed to load resource: the server responded with a status of 404 ()", url: "https://the-internet.herokuapp.com/favicon.ico" }],
      }),
    );
    expect(favicon404.status).toBe(CheckStatus.PASSED);
    expect(favicon404.findings).toEqual([]);
    expect(favicon404.metadata.classified_non_blocking).toEqual([
      expect.objectContaining({ kind: "non_blocking_asset" }),
    ]);

    const brokenImages = evaluateBrowserCheck(
      "browser.network",
      baseView({
        navigation: { url: "https://the-internet.herokuapp.com/broken_images", finalUrl: "https://the-internet.herokuapp.com/broken_images", status: 200 },
        networkEntries: [{ url: "https://the-internet.herokuapp.com/img/asdf.jpg", status: 404, failed: false, method: "GET" }],
      }),
    );
    expect(brokenImages.status).toBe(CheckStatus.PASSED);
    expect(brokenImages.findings).toEqual([]);

    const brokenImageConsole = evaluateBrowserCheck(
      "browser.console",
      baseView({
        navigation: { url: "https://the-internet.herokuapp.com/broken_images", finalUrl: "https://the-internet.herokuapp.com/broken_images", status: 200 },
        consoleMessages: [{ type: "error", text: "Failed to load resource: the server responded with a status of 404 ()", url: "https://the-internet.herokuapp.com/hjkl.jpg" }],
      }),
    );
    expect(brokenImageConsole.status).toBe(CheckStatus.PASSED);
    expect(brokenImageConsole.findings).toEqual([]);
    expect(brokenImageConsole.metadata.classified_non_blocking).toEqual([
      expect.objectContaining({ kind: "intentional_fixture" }),
    ]);

    const authChallenge = evaluateBrowserCheck(
      "browser.load",
      baseView({
        navigation: { url: "https://the-internet.herokuapp.com/basic_auth", finalUrl: "https://the-internet.herokuapp.com/basic_auth", status: 401 },
      }),
    );
    expect(authChallenge.status).toBe(CheckStatus.PASSED);
    expect(authChallenge.findings).toEqual([]);
    expect(authChallenge.metadata.classified_non_blocking).toEqual([
      expect.objectContaining({ kind: "intentional_fixture" }),
    ]);

    const realFailure = evaluateBrowserCheck(
      "browser.network",
      baseView({
        networkEntries: [{ url: "https://example.test/api/cart", status: 500, failed: false, method: "GET" }],
      }),
    );
    expect(realFailure.status).toBe(CheckStatus.FAILED);
    expect(realFailure.findings).toHaveLength(1);
  });

  it("browser.content checks heading and title structure", () => {
    const ok = evaluateBrowserCheck("browser.content", baseView());
    expect(ok.status).toBe(CheckStatus.PASSED);
    expect(ok.actual).toBe("h1 count: 1; title length: 12; text length: 120");

    const bad = evaluateBrowserCheck(
      "browser.content",
      baseView({
        snapshot: { title: "Hi", bodyTextLength: 40, h1s: ["One", "Two"], links: [] },
      }),
    );
    expect(bad.status).toBe(CheckStatus.FAILED);
    expect(bad.findings.some((f) => f.title === "The page has 2 primary heading(s) instead of one")).toBe(true);
    expect(bad.findings.some((f) => f.title === "The page title is outside a useful length range")).toBe(true);
    expect(bad.findings[0]?.domain).toBe("content");
  });

  it("browser.links detects placeholder, insecure, and unsafe-target links", () => {
    const ok = evaluateBrowserCheck("browser.links", baseView());
    expect(ok.status).toBe(CheckStatus.PASSED);

    const bad = evaluateBrowserCheck(
      "browser.links",
      baseView({
        navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
        snapshot: {
          title: "T",
          bodyTextLength: 30,
          h1s: ["H"],
          links: [
            { selector: "a.empty", href: "#", target: "", rel: "" },
            { selector: "a.js", href: "javascript:void(0)", target: "", rel: "" },
            { selector: "a.insecure", href: "http://evil.test/x", target: "", rel: "" },
            { selector: "a.blank", href: "https://other.test/", target: "_blank", rel: "" },
            { selector: "a.safe", href: "https://other.test/", target: "_blank", rel: "noopener noreferrer" },
          ],
        },
      }),
    );
    expect(bad.status).toBe(CheckStatus.FAILED);
    expect(bad.actual).toBe("5 link(s); 2 placeholder; 1 insecure; 1 missing noopener.");
    expect(bad.findings.some((f) => /placeholder, or javascript/.test(f.title))).toBe(true);
    expect(bad.findings.some((f) => f.title.includes("plain HTTP from an HTTPS page") && f.severity === Severity.MEDIUM)).toBe(true);
    expect(bad.findings.some((f) => f.title.includes("omit noopener/noreferrer") && f.domain === "security")).toBe(true);
  });
});

describe("LEM-051 runtime integration", () => {
  it("evaluates implemented checks from injected observations and blocks unsupported checks", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [check("browser.load"), check("browser.console"), check("browser.steps")],
      options: {
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: baseView({
        consoleMessages: [{ type: "error", text: "boom" }],
      }),
      onOutcome: (c, o) => {
        outcomes.set(c.id, o);
      },
    });

    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.PASSED);
    expect(outcomes.get("browser.console")?.status).toBe(CheckStatus.FAILED);
    const steps = outcomes.get("browser.steps");
    // browser.steps is implemented, but no scenario context is provided here
    expect(steps?.status).toBe(CheckStatus.BLOCKED);
    expect(steps?.findings).toEqual([]);
    expect(String(steps?.blocker?.boundary ?? "")).toMatch(/scenario|browser/i);
  });

  it("keeps browser.load evaluable and blocks other implemented checks on navigation failure", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    const navFailedView = baseView({
      navigation: { url: "https://bad.test/", finalUrl: "https://bad.test/", error: "timeout" },
      snapshot: {},
      consoleMessages: [],
      pageErrors: [],
      networkEntries: [],
    });
    await runBrowserChecks({
      url: "https://bad.test/",
      checks: [check("browser.load"), check("browser.console"), check("browser.links")],
      options: {
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: navFailedView,
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    const load = outcomes.get("browser.load");
    expect(load?.status).toBe(CheckStatus.FAILED);
    expect(load?.findings.some((f) => f.title.includes("could not be loaded"))).toBe(true);

    for (const id of ["browser.console", "browser.links"]) {
      const o = outcomes.get(id);
      expect(o?.status).toBe(CheckStatus.BLOCKED);
      expect(String(o?.blocker?.boundary)).toContain("Navigation did not complete");
      expect(o?.findings).toEqual([]);
    }
  });

  it("preserves blocked degradation when runtime is unavailable (no regression)", async () => {
    const outcomes: CheckOutcome[] = [];
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [check("browser.load")],
      options: { playwrightLoader: () => Promise.reject(new Error("missing playwright")) },
      onOutcome: (_c, o) => outcomes.push(o),
    });
    expect(outcomes[0]?.status).toBe(CheckStatus.BLOCKED);
    expect(String(outcomes[0]?.blocker?.boundary ?? outcomes[0]?.actual)).toMatch(/playwright|chromium|browser/i);
  });
});
