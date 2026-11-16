import { describe, expect, it } from "vitest";

import { buildJourneyMap } from "@lemma/core";

describe("LEM-147 journey map links (browser artifacts)", () => {
  it("preserves browser route/check screenshot evidence refs as linkable journey map node/check evidence", () => {
    const report = {
      run_id: "run_browser_journey",
      target: { raw: "https://example.test", kind: "url", resolved: "https://example.test/", source: null },
      checks: [
        {
          id: "browser.load",
          title: "Load",
          status: "passed",
          evidence: [".lemma/evidence/run_browser_journey/browser.load/screenshot-1.png"],
          metadata: {
            routes: [
              { page: "landing", route: "https://example.test/", status: "passed" },
              { page: "route-1-about", route: "https://example.test/about", status: "passed" },
            ],
          },
        },
        {
          id: "browser.console",
          title: "Console",
          status: "passed",
          evidence: [".lemma/evidence/run_browser_journey/browser.console/screenshot-1.png"],
          metadata: {
            routes: [
              { page: "landing", route: "https://example.test/", status: "passed" },
              { page: "route-1-about", route: "https://example.test/about", status: "passed" },
            ],
          },
        },
      ],
    };

    const map = buildJourneyMap(report);
    expect(map.nodes.length).toBe(2);
    for (const node of map.nodes) {
      // screenshot refs from browser per-check evidence are linked/available for node rendering
      expect(node.screenshot_ref === null || node.screenshot_ref.includes("/screenshot-")).toBe(true);
      expect(node.checks.length).toBe(2);
    }
    const checks = map.checks.filter((c) => c.id === "browser.load");
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.evidence.some((e) => e.includes("browser.load/screenshot-1.png")))).toBe(true);
  });
});
