import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import { runBrowserChecks } from "../src/index.js";

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
  };
}

describe("LEM-060 browser blocked-degradation leg", () => {
  it("blocks browser checks without false pass when runtime is disabled", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load"), makeCheck("browser.console")],
      options: { disabled: true },
      onOutcome: (check, outcome) => outcomes.set(check.id, outcome),
    });

    const load = outcomes.get("browser.load");
    const consoleOut = outcomes.get("browser.console");
    expect(load?.status).toBe(CheckStatus.BLOCKED);
    expect(consoleOut?.status).toBe(CheckStatus.BLOCKED);
    expect(load?.findings ?? []).toEqual([]);
    expect(consoleOut?.findings ?? []).toEqual([]);
    const boundary = typeof load?.blocker?.boundary === "string"
      ? load.blocker.boundary
      : typeof load?.metadata?.limitation === "string"
        ? load.metadata.limitation
        : "";
    expect(boundary).toMatch(/disabled|browser/i);
  });

  it("blocks browser checks without false pass when runtime is unavailable", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: {
        playwrightLoader: () => Promise.reject(new Error("playwright missing")),
      },
      onOutcome: (check, outcome) => outcomes.set(check.id, outcome),
    });

    const load = outcomes.get("browser.load");
    expect(load?.status).toBe(CheckStatus.BLOCKED);
    expect(load?.findings ?? []).toEqual([]);
    const boundary = typeof load?.blocker?.boundary === "string"
      ? load.blocker.boundary
      : typeof load?.metadata?.limitation === "string"
        ? load.metadata.limitation
        : "";
    expect(boundary).toMatch(/unavailable|playwright|browser/i);
  });
});
