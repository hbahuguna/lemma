import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import {
  IMPLEMENTED_BROWSER_CHECKS,
  executeScenarioPlan,
  loadScenarioPlan,
  loadScenarioPlanFromFile,
  runBrowserChecks,
  type BrowserScenarioPageLike,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    try { rmSync(t, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

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

function makePage(): { calls: string[]; page: BrowserScenarioPageLike } {
  const calls: string[] = [];
  const bodyText = "Welcome pricing $10/mo";
  let url = "https://example.test/";
  return {
    calls,
    page: {
      goto: (u: string) => { calls.push(`goto:${u}`); url = u; return Promise.resolve(); },
      waitForTimeout: () => Promise.resolve(),
      url: () => url,
      innerText: () => Promise.resolve(bodyText),
      getByText: () => ({
        count: () => Promise.resolve(1),
        first: () => ({ click: () => { calls.push("click"); return Promise.resolve(); } }),
      }),
      getByRole: () => ({ count: () => Promise.resolve(0) }),
      getByLabel: () => ({
        count: () => Promise.resolve(1),
        first: () => ({ fill: (v: string) => { calls.push(`fill:${v}`); return Promise.resolve(); } }),
      }),
      getByPlaceholder: () => ({ count: () => Promise.resolve(0) }),
      locator: (sel: string) => ({
        count: () => Promise.resolve(sel.includes("text=") ? 1 : 0),
        first: () => ({ click: () => { calls.push(`click:${sel}`); return Promise.resolve(); } }),
      }),
      screenshot: () => Promise.resolve(Buffer.from("png")),
    },
  };
}

describe("scenario loading/compilation", () => {
  it("parses JSON scenario plan object/string and preserves steps/source/target", () => {
    const plan = loadScenarioPlan({
      title: "T",
      source: "explicit",
      target_url: "https://example.test/",
      steps: [{ step_number: 1, name: "Go", action: "goto", target: "/a", value: "", options: {} }],
    }, { baseUrl: "https://example.test" });
    expect(plan.title).toBe("T");
    expect(plan.source).toBe("explicit");
    expect(plan.steps[0]?.action).toBe("goto");
  });

  it("compiles natural-language text via heuristic planner", () => {
    const plan = loadScenarioPlan("Navigate to /pricing and click \"Buy\"", { baseUrl: "https://example.test" });
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(["heuristic", "explicit", "llm"]).toContain(plan.source);
  });

  it("loads scenario plan from file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemma-scenario-"));
    temps.push(dir);
    const p = join(dir, "scenario.json");
    writeFileSync(p, JSON.stringify({ title: "File", steps: [{ step_number: 1, name: "Wait", action: "wait", options: { ms: 1 } }] }), "utf8");
    const plan = loadScenarioPlanFromFile(p);
    expect(plan.title).toBe("File");
    expect(plan.steps[0]?.action).toBe("wait");
  });
});

