import { now } from "./determinism.js";
import { redactText } from "./redaction.js";
import { CheckStatus, Severity, Strength } from "./models.js";

export interface StepAction {
  step_number: number;
  name: string;
  action: string; // goto | click | fill | select | assert_text | assert_visible | assert_no_errors | wait | screenshot
  target: string;
  value: string;
  options: Record<string, unknown>;
  raw_instruction: string;
}

export interface ScenarioPlan {
  title: string;
  steps: StepAction[];
  source: string; // llm | heuristic | explicit
  model: string;
  target_url: string;
}

export interface StepResult {
  step_number: number;
  name: string;
  action: string;
  status: string; // passed | failed | skipped
  duration_ms: number;
  error: string;
  screenshot_ref: string;
  target: string;
  value: string;
}

export interface ScenarioExecutionResult {
  title: string;
  target_url: string;
  passed: boolean;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  skipped_steps: number;
  duration_ms: number;
  results: StepResult[];
  evidence_refs: Record<string, string>;
  error: string;
}

export interface ScenarioCheckFindingDraft {
  title: string;
  severity: string;
  domain: string;
  strength: string;
  consequence: string;
  location: string;
  reproduction: string;
  remediation: string;
  verification: string;
  tags: string[];
}

export interface ScenarioCheckOutcome {
  status: string;
  actual: string;
  evidence: string[];
  metadata: Record<string, unknown>;
  findings: ScenarioCheckFindingDraft[];
}

export interface StepPlanner {
  plan(text: string, baseUrl?: string): ScenarioPlan | Promise<ScenarioPlan>;
}

function cleanText(s: string): string {
  return (s || "").trim();
}

function urlJoin(baseUrl: string, route: string): string {
  if (!baseUrl) return route;
  try {
    return new URL(route, baseUrl).toString();
  } catch {
    if (route.startsWith("/")) return baseUrl.replace(/\/+$/, "") + route;
    return route;
  }
}

function stepAction(partial: Partial<StepAction> & Pick<StepAction, "step_number" | "name" | "action">): StepAction {
  return {
    step_number: partial.step_number,
    name: partial.name,
    action: partial.action,
    target: partial.target ?? "",
    value: partial.value ?? "",
    options: partial.options ?? {},
    raw_instruction: partial.raw_instruction ?? "",
  };
}

export class HeuristicStepPlanner implements StepPlanner {
  plan(text: string, baseUrl = ""): ScenarioPlan {
    const lines = (text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const steps: StepAction[] = [];
    const title = "Ticket Scenario";

    const joined = lines.join(" ");
    const rawItems: string[] = [];
    const stepsMatch = joined.match(
      /(?:steps\s+to\s+(?:reproduce|run)|steps|guidelines)[\s:]+(.*?)(?=$|\n\n|preconditions|acceptance\s+criteria)/i,
    );
    const workingText = stepsMatch?.[1] ? stepsMatch[1] : joined;

    const pattern = /(?:^|\s)(?:step\s*)?(\d+)[.)]\s*/gi;
    const splits = workingText.split(pattern);
    if (splits.length > 1) {
      const preamble = (splits[0] ?? "").trim();
      if (preamble) rawItems.push(preamble);
      for (let i = 1; i < splits.length; i += 2) {
        if (i + 1 < splits.length) {
          const item = (splits[i + 1] ?? "").trim();
          if (item) rawItems.push(item);
        }
      }
    } else {
      for (const line of lines) {
        const cleaned = line.replace(/^[-*•\d.)\s]+/, "").trim();
        if (cleaned) rawItems.push(cleaned);
      }
    }

    if (rawItems.length === 0 && cleanText(text)) {
      rawItems.push(...cleanText(text).split(/[.;]\s+/).map((s) => s.trim()).filter((s) => s.length > 3));
    }

    let stepIdx = 1;
    for (const item of rawItems) {
      const subActions = this.compileInstruction(item, stepIdx, baseUrl);
      for (const sa of subActions) {
        sa.step_number = stepIdx;
        steps.push(sa);
        stepIdx += 1;
      }
    }

