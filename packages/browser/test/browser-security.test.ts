import { describe, expect, it } from "vitest";

import { CheckStatus, Severity, type Check, type CheckOutcome } from "@lemma/core";
import { evaluateBrowserCheck, runBrowserChecks, type BrowserPageView } from "../src/index.js";

function makeCheck(id: string, title = id): Check {
  return {
    id,
    title,
    domain: "security",
    persona: "security",
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

function secureView(overrides: Partial<BrowserPageView> = {}): BrowserPageView {
  return {
    navigation: {
      url: "https://app.example.test/",
      finalUrl: "https://app.example.test/",
      status: 200,
      headers: {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    },
    snapshot: {
      title: "App",
      bodyTextLength: 100,
      h1s: ["App"],
      scripts: ["https://app.example.test/app.js"],
      links: [{ selector: "a", href: "https://app.example.test/docs", target: "", rel: "" }],
      forms: [{ selector: "form", action: "https://app.example.test/submit" }],
    },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    cookies: [{ name: "session_id", secure: true, http_only: true }],
    evidenceRefs,
    ...overrides,
  };
}

describe("LEM-052 browser.security evaluator", () => {
  it("passes when HTTPS, baseline headers, and resources/cookies are secure", () => {
    const outcome = evaluateBrowserCheck("browser.security", secureView());
    expect(outcome.status).toBe(CheckStatus.PASSED);
    expect(outcome.findings).toEqual([]);
    expect(outcome.actual).toBe("HTTPS=true; missing headers: none; mixed content: 0; weak cookies: 0");
  });

  it("flags plain HTTP targets and missing baseline headers", () => {
    const outcome = evaluateBrowserCheck(
      "browser.security",
      secureView({
        navigation: {
          url: "http://example.test/",
          finalUrl: "http://example.test/",
          status: 200,
          headers: {},
        },
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    const titles = outcome.findings.map((f) => f.title);
    expect(titles).toContain("The live target is served over plain HTTP");
    const missing = outcome.findings.find((f) => f.title.startsWith("Baseline security headers are missing:"));
    expect(missing).toBeTruthy();
    expect(missing?.title).toContain("Content-Security-Policy");
    expect(missing?.title).toContain("X-Content-Type-Options");
    expect(missing?.title).toContain("frame protection (X-Frame-Options or CSP frame-ancestors)");
    expect(missing?.title).toContain("Referrer-Policy");
    // HSTS is only required on HTTPS targets
    expect(missing?.title).not.toContain("Strict-Transport-Security");
    expect(missing?.severity).toBe(Severity.MEDIUM);
    expect(missing?.domain).toBe("security");
    expect(missing?.tags).toEqual(["headers", "hardening"]);
    expect(outcome.actual).toContain("HTTPS=false");
  });

  it("accepts CSP report-only and frame-ancestors in CSP for frame protection", () => {
    const outcome = evaluateBrowserCheck(
      "browser.security",
      secureView({
        navigation: {
          url: "https://example.test/",
          finalUrl: "https://example.test/",
          status: 200,
          headers: {
            "strict-transport-security": "max-age=31536000",
            "content-security-policy-report-only": "default-src 'self'",
            "content-security-policy": "frame-ancestors 'self'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        },
      }),
    );
    expect(outcome.status).toBe(CheckStatus.PASSED);
    expect(outcome.actual).toBe("HTTPS=true; missing headers: none; mixed content: 0; weak cookies: 0");
  });

  it("flags mixed content and insecure form actions on HTTPS pages", () => {
    const outcome = evaluateBrowserCheck(
      "browser.security",
      secureView({
        snapshot: {
          title: "App",
          bodyTextLength: 100,
          h1s: ["App"],
          scripts: ["http://cdn.example.test/insecure.js"],
          links: [{ selector: "a.bad", href: "http://insecure.test/page", target: "", rel: "" }],
          forms: [{ selector: "form.login", action: "http://example.test/login" }],
        },
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    expect(outcome.findings.some((f) => f.title === "The page loads insecure resources or links on an HTTPS page")).toBe(true);
    expect(outcome.findings.some((f) => f.title === "A form submits over plain HTTP")).toBe(true);
    expect(outcome.actual).toBe("HTTPS=true; missing headers: none; mixed content: 3; weak cookies: 0");
  });

  it("flags weak session-like cookies missing Secure or HttpOnly", () => {
    const outcome = evaluateBrowserCheck(
      "browser.security",
      secureView({
        cookies: [
          { name: "session_id", secure: false, http_only: true },
          { name: "auth_token", secure: true, httpOnly: false },
          { name: "prefs", secure: false, http_only: false },
        ],
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    const finding = outcome.findings.find((f) => f.title === "Session-like cookies lack Secure or HttpOnly flags");
    expect(finding).toBeTruthy();
    expect(finding?.location).toBe("auth_token, session_id");
    expect(finding?.severity).toBe(Severity.MEDIUM);
    expect(finding?.tags).toEqual(["cookies", "session"]);
    expect(outcome.actual).toContain("weak cookies: 2");
  });
});

describe("LEM-052 runtime integration", () => {
  it("evaluates browser.security from injected observations (implemented, not blocked)", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://app.example.test/",
      checks: [makeCheck("browser.security", "Browser security")],
      options: {
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: secureView(),
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.security")?.status).toBe(CheckStatus.PASSED);
    expect(outcomes.get("browser.security")?.metadata?.not_implemented).not.toBe(true);
  });
});
