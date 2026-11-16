import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import { evaluateBrowserCheck, runBrowserChecks, type BrowserPageView } from "../../src/index.js";

function makeCheck(id = "browser.accessibility"): Check {
  return {
    id,
    title: "Accessibility",
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
  } as Check;
}

const evidenceRefs = {
  screenshot: "evidence/shot.png",
  snapshot: "evidence/snapshot.json",
  navigation: "evidence/navigation.json",
  accessibility: "evidence/accessibility.json",
};

function baseView(snapshot: Record<string, unknown>): BrowserPageView {
  return {
    navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
    snapshot: {
      title: "Page",
      bodyTextLength: 200,
      h1s: ["H"],
      lang: "en",
      images: [],
      inputs: [],
      controls: [],
      duplicateIds: [],
      positiveTabindex: 0,
      ...snapshot,
    },
    consoleMessages: [],
    pageErrors: [],
    networkEntries: [],
    evidenceRefs,
  };
}

describe("LEM-149 dynamic accessibility (keyboard traversal)", () => {
  it("records bounded observed focus order and flags trap/unreachable and DOM-sequence mismatch", () => {
    const happy = evaluateBrowserCheck("browser.accessibility", baseView({
      focusTraversal: {
        max: 50,
        observed: ["a", "b", "c"],
        domSequence: ["a", "b", "c"],
        unreachable: [],
        traps: [],
        loopDetected: false,
      },
    }));
    expect(happy.status).toBe(CheckStatus.PASSED);
    expect((happy.metadata.focus_traversal as any).observed).toEqual(["a", "b", "c"]);
    expect((happy.metadata.focus_traversal as any).dom_sequence).toEqual(["a", "b", "c"]);
    expect(happy.metadata.manual_review_required).toBe(true);
    expect(Array.isArray(happy.metadata.manual_review_required_items)).toBe(true);
    expect(happy.evidence).toContain(evidenceRefs.screenshot);
    expect(happy.evidence).toContain(evidenceRefs.accessibility);

    const trap = evaluateBrowserCheck("browser.accessibility", baseView({
      focusTraversal: {
        max: 50,
        observed: ["dialog.close", "dialog.close"],
        domSequence: ["dialog.close", "outside"],
        unreachable: ["outside"],
        traps: ["dialog"],
        loopDetected: true,
      },
    }));
    expect(trap.status).toBe(CheckStatus.FAILED);
    expect(trap.findings.some((f) => /trap-prone/i.test(f.title))).toBe(true);
    expect(trap.findings.some((f) => /unreachable/i.test(f.title))).toBe(true);
    expect(trap.findings.some((f) => /differs from the DOM sequence/i.test(f.title))).toBe(true);
    expect((trap.metadata.focus_traversal as any).max).toBe(50);
  });
});

describe("LEM-149 dynamic accessibility (live contrast)", () => {
  it("passes AA-compliant samples and flags normal/large-text AA failures with ratio/level and evidence refs", () => {
    const pass = evaluateBrowserCheck("browser.accessibility", baseView({
      contrastSamples: [
        { selector: "p.ok", fg: "rgb(0,0,0)", bg: "rgb(255,255,255)", fontSize: 16, fontWeight: 400 },
        { selector: "h1.ok", fg: "rgb(80,80,80)", bg: "rgb(255,255,255)", fontSize: 24, fontWeight: 700 },
      ],
    }));
    expect(pass.status).toBe(CheckStatus.PASSED);
    expect((pass.metadata.contrast as any).sample_count).toBe(2);
    expect(((pass.metadata.contrast as any).violations ?? []).length).toBe(0);

    const fail = evaluateBrowserCheck("browser.accessibility", baseView({
      contrastSamples: [
        { selector: "p.low", fg: "rgb(170,170,170)", bg: "rgb(255,255,255)", fontSize: 16, fontWeight: 400 }, // fails normal AA 4.5
        { selector: "h2.low", fg: "rgb(150,150,150)", bg: "rgb(255,255,255)", fontSize: 24, fontWeight: 700 }, // fails large AA 3.0
      ],
    }));
    expect(fail.status).toBe(CheckStatus.FAILED);
    const normal = fail.findings.find((f) => /normal text/i.test(f.title));
    const large = fail.findings.find((f) => /large text/i.test(f.title));
    expect(normal).toBeTruthy();
    expect(large).toBeTruthy();
    const violations = (fail.metadata.contrast as any).violations as any[];
    expect(violations.some((v) => v.selector === "p.low" && v.wcag_level === "AA" && v.large_text === false && typeof v.ratio === "number")).toBe(true);
    expect(violations.some((v) => v.selector === "h2.low" && v.wcag_level === "AA" && v.large_text === true && typeof v.ratio === "number")).toBe(true);
    expect(fail.evidence).toContain(evidenceRefs.screenshot);
    expect(fail.evidence).toContain(evidenceRefs.accessibility);
  });
});

