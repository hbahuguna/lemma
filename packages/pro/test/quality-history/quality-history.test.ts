import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateError } from "@lemma/core";
import {
  ProUnavailableError,
  QUALITY_HISTORY_SCHEMA_VERSION,
  historyBuild,
  historyRead,
  inventoryBuild,
  validateQualityHistory,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const validLicense = {
  verification: {
    valid: true,
    reason: "ok",
    workspace_id: "ws_pro_hist",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_hist",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

function runReport(runId: string, score: number, decision: string, coverage: number, blockers: number, severities: Record<string, number>) {
  const findings = Object.entries(severities).flatMap(([sev, n], i) => Array.from({ length: n }, (_, j) => ({ id: `${runId}-${sev}-${i}-${j}`, severity: sev })));
  return {
    run_id: runId,
    generated_at: "2026-11-16T00:00:00Z",
    confidence: { score, coverage },
    decision: { decision },
    blockers: Array.from({ length: blockers }, (_, i) => ({ id: `b${i}` })),
    findings,
  };
}

describe("LEM-160 quality history and trend analysis", () => {
  it("rejects unlicensed build/read with ProUnavailableError and performs no reads/writes", async () => {
    const root = await mkdtemp("lemma-hist-unlic-");
    tempDirs.push(root);
    const histPath = path.join(root, ".lemma", "pro", "quality-history.json");
    const inv = { schema_version: "lemma.pro.test_inventory/v1", project_root: root, generated_at: "", history_cap: 20, runs_indexed: [], checks: [] } as any;
    await expect(historyBuild({ projectRoot: root, inventory: inv, window: 5, license: null } as any)).rejects.toBeInstanceOf(ProUnavailableError);
    const exists = await fs.stat(histPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    await fs.mkdir(path.dirname(histPath), { recursive: true });
    await fs.writeFile(histPath, "{bad json", "utf8");
    await expect(historyRead({ projectRoot: root, license: null, window: 5 } as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("builds versioned, schema-validated history with per-window trends and persists atomically with bounded growth", async () => {
    const root = await mkdtemp("lemma-hist-build-");
    tempDirs.push(root);
    const runs = [
      { run_id: "r1", results: [{ id: "a", status: "failed", persona: "functional", evidence: ["e1"] }, { id: "b", status: "passed", persona: "functional", evidence: ["e2"] }] },
      { run_id: "r2", results: [{ id: "a", status: "passed", persona: "functional", evidence: ["e3"] }, { id: "b", status: "failed", persona: "functional", evidence: ["e4"] }, { id: "c", status: "failed", persona: "security", evidence: ["e5"] }] },
      { run_id: "r3", results: [{ id: "b", status: "failed", persona: "functional", evidence: ["e6"] }, { id: "c", status: "failed", persona: "security", evidence: ["e7"] }, { id: "d", status: "failed", persona: "reliability", evidence: ["e8"] }] },
    ];
    const inv = await inventoryBuild({ projectRoot: root, runs, license: validLicense as any, historyCap: 10 });
    const richRuns = [
      runReport("r1", 60, "hold", 40, 1, { high: 1 }),
      runReport("r2", 75, "caution", 70, 0, { medium: 2 }),
      runReport("r3", 82, "ship", 90, 0, { low: 1 }),
    ];
    const hist = await historyBuild({ projectRoot: root, inventory: inv, runs: richRuns, window: 2, historyCap: 20, license: validLicense as any, now: () => "2026-11-16T12:00:00Z" });
    expect(hist.schema_version).toBe(QUALITY_HISTORY_SCHEMA_VERSION);
    expect(validateQualityHistory(hist).schema_version).toBe(QUALITY_HISTORY_SCHEMA_VERSION);
    expect(hist.window).toBe(2);
    expect(hist.runs.map((r) => r.run_id)).toEqual(["r2", "r3"]);
    expect(hist.score_trend.map((p) => p.run_id)).toEqual(["r2", "r3"]);
    expect(hist.decision_trend.map((p) => p.decision)).toEqual(["caution", "ship"]);
    expect(hist.coverage_trend.length).toBe(2);
    expect(hist.findings_by_severity_trend.length).toBe(2);
    expect(hist.blocker_trend.length).toBe(2);
    expect(hist.runs[0]!.findings_by_severity.medium).toBe(2);

    const histPath = path.join(root, ".lemma", "pro", "quality-history.json");
    const onDisk = JSON.parse(await fs.readFile(histPath, "utf8"));
    expect(onDisk.schema_version).toBe(QUALITY_HISTORY_SCHEMA_VERSION);

    const histCapped = await historyBuild({ projectRoot: root, inventory: inv, runs: richRuns, window: 10, historyCap: 2, license: validLicense as any });
    expect(histCapped.runs.length).toBeLessThanOrEqual(2);
    expect(histCapped.history_cap).toBe(2);
  });

  it("classifies check status changes (new/resolved/persistent) consistently with LEM-068 vocabulary", async () => {
    const root = await mkdtemp("lemma-hist-class-");
    tempDirs.push(root);
    const runs = [
      { run_id: "r1", results: [{ id: "a", status: "failed", persona: "functional", evidence: ["1"] }, { id: "b", status: "passed", persona: "functional", evidence: ["2"] }] },
      { run_id: "r2", results: [{ id: "a", status: "passed", persona: "functional", evidence: ["3"] }, { id: "b", status: "failed", persona: "functional", evidence: ["4"] }, { id: "c", status: "blocked", persona: "security", evidence: ["5"] }] },
      { run_id: "r3", results: [{ id: "a", status: "passed", persona: "functional", evidence: ["6"] }, { id: "b", status: "failed", persona: "functional", evidence: ["7"] }, { id: "c", status: "error", persona: "security", evidence: ["8"] }, { id: "d", status: "failed", persona: "reliability", evidence: ["9"] }] },
    ];
    const inv = await inventoryBuild({ projectRoot: root, runs, license: validLicense as any });
    const hist = await historyBuild({ projectRoot: root, inventory: inv, window: 3, license: validLicense as any });
    expect(hist.check_status_changes.baseline).toBe(false);
    expect(hist.check_status_changes.previous_run_id).toBe("r2");
    expect(hist.check_status_changes.current_run_id).toBe("r3");
    expect(hist.check_status_changes.new).toEqual(["d"]);
    expect(hist.check_status_changes.resolved).toEqual([]);
    expect(hist.check_status_changes.persistent).toEqual(["b", "c"]);

    const baseline = await historyBuild({ projectRoot: root, inventory: inv, window: 1, license: validLicense as any, persist: false });
    expect(baseline.check_status_changes.baseline).toBe(true);
    expect(baseline.check_status_changes.previous_run_id).toBeNull();
  });

  it("raises typed StateError on corrupt reads and preserves corrupt file", async () => {
    const root = await mkdtemp("lemma-hist-corrupt-");
    tempDirs.push(root);
    const histPath = path.join(root, ".lemma", "pro", "quality-history.json");
    await fs.mkdir(path.dirname(histPath), { recursive: true });
    await fs.writeFile(histPath, "{ not json", "utf8");
    await expect(historyRead({ projectRoot: root, license: validLicense as any })).rejects.toSatisfy((e: unknown) => e instanceof StateError);
    const raw = await fs.readFile(histPath, "utf8");
    expect(raw).toContain("not json");
  });
});
