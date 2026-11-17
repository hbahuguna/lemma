import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { QuotaError as CoreQuotaError } from "@lemma/core";
import { JobQueue, QuotaError as CloudQuotaError, QuotaStore, type QuotaPlan } from "@lemma/cloud";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export { CoreQuotaError, CloudQuotaError };

export interface CloudAgentSpec {
  id?: string;
  tenantId?: string;
  tenant_id?: string;
  workspaceId?: string;
  workspace_id?: string;
  target?: string;
  /** Optional per-agent plan slice (page/journey/dimension). */
  task?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CloudTenantSpec {
  id: string;
  plan?: QuotaPlan | Record<string, unknown> | string | null;
  quota?: { store?: QuotaStore; plan?: QuotaPlan | Record<string, unknown> | string | null };
  [key: string]: unknown;
}

export interface RunCloudAssessmentParams {
  tenants: CloudTenantSpec[] | Record<string, CloudTenantSpec>;
  plan: Record<string, unknown> & { agents?: CloudAgentSpec[]; tasks?: CloudAgentSpec[] };
  parallelism?: number;
  /** License/entitlement context (LEM-156). */
  license?: ProLicenseContext | null;
  /** Root for cloud state/queue/tenant sandboxes. */
  root?: string;
  /** Injectable queue (or factory will create one per root). */
  queue?: JobQueue;
  /** Injectable per-agent executor. Must return a per-agent report/result. */
  executeAgent?: (input: CloudAgentExecutionInput) => Promise<CloudAgentResult> | CloudAgentResult;
  /** Optional per-tier parallelism limits documentation/enforcement. */
  tierParallelismLimits?: Record<string, number>;
}

export interface CloudAgentExecutionInput {
  agent: CloudAgentSpec & { id: string; tenant_id: string };
  tenant: CloudTenantSpec;
  root: string;
  sandbox_root: string;
  lemma_dir: string;
  queue: JobQueue;
  plan: Record<string, unknown>;
  metering: { workspace: string; sink: string; run_id: string };
}

export interface CloudAgentResult {
  agent_id: string;
  tenant_id: string;
  status: "completed" | "failed" | "halted" | "error";
  report?: Record<string, unknown> | null;
  findings?: unknown[];
  coverage_gaps?: unknown[];
  error?: string | null;
  metering?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CloudAssessmentReport {
  schema_version: "lemma.pro.cloud_assessment/v1";
  status: "completed" | "partial" | "failed";
  parallelism: { requested: number; allowed: number; enforced: boolean; tier_limits?: Record<string, number> };
  tenants: string[];
  agents: Array<{ id: string; tenant_id: string; status: string; sandbox_root: string; job_id?: string; coverage_gap?: boolean }>;
  per_agent_reports: CloudAgentResult[];
  aggregate: {
    agent_count: number;
    completed: number;
    failed: number;
    coverage_gaps: number;
    findings: number;
    passed: false; // failed/partial agents are explicit coverage gaps, never aggregated into a pass
  };
  coverage_gaps: Array<{ agent_id: string; tenant_id: string; reason: string; explicit: true }>;
  metering: { workspaces: string[]; event_types: string[] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeTenants(input: RunCloudAssessmentParams["tenants"]): CloudTenantSpec[] {
  if (Array.isArray(input)) return input.map((t) => ({ ...t, id: String((t as any).id) }));
  if (isRecord(input)) return Object.entries(input).map(([id, t]) => ({ ...(t as any), id: String((t as any)?.id ?? id) }));
  return [];
}

function normalizeAgents(plan: RunCloudAssessmentParams["plan"], tenants: CloudTenantSpec[]): Array<CloudAgentSpec & { id: string; tenant_id: string }> {
  const raw = Array.isArray(plan.agents) ? plan.agents : Array.isArray((plan as any).tasks) ? (plan as any).tasks : [];
  if (raw.length) {
    return raw.map((a: any, i: number) => ({
      ...a,
      id: String(a?.id ?? `agent-${i + 1}`),
      tenant_id: String(a?.tenant_id ?? a?.tenantId ?? a?.workspace_id ?? a?.workspaceId ?? tenants[0]?.id ?? "default"),
    }));
  }
  // default: one agent per tenant
  return tenants.map((t, i) => ({ id: `agent-${i + 1}`, tenant_id: t.id, target: String((plan as any).target ?? "."), task: { tenant: t.id } }));
}

function ensureDirSync(p: string) { fs.mkdirSync(p, { recursive: true }); }

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function tierLimitFor(tenant: CloudTenantSpec, limits?: Record<string, number>): number | undefined {
  if (!limits) return undefined;
  const tier = String((tenant as any).tier ?? (tenant as any).plan_tier ?? (tenant as any).planTier ?? "");
  if (tier && limits[tier] !== undefined) return limits[tier];
  if (limits.default !== undefined) return limits.default;
  return undefined;
}

/**
 * Run multi-agent cloud assessment in parallel across tenant-scoped sandboxes.
 * Unlicensed invocation refuses with ProUnavailableError (no partial execution).
 */
export async function runCloudAssessment(params: RunCloudAssessmentParams): Promise<CloudAssessmentReport> {
  // Unlicensed invocation returns ProUnavailableError (LEM-156), before any work.
  if (!isProLicensed(params.license ?? null)) {
    throw new ProUnavailableError("cloud execution (parallel agent assessment)");
  }

  const root = path.resolve(params.root ?? process.cwd());
  const tenants = normalizeTenants(params.tenants);
  if (!tenants.length) throw new CloudQuotaError("At least one tenant is required for cloud assessment.");
  const agents = normalizeAgents(params.plan, tenants);
  const requestedParallelism = Math.max(1, Math.floor(Number(params.parallelism ?? agents.length) || 1));

  // Parallelism bounded by tenant quota (LEM-115) and documented per-tier limits.
  let allowedParallelism = requestedParallelism;
  for (const t of tenants) {
    const tierLimit = tierLimitFor(t, params.tierParallelismLimits);
    if (tierLimit !== undefined) allowedParallelism = Math.min(allowedParallelism, Math.max(1, Math.floor(tierLimit)));
    const quotaLimit = Number((t as any).quota?.max_parallel_agents ?? (t as any).quota?.parallelism ?? (t as any).max_parallel_agents);
    if (Number.isFinite(quotaLimit) && quotaLimit > 0) allowedParallelism = Math.min(allowedParallelism, Math.floor(quotaLimit));
  }
  allowedParallelism = Math.max(1, allowedParallelism);
  if (requestedParallelism > allowedParallelism) {
    throw new CloudQuotaError(`Requested parallelism ${requestedParallelism} exceeds tenant quota/tier limit ${allowedParallelism}.`);
  }

  // Use tenant queue (LEM-119)
  const queue = params.queue ?? new JobQueue(root, { tenantRoot: path.join(root, ".lemma", "tenants") });

  // Pre-validate quota consumption where quota stores provided (metering/quota integration)
  for (const t of tenants) {
    const store = t.quota?.store as QuotaStore | undefined;
    if (store && typeof (store as any).consume === "function") {
      // best-effort: ensure tenant can start at least 1 run/agent; do not mutate beyond check when possible
      try {
        if (typeof (store as any).check === "function") (store as any).check("runs", 1);
      } catch (e) {
        if (e instanceof CloudQuotaError || e instanceof CoreQuotaError || (e as any)?.name === "QuotaExceeded") throw e;
      }
    }
  }

  const executeAgent = params.executeAgent ?? (async (input) => ({
    agent_id: input.agent.id,
    tenant_id: input.agent.tenant_id,
    status: "completed" as const,
    report: { schema_version: "lemma.report/v1", status: "completed", tenant_id: input.agent.tenant_id, agent_id: input.agent.id },
    findings: [],
    coverage_gaps: [],
    error: null,
  }));

  const perAgent = await runWithConcurrency(agents, allowedParallelism, async (agent) => {
    const tenant = tenants.find((t) => t.id === agent.tenant_id) ?? tenants[0]!;
    // isolated tenant-scoped sandbox: each agent gets its own .lemma/ sub-tree
    const sandboxRoot = path.join(queue.tenantRootFor(agent.tenant_id), "agents", agent.id);
    const lemmaDir = path.join(sandboxRoot, ".lemma");
    ensureDirSync(lemmaDir);
    ensureDirSync(path.join(lemmaDir, "state"));
    ensureDirSync(path.join(lemmaDir, "evidence"));

    // submit to tenant queue (LEM-119) for traceability/scheduling
    const job = queue.submit(agent.tenant_id, String(agent.target ?? (params.plan as any).target ?? "."), {
      options: { agent_id: agent.id, tenant_id: agent.tenant_id, isolated_lemma_dir: lemmaDir, plan: params.plan },
      workspace: agent.tenant_id,
      metering_sink: ".lemma/metering/events.jsonl",
    });

    const metering = { workspace: agent.tenant_id, sink: ".lemma/metering/events.jsonl", run_id: `cloud-${job.job_id}-${randomUUID().slice(0, 8)}` };
    try {
      const result = await executeAgent({ agent, tenant, root, sandbox_root: sandboxRoot, lemma_dir: lemmaDir, queue, plan: params.plan, metering });
      const status = result.status === "completed" ? "completed" : result.status;
      if (status === "completed") {
        try { (queue as any).completeJob?.(job.job_id, { run_id: metering.run_id, status_detail: "completed" }); } catch {}
      } else {
        try { (queue as any).failJob?.(job.job_id, String(result.error || "agent failed"), { run_id: metering.run_id }); } catch {}
      }
      return { result: { ...result, agent_id: agent.id, tenant_id: agent.tenant_id }, sandboxRoot, jobId: job.job_id };
    } catch (err) {
      try { (queue as any).failJob?.(job.job_id, err instanceof Error ? err.message : String(err)); } catch {}
      return {
        result: {
          agent_id: agent.id,
          tenant_id: agent.tenant_id,
          status: "failed" as const,
          report: null,
          findings: [],
          coverage_gaps: [{ type: "agent_failure", reason: err instanceof Error ? err.message : String(err), explicit: true }],
          error: err instanceof Error ? err.message : String(err),
        },
        sandboxRoot,
        jobId: job.job_id,
      };
    }
  });

  const per_agent_reports = perAgent.map((p) => p.result);
  const coverage_gaps: CloudAssessmentReport["coverage_gaps"] = [];
  let completed = 0, failed = 0, findings = 0;
  const agentsMeta = perAgent.map((p) => {
    const ok = p.result.status === "completed" && !p.result.error;
    if (ok) completed++; else {
      failed++;
      // Failed agents recorded as explicit coverage gaps, never aggregated into a pass.
      coverage_gaps.push({ agent_id: p.result.agent_id, tenant_id: p.result.tenant_id, reason: String(p.result.error || p.result.status || "agent failed"), explicit: true });
    }
    if (Array.isArray(p.result.findings)) findings += p.result.findings.length;
    return { id: p.result.agent_id, tenant_id: p.result.tenant_id, status: p.result.status, sandbox_root: p.sandboxRoot, job_id: p.jobId, coverage_gap: !ok };
  });

  // aggregate built from per-agent reports
  const status = failed === 0 ? "completed" : completed === 0 ? "failed" : "partial";
  return {
    schema_version: "lemma.pro.cloud_assessment/v1",
    status,
    parallelism: { requested: requestedParallelism, allowed: allowedParallelism, enforced: true, ...(params.tierParallelismLimits ? { tier_limits: params.tierParallelismLimits } : {}) },
    tenants: tenants.map((t) => t.id),
    agents: agentsMeta,
    per_agent_reports,
    aggregate: {
      agent_count: agents.length,
      completed,
      failed,
      coverage_gaps: coverage_gaps.length,
      findings,
      passed: false,
    },
    coverage_gaps,
    metering: { workspaces: Array.from(new Set(agents.map((a) => a.tenant_id))), event_types: ["cloud.agent.started", "cloud.agent.completed", "cloud.agent.failed"] },
  };
}
