import { describe, expect, it } from "vitest";

import { RiskAnalyzer, Severity, analyzeRisk, normalizeTarget } from "../../src/index.js";

const TARGET = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
const COMMITTED_ENV_TITLE = "Committed environment files may expose live configuration";
const NO_CI_TITLE = "Test evidence is not refreshed by continuous integration";

describe("LEM-036 risk tracked-file parity", () => {
  it("uses tracked env files when tracked_available and ignores untracked-only env files", () => {
    const risksTracked = analyzeRisk(
      TARGET,
      "",
      {
        available: true,
        tracked_available: true,
        env_files_tracked: [".env", ".env.production"],
        env_files: [".env", ".env.production", ".env.local"],
        env_files_ignored: [".env.local"],
        test_files: ["a.test.ts"],
        ci_files: [".github/workflows/ci.yml"],
      },
      false,
    );
    const envRisk = risksTracked.find((r) => r.title === COMMITTED_ENV_TITLE);
    expect(envRisk).toMatchObject({ priority: Severity.HIGH, domain: "security", source: "inventory" });
    expect(envRisk?.evidence).toEqual(["Committed env files: .env, .env.production"]);

    const risksIgnoredOnly = analyzeRisk(
      TARGET,
      "",
      {
        available: true,
        tracked_available: true,
        env_files_tracked: [],
        env_files: [".env.local"],
        env_files_ignored: [".env.local"],
        test_files: ["a.test.ts"],
        ci_files: [".github/workflows/ci.yml"],
      },
      false,
    );
    expect(risksIgnoredOnly.some((r) => r.title === COMMITTED_ENV_TITLE)).toBe(false);
  });

  it("falls back to env_files when tracked status is unavailable", () => {
    const risks = new RiskAnalyzer(
      TARGET,
      "",
      {
        available: true,
        tracked_available: false,
        env_files: [".env", ".env.local"],
        test_files: ["a.test.ts"],
        ci_files: ["Jenkinsfile"],
      },
      false,
    ).analyze();
    const envRisk = risks.find((r) => r.title === COMMITTED_ENV_TITLE);
    expect(envRisk?.evidence).toEqual(["Committed env files: .env, .env.local"]);
  });

  it("drives CI-refresh risk from scoped ci_files so untracked-only CI is treated as absent in tracked scope", () => {
    const risksNoCommittedCi = analyzeRisk(
      TARGET,
      "",
      {
        available: true,
        tracked_available: true,
        env_files_tracked: [],
        test_files: ["a.test.ts"],
        ci_files: [], // scoped inventory: untracked-only CI filtered out
      },
      false,
    );
    const ciRisk = risksNoCommittedCi.find((r) => r.title === NO_CI_TITLE);
    expect(ciRisk).toMatchObject({ priority: Severity.LOW, domain: "reliability", source: "inventory" });
    expect(ciRisk?.evidence).toEqual(["No CI configuration found."]);

    const risksCommittedCi = analyzeRisk(
      TARGET,
      "",
      {
        available: true,
        tracked_available: true,
        env_files_tracked: [],
        test_files: ["a.test.ts"],
        ci_files: [".github/workflows/ci.yml"],
      },
      false,
    );
    expect(risksCommittedCi.some((r) => r.title === NO_CI_TITLE)).toBe(false);
  });
});
