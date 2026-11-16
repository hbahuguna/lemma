import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runStateHunt } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-state-hunt-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function listArtifactHashes(root: string, runId: string): Promise<Record<string, string>> {
  const manifestPath = path.join(root, ".lemma", "evidence", runId, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const map: Record<string, string> = {};
  for (const e of manifest.evidence || []) {
    if (typeof e.path === "string" && typeof e.sha256 === "string") map[e.path] = e.sha256;
  }
  return map;
}

describe("LEM-175 state-hunting workflow", () => {
  it("plans and exercises bounded sequences (multi-tab, reload, export/import, malformed-data) with per-step screenshot+state snapshot evidence", async () => {
    await withTempDir(async (root) => {
      const report = await runStateHunt({
        root,
        target: "https://app.example.test",
        seed: "seed-1",
        clock: "frozen",
        frozenNow: "2026-01-01T00:00:00.000Z",
      } as any);

      expect(report.schema_version).toBe("lemma.state_hunt_report/v1");
      expect(report.status).toBe("completed");
      expect(report.sequences_exercised.length).toBeGreaterThan(0);
      const kinds = new Set(report.sequences_exercised.map(s => s.kind));
      expect(kinds.has("multi-tab")).toBe(true);
      expect(kinds.has("reload")).toBe(true);
      expect(kinds.has("export-import")).toBe(true);
      expect(kinds.has("malformed-data")).toBe(true);
      expect(report.coverage.steps_executed).toBeGreaterThan(0);

      const huntDir = path.join(root, ".lemma", "evidence", report.run_id, "state-hunt");
      const runDir = path.join(root, ".lemma", "evidence", report.run_id);
      const huntFiles = await fs.readdir(huntDir);
      const runFiles = await fs.readdir(runDir);
      const allFiles = [...huntFiles, ...runFiles];
      expect(allFiles.some(f => f.includes("screenshot"))).toBe(true);
      expect(allFiles.some(f => f.includes("state-snapshot"))).toBe(true);
      expect(report.evidence.artifacts.some((a: string) => a.includes("screenshot")) || report.evidence.artifacts.some((a: string) => a.includes("state-snapshot"))).toBe(true);
      // redaction applied (smoke: artifacts are readable JSON/text)
      const reportJson = await fs.readFile(path.join(huntDir, "state-hunt-report.json"), "utf8");
      expect(JSON.parse(reportJson).target.replace(/\/$/, "")).toBe("https://app.example.test");
    });
  });

  it("enforces maxSteps and wall-clock caps with halted status", async () => {
    await withTempDir(async (root) => {
      const bySteps = await runStateHunt({
        root,
        target: "https://app.example.test",
        maxSteps: 2,
        seed: 1,
        clock: "frozen",
        frozenNow: "2026-01-01T00:00:00.000Z",
      } as any);
      expect(bySteps.status).toBe("halted");
      expect(bySteps.halted_reason).toMatch(/maxSteps/);
      expect(bySteps.coverage.steps_executed).toBe(2);

      let t = 0;
      const byTime = await runStateHunt({
        root,
        target: "https://app.example.test",
        maxSteps: 100,
        wallClockMs: 5,
        seed: 1,
        nowMs: () => t,
        executeStep: async ({ action }) => { t += 10; return { action, snapshot: { storage: { a: 1 } }, screenshot: "x" }; },
      } as any);
      expect(byTime.status).toBe("halted");
      expect(byTime.halted_reason).toMatch(/wallClock/i);
    });
  });

  it("emits findings only when a documented invariant violation is observed; no bug => UNCHANGED coverage (never pass)", async () => {
    await withTempDir(async (root) => {
      const noBug = await runStateHunt({
        root,
        target: "https://app.example.test",
        seed: "clean",
        clock: "frozen",
        frozenNow: "2026-01-01T00:00:00.000Z",
        sequences: [{ kind: "reload", steps: [{ action: "capture_initial_state" }, { action: "reload" }] }],
        executeStep: async ({ action, previous }) => ({ action, snapshot: { storage: { ...(previous?.storage || {}), count: 1 } }, screenshot: "ok" }),
      } as any);
      expect(noBug.findings.length).toBe(0);
      expect(noBug.coverage.status).toBe("UNCHANGED");
      expect(noBug.status).toBe("completed");
      expect((noBug as any).decision).toBeUndefined();

      const buggy = await runStateHunt({
        root,
        target: "https://app.example.test",
        seed: "bug",
        clock: "frozen",
        frozenNow: "2026-01-01T00:00:00.000Z",
        sequences: [{ kind: "reload", id: "r1", steps: [{ action: "capture_initial_state" }, { action: "mutate_state" }, { action: "reload" }] }],
        executeStep: async ({ action, previous }) => {
          if (action === "mutate_state") return { action, snapshot: { storage: { count: 2 } }, screenshot: "mut" };
          if (action === "reload") return { action, snapshot: { storage: { count: 0 } }, screenshot: "lost" }; // violates persistence
          return { action, snapshot: { storage: { count: 1 } }, screenshot: "init" };
        },
      } as any);
      expect(buggy.findings.length).toBeGreaterThan(0);
      expect(buggy.coverage.status).toBe("CHANGED");
      expect(buggy.findings[0].invariant).toBeTruthy();
      expect(buggy.findings[0].evidence.length).toBeGreaterThan(0);
    });
  });

  it("is deterministic for same seed+frozen clock+target (same findings and artifact evidence fingerprints modulo volatile manifest fields)", async () => {
    await withTempDir(async (rootA) => {
      await withTempDir(async (rootB) => {
        const params = {
          target: "https://app.example.test",
          seed: "same-seed",
          clock: "frozen" as const,
          frozenNow: "2026-01-01T00:00:00.000Z",
          runId: "same-run",
          maxSteps: 12,
        };
        const a = await runStateHunt({ root: rootA, ...params } as any);
        const b = await runStateHunt({ root: rootB, ...params } as any);

        expect(a.findings).toEqual(b.findings);
        expect(a.coverage).toEqual(b.coverage);
        expect(a.sequences_exercised).toEqual(b.sequences_exercised);
        expect(a.deterministic).toEqual(b.deterministic);

        const ha = await listArtifactHashes(rootA, "same-run");
        const hb = await listArtifactHashes(rootB, "same-run");
        // artifact file hashes (screenshots/snapshots/reports etc.) should match; manifest itself is excluded from this map comparison by key? manifest entry exists
        const filter = (m: Record<string,string>) => Object.fromEntries(Object.entries(m).filter(([p]) => !p.endsWith("manifest.json")));
        expect(filter(ha)).toEqual(filter(hb));
      });
    });
  });
});
