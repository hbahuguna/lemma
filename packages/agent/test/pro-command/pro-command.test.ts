import { describe, expect, it } from "vitest";

import { renderLemmaProSummary, routeSlashCommand } from "../../src/index.js";

describe("LEM-155 /lemma-pro command", () => {
  it("returns static summary with learn-more link when dashboard is off", () => {
    const routed = routeSlashCommand("/lemma-pro");
    expect(routed.decision.kind).toBe("known");
    expect((routed.decision as any).command).toBe("/lemma-pro");
    expect((routed.decision as any).dashboard_route).toContain("/pro");
    expect(routed.message).toContain("Dashboard is off");
    expect(routed.message).toContain("https://lemma.dev/pro");
    expect(routed.message).toContain("informational only");
    expect(routed.message).toContain("does not start a checkout");
    expect(routed.message).toContain("does not collect data");
    expect(routed.message).toContain("does not require an account");
  });

  it("returns dashboard-routed summary with same learn-more link when dashboard is running", () => {
    const msg = renderLemmaProSummary({ dashboardRunning: true, dashboardBaseUrl: "http://127.0.0.1:9999", route: "/pro" });
    expect(msg).toContain("Dashboard (running)");
    expect(msg).toContain("http://127.0.0.1:9999/pro");
    expect(msg).toContain("https://lemma.dev/pro");
    expect(msg).toContain("informational only");
  });
});
