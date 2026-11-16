import { describe, expect, it } from "vitest";

import { routeSlashCommand } from "../../src/index.js";

describe("LEM-157 specialist routing (slash commands)", () => {
  it("routes specialist slash commands through the agent-loop slash router", () => {
    const sec = routeSlashCommand("/lemma-security /tmp/demo");
    expect(sec.decision.kind).toBe("known");
    expect((sec.decision as any).pro_specialist).toBe("security");
    expect((sec.decision as any).intent).toBe("pro.specialist.security");
    expect((sec.decision as any).pro_target).toContain("/tmp/demo");

    const conf = routeSlashCommand("/lemma-confidence");
    expect(conf.decision.kind).toBe("known");
    expect((conf.decision as any).pro_specialist).toBe("confidence");

    const perf = routeSlashCommand("/lemma-performance ./app");
    expect(perf.decision.kind).toBe("known");
    expect((perf.decision as any).pro_specialist).toBe("performance");

    const priv = routeSlashCommand("/lemma-privacy");
    expect(priv.decision.kind).toBe("known");
    expect((priv.decision as any).pro_specialist).toBe("privacy");

    const viaPro = routeSlashCommand("/lemma-pro security ./repo");
    expect(viaPro.decision.kind).toBe("known");
    expect((viaPro.decision as any).pro_specialist).toBe("security");
  });
});
