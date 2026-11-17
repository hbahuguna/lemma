import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, QuotaError as CloudQuotaError } from "@lemma/cloud";
import { ProUnavailableError, runCloudAssessment } from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };

describe("LEM-196 cloud execution with parallel agents", () => {
  it("unlicensed invocation returns ProUnavailableError (no partial execution)", async () => {
    const root = await mk("lemma-pro-cloud-");
    let called = 0;
    await expect(runCloudAssessment({
      root,
      tenants: [{ id: "t1" }],
      plan: { agents: [{ id: "a1", tenant_id: "t1" }] },
      license: null,
      executeAgent: async () => { called++; return { agent_id: "a1", tenant_id: "t1", status: "completed" }; },
    })).rejects.toBeInstanceOf(ProUnavailableError);
    expect(called).toBe(0);
  });

  it("runs agents in parallel up to allowed parallelism and isolates each agent .lemma sub-tree", async () => {
    const root = await mk("lemma-pro-cloud-par-");
    const queue = new JobQueue(root, { tenantRoot: path.join(root, ".lemma", "tenants") });
    let active = 0, maxActive = 0;
    const sandboxes = new Set<string>();
    const report = await runCloudAssessment({
      root,
      license: licensed,
      tenants: [{ id: "t1" }, { id: "t2" }],
      plan: { agents: [{ id: "a1", tenant_id: "t1" }, { id: "a2", tenant_id: "t2" }, { id: "a3", tenant_id: "t1" }] },
      parallelism: 2,
      queue,
      executeAgent: async (input) => {
        active++; maxActive = Math.max(maxActive, active);
        sandboxes.add(input.lemma_dir);
        // isolation: each agent has its own tenant-scoped sandbox .lemma sub-tree
        expect(input.lemma_dir).toContain(path.join(".lemma", "tenants", input.agent.tenant_id, "agents", input.agent.id, ".lemma"));
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { agent_id: input.agent.id, tenant_id: input.agent.tenant_id, status: "completed", report: { agent: input.agent.id, sandbox: input.sandbox_root }, findings: [{ id: `f-${input.agent.id}` }] };
      },
    });

    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(report.parallelism.requested).toBe(2);
    expect(report.parallelism.allowed).toBe(2);
    expect(report.parallelism.enforced).toBe(true);
    expect(sandboxes.size).toBe(3);
    expect(report.per_agent_reports).toHaveLength(3);
  });

  it("enforces quota/tier parallelism limits and raises typed QuotaError when exceeded", async () => {
    const root = await mk("lemma-pro-cloud-quota-");
    await expect(runCloudAssessment({
      root,
      license: licensed,
      tenants: [{ id: "t1", tier: "basic" }],
      plan: { agents: [{ id: "a1", tenant_id: "t1" }, { id: "a2", tenant_id: "t1" }] },
      parallelism: 3,
      tierParallelismLimits: { basic: 2 },
      executeAgent: async (input) => ({ agent_id: input.agent.id, tenant_id: input.agent.tenant_id, status: "completed" }),
    })).rejects.toSatisfy((e: any) => e instanceof CloudQuotaError || e?.name === "QuotaError" || e?.name === "QuotaExceeded");

    // allowed when within quota/tier limit
    const ok = await runCloudAssessment({
      root,
      license: licensed,
      tenants: [{ id: "t1", tier: "basic", quota: { parallelism: 2 } }],
      plan: { agents: [{ id: "a1", tenant_id: "t1" }, { id: "a2", tenant_id: "t1" }] },
      parallelism: 2,
      tierParallelismLimits: { basic: 2 },
      executeAgent: async (input) => ({ agent_id: input.agent.id, tenant_id: input.agent.tenant_id, status: "completed" }),
    });
    expect(ok.status).toBe("completed");
  });

  it("records failed agents as explicit coverage gaps, never aggregated into a pass, and aggregates from per-agent reports", async () => {
    const root = await mk("lemma-pro-cloud-fail-");
    const report = await runCloudAssessment({
      root,
      license: licensed,
      tenants: [{ id: "t1" }],
      plan: { agents: [{ id: "ok1", tenant_id: "t1" }, { id: "bad1", tenant_id: "t1" }, { id: "bad2", tenant_id: "t1" }] },
      parallelism: 2,
      executeAgent: async (input) => {
        if (input.agent.id.startsWith("bad")) {
          if (input.agent.id === "bad2") throw new Error("boom");
          return { agent_id: input.agent.id, tenant_id: input.agent.tenant_id, status: "failed", error: "failed", report: null, findings: [] };
        }
        return { agent_id: input.agent.id, tenant_id: input.agent.tenant_id, status: "completed", report: { ok: true }, findings: [{ x: 1 }] };
      },
    });

    expect(report.status).toBe("partial");
    expect(report.aggregate.agent_count).toBe(3);
    expect(report.aggregate.completed).toBe(1);
    expect(report.aggregate.failed).toBe(2);
    expect(report.aggregate.coverage_gaps).toBe(2);
    expect(report.aggregate.findings).toBe(1);
    expect(report.aggregate.passed).toBe(false); // never aggregated into a pass
    expect(report.coverage_gaps).toHaveLength(2);
    expect(report.coverage_gaps.every((g) => g.explicit === true)).toBe(true);
    expect(report.agents.filter((a) => a.coverage_gap).map((a) => a.id).sort()).toEqual(["bad1", "bad2"]);
    // aggregate built from per-agent reports
    expect(report.per_agent_reports.map((r) => r.agent_id).sort()).toEqual(["bad1", "bad2", "ok1"]);

    const allFailed = await runCloudAssessment({
      root,
      license: licensed,
      tenants: [{ id: "t1" }],
      plan: { agents: [{ id: "bad", tenant_id: "t1" }] },
      parallelism: 1,
      executeAgent: async (input) => ({ agent_id: input.agent.id, tenant_id: input.agent.tenant_id, status: "failed", error: "nope" }),
    });
    expect(allFailed.status).toBe("failed");
    expect(allFailed.aggregate.passed).toBe(false);
  });
});
