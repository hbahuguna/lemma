import { describe, expect, it } from "vitest";

import { routeSlashCommand } from "../../src/index.js";

describe("LEM-163 model-eval routing (slash commands)", () => {
  it("routes /lemma-eval and /eval through the agent-loop slash router", () => {
    const a = routeSlashCommand("/lemma-eval --cases evals/cases/sample");
    expect(a.decision.kind).toBe("known");
    expect((a.decision as any).intent).toBe("pro.model_eval");
    expect((a.decision as any).pro_model_eval).toBe(true);
    expect((a.decision as any).model_eval_cases).toBe("evals/cases/sample");

    const b = routeSlashCommand("/eval");
    expect(b.decision.kind).toBe("known");
    expect((b.decision as any).pro_model_eval).toBe(true);
  });
});
