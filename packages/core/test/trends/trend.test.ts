import { describe, expect, it } from "vitest";

import { computeTrendDiff } from "../../src/trends.js";

describe("LEM-068 run-to-run trend diff", () => {
  it("returns baseline with no fabricated deltas when no comparable previous run exists", () => {
    const trend = computeTrendDiff({
      runId: "run_current",
      targetRaw: "/repo/project",
      findingFingerprints: ["fp-a", "fp-b"],
      score: 88.8,
      historyRuns: [
        { run_id: "run_other_target", target: { raw: "/repo/other" }, finding_fingerprints: ["fp-a"], score: 90 },
        { run_id: "run_current", target: { raw: "/repo/project" }, finding_fingerprints: ["fp-old"], score: 70 },
      ],
    });

    expect(trend).toEqual({
      baseline: true,
      previous_run_id: null,
      new: [],
      resolved: [],
      persistent: [],
      score_delta: 0.0,
      coverage_delta: 0.0,
    });
  });

  it("selects most recent matching history entry for same target and computes sorted fingerprint diffs and score delta", () => {
    const trend = computeTrendDiff({
      runId: "run_3",
      targetRaw: "/repo/project",
      findingFingerprints: ["fp-b", "fp-c", "fp-b"],
      score: 72.24,
      historyRuns: [
        { run_id: "run_3", target: { raw: "/repo/project" }, finding_fingerprints: ["fp-x"], score: 10 },
        { run_id: "run_2", target: { raw: "/repo/project" }, finding_fingerprints: ["fp-a", "fp-b"], score: 80.19 },
        { run_id: "run_1", target: { raw: "/repo/project" }, finding_fingerprints: ["fp-z"], score: 99 },
      ],
    });

    expect(trend.baseline).toBe(false);
    expect(trend.previous_run_id).toBe("run_2");
    expect(trend.new).toEqual(["fp-c"]);
    expect(trend.resolved).toEqual(["fp-a"]);
    expect(trend.persistent).toEqual(["fp-b"]);
    expect(trend.score_delta).toBe(-8.0); // 72.24 - 80.19 = -7.95 -> rounded to 1 decimal
    expect(trend.coverage_delta).toBe(0.0);
  });

  it("accepts findings/confidence inputs and tolerates missing history fingerprint/score data", () => {
    const trend = computeTrendDiff({
      targetRaw: "https://example.test",
      findings: [{ fingerprint: "fp-1" }, { fingerprint: "fp-2" }, { fingerprint: "fp-1" }, {}],
      confidence: { score: 50 },
      history: {
        schema_version: "lemma.history/v1",
        runs: [
          { run_id: "prev", status: "completed", target: { raw: "https://example.test" } },
        ],
      },
    });

    expect(trend).toEqual({
      baseline: false,
      previous_run_id: "prev",
      new: ["fp-1", "fp-2"],
      resolved: [],
      persistent: [],
      score_delta: 50.0,
      coverage_delta: 0.0,
    });
  });
});