    return { title, steps, source: "heuristic", model: "", target_url: baseUrl };
  }

  private compileInstruction(text: string, startIndex: number, baseUrl: string): StepAction[] {
    const actions: StepAction[] = [];
    const norm = cleanText(text);
    const parts = norm.split(/\s*(?:->|then|and then)\s*/i).map((p) => p.trim()).filter((p) => p.length > 0);
    const useParts = parts.length > 0 ? parts : [norm];

    for (const part of useParts) {
      const mFaq = part.match(/\b(?:open\s+faq|expand(?:\s+faq)?|click\s+faq)\s+["']?(.*?)["']?(?:\s*->|\.|$)/i);
      if (mFaq) {
        const label = (mFaq[1] ?? "").trim();
        actions.push(stepAction({ step_number: startIndex, name: `Expand FAQ: ${label}`, action: "click", target: label, raw_instruction: part }));
        continue;
      }

      const mGoto = part.match(/\b(?:open|go\s+to|navigate\s+to|visit)\s+([/\w\-.:?&=#]+)/i);
      if (mGoto && ((mGoto[1] ?? "").startsWith("/") || (mGoto[1] ?? "").includes("http") || (mGoto[1] ?? "").includes(".html"))) {
        const route = (mGoto[1] ?? "").trim();
        const target = urlJoin(baseUrl, route);
        actions.push(stepAction({ step_number: startIndex, name: `Navigate to ${route}`, action: "goto", target, raw_instruction: part }));
        continue;
      }

      const mToggle = part.match(/\b(?:toggle|switch\s+to)\s+["']?(.*?)["']?(?:\s+toggle)?(?:\s+with|\s+to|\.|$)/i);
      if (mToggle) {
        const label = (mToggle[1] ?? "").trim();
        actions.push(stepAction({ step_number: startIndex, name: `Toggle ${label}`, action: "click", target: label, raw_instruction: part }));
        continue;
      }

      const mFill = part.match(/\b(?:set|enter|type|change)\s+(?:the\s+)?(.*?)\s+to\s+["']?(.*?)["']?(?:\s*->|\.|$)/i);
      if (mFill) {
        const targetField = (mFill[1] ?? "").trim();
        const value = (mFill[2] ?? "").trim();
        actions.push(stepAction({ step_number: startIndex, name: `Set ${targetField} to ${value}`, action: "fill", target: targetField, value, raw_instruction: part }));
        continue;
      }

      const mClick = part.match(/\b(?:click(?:\s+on)?(?:\s+the)?)\s+(?:["']?(.*?)["']?)(?:\s*\(|\s*->|\.|$)/i);
      if (mClick) {
        let label = (mClick[1] ?? "").trim();
        const paren = part.match(/\((.*?)\)/);
        if (paren?.[1]) label = paren[1].trim();
        actions.push(stepAction({ step_number: startIndex, name: `Click ${label}`, action: "click", target: label, raw_instruction: part }));
        continue;
      }

      const mVerify = part.match(/\b(?:verify|confirm|check|see|ensure)\s+(.*?)(?:\s*->|\.|$)/i);
      if (mVerify) {
        const expectation = (mVerify[1] ?? "").trim();
        if (/no client errors|no error/i.test(expectation)) {
          actions.push(stepAction({ step_number: startIndex, name: "Confirm no client errors", action: "assert_no_errors", raw_instruction: part }));
        } else if (/five cards|plan cards/i.test(expectation)) {
          actions.push(stepAction({ step_number: startIndex, name: "Verify plan cards", action: "assert_visible", target: "Free", raw_instruction: part }));
        } else {
          actions.push(stepAction({ step_number: startIndex, name: `Verify ${expectation.slice(0, 40)}`, action: "assert_text", value: expectation, raw_instruction: part }));
        }
        continue;
      }

      if (/(click|select|choose|press)/i.test(part)) {
        actions.push(stepAction({ step_number: startIndex, name: `Action: ${part.slice(0, 40)}`, action: "click", target: part, raw_instruction: part }));
      } else {
        actions.push(stepAction({ step_number: startIndex, name: `Step: ${part.slice(0, 40)}`, action: "assert_visible", target: part, raw_instruction: part }));
      }
    }

    return actions;
  }
}

export interface LLMStepPlannerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fallback?: StepPlanner;
  fetchImpl?: typeof fetch;
}

const LLM_SYSTEM_PROMPT = `You are a software test step compiler.
Convert user stories, acceptance criteria, or testing steps into a JSON plan of executable browser actions.
Available actions:
- goto: {"action": "goto", "target": "/path or full URL", "name": "Navigate to ..."}
- click: {"action": "click", "target": "visible text or selector", "name": "Click ..."}
- fill: {"action": "fill", "target": "input name/label/placeholder/selector", "value": "text to enter", "name": "Set ..."}
- select: {"action": "select", "target": "select selector or label", "value": "option value/text", "name": "Select ..."}
- assert_text: {"action": "assert_text", "value": "expected text substring", "name": "Verify text ..."}
- assert_visible: {"action": "assert_visible", "target": "text or selector", "name": "Verify element ..."}
- assert_no_errors: {"action": "assert_no_errors", "name": "Confirm no client errors"}
- wait: {"action": "wait", "options": {"ms": 1000}, "name": "Wait for ..."}
- screenshot: {"action": "screenshot", "name": "label"}

Output ONLY valid JSON with this shape:
{
  "title": "Short title",
  "steps": [
    {
      "step_number": 1,
      "name": "Human-readable description",
      "action": "action_name",
      "target": "target or empty",
      "value": "value or empty",
      "options": {}
    }
  ]
}`;

export class LLMStepPlanner implements StepPlanner {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallback: StepPlanner;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LLMStepPlannerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ASSAY_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.ASSAY_LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.model ?? process.env.ASSAY_LLM_MODEL ?? "gpt-4o-mini";
    this.fallback = options.fallback ?? new HeuristicStepPlanner();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async plan(text: string, baseUrl = ""): Promise<ScenarioPlan> {
    if (!this.apiKey) {
      return this.fallback.plan(text, baseUrl);
    }
    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: LLM_SYSTEM_PROMPT },
        { role: "user", content: `Base URL: ${baseUrl}\n\nTicket instructions / steps:\n${text}` },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    };
    try {
      const resp = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as { title?: string; steps?: Array<Record<string, unknown>> };
      const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const steps: StepAction[] = rawSteps.map((s, i) => {
        let target = typeof s.target === "string" ? s.target : "";
        const action = typeof s.action === "string" ? s.action : "assert_visible";
        if (action === "goto" && baseUrl) target = urlJoin(baseUrl, target);
        return stepAction({
          step_number: typeof s.step_number === "number" ? s.step_number : i + 1,
          name: typeof s.name === "string" ? s.name : `Step ${i + 1}`,
          action,
          target,
          value: typeof s.value === "string" ? s.value : typeof s.value === "number" || typeof s.value === "boolean" ? String(s.value) : s.value == null ? "" : JSON.stringify(s.value),
          options: (s.options && typeof s.options === "object" ? (s.options as Record<string, unknown>) : {}),
          raw_instruction: typeof s.name === "string" ? s.name : "",
        });
      });
      return {
        title: typeof parsed.title === "string" && parsed.title ? parsed.title : "Ticket Scenario",
        steps,
        source: "llm",
        model: this.model,
        target_url: baseUrl,
      };
    } catch {
      const plan = await Promise.resolve(this.fallback.plan(text, baseUrl));
      return { ...plan, model: `${this.model} (fallback)` };
    }
  }
}

export function createStepPlanner(options: LLMStepPlannerOptions = {}): StepPlanner {
  const key = options.apiKey ?? process.env.ASSAY_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (key) return new LLMStepPlanner(options);
  return new HeuristicStepPlanner();
}

export function evaluateScenarioCheck(
  execution: ScenarioExecutionResult | null | undefined,
  _pageView?: unknown,
): ScenarioCheckOutcome {
  if (!execution) {
    return {
      status: CheckStatus.BLOCKED,
      actual: "No scenario execution results were captured.",
      evidence: [],
      metadata: {},
      findings: [],
    };
  }

  const evidence = Object.values(execution.evidence_refs ?? {}).filter((v) => typeof v === "string" && v.length > 0);
  const metadata: Record<string, unknown> = {
    total_steps: execution.total_steps,
    passed_steps: execution.passed_steps,
    failed_steps: execution.failed_steps,
    skipped_steps: execution.skipped_steps,
    scenario_title: execution.title,
  };

  if (execution.passed && execution.total_steps > 0) {
    return {
      status: CheckStatus.PASSED,
      actual: `All ${execution.passed_steps} scenario step(s) executed successfully.`,
      evidence,
      metadata,
      findings: [],
    };
  }

  const error = redactText(execution.error || `${execution.failed_steps} step(s) failed`);
  return {
    status: CheckStatus.FAILED,
    actual: `Scenario failed: ${error}`,
    evidence,
    metadata,
    findings: [
      {
        title: `Scenario step failed: ${error.slice(0, 80)}`,
        severity: Severity.HIGH,
        domain: "functional",
        strength: Strength.OBSERVED,
        consequence: "The customer journey or acceptance criteria specified in the ticket could not be completed.",
        location: execution.target_url,
        reproduction: "Execute the scenario steps against the target and observe the failure.",
        remediation: "Fix the underlying UI interaction, element selector, or route so the journey succeeds.",
        verification: "Re-run the scenario and confirm all steps pass.",
        tags: ["scenario", "steps", "functional"],
      },
    ],
  };
}

// helper to ensure deterministic timestamp usage available to consumers if needed
export const scenarioNow = now;