describe("scenario execution and browser.steps", () => {
  it("executes steps, continues after failure, and returns result fields/evidence refs", async () => {
    const { page } = makePage();
    const plan = loadScenarioPlan({
      title: "Run",
      target_url: "https://example.test/",
      steps: [
        { step_number: 1, name: "go", action: "goto", target: "https://example.test/" },
        { step_number: 2, name: "missing", action: "click", target: "Nope" },
        { step_number: 3, name: "shot", action: "screenshot" },
      ],
    });
    // make click fail for step 2 by overriding getByText/locator to none
    page.getByText = () => ({ count: () => Promise.resolve(0) });
    page.locator = () => ({ count: () => Promise.resolve(0) });
    const saved: string[] = [];
    const evidence = {
      saveJson: (name: string) => { saved.push(name); return Promise.resolve(`ev/${name}.json`); },
      saveScreenshot: (name: string) => { saved.push(name); return Promise.resolve(`ev/${name}.png`); },
    };
    const result = await executeScenarioPlan(page, plan, evidence, { label: "sc" });
    expect(result.total_steps).toBe(3);
    expect(result.passed_steps).toBe(2);
    expect(result.failed_steps).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.results.some((r) => r.status === "failed")).toBe(true);
    expect(result.evidence_refs.scenario_results).toContain("sc-results");
  });

  it("records a missing auto-discovered control as a skipped coverage gap when the step is soft", async () => {
    const { page } = makePage();
    page.getByText = () => ({ count: () => Promise.resolve(0) });
    page.locator = () => ({ count: () => Promise.resolve(0) });
    const plan = loadScenarioPlan({
      title: "Auto",
      target_url: "https://example.test/",
      steps: [
        { step_number: 1, name: "wait", action: "wait", options: { ms: 1 } },
        { step_number: 2, name: "missing", action: "click", target: "Nope", options: { soft: true } },
      ],
    });
    const result = await executeScenarioPlan(page, plan, undefined, { label: "soft" });
    expect(result.failed_steps).toBe(0);
    expect(result.skipped_steps).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.results.find((r) => r.step_number === 2)?.status).toBe("skipped");
  });

  it("maps scenario skips to a SKIPPED check outcome instead of a clean pass", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    const pageView = { navigation: { url: "https://example.test", finalUrl: "https://example.test", status: 200 }, snapshot: { title: "T", bodyTextLength: 100 }, consoleMessages: [], pageErrors: [], networkEntries: [], evidenceRefs: {} };
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.steps")],
      pageView,
      options: {
        scenarioExecution: {
          title: "auto",
          target_url: "https://example.test/",
          passed: true,
          total_steps: 2,
          passed_steps: 1,
          failed_steps: 0,
          skipped_steps: 1,
          duration_ms: 1,
          results: [],
          evidence_refs: {},
          error: "",
        },
      },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    const out = outcomes.get("browser.steps");
    expect(out?.status).toBe(CheckStatus.SKIPPED);
    expect(out?.actual).toContain("coverage gaps");
  });

  it("integrates browser.steps via runBrowserChecks with injected scenarioExecution (pass/fail/blocked)", async () => {
    expect(IMPLEMENTED_BROWSER_CHECKS.has("browser.steps")).toBe(true);
    const outcomes = new Map<string, CheckOutcome>();
    const pageView = { navigation: { url: "https://example.test", finalUrl: "https://example.test", status: 200 }, snapshot: { title: "T", bodyTextLength: 100 }, consoleMessages: [], pageErrors: [], networkEntries: [], evidenceRefs: {} };

    const playwrightLoader = () => Promise.resolve({
      chromium: {
        launch: () => Promise.resolve({
          newContext: () => Promise.resolve({
            newPage: () => Promise.resolve({}),
            close: () => Promise.resolve(),
          }),
          close: () => Promise.resolve(),
        }),
      },
    });

    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.steps")],
      pageView,
      options: {
        playwrightLoader,
        scenarioExecution: {
          title: "ok",
          target_url: "https://example.test/",
          passed: true,
          total_steps: 1,
          passed_steps: 1,
          failed_steps: 0,
          skipped_steps: 0,
          duration_ms: 1,
          results: [],
          evidence_refs: { scenario_results: "ev/sc.json" },
          error: "",
        },
      },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    const passOut = outcomes.get("browser.steps");
    expect(passOut?.status).toBe(CheckStatus.PASSED);
    expect(passOut?.evidence).toContain("ev/sc.json");

    outcomes.clear();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.steps")],
      pageView,
      options: {
        playwrightLoader,
        scenarioExecution: {
          title: "bad",
          target_url: "https://example.test/",
          passed: false,
          total_steps: 1,
          passed_steps: 0,
          failed_steps: 1,
          skipped_steps: 0,
          duration_ms: 1,
          results: [],
          evidence_refs: {},
          error: "Step 1 failed",
        },
      },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.steps")?.status).toBe(CheckStatus.FAILED);

    outcomes.clear();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.steps")],
      options: { disabled: true },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.steps")?.status).toBe(CheckStatus.BLOCKED);
  });
});
