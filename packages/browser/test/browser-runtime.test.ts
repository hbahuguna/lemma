import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import {
  BrowserUnavailableError,
  blockedBrowserOutcome,
  degradeBrowserChecks,
  loadPlaywright,
  probeBrowserRuntime,
  runBrowserChecks,
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

describe("LEM-050 browser runtime and blocked degradation", () => {
  it("degrades every browser check when runtime is unavailable (missing Playwright)", async () => {
    const checks = [
      makeCheck("browser.load", "Page loads"),
      makeCheck("browser.console", "Console clean"),
    ];
    const outcomes: Array<{ id: string; outcome: CheckOutcome }> = [];

    await runBrowserChecks({
      url: "https://example.test/",
      checks,
      options: {
        playwrightLoader: () => Promise.reject(new Error("Cannot find package 'playwright'")),
      },
      onOutcome: (check, outcome) => {
        outcomes.push({ id: check.id, outcome });
      },
    });

    expect(outcomes).toHaveLength(2);
    for (const { id, outcome } of outcomes) {
      expect(outcome.status).toBe(CheckStatus.BLOCKED);
      expect(outcome.status).not.toBe(CheckStatus.PASSED);
      expect(outcome.status).not.toBe(CheckStatus.FAILED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual.toLowerCase()).toContain("browser");
      expect(outcome.metadata?.limitation).toBeTruthy();
      expect(outcome.blocker).toBeTruthy();
      expect(outcome.blocker?.attempted_action).toBeTruthy();
      const boundary = outcome.blocker?.boundary ?? "";
      expect(boundary.toLowerCase()).toMatch(/browser|playwright|chromium/);
      expect(outcome.blocker?.unblock_evidence?.length ?? 0).toBeGreaterThan(0);
      const hints = (outcome.blocker?.unblock_evidence ?? []).join(" ").toLowerCase();
      expect(hints).toMatch(/playwright|chromium|rerun/);
      expect((outcome.blocker?.unblock_evidence ?? []).join(" ")).toContain(id);
    }
  });

  it("degrades disabled/no-browser mode with the same blocked contract without throwing", async () => {
    const checks = [makeCheck("browser.load"), makeCheck("browser.network")];
    const outcomes: CheckOutcome[] = [];

    await expect(
      runBrowserChecks({
        url: "https://example.test/",
        checks,
        options: { noBrowser: true },
        onOutcome: (_check, outcome) => {
          outcomes.push(outcome);
        },
      }),
    ).resolves.toBeUndefined();

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe(CheckStatus.BLOCKED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.blocker).toBeTruthy();
      expect(String(outcome.metadata?.limitation)).toMatch(/disabled|no-browser/i);
      expect((outcome.blocker?.boundary ?? "").toLowerCase()).toMatch(/browser|disabled|no-browser/);
    }

    const outcomes2: CheckOutcome[] = [];
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: { disabled: true },
      onOutcome: (_c, o) => outcomes2.push(o),
    });
    expect(outcomes2[0]?.status).toBe(CheckStatus.BLOCKED);
  });

  it("probe/load report unavailability and helpers build blocked outcomes without findings", async () => {
    await expect(
      loadPlaywright({
        playwrightLoader: () => Promise.reject(new Error("playwright not installed")),
      }),
    ).rejects.toBeInstanceOf(BrowserUnavailableError);

    const probe = await probeBrowserRuntime({
      playwrightLoader: () => Promise.reject(new Error("missing chromium")),
    });
    expect(probe.available).toBe(false);
    expect(String(probe.reason).toLowerCase()).toMatch(/playwright|chromium|unavailable|missing/);

    const check = makeCheck("browser.security", "Security headers");
    const blocked = blockedBrowserOutcome(check, "Chromium launch failed");
    expect(blocked.status).toBe(CheckStatus.BLOCKED);
    expect(blocked.findings).toEqual([]);
    expect(blocked.blocker?.boundary).toContain("Chromium");

    const collected: string[] = [];
    await degradeBrowserChecks([check], "runtime unavailable", (c) => {
      collected.push(c.id);
    });
    expect(collected).toEqual(["browser.security"]);
  });
});
