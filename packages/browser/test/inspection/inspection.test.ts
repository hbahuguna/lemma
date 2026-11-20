import { describe, expect, it } from "vitest";

import { collectInteractionTargets, deterministicFixPrompt, featuresForTarget, prioritizeSourceRoutes, runBrowserInspectionInBrowser } from "../../src/inspection.js";

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

  it("collects classified fixture evidence from crawled views without promoting child-route quirks to findings", async () => {
    const landing = fakePageView("landing");
    const broken = fakePageView("broken_images");
    broken.navigation = {
      url: "https://example.com/broken_images",
      finalUrl: "https://example.com/broken_images",
      status: 200,
      headers: { "content-type": "text/html" },
    } as any;
    broken.consoleMessages = [
      { type: "error", text: "Failed to load resource: the server responded with a status of 404 ()", url: "https://example.com/asdf.jpg" },
    ];

    const result = await runBrowserInspectionInBrowser({
      target: "https://example.com",
      checks: ["browser.console"],
      pageViews: [landing, broken],
      runId: "run-insp-multi-view",
      options: { root: "/tmp" } as any,
    } as any);

    const obs = result.observations[0];
    expect(obs?.status).toBe("passed");
    expect(obs?.findings ?? []).toEqual([]);
    expect(obs?.metadata.classified_non_blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "intentional_fixture" })]),
    );
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

  it("prioritizes canonical example routes over internal contract pages", () => {
    const routes = prioritizeSourceRoutes([
      { id: "r1", kind: "route", label: "/zzz", selector_hint: "", route_hint: "/zzz", source: { path: "examples.csv", line: 3 } },
      { id: "r2", kind: "route", label: "/aaa", selector_hint: "", route_hint: "/aaa", source: { path: "spec/contract/pages.rb", line: 5 } },
      { id: "r3", kind: "route", label: "/zzz", selector_hint: "", route_hint: "/zzz", source: { path: "spec/contract/pages.rb", line: 9 } },
    ] as any);
    expect(routes.map((r) => r.label)).toEqual(["/zzz", "/aaa"]);
  });

  it("does not replay a homepage catalog link on its destination route", () => {
    const features = [
      { id: "catalog-link", kind: "link", label: "A/B Testing", route_hint: "/abtest", routes: ["/"] },
      { id: "verify", kind: "button", label: "Verify", route_hint: "", routes: ["/two_factor"] },
      { id: "layout-home", kind: "link", label: "Home", route_hint: "/" },
    ] as any;
    const onDestination = featuresForTarget(features, "https://example.test/abtest").map((f) => f.id);
    expect(onDestination).not.toContain("catalog-link");
    expect(onDestination).not.toContain("verify");
    expect(featuresForTarget(features, "https://example.test/").map((f) => f.id)).toContain("catalog-link");
    expect(featuresForTarget(features, "https://example.test/two_factor").map((f) => f.id)).toContain("verify");
  });

  it("collects every crawled route as an interaction target without a 10-page cap", () => {
    const views = Array.from({ length: 76 }, (_, i) => {
      const view = fakePageView(`route-${i + 1}`);
      const url = `https://example.com/example-${i + 1}`;
      view.navigation = { ...view.navigation, url, finalUrl: url };
      return view;
    }) as any;
    views.push({
      ...fakePageView("chrome-error"),
      navigation: { url: "chrome-error://chromewebdata/", finalUrl: "chrome-error://chromewebdata/", error: "failed" },
    });

    const targets = collectInteractionTargets("https://example.com", views);
    expect(targets).toHaveLength(77); // 76 crawled pages plus the seed URL
    expect(targets[0]).toBe("https://example.com");
    expect(targets).toContain("https://example.com/example-76");
    expect(targets.some((t) => t.startsWith("chrome-error:"))).toBe(false);
  });

  it("fix prompts are deterministic and check-derived", () => {
    expect(deterministicFixPrompt("browser.load")).toBe(deterministicFixPrompt("browser.load"));
    expect(deterministicFixPrompt("browser.console")).toContain("console");
    expect(deterministicFixPrompt("browser.unknown-check").length).toBeGreaterThan(0);
  });
});
