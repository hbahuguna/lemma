import { describe, expect, it } from "vitest";

import { CheckStatus, Severity, type Check, type CheckOutcome } from "@lemma/core";
import { evaluateBrowserCheck, runBrowserChecks, type BrowserPageView } from "../src/index.js";

function makeCheck(id: string, title = id): Check {
  return {
    id,
    title,
    domain: "accessibility",
    persona: "accessibility",
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

function accessibleView(overrides: Partial<BrowserPageView> = {}): BrowserPageView {
  return {
    navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
    snapshot: {
      title: "Accessible page",
      bodyTextLength: 200,
      h1s: ["Hello"],
      lang: "en",
      positiveTabindex: 0,
      images: [{ selector: "img.logo", altPresent: true }],
      inputs: [
        { selector: "input#name", type: "text", hasLabel: true },
        { selector: "input#hidden", type: "hidden", hasLabel: false },
        { selector: "input#submit", type: "submit", hasLabel: false },
      ],
      controls: [{ selector: "button.save", name: "Save" }],
      duplicateIds: [],
      links: [],
    },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    cookies: [],
    evidenceRefs,
    ...overrides,
  };
}

describe("LEM-053 browser.accessibility evaluator", () => {
  it("passes clean pages but always marks manual review required with summary actual", () => {
    const outcome = evaluateBrowserCheck("browser.accessibility", accessibleView());
    expect(outcome.status).toBe(CheckStatus.PASSED);
    expect(outcome.findings).toEqual([]);
    expect(outcome.actual).toBe("0 image(s) without alt; 0 unlabeled control(s); 0 unnamed control(s); 0 duplicate id(s).");
    expect(outcome.metadata.manual_review_required).toBe(true);
    expect(outcome.evidence).toContain(evidenceRefs.snapshot);
  });

  it("flags images missing alt attributes", () => {
    const outcome = evaluateBrowserCheck(
      "browser.accessibility",
      accessibleView({
        snapshot: {
          ...accessibleView().snapshot,
          images: [
            { selector: "img.hero", altPresent: false },
            { selector: "img.icon", altPresent: false },
          ],
        },
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    const finding = outcome.findings.find((f) => f.title === "2 image(s) are missing an alt attribute");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe(Severity.MEDIUM);
    expect(finding?.domain).toBe("accessibility");
    expect(finding?.strength).toBe("observed");
    expect(finding?.tags).toEqual(["a11y", "images"]);
    expect(finding?.location).toBe("img.hero, img.icon");
    expect(outcome.actual).toContain("2 image(s) without alt");
  });

  it("flags unlabeled form controls excluding hidden/submit/button/reset/image types", () => {
    const outcome = evaluateBrowserCheck(
      "browser.accessibility",
      accessibleView({
        snapshot: {
          ...accessibleView().snapshot,
          inputs: [
            { selector: "input#email", type: "email", hasLabel: false },
            { selector: "textarea#msg", type: "textarea", hasLabel: false },
            { selector: "input#hid", type: "hidden", hasLabel: false },
            { selector: "input#sub", type: "submit", hasLabel: false },
            { selector: "input#btn", type: "button", hasLabel: false },
            { selector: "input#rst", type: "reset", hasLabel: false },
            { selector: "input#img", type: "image", hasLabel: false },
            { selector: "input#ok", type: "text", hasLabel: true },
          ],
        },
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    const finding = outcome.findings.find((f) => f.title === "2 form control(s) may lack a programmatic label");
    expect(finding).toBeTruthy();
    expect(finding?.tags).toEqual(["a11y", "forms"]);
    expect(finding?.location).toContain("input#email");
    expect(finding?.location).toContain("textarea#msg");
    expect(finding?.location).not.toContain("input#hid");
  });

  it("flags unnamed interactive controls, duplicate ids, positive tabindex, and missing lang", () => {
    const outcome = evaluateBrowserCheck(
      "browser.accessibility",
      accessibleView({
        navigation: { url: "https://example.test/page", finalUrl: "https://example.test/page", status: 200 },
        snapshot: {
          ...accessibleView().snapshot,
          controls: [
            { selector: "button.icon", name: "" },
            { selector: "a.nav", name: "  " },
          ],
          duplicateIds: ["main", "cta", "cta"],
          positiveTabindex: 2,
          lang: "",
        },
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    expect(outcome.findings.some((f) => f.title === "2 interactive control(s) have no accessible name" && f.tags.join(",") === "a11y,controls")).toBe(true);
    expect(outcome.findings.some((f) => f.title === "3 duplicate element id(s) were found" && f.location === "main, cta, cta")).toBe(true);
    expect(outcome.findings.some((f) => f.title === "Positive tabindex values change the natural focus order" && f.tags.join(",") === "a11y,keyboard")).toBe(true);
    expect(outcome.findings.some((f) => f.title === "The document language is not declared" && f.tags.join(",") === "a11y,language")).toBe(true);
    expect(outcome.actual).toBe("0 image(s) without alt; 0 unlabeled control(s); 2 unnamed control(s); 3 duplicate id(s).");
    expect(outcome.metadata.manual_review_required).toBe(true);
  });
});

describe("LEM-053 runtime integration", () => {
  it("evaluates browser.accessibility from injected observations (implemented, not blocked)", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.accessibility", "Accessibility")],
      options: {
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: accessibleView(),
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.accessibility")?.status).toBe(CheckStatus.PASSED);
    expect(outcomes.get("browser.accessibility")?.metadata.manual_review_required).toBe(true);
    expect(outcomes.get("browser.accessibility")?.metadata?.not_implemented).not.toBe(true);
  });
});
