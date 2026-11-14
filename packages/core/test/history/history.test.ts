import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { StateError, StateStore } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-history-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mkRun(
  store: StateStore,
  root: string,
  id: string,
  status: string,
  completed: string,
  extra: Record<string, unknown> = {},
) {
  const evidencePath = path.posix.join(".lemma", "evidence", id);
  const abs = path.join(root, evidencePath);
  await mkdir(abs, { recursive: true });
  await writeFile(path.join(abs, "artifact.txt"), id, "utf8");
  await store.recordRun({
    run_id: id,
    status,
    started_at: completed,
    completed_at: completed,
    evidence_dir: evidencePath,
    ...extra,
  });
}

describe("LEM-023 run history, retention, and prune", () => {
  it("records enriched versioned history, sorted newest-first with upsert by run id", async () => {
    await withTempDir(async (root) => {
      const store = new StateStore(root);
      await store.recordRun({
        run_id: "r1",
        status: "completed",
        workflow_id: "release-confidence",
        workflow_version: "1.0",
        started_at: "2026-11-14T01:00:00Z",
        completed_at: "2026-11-14T01:10:00Z",
        target: { raw: ".", kind: "directory", resolved: "/repo" },
        confidence: { score: 80.5, gate: { status: "pass" } },
        findings: [
          { severity: "high", fingerprint: "fp-b" },
          { severity: "high", fingerprint: "fp-a" },
          { severity: "low", fingerprint: "fp-a" },
          { severity: "info" },
        ],
        evidence_dir: ".lemma/evidence/r1",
      });
      await store.recordRun({
        run_id: "r2",
        status: "halted",
        started_at: "2026-11-14T02:00:00Z",
        completed_at: "2026-11-14T02:05:00Z",
        confidence: { score: 10 },
      });
      await store.recordRun(
        {
          run_id: "r1",
          status: "completed",
          started_at: "2026-11-14T01:00:00Z",
          completed_at: "2026-11-14T01:20:00Z",
          confidence: { score: 90 },
          findings: [{ severity: "medium", fingerprint: "fp-x" }],
          evidence_dir: ".lemma/evidence/r1",
        },
        { decision: { decision: "ship" } },
      );

      const history = await store.loadHistory();
      expect(history.schema_version).toBe("lemma.history/v1");
      expect(history.runs.map((r) => r.run_id)).toEqual(["r2", "r1"]);
      const r1 = history.runs.find((r) => r.run_id === "r1") as Record<string, unknown>;
      expect(r1.decision).toBe("ship");
      expect(r1.score).toBe(90);
      expect(r1.workflow_id).toBeUndefined(); // upsert replaced with second record
      expect(r1.evidence_path).toBe(".lemma/evidence/r1");
      expect(r1.finding_counts).toEqual({ critical: 0, high: 0, medium: 1, low: 0, info: 0 });
      expect(r1.finding_fingerprints).toEqual(["fp-x"]);
      const r2 = history.runs.find((r) => r.run_id === "r2") as Record<string, unknown>;
      expect(r2.decision).toBe("hold");
    });
  });

  it("prunes by keepRuns/olderThanDays with protections and writes index before evidence removal", async () => {
    await withTempDir(async (root) => {
      const store = new StateStore(root);
      await mkRun(store, root, "old-completed", "completed", "2026-10-01T00:00:00Z");
      await mkRun(store, root, "old-halted", "halted", "2026-10-02T00:00:00Z", { confidence: { score: 1 } });
      await mkRun(store, root, "mid", "failed", "2026-11-01T00:00:00Z");
      await mkRun(store, root, "latest", "completed", "2026-11-14T00:00:00Z");

      const pruned = await store.prune({ keepRuns: 2, olderThanDays: 10, now: "2026-11-14T12:00:00Z" });
      // protected: latest (newest), latest completed, all halted
      expect(pruned.retained).toEqual(expect.arrayContaining(["latest", "old-halted"]));
      expect(pruned.removed).toEqual(expect.arrayContaining(["mid"]));
      // old-completed is old and not latest completed -> removable
      expect(pruned.removed).toContain("old-completed");

      const after = await store.loadHistory();
      const ids = after.runs.map((r) => r.run_id);
      expect(ids).toContain("latest");
      expect(ids).toContain("old-halted");
      for (const id of pruned.removed) {
        expect(existsSync(path.join(root, ".lemma", "evidence", id))).toBe(false);
      }
      for (const id of pruned.retained) {
        expect(existsSync(path.join(root, ".lemma", "evidence", id))).toBe(true);
      }
    });
  });

  it("dryRun does not mutate history or evidence and invalid options fail safely", async () => {
    await withTempDir(async (root) => {
      const store = new StateStore(root);
      await mkRun(store, root, "a", "completed", "2026-10-01T00:00:00Z");
      await mkRun(store, root, "b", "completed", "2026-11-14T00:00:00Z");

      const beforeHistory = await store.loadHistory();
      const dry = await store.prune({ keepRuns: 1, dryRun: true, now: "2026-11-14T12:00:00Z" });
      expect(dry.dryRun).toBe(true);
      expect(dry.removed.length).toBeGreaterThan(0);
      const afterHistory = await store.loadHistory();
      expect(afterHistory.runs.map((r) => r.run_id)).toEqual(beforeHistory.runs.map((r) => r.run_id));
      for (const id of ["a", "b"]) {
        expect(existsSync(path.join(root, ".lemma", "evidence", id))).toBe(true);
      }

      await expect(store.prune({ keepRuns: -1 })).rejects.toBeInstanceOf(StateError);
      await expect(store.prune({ olderThanDays: -1 })).rejects.toBeInstanceOf(StateError);
      await expect(store.prune({ now: "not-a-date" })).rejects.toBeInstanceOf(StateError);
    });
  });
});
