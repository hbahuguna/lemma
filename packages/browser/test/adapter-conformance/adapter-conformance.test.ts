import { describe, expect, it } from "vitest";

import { CheckStatus, type Check } from "@lemma/core";
import { PlaywrightBrowserAdapter, createPlaywrightBrowserAdapter, runBrowserChecks } from "../../src/index.js";

function makeCheck(id: string): Check {
  return {
    id,
    title: id,
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
  } as any;
}

describe("LEM-191 Playwright browser adapter conformance", () => {
  it("implements BrowserAdapter contract and declares capabilities", async () => {
    const adapter = createPlaywrightBrowserAdapter();
    expect(adapter.id).toBe("playwright");
    expect(typeof adapter.version).toBe("string");
    expect(adapter).toBeInstanceOf(PlaywrightBrowserAdapter);
    const caps = await Promise.resolve(adapter.capabilities());
    expect(caps).toEqual({
      navigation: true,
      screenshots: true,
      console: true,
      network: true,
      storage: true,
      viewport: true,
      crawl: true,
    });
    const probe = await adapter.probe({ disabled: true });
    expect(probe.available).toBe(false);
  });

  it("re-plans on missing channel with explicit coverage notes (never fabricated pass) when runtime is available", async () => {
    const outcomes = new Map<string, any>();
    const adapter = createPlaywrightBrowserAdapter({ declaredCapabilities: { console: false } });
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load"), makeCheck("browser.console")],
      options: { disabled: false },
      browserAdapter: adapter,
      pageView: {
        navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200, headers: {} },
        snapshot: { title: "ok", bodyTextLength: 100, h1s: ["hi"], links: [] },
        consoleMessages: [],
        pageErrors: [],
        networkEntries: [],
        evidenceRefs: {},
      },
      onOutcome: (check, outcome) => outcomes.set(check.id, outcome),
    });

    const load = outcomes.get("browser.load");
    const consoleCheck = outcomes.get("browser.console");
    expect(load?.status).toBe(CheckStatus.PASSED);
    expect(consoleCheck?.status).toBe(CheckStatus.SKIPPED);
    expect(String(consoleCheck?.actual || "")).toMatch(/Re-planned|missing required channel|coverage/i);
    expect(consoleCheck?.metadata?.not_a_pass).toBe(true);
    expect(consoleCheck?.metadata?.missing_channels).toContain("console");
  });

  it("preserves blocked-runtime behavior (LEM-050) end-to-end", async () => {
    const outcomesDisabled = new Map<string, any>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load"), makeCheck("browser.console")],
      options: { disabled: true },
      onOutcome: (check, outcome) => outcomesDisabled.set(check.id, outcome),
    });
    for (const id of ["browser.load", "browser.console"]) {
      const out = outcomesDisabled.get(id);
      expect(out?.status).toBe(CheckStatus.BLOCKED);
      expect(out?.findings ?? []).toEqual([]);
      expect(String(out?.metadata?.limitation || out?.blocker?.boundary || "")).toMatch(/disabled|browser/i);
    }

    const outcomesUnavailable = new Map<string, any>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: { playwrightLoader: () => Promise.reject(new Error("playwright missing")) },
      onOutcome: (check, outcome) => outcomesUnavailable.set(check.id, outcome),
    });
    const load = outcomesUnavailable.get("browser.load");
    expect(load?.status).toBe(CheckStatus.BLOCKED);
    expect(load?.findings ?? []).toEqual([]);
    expect(String(load?.metadata?.limitation || load?.blocker?.boundary || "")).toMatch(/unavailable|playwright|browser/i);
  });
});
