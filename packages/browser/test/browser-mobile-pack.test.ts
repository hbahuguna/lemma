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

function baseView(snapshot: Record<string, unknown>): BrowserPageView {
  return {
    navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
    snapshot,
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    evidenceRefs,
  };
}

describe("LEM-055 browser.overflow evaluator", () => {
  it("passes when content fits viewport and records viewport metadata", () => {
    const outcome = evaluateBrowserCheck(
      "browser.overflow",
      baseView({ viewportWidth: 390, documentScrollWidth: 390, overflowingElements: [] }),
    );
    expect(outcome.status).toBe(CheckStatus.PASSED);
    expect(outcome.findings).toEqual([]);
    expect(outcome.actual).toBe("No horizontal overflow: scroll width 390 <= viewport 390.");
    expect(outcome.metadata.viewport_width).toBe(390);
    expect(outcome.metadata.scroll_width).toBe(390);
  });

  it("fails on horizontal overflow with offending element and metadata", () => {
    const outcome = evaluateBrowserCheck(
      "browser.overflow",
      baseView({
        viewportWidth: 390,
        documentScrollWidth: 1000,
        overflowingElements: [{ selector: "div.wide", right: 1000 }],
      }),
    );
    expect(outcome.status).toBe(CheckStatus.FAILED);
    expect(outcome.actual).toBe(
      "Horizontal overflow: scroll width 1000 > viewport 390; offending element div.wide.",
    );
    expect(outcome.metadata.viewport_width).toBe(390);
    expect(outcome.metadata.scroll_width).toBe(1000);
    expect(outcome.metadata.offending_element).toEqual({ selector: "div.wide", right: 1000 });
    expect(outcome.findings.length).toBe(1);
    expect(outcome.findings[0]?.title).toBe("The page overflows the 390px mobile viewport");
    expect(outcome.findings[0]?.severity).toBe(Severity.MEDIUM);
    expect(outcome.findings[0]?.tags).toEqual(["responsive", "overflow", "mobile"]);
    expect(outcome.findings[0]?.location).toBe("div.wide");
  });

  it("defaults viewport width to 390 when not provided", () => {
    const outcome = evaluateBrowserCheck(
      "browser.overflow",
      baseView({ documentScrollWidth: 391, overflowingElements: [] }),
    );
    expect(outcome.status).toBe(CheckStatus.PASSED);
    expect(outcome.metadata.viewport_width).toBe(390);
  });
});

describe("LEM-055 browser.focus_order evaluator", () => {
  it("passes when focus follows DOM order", () => {
    const outcome = evaluateBrowserCheck(
      "browser.focus_order",
      baseView({ positiveTabindex: 0, focusOrderMatchesDom: true }),
    );
    expect(outcome.status).toBe(CheckStatus.PASSED);
    expect(outcome.actual).toBe("Focus order follows document order.");
    expect(outcome.metadata.positive_tabindex_count).toBe(0);
  });

  it("fails when positive tabindex or DOM-order mismatch is observed", () => {
    const positive = evaluateBrowserCheck(
      "browser.focus_order",
      baseView({ positiveTabindex: 2, focusOrderMatchesDom: true }),
    );
    expect(positive.status).toBe(CheckStatus.FAILED);
    expect(positive.actual).toBe("2 positive tabindex value(s) disturbed focus order.");
    expect(positive.metadata.positive_tabindex_count).toBe(2);
    expect(positive.findings[0]?.tags).toEqual(["a11y", "focus", "keyboard"]);
    expect(positive.findings[0]?.location).toBe("https://example.test/");

    const mismatch = evaluateBrowserCheck(
      "browser.focus_order",
      baseView({ positiveTabindex: 0, focusOrderMatchesDom: false }),
    );
    expect(mismatch.status).toBe(CheckStatus.FAILED);
    expect(mismatch.findings[0]?.title).toBe("Keyboard focus order does not follow document order");
  });
});

describe("LEM-055 runtime integration", () => {
  it("evaluates overflow and focus_order from injected observations (implemented)", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.overflow"), makeCheck("browser.focus_order")],
      options: {
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: baseView({
        viewportWidth: 390,
        documentScrollWidth: 390,
        overflowingElements: [],
        positiveTabindex: 0,
        focusOrderMatchesDom: true,
      }),
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.overflow")?.status).toBe(CheckStatus.PASSED);
    expect(outcomes.get("browser.focus_order")?.status).toBe(CheckStatus.PASSED);
    expect(outcomes.get("browser.overflow")?.metadata?.not_implemented).not.toBe(true);
  });
});
