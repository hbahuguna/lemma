import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  HeuristicStepPlanner,
  LLMStepPlanner,
  Severity,
  Strength,
  createStepPlanner,
  evaluateScenarioCheck,
  type ScenarioExecutionResult,
} from "../../src/index.js";

describe("LEM-025 scenario step planner and runner contracts", () => {
  it("heuristically compiles common ticket instructions into structured actions with base URL resolution", () => {
    const planner = new HeuristicStepPlanner();
    const plan = planner.plan(
      [
        "Steps to reproduce:",
        "1) Open /pricing -> Click the Free CTA (Get Started Free)",
        "2) Set calculator developers to 10 -> verify prices update",
        "3) Open FAQ 'Can I cancel anytime?' -> confirm no client errors",
        "4) Toggle annual",
      ].join("\n"),
      "https://example.test",
    );

    expect(plan.source).toBe("heuristic");
    expect(plan.title).toBe("Ticket Scenario");
    expect(plan.target_url).toBe("https://example.test");
    const actions = plan.steps.map((s) => [s.action, s.target, s.value, s.name]);
    expect(actions).toContainEqual(["goto", "https://example.test/pricing", "", "Navigate to /pricing"]);
    expect(actions).toContainEqual(["click", "Get Started Free", "", "Click Get Started Free"]);
    expect(actions).toContainEqual(["fill", "calculator developers", "10", "Set calculator developers to 10"]);
    expect(plan.steps.some((s) => s.action === "assert_text" && /prices update/i.test(s.value))).toBe(true);
    expect(plan.steps.some((s) => s.action === "click" && s.target === "Can I cancel anytime?")).toBe(true);
    expect(plan.steps.some((s) => s.action === "assert_no_errors")).toBe(true);
    expect(plan.steps.some((s) => s.action === "click" && /Toggle annual/i.test(s.name))).toBe(true);
    expect(plan.steps.every((s, i) => s.step_number === i + 1)).toBe(true);
  });

  it("LLM planner parses JSON responses and falls back to heuristic on failure", async () => {
    const okFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "LLM Plan",
                    steps: [
                      { step_number: 1, name: "Go", action: "goto", target: "/home", value: "", options: {} },
                      { step_number: 2, name: "Check", action: "assert_visible", target: "Welcome", value: "", options: {} },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const llm = new LLMStepPlanner({ apiKey: "k", baseUrl: "https://llm.test/v1", model: "m1", fetchImpl: okFetch });
    const plan = await llm.plan("ignored", "https://base.test");
    expect(plan.source).toBe("llm");
    expect(plan.model).toBe("m1");
    expect(plan.title).toBe("LLM Plan");
    expect(plan.steps[0]).toMatchObject({ action: "goto", target: "https://base.test/home" });
    expect(plan.steps[1]).toMatchObject({ action: "assert_visible", target: "Welcome" });

    const badFetch: typeof fetch = () => Promise.reject(new Error("network down"));
    const fallback = new LLMStepPlanner({ apiKey: "k", model: "m2", fetchImpl: badFetch });
    const fbPlan = await fallback.plan("1) Open /x\n2) verify hello", "https://base.test");
    expect(fbPlan.source).toBe("heuristic");
    expect(fbPlan.model).toBe("m2 (fallback)");
    expect(fbPlan.steps.length).toBeGreaterThan(0);

    expect(createStepPlanner({ apiKey: "" })).toBeInstanceOf(HeuristicStepPlanner);
    expect(createStepPlanner({ apiKey: "x", fetchImpl: okFetch })).toBeInstanceOf(LLMStepPlanner);
  });

  it("evaluates scenario execution results into deterministic check outcomes", () => {
    expect(evaluateScenarioCheck(null)).toMatchObject({
      status: CheckStatus.BLOCKED,
      actual: "No scenario execution results were captured.",
      evidence: [],
    });

    const passExec: ScenarioExecutionResult = {
      title: "T",
      target_url: "https://example.test",
      passed: true,
      total_steps: 2,
      passed_steps: 2,
      failed_steps: 0,
      skipped_steps: 0,
      duration_ms: 10,
      results: [],
      evidence_refs: { scenario_results: "e/results.json", extra: "e/shot.png" },
      error: "",
    };
    expect(evaluateScenarioCheck(passExec)).toMatchObject({
      status: CheckStatus.PASSED,
      actual: "All 2 scenario step(s) executed successfully.",
      evidence: ["e/results.json", "e/shot.png"],
      metadata: { total_steps: 2, passed_steps: 2, failed_steps: 0, skipped_steps: 0, scenario_title: "T" },
    });

    const failExec: ScenarioExecutionResult = {
      ...passExec,
      passed: false,
      passed_steps: 1,
      failed_steps: 1,
      error: "Step 2 (Click Submit) failed: timeout",
    };
    const failed = evaluateScenarioCheck(failExec);
    expect(failed.status).toBe(CheckStatus.FAILED);
    expect(failed.actual).toContain("Scenario failed");
    expect(failed.actual).toContain("Step 2");
    expect(failed.findings).toHaveLength(1);
    expect(failed.findings[0]).toMatchObject({
      severity: Severity.HIGH,
      domain: "functional",
      strength: Strength.OBSERVED,
      location: "https://example.test",
      tags: ["scenario", "steps", "functional"],
    });
    expect(failed.findings[0]?.title).toContain("Scenario step failed");
  });
});
