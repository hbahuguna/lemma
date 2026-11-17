import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  dispatchWithBrowserAdapter,
  negotiateBrowserDispatch,
  type BrowserAdapter,
  type BrowserAdapterCapabilities,
  type BrowserDispatchRequest,
  type Check,
} from "../../src/index.js";

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

function adapterWithCaps(caps: Partial<BrowserAdapterCapabilities>, dispatch?: BrowserAdapter["dispatch"]): BrowserAdapter {
  const capabilities: BrowserAdapterCapabilities = {
    navigation: true, screenshots: true, console: true, network: true, storage: true, viewport: true, crawl: true,
    ...caps,
  };
  return {
    id: "fake-browser",
    version: "1.0.0",
    nativeVersion: "0.0-test",
    capabilities: () => capabilities,
    dispatch: dispatch ?? (async (req: BrowserDispatchRequest) => ({
      outcomes: new Map(req.checks.map((c) => [c.id, { status: CheckStatus.PASSED, actual: "ok", evidence: [], findings: [], finding_ids: [], blocker: null, metadata: {} } as any])),
    })),
  };
}

describe("LEM-191 browser adapter contract (core)", () => {
  it("negotiates capabilities before dispatch and re-plans missing-channel checks with explicit coverage notes (no fabricated pass)", async () => {
    const adapter = adapterWithCaps({ console: false });
    const checks = [makeCheck("browser.load"), makeCheck("browser.console")];

    const negotiation = negotiateBrowserDispatch(adapter, adapter.capabilities() as any, checks, {});
    expect(negotiation.dispatch_checks).toEqual(["browser.load"]);
    expect(negotiation.replanned_checks).toEqual(["browser.console"]);
    expect(negotiation.coverage_notes.some((n) => n.includes("browser.console") && n.includes("console") && n.includes("not a pass"))).toBe(true);

    const { outcomes, coverage_notes } = await dispatchWithBrowserAdapter(adapter, { url: "https://example.test", checks, options: {} });
    const load = outcomes.get("browser.load") as any;
    const consoleCheck = outcomes.get("browser.console") as any;
    expect(load.status).toBe(CheckStatus.PASSED);
    expect(consoleCheck.status).toBe(CheckStatus.SKIPPED);
    expect(String(consoleCheck.actual)).toMatch(/Re-planned|coverage gap/i);
    expect(consoleCheck.metadata?.replanned).toBe(true);
    expect(consoleCheck.metadata?.not_a_pass).toBe(true);
    expect(consoleCheck.metadata?.missing_channels).toContain("console");
    expect(coverage_notes.some((n) => n.includes("browser.console") && /explicit coverage/i.test(n))).toBe(true);
  });

  it("re-plans crawl-dependent dispatch when crawl channel is missing and never silently drops checks", async () => {
    const adapter = adapterWithCaps({ crawl: false }, async (req) => ({
      outcomes: new Map(req.checks.map((c) => [c.id, { status: CheckStatus.PASSED, actual: "ok", evidence: [], findings: [], finding_ids: [], blocker: null, metadata: {} } as any])),
    }));
    const checks = [makeCheck("browser.load")];
    const { outcomes, coverage_notes } = await dispatchWithBrowserAdapter(adapter, { url: "https://example.test", checks, options: { crawl: true } });
    const out = outcomes.get("browser.load") as any;
    expect(out.status).toBe(CheckStatus.SKIPPED);
    expect(out.metadata?.missing_channels).toContain("crawl");
    expect(coverage_notes.some((n) => n.includes("crawl"))).toBe(true);

    // silent drop guard: if adapter returns no outcome for a dispatched check, core records skipped coverage gap
    const dropping = adapterWithCaps({}, async () => ({ outcomes: new Map() }));
    const res2 = await dispatchWithBrowserAdapter(dropping, { url: "https://example.test", checks: [makeCheck("browser.load")], options: {} });
    const out2 = res2.outcomes.get("browser.load") as any;
    expect(out2.status).toBe(CheckStatus.SKIPPED);
    expect(String(out2.actual)).toMatch(/not produced|coverage gap/i);
    expect(out2.metadata?.not_a_pass).toBe(true);
  });
});
