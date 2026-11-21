import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  Severity,
  buildTestPlan,
  checksFromObservations,
  createDefaultPhaseHandlers,
  finalizeTestPlan,
  intentLabel,
  normalizeTarget,
  runBrowserInspection,
  type Check,
  type Finding,
  type PhaseHandlerContext,
  type TestPlan,
} from "../../src/index.js";

function makeCheck(id: string, status: string, overrides: Partial<Check> = {}): Check {
  return {
    id,
    title: id,
    domain: "functional",
    persona: "functional",
    kind: "static",
    intent: "",
    expected: "",
    base_weight: 1,
    weight: 1,
    status,
    actual: status === "passed" ? "observed" : "",
    evidence: status === "passed" ? [`.lemma/evidence/run/${id}.json`] : [],
    finding_ids: [],
    skip_reason: status === "blocked" ? "no safe fixture" : "",
    started_at: null,
    completed_at: null,
    metadata: {},
    ...overrides,
  };
}

function makeFinding(id: string, checkId: string): Finding {
  return {
    id,
    title: id,
    severity: Severity.LOW,
    domain: "security",
    persona: "security",
    strength: "heuristic",
    consequence: "",
    location: "",
    reproduction: "",
    evidence: [],
    remediation: "",
    verification: "",
    check_id: checkId,
    created_at: "2026-01-01T00:00:00Z",
    tags: [],
    fingerprint: `fp-${id}`,
    suppressed: false,
    suppression_owner: "",
    suppression_reason: "",
    suppression_ticket: "",
    suppression_expires_at: "",
  };
}