describe("LEM-149 dynamic accessibility (screen-reader hints)", () => {
  it("reports contract violations and manual review list without fabricating screen-reader output", () => {
    const outcome = evaluateBrowserCheck("browser.accessibility", baseView({
      screenReaderHints: {
        contradictoryNames: [{ selector: "button.x", role: "button", name: "", state: "aria-pressed conflicting" }],
        duplicateLandmarks: ["main", "navigation"],
        interactiveWithoutName: [{ selector: "button.icon-only" }],
        manual_review_required: ["Verify landmark labels in actual screen reader."],
      },
    }));
    expect(outcome.status).toBe(CheckStatus.FAILED);
    expect(outcome.findings.some((f) => /contradictory or invalid accessible role\/name\/state/i.test(f.title))).toBe(true);
    expect(outcome.findings.some((f) => /duplicate landmark/i.test(f.title))).toBe(true);
    expect(outcome.findings.some((f) => /interactive element\(s\) lack an accessible name/i.test(f.title))).toBe(true);
    expect((outcome.metadata.screen_reader_hints as any).contradictory_names).toBe(1);
    expect((outcome.metadata.screen_reader_hints as any).duplicate_landmarks).toBe(2);
    expect((outcome.metadata.screen_reader_hints as any).interactive_without_name).toBe(1);
    const reviews = outcome.metadata.manual_review_required_items as string[];
    expect(reviews.some((r) => /not fabricated/i.test(r))).toBe(true);
    expect(reviews.some((r) => /Verify landmark labels/i.test(r))).toBe(true);
    expect(outcome.actual).not.toMatch(/screen reader said|announced as/i);
  });
});

describe("LEM-149 blocked runtime and determinism", () => {
  it("degrades to blocked with explicit coverage notes when browser unavailable (never pass)", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck()],
      options: { noBrowser: true },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    const o = outcomes.get("browser.accessibility")!;
    expect(o.status).toBe(CheckStatus.BLOCKED);
    expect(o.status).not.toBe(CheckStatus.PASSED);
    expect(o.actual).toContain("Browser checks were not executed");
    expect(typeof o.metadata.limitation).toBe("string");
  });

  it("produces deterministic findings for same target/viewport observations and stable evidence refs", () => {
    const view = baseView({
      focusTraversal: { max: 50, observed: ["a"], domSequence: ["a", "b"], unreachable: ["b"], traps: [], loopDetected: false },
      contrastSamples: [{ selector: "p", fg: "rgb(170,170,170)", bg: "rgb(255,255,255)", fontSize: 16, fontWeight: 400 }],
    });
    const a = evaluateBrowserCheck("browser.accessibility", view);
    const b = evaluateBrowserCheck("browser.accessibility", view);
    expect(a).toEqual(b);
    expect(a.evidence).toEqual(b.evidence);
  });
});
