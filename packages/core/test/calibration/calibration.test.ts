import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CALIBRATION_SCHEMA,
  FORMULA_VERSION,
  loadCalibrationFixtures,
  runCalibration,
  writeCalibrationReport,
} from "../../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fixturesDir = path.join(repoRoot, "calibration", "fixtures");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cal-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

describe("LEM-070 labeled calibration fixtures and calibrate", () => {
  it("loads >=12 labeled fixtures covering ship, review, and hold outcomes", async () => {
    const fixtures = await loadCalibrationFixtures(fixturesDir);
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    const expected = new Set(fixtures.map((f) => f.expected_decision));
    expect([...expected].sort()).toEqual(["hold", "review", "ship"]);
  });

  it("produces a parity-aligned calibration report with required fields and summary counts", async () => {
    const fixtures = await loadCalibrationFixtures(fixturesDir);
    const reportUnknown = await runCalibration(fixturesDir);
    expect(isRecord(reportUnknown)).toBe(true);
    const report = reportUnknown;

    expect(report.schema_version).toBe(CALIBRATION_SCHEMA);
    expect(report.formula).toBe(FORMULA_VERSION);
    expect(report.fixture_count).toBe(fixtures.length);
    expect(Array.isArray(report.fixtures)).toBe(true);
    const fixtureResults = report.fixtures as unknown[];
    expect(fixtureResults).toHaveLength(fixtures.length);

    expect(isRecord(report.summary)).toBe(true);
    const summary = report.summary as Record<string, unknown>;
    expect(summary.decision_mismatches).toBe((summary.mismatched_fixtures as unknown[]).length);
    expect(typeof summary.decision_matches).toBe("number");
    expect((summary.decision_matches as number) + (summary.decision_mismatches as number)).toBe(report.fixture_count);
    expect(summary.expected_decisions).toEqual({
      ship: fixtures.filter((f) => f.expected_decision === "ship").length,
      review: fixtures.filter((f) => f.expected_decision === "review").length,
      hold: fixtures.filter((f) => f.expected_decision === "hold").length,
    });

    const decisions = new Set<string>();
    for (const item of fixtureResults) {
      expect(isRecord(item)).toBe(true);
      const f = item as Record<string, unknown>;
      decisions.add(String(f.expected_decision));
      for (const key of [
        "id",
        "label",
        "description",
        "expected_decision",
        "expected_gate",
        "actual_decision",
        "decision_match",
        "gate_match",
        "intentional_disagreement",
        "human_note",
        "score",
        "band",
        "gate",
        "gate_reasons",
        "coverage",
        "breakdown",
        "penalties",
        "domain_scores",
      ]) {
        expect(f).toHaveProperty(key);
      }
      expect(typeof f.score).toBe("number");
      expect(Array.isArray(f.gate_reasons)).toBe(true);
      expect(typeof f.decision_match).toBe("boolean");
    }
    expect([...decisions].sort()).toEqual(["hold", "review", "ship"]);

    const halted = fixtureResults
      .map((x) => (isRecord(x) ? x : null))
      .find((f) => f?.id === "halted-run");
    if (halted) {
      expect(halted.actual_decision).toBe("hold");
    }
  });

  it("writes calibration report JSON to output path (creating parent dirs) and returns report", async () => {
    await withTempDir(async (dir) => {
      const out = path.join(dir, "nested", "calibration-report.json");
      const reportUnknown = await writeCalibrationReport(fixturesDir, out);
      const report = reportUnknown;
      const writtenUnknown = JSON.parse(await readFile(out, "utf8")) as unknown;
      expect(isRecord(writtenUnknown)).toBe(true);
      const written = writtenUnknown as Record<string, unknown>;
      expect(written.schema_version).toBe(CALIBRATION_SCHEMA);
      expect(written.fixture_count).toBe(report.fixture_count);
      expect((written.summary as Record<string, unknown>).decision_matches).toBe(
        (report.summary as Record<string, unknown>).decision_matches,
      );
      expect((written.summary as Record<string, unknown>).mismatched_fixtures).toEqual(
        (report.summary as Record<string, unknown>).mismatched_fixtures,
      );
    });
  });
});