describe("LEM-216 deterministic intent-specific test plan", () => {
  it("parses both canonical and legacy intent labels", () => {
    expect(intentLabel("Lemma browser assessment")).toBe("browser");
    expect(intentLabel("Lemma security assessment")).toBe("security");
    expect(intentLabel("assay test assessment")).toBe("test");
    expect(intentLabel("performance category assessment")).toBe("performance");
    expect(intentLabel("")).toBe("general");
  });

  it("builds comprehensive browser and security plans from intent", () => {
    const target = normalizeTarget({ kind: "url", raw: "https://example.test", resolved: "https://example.test", source: "" });
    const browser = buildTestPlan({ intent: "Lemma browser assessment", target, command: "browser" });
    expect(browser).toMatchObject({
      schema_version: "lemma.test_plan/v1",
      label: "browser",
      profile: "browser",
      title: "Comprehensive browser test plan",
    });
    expect(browser.scenarios).toHaveLength(11);
    expect(browser.scenarios.every((s) => s.id && s.objective && s.steps.length > 0 && s.expected_result)).toBe(true);
    expect(browser.scenarios.map((s) => s.title).join(" ")).toMatch(/route|interaction|console|network|evidence/i);
    expect(browser.scenarios.some((s) => s.title.includes("auth") && s.automation === "coverage-gap")).toBe(true);
    expect(browser.scenarios.every((s) => s.result === null)).toBe(true);

    const security = buildTestPlan({ intent: "Lemma security assessment", target, command: "security" });
    expect(security.profile).toBe("security");
    expect(security.scenarios.map((s) => s.title).join(" ")).toMatch(/credential|auth|unsafe code|redaction/i);
    expect(security.scenarios.some((s) => s.title.includes("destructive") && s.automation === "coverage-gap")).toBe(true);
  });

  it("links checks and never upgrades blocked, skipped, errored, or unlinked scenarios to passes", () => {
    const target = normalizeTarget({ kind: "repo", raw: ".", resolved: ".", source: "" });
    const plan = buildTestPlan({ intent: "Lemma security assessment", target, command: "security" });
    const ready: TestPlan = {
      ...plan,
      scenarios: plan.scenarios.map((scenario, index) => ({
        ...scenario,
        check_ids: index === 0 ? ["sec-pass"] : index === 1 ? ["sec-blocked"] : index === 2 ? ["sec-skip"] : index === 3 ? ["sec-error"] : [],
      })),
    };
    const checks = [
      makeCheck("sec-pass", CheckStatus.PASSED, { evidence: [".lemma/evidence/run/pass.json"] }),
      makeCheck("sec-blocked", CheckStatus.BLOCKED),
      makeCheck("sec-skip", CheckStatus.SKIPPED, { skip_reason: "not safe" }),
      makeCheck("sec-error", CheckStatus.ERROR, { actual: "runtime failed" }),
    ];
    const findings = [makeFinding("finding-1", "sec-pass")];
    const final = finalizeTestPlan(ready, checks, findings);

    expect(final.scenarios[0]?.result).toMatchObject({
      status: "passed",
      check_ids: ["sec-pass"],
      evidence: [".lemma/evidence/run/pass.json"],
      finding_ids: ["finding-1"],
    });
    expect(final.scenarios[1]?.result?.status).toBe("blocked");
    expect(final.scenarios[2]?.result?.status).toBe("skipped");
    expect(final.scenarios[3]?.result?.status).toBe("error");
    for (const scenario of final.scenarios.slice(4)) {
      expect(scenario.result?.status).toBe("coverage_gap");
      expect(scenario.result?.coverage_gap_reason).toMatch(/No executed check|coverage gap/i);
    }
    expect(final.summary).toMatchObject({ total: plan.scenarios.length, passed: 1, blocked: 1, skipped: 1, error: 1, executed: 1 });
  });

  it("adapts browser observations to checks with nested evidence paths", () => {
    const checks = checksFromObservations([
      {
        check_id: "browser.steps",
        status: "passed",
        evidence: { screenshot: "screens/a.png", dom: ["dom/a.json"], ignored: 42 },
        findings: [{ id: "f-1" }, "f-2"],
      },
    ]);
    expect(checks[0]).toMatchObject({
      id: "browser.steps",
      status: "passed",
      evidence: ["screens/a.png", "dom/a.json"],
      finding_ids: ["f-1", "f-2"],
    });
  });

  it("is created during the fixed test_planning phase before execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-plan-phase-"));
    try {
      const state = {
        run_id: "plan-phase",
        status: "running",
        target: normalizeTarget({ kind: "repo", raw: root, resolved: root, source: "" }),
        intent: "Lemma security assessment",
        risks: [],
        checks: [],
        findings: [],
        blockers: [],
        inventory: {},
        options: {},
        phases: [],
      };
      const handlers = createDefaultPhaseHandlers({});
      const ctx = {
        state,
        phase: { name: "test_planning", title: "Test Planning", status: "running", summary: "", details: {}, started_at: null, completed_at: null },
        options: { intent: "Lemma security assessment", maxChecks: 20 },
        budget: { maxChecks: 20 },
        store: {},
      } as unknown as PhaseHandlerContext;

      await handlers.test_planning?.(ctx);
      const plan = (state as unknown as { test_plan?: TestPlan }).test_plan;
      expect(plan).toBeDefined();
      expect(plan?.profile).toBe("security");
      expect(plan?.scenarios.length).toBeGreaterThan(5);
      expect(plan?.scenarios.every((scenario) => scenario.result === null)).toBe(true);
      expect((ctx.phase.details as Record<string, unknown>).test_plan_profile).toBe("security");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attaches the plan and its results to browser inspection output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-browser-plan-"));
    try {
      const result = await runBrowserInspection({
        target: "https://example.test",
        root,
        runId: "browser-plan-test",
        checks: ["browser.load", "browser.content"],
        pageViews: [{
          navigation: { url: "https://example.test", finalUrl: "https://example.test", status: 200 },
          snapshot: { title: "Example Domain Home", h1s: ["Example Domain"], bodyTextLength: 200 },
          consoleMessages: [],
          pageErrors: [],
          networkEntries: [],
          evidenceRefs: { dom: ".lemma/evidence/browser-plan-test/dom.json" },
          label: "landing",
        }],
      });
      expect(result.test_plan.profile).toBe("browser");
      expect(result.test_plan.title).toBe("Comprehensive browser test plan");
      expect(result.test_plan.scenarios.length).toBe(11);
      expect(result.test_plan.scenarios.some((scenario) => scenario.result?.status === "passed")).toBe(true);
      expect(result.test_plan.scenarios.some((scenario) => scenario.result?.status === "coverage_gap")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
