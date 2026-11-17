import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RegressionStore,
  StateError,
  buildReport,
  listPromotedRegressionChecks,
  listPromotedRegressions,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-regression-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const workflow = { id: "release-confidence", name: "Release Confidence", version: "1.0.0", phases: [] } as any;

function minimalState(evidenceDir: string): any {
  return {
    run_id: "run-r",
    workflow_id: "release-confidence",
    workflow_version: "1.0.0",
    target: { raw: ".", kind: "directory", resolved: "fixtures/target", source: null },
    intent: "test",
    status: "completed",
    current_phase: "confidence_scoring",
    phases: [],
    risks: [],
    checks: [],
    findings: [],
    invalid_findings: [],
    blockers: [],
    contract_failures: {},
    contract_failure_streaks: {},
    degraded_personas: [],
    confidence: { score: 0, band: "none", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "warn", reasons: [] } },
    kill_switch: { triggered: false, reason: "", manual: false, triggered_at: null },
    inventory: {},
    personas: [],
    options: {},
    evidence_dir: evidenceDir,
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    halted_reason: "",
    error: "",
    seed: null,
    clock_mode: "real",
    mode: "test",
    run_size: "medium",
    perspectives_count: 4,
    coverage_notes: [],
  };
}

describe("LEM-189 regression-promotion lifecycle", () => {
  it("supports each transition and writes atomically to .lemma/regressions/<id>.json", async () => {
    await withTempDir(async (root) => {
      const store = new RegressionStore({ root });
      const fp = "fp-same";
      const c = await store.promote({ findingId: "F-1", lifecycleStep: "candidate", fingerprint: fp });
      expect(c.lifecycle_step).toBe("candidate");
      const o = await store.promote({ findingId: "F-1", lifecycleStep: "observed", fingerprint: fp });
      expect(o.lifecycle_step).toBe("observed");
      const r = await store.promote({ findingId: "F-1", lifecycleStep: "repeatable", fingerprint: fp });
      expect(r.lifecycle_step).toBe("repeatable");
      expect(r.repeatable_observations).toBeGreaterThanOrEqual(1);
      const p = await store.promote({ findingId: "F-1", lifecycleStep: "promoted", fingerprint: fp });
      expect(p.lifecycle_step).toBe("promoted");
      expect(p.promoted).toBe(true);

      const recPath = path.join(root, ".lemma", "regressions", `${p.regression_id}.json`);
      const raw = JSON.parse(await fs.readFile(recPath, "utf8"));
      expect(raw.schema_version).toBe("lemma.regression/v1");
      expect(raw.lifecycle_history).toEqual(["candidate", "observed", "repeatable", "promoted"]);
    });
  });

  it("rejects skip transitions and enforces promoted requires repeatable observation with same fingerprint", async () => {
    await withTempDir(async (root) => {
      const store = new RegressionStore({ root });
      await expect(store.promote({ findingId: "F-skip", lifecycleStep: "observed" })).rejects.toBeInstanceOf(StateError);
      await expect(store.promote({ findingId: "F-skip", lifecycleStep: "observed" })).rejects.toThrow(/Skip transition/);

      await store.promote({ findingId: "F-prom", lifecycleStep: "candidate", fingerprint: "fp1" });
      await store.promote({ findingId: "F-prom", lifecycleStep: "observed", fingerprint: "fp1" });
      // cannot promote without reaching repeatable
      await expect(store.promote({ findingId: "F-prom", lifecycleStep: "promoted", fingerprint: "fp1" })).rejects.toBeInstanceOf(StateError);
      await expect(store.promote({ findingId: "F-prom", lifecycleStep: "promoted", fingerprint: "fp1" })).rejects.toThrow(/Skip transition|repeatable/i);

      await store.promote({ findingId: "F-prom", lifecycleStep: "repeatable", fingerprint: "fp1" });
      await expect(store.promote({ findingId: "F-prom", lifecycleStep: "promoted", fingerprint: "fp1" })).resolves.toMatchObject({ lifecycle_step: "promoted" });
    });
  });

  it("appends audit events (JSONL) with previous/new state and stable ids", async () => {
    await withTempDir(async (root) => {
      const store = new RegressionStore({ root });
      const fp = "fp-audit";
      await store.promote({ findingId: "F-a", lifecycleStep: "candidate", fingerprint: fp });
      await store.promote({ findingId: "F-a", lifecycleStep: "observed", fingerprint: fp });
      await store.promote({ findingId: "F-a", lifecycleStep: "repeatable", fingerprint: fp });
      const promoted = await store.promote({ findingId: "F-a", lifecycleStep: "promoted", fingerprint: fp });

      const auditPath = path.join(root, ".lemma", "regressions", `${promoted.regression_id}.events.jsonl`);
      const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(4);
      const events = lines.map((l) => JSON.parse(l));
      expect(events[0].previous_state.lifecycle_step).toBe(null);
      expect(events[0].new_state.lifecycle_step).toBe("candidate");
      expect(events[1].previous_state.lifecycle_step).toBe("candidate");
      expect(events[1].new_state.lifecycle_step).toBe("observed");
      expect(events[3].previous_state.lifecycle_step).toBe("repeatable");
      expect(events[3].new_state.lifecycle_step).toBe("promoted");
      for (const e of events) {
        expect(typeof e.id).toBe("string");
        expect(e.id.length).toBeGreaterThan(0);
        expect(e.schema_version).toBe("lemma.regression.audit/v1");
        expect(e.regression_id).toBe(promoted.regression_id);
        expect(e.finding_id).toBe("F-a");
      }
    });
  });

  it("references promoted regressions from the report and exposes them as first-class checks for continuous workflows", async () => {
    await withTempDir(async (root) => {
      const store = new RegressionStore({ root });
      const fp = "fp-r";
      await store.promote({ findingId: "F-r", lifecycleStep: "candidate", fingerprint: fp });
      await store.promote({ findingId: "F-r", lifecycleStep: "observed", fingerprint: fp });
      await store.promote({ findingId: "F-r", lifecycleStep: "repeatable", fingerprint: fp });
      await store.promote({ findingId: "F-r", lifecycleStep: "promoted", fingerprint: fp });

      const promoted = await listPromotedRegressions(root);
      expect(promoted.length).toBe(1);
      expect(promoted[0]?.finding_id).toBe("F-r");

      // eligible for continuous workflows (LEM-182, LEM-194) as first-class checks
      const checks = await listPromotedRegressionChecks(root);
      expect(checks.length).toBe(1);
      expect(checks[0]).toMatchObject({ kind: "regression", finding_id: "F-r", promoted: true, lifecycle_step: "promoted" });
      expect(String(checks[0]?.id)).toMatch(/^regression:/);

      // referenced from report
      const evidenceDir = path.join(root, ".lemma", "evidence", "run-r");
      await fs.mkdir(evidenceDir, { recursive: true });
      const report = buildReport(minimalState(path.relative(process.cwd(), evidenceDir)), workflow, {}) as any;
      // depending on cwd inference, also try with absolute root context via options
      const report2 = buildReport({ ...minimalState(evidenceDir), options: { root } }, workflow, {}) as any;
      const regs = (report.regressions?.promoted?.length ? report.regressions.promoted : report2.regressions?.promoted) ?? [];
      expect(Array.isArray(regs)).toBe(true);
      expect(regs.length).toBeGreaterThanOrEqual(1);
      expect(regs[0].finding_id || regs[0].regression_id).toBeTruthy();
    });
  });
});
