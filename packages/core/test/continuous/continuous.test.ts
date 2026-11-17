import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { RegressionStore, StateError, readContinuousHistory, runContinuous } from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("LEM-194 continuous workflows (core)", () => {
  it("runs each trigger and writes durable history under .lemma/continuous/<trigger>/", async () => {
    const root = await mk("lemma-cont-");
    let fixed = 0;
    const now = () => new Date(1700000000000 + (fixed++) * 1000).toISOString();

    for (const trigger of ["pr", "nightly", "scheduled"] as const) {
      const res = await runContinuous({ trigger, config: { root, now, run: async () => ({ status: "completed", run_id: `${trigger}-1` }) } });
      expect(res.trigger).toBe(trigger);
      expect(res.entry.schema_version).toBe("lemma.continuous_history/v1");
      expect(res.entry.status).toBe("completed");
      const latest = JSON.parse(await readFile(path.join(root, ".lemma", "continuous", trigger, "latest.json"), "utf8"));
      expect(latest.id).toBe(res.entry.id);
      const history = await readContinuousHistory(root, trigger);
      expect(history.length).toBe(1);
      expect(history[0]!.id).toBe(res.entry.id);
      expect(res.entry_path.startsWith(path.join(root, ".lemma", "continuous", trigger, "history"))).toBe(true);
    }
  });

  it("PR validation uses bounded subset; nightly runs full default catalog plus promoted regressions", async () => {
    const root = await mk("lemma-cont-scope-");
    // seed promoted regression
    const store = new RegressionStore({ root });
    await store.promote({ findingId: "finding-x", lifecycleStep: "candidate", fingerprint: "fp1" });
    await store.promote({ findingId: "finding-x", lifecycleStep: "observed", fingerprint: "fp1" });
    await store.promote({ findingId: "finding-x", lifecycleStep: "repeatable", fingerprint: "fp1" });
    await store.promote({ findingId: "finding-x", lifecycleStep: "promoted", fingerprint: "fp1" });

    const pr = await runContinuous({ trigger: "pr", config: { root, now: () => "2026-01-01T00:00:00.000Z", prSubsetChecks: ["static.integrity", "test.functionality"], run: async () => ({ status: "completed" }) } });
    expect(pr.entry.scope.mode).toBe("bounded_subset");
    expect(pr.entry.scope.check_ids).toEqual(["static.integrity", "test.functionality"]);
    expect(pr.entry.scope.promoted_regression_checks).toEqual([]);
    expect(pr.entry.scope.documented).toMatch(/bounded subset/i);

    const nightly = await runContinuous({ trigger: "nightly", config: { root, now: () => "2026-01-01T00:00:01.000Z", run: async () => ({ status: "completed" }) } });
    expect(nightly.entry.scope.mode).toBe("full_default_plus_promoted_regressions");
    expect(nightly.entry.scope.promoted_regression_checks.some((r) => r.finding_id === "finding-x")).toBe(true);
    expect(nightly.entry.scope.check_ids.some((id) => id.startsWith("regression:"))).toBe(true);
    expect(nightly.entry.scope.documented).toMatch(/full default catalog plus promoted regressions/i);

    const scheduled = await runContinuous({ trigger: "scheduled", config: { root, now: () => "2026-01-01T00:00:02.000Z", run: async () => ({ status: "completed" }) } });
    expect(scheduled.entry.scope.mode).toBe("full_default_plus_promoted_regressions");
  });

  it("renders one marker-based PR summary per LEM-136 contract", async () => {
    const modPath = path.resolve(process.cwd(), "../../.github/actions/quality-harness/pr-comment.mjs");
    const mod = await import(pathToFileURL(modPath).href);
    const body = mod.renderPrComment({ run_id: "r1", status: "completed", decision: { decision: "ship" }, findings: [], blockers: [] }, { reportPath: ".lemma/report.json" });
    expect(body.includes(mod.COMMENT_MARKER)).toBe(true);
    expect(body.match(new RegExp(mod.COMMENT_MARKER, "g"))?.length).toBe(1);
    expect(body).toMatch(/Lemma Release Confidence/);
  });

  it("bounds continuous history retention (documented)", async () => {
    const root = await mk("lemma-cont-ret-");
    let i = 0;
    const now = () => new Date(1700000000000 + (i++) * 1000).toISOString();
    for (let n = 0; n < 5; n++) await runContinuous({ trigger: "pr", config: { root, retention: 2, now, run: async () => ({ status: "completed" }) } });
    const history = await readContinuousHistory(root, "pr");
    expect(history.length).toBe(2);
  });

  it("corruption raises typed error and never corrupts the run", async () => {
    const root = await mk("lemma-cont-corrupt-");
    await runContinuous({ trigger: "nightly", config: { root, now: () => "2026-01-01T00:00:00.000Z", run: async () => ({ status: "completed" }) } });
    const histDir = path.join(root, ".lemma", "continuous", "nightly", "history");
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(histDir)).filter((f) => f.endsWith(".json"));
    await writeFile(path.join(histDir, files[0]!), "{not-json", "utf8");

    await expect(readContinuousHistory(root, "nightly")).rejects.toBeInstanceOf(StateError);

    // run still proceeds and writes valid durable history without mutating/corrupting existing entries
    const before = await readdir(histDir);
    await runContinuous({ trigger: "nightly", config: { root, now: () => "2026-01-01T00:00:05.000Z", run: async () => ({ status: "completed" }) } });
    const after = await readdir(histDir);
    expect(after.length).toBe(before.length + 1);
    // corrupt file preserved (never "fixed"/corrupted by run)
    const corrupt = await readFile(path.join(histDir, files[0]!), "utf8");
    expect(corrupt).toBe("{not-json");
  });
});
