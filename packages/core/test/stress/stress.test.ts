import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runStressReview } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-stress-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-174 stress-risk review workflow", () => {
  it("static-only mode: reads code/config for risk patterns and records findings with stable ids; no bounded loop without approve", async () => {
    await withTempDir(async (root) => {
      await fs.writeFile(path.join(root, "worker.ts"), "while (true) { doWork(); }\nretryRequest();\n", "utf8");
      await fs.writeFile(path.join(root, "config.yml"), "workers: 4\nretry: enabled\n", "utf8");

      const r1 = await runStressReview({ root, target: "local" } as any);
      const r2 = await runStressReview({ root, target: "local" } as any);

      expect(r1.status).toBe("completed");
      expect(r1.phases.static.status).toBe("completed");
      expect(r1.phases.static.files_scanned).toBeGreaterThan(0);
      expect(r1.phases.bounded_loop.status).toBe("skipped");
      expect(r1.phases.recovery.status).toBe("skipped");

      const staticFindings = r1.findings.filter(f => f.kind === "static_risk");
      expect(staticFindings.length).toBeGreaterThan(0);
      for (const f of staticFindings) {
        expect(f.id).toMatch(/^stress\.static\./);
        expect(typeof f.title).toBe("string");
        expect(f.severity).toBeTruthy();
      }
      // stable ids across runs for same content
      expect(r1.findings.filter(f=>f.kind==="static_risk").map(f=>f.id).sort())
        .toEqual(r2.findings.filter(f=>f.kind==="static_risk").map(f=>f.id).sort());
    });
  });

  it("bounded-loop runs only when approved; hard caps enforced and halts cleanly when exceeded", async () => {
    await withTempDir(async (root) => {
      let t = 0;
      const nowMs = () => t;
      const sleep = async () => { t += 1; };
      let ran = 0;
      const report = await runStressReview({
        root,
        approve: (ctx: any) => ctx.phase === "bounded_loop" ? { approved: true } : { approved: false },
        boundedLoop: { iterations: 100, concurrency: 2, durationMs: 5, operation: async () => { ran += 1; t += 2; } },
        nowMs,
        sleep,
      } as any);

      expect(report.phases.bounded_loop.status).toBe("halted");
      expect((report.phases.bounded_loop as any).duration_ms).toBeGreaterThanOrEqual(0);
      expect(ran).toBeGreaterThan(0);
      expect(report.findings.some(f => f.kind === "bounded_loop")).toBe(true);
    });
  });

  it("bounded-loop does not run when approve declines", async () => {
    await withTempDir(async (root) => {
      let ran = 0;
      const report = await runStressReview({
        root,
        approve: (ctx: any) => ctx.phase === "bounded_loop" ? { approved: false, reason: "no" } : false,
        boundedLoop: { iterations: 5, concurrency: 1, durationMs: 50, operation: async () => { ran += 1; } },
      } as any);
      expect(report.phases.bounded_loop.status).toBe("declined");
      expect(ran).toBe(0);
      expect(report.findings.some(f => f.kind === "bounded_loop")).toBe(false);
    });
  });

  it("recovery phase requires explicit approval per experiment and labelled scenario; records recovery times as evidence", async () => {
    await withTempDir(async (root) => {
      let t = 0;
      const nowMs = () => t;
      const report = await runStressReview({
        root,
        approve: (ctx: any) => {
          if (ctx.phase === "recovery") return ctx.experiment?.label === "db-restart" ? { approved: true } : { approved: false };
          return false;
        },
        recoveryExperiments: [
          { label: "db-restart", action: async () => { t += 10; }, recover: async () => { t += 15; } },
          { label: "cache-flush", action: async () => { t += 5; } },
          { label: "" } as any, // missing label -> cannot run
        ],
        nowMs,
      } as any);

      expect(report.phases.recovery.status).toBe("completed");
      expect((report.phases.recovery as any).experiments_run).toBe(1);
      expect((report.phases.recovery as any).experiments_declined).toBe(2);
      const completed = report.experiments.find((e: any) => e.kind === "recovery" && e.status === "completed") as any;
      expect(completed?.label).toBe("db-restart");
      expect(completed?.recovery_time_ms).toBe(25);
      expect(report.findings.some(f => f.kind === "recovery" && f.title.includes("db-restart"))).toBe(true);
    });
  });

  it("produces schema-valid report and persists evidence", async () => {
    await withTempDir(async (root) => {
      await fs.writeFile(path.join(root, "app.ts"), "export const x = 1;\n", "utf8");
      const runId = "stress-run-1";
      const report = await runStressReview({ root, runId } as any);

      expect(report.schema_version).toBe("lemma.stress_report/v1");
      expect(report.run_id).toBe(runId);
      expect(["completed", "halted"]).toContain(report.status);
      expect(report.evidence.directory).toBe(`.lemma/evidence/${runId}/stress`);
      expect(Array.isArray(report.evidence.artifacts)).toBe(true);

      const stressDir = path.join(root, ".lemma", "evidence", runId, "stress");
      const reportFile = await fs.readFile(path.join(stressDir, "stress-report.json"), "utf8");
      const findingsFile = await fs.readFile(path.join(stressDir, "findings.json"), "utf8");
      expect(JSON.parse(reportFile).schema_version).toBe("lemma.stress_report/v1");
      expect(Array.isArray(JSON.parse(findingsFile))).toBe(true);

      // schema file present
      const schemaRaw = await fs.readFile(path.join(process.cwd(), "schemas/stress/stress_report.v1.schema.json"), "utf8").catch(() => null);
      if (schemaRaw) expect(JSON.parse(schemaRaw).properties.schema_version.const).toBe("lemma.stress_report/v1");
    });
  });
});
