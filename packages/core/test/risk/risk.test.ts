import { describe, expect, it } from "vitest";

import {
  PRIORITY_MULTIPLIER,
  RiskAnalyzer,
  Severity,
  analyzeRisk,
  normalizeTarget,
} from "../../src/index.js";

describe("LEM-024 risk analysis", () => {
  it("produces baseline intent/scope risks and intent-keyword risks with evidence and multipliers", () => {
    const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
    const risks = analyzeRisk(target, "Add login and checkout for onboarding", {}, false);
    expect(risks[0]).toMatchObject({
      id: "risk-01",
      title: "The stated customer outcome may not be delivered",
      priority: Severity.HIGH,
      domain: "functional",
      source: "intent",
      weight_multiplier: PRIORITY_MULTIPLIER[Severity.HIGH],
    });
    expect(risks[0]?.evidence).toEqual(["Intent: Add login and checkout for onboarding"]);
    expect(risks.some((r) => r.title === "Identity and session boundaries may fail open" && r.domain === "security")).toBe(true);
    expect(risks.some((r) => r.title === "Money, entitlements, and usage accounting may be wrong")).toBe(true);
    expect(risks.some((r) => r.title === "The self-serve activation path may lose or mislead a new customer")).toBe(true);
    // source-only when browser not planned and target not url
    expect(risks.some((r) => r.title === "Source-only evidence cannot establish rendered behavior")).toBe(true);
  });

  it("adds target/inventory-driven risks including tracked env handling and manifest/markup signals", () => {
    const urlTarget = normalizeTarget({ raw: "https://example.test", kind: "url", resolved: "https://example.test" });
    const inventory = {
      available: true,
      test_files: [],
      ci_files: [],
      manifests: ["package.json"],
      lockfiles: [],
      markup_files: ["a.tsx", "b.tsx"],
      tracked_available: true,
      env_files_tracked: [".env", ".env.local", "secrets.env", "x", "y", "z"],
      env_files: [".env.ignored"], // should not be used when tracked_available
    };
    const risks = new RiskAnalyzer(urlTarget, "", inventory, true).analyze();
    expect(risks.some((r) => r.title === "The live surface may expose transport, session, or runtime defects" && r.source === "target")).toBe(true);
    expect(risks.some((r) => r.title === "No automated regression signal protects this change")).toBe(true);
    expect(risks.some((r) => r.title === "Test evidence is not refreshed by continuous integration")).toBe(true);
    expect(risks.some((r) => r.title === "Dependency resolution is not reproducible")).toBe(true);
    const envRisk = risks.find((r) => r.title === "Committed environment files may expose live configuration");
    expect(envRisk?.evidence[0]).toContain(".env, .env.local, secrets.env, x, y");
    expect(envRisk?.evidence[0]).not.toContain(".env.ignored");
    expect(risks.some((r) => r.title === "Rendered interfaces may carry accessibility barriers" && r.evidence[0] === "2 markup/component files found.")).toBe(true);
  });

  it("dedupes by normalized title, numbers risk ids sequentially, and caps to 12", () => {
    const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
    // many intent keywords to trigger duplicates/overflow potential; dedupe keeps unique titles
    const risks = analyzeRisk(
      target,
      "login auth checkout payment billing signup onboarding accessibility keyboard upload import api webhook integration sync export search content performance latency",
      { available: true, test_files: [], ci_files: [], manifests: ["p"], lockfiles: [], markup_files: ["m"], env_files_tracked: [".env"], tracked_available: true },
      false,
    );
    const titles = risks.map((r) => r.title.toLowerCase().replace(/\W+/g, " ").trim());
    expect(new Set(titles).size).toBe(titles.length);
    expect(risks.length).toBeLessThanOrEqual(12);
    expect(risks.map((r) => r.id)).toEqual(risks.map((_, i) => `risk-${String(i + 1).padStart(2, "0")}`));
  });
});
