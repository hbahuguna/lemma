import { describe, expect, it } from "vitest";

import { routeSlashCommand } from "../../src/index.js";

describe("LEM-158 proof routing (slash commands)", () => {
  it("routes /lemma-proof and /proof through the agent-loop slash router", () => {
    const a = routeSlashCommand('/lemma-proof --property "x > 0" --target ./src');
    expect(a.decision.kind).toBe("known");
    expect((a.decision as any).intent).toBe("pro.proof");
    expect((a.decision as any).pro_proof).toBe(true);
    expect((a.decision as any).proof_property).toBe("x > 0");
    expect((a.decision as any).proof_target).toBe("./src");

    const b = routeSlashCommand('/proof --property "invariant holds" --target .');
    expect(b.decision.kind).toBe("known");
    expect((b.decision as any).pro_proof).toBe(true);
    expect((b.decision as any).proof_property).toBe("invariant holds");
  });
});
