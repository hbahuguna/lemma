import { describe, expect, it } from "vitest";

import { deterministicFixPrompt, runBrowserInspectionInBrowser } from "../../src/inspection.js";

function fakePageView(label = "landing") {
  return {
    label,
    navigation: { url: "https://example.com", finalUrl: "https://example.com", status: 200, headers: { "content-type": "text/html" } },
    snapshot: {
      title: "Example",
      bodyTextLength: 120,
      h1s: ["Example"],
      links: [{ href: "https://example.com/about", target: "", rel: "", selector: "a:nth-of-type(1)" }],
    },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [{ url: "https://example.com", status: 200, failed: false }],
    evidenceRefs: {
      screenshot: ".lemma/evidence/run/browser/screenshot.png",
      console: ".lemma/evidence/run/browser/console-log.json",
      network: ".lemma/evidence/run/browser/network-log.json",
      navigation: ".lemma/evidence/run/browser/navigation.json",
      snapshot: ".lemma/evidence/run/browser/dom-snapshot.json",
    },
  };
}

describe("LEM-167 browser inspection (browser package)", () => {
  it("scopes to user-selected check subset and links evidence + fix prompts", async () => {
    const result = await runBrowserInspectionInBrowser({
      target: "https://example.com",
      checks: ["browser.load", "browser.console"],
      pageView: fakePageView(),
      runId: "run-insp-1",
      options: { root: "/tmp" } as any,
    } as any);

    expect(result.scoped_checks).toEqual(["browser.load", "browser.console"]);
    expect(result.observations).toHaveLength(2);
    for (const obs of result.observations) {
      expect(obs.fix_prompt).toBe(deterministicFixPrompt(obs.check_id));
      expect(obs.evidence.refs.length).toBeGreaterThan(0);
      expect(obs.evidence.screenshot).toBeTruthy();
      expect(obs.evidence.console).toBeTruthy();
      expect(obs.evidence.network).toBeTruthy();
      for (const f of (obs.findings ?? [])) {
        expect((f as any).fix_prompt).toBe(obs.fix_prompt);
      }
    }
  });

  it("treats an invalid check filter as unscoped so interaction coverage is not silently dropped", async () => {
    const result = await runBrowserInspectionInBrowser({
      target: "https://example.com",
      checks: ["browser.does-not-exist"],
      runId: "run-insp-invalid-filter",
      options: { noBrowser: true, root: "/tmp" } as any,
    } as any);

    expect(result.scoped_checks).toContain("browser.steps");
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.status).toBe("blocked");
  });

  it("blocks when browser runtime unavailable with explicit blocker and no fabricated screenshot", async () => {
    const result = await runBrowserInspectionInBrowser({
      target: "https://example.com",
      checks: ["browser.load"],
      runId: "run-insp-blocked",
      options: { noBrowser: true, root: "/tmp" } as any,
    } as any);

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
    expect(result.blocker).toBeTruthy();
    expect(result.observations[0]?.status).toBe("blocked");
    expect(result.observations[0]?.blocker?.reason).toBeTruthy();
    expect(result.observations[0]?.evidence.screenshot).toBeFalsy();
    expect((result.observations[0]?.evidence.refs ?? []).some((r) => /screenshot/i.test(String(r)))).toBe(false);
  });

  it("fix prompts are deterministic and check-derived", () => {
    expect(deterministicFixPrompt("browser.load")).toBe(deterministicFixPrompt("browser.load"));
    expect(deterministicFixPrompt("browser.console")).toContain("console");
    expect(deterministicFixPrompt("browser.unknown-check").length).toBeGreaterThan(0);
  });
});
