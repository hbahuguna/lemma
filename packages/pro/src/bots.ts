import { createHash } from "node:crypto";
import path from "node:path";

import { StateError, atomicWriteJson, ensureDir } from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";
import { SteeredPlanStore, type SteeredPlan } from "./steered-plan.js";

export const BOTS_EVIDENCE_DIR = path.join(".lemma", "pro", "bots");

export const DOCUMENTED_BOT_TIER_LIMITS: Record<string, { count: number; depth: number }> = {
  starter: { count: 2, depth: 2 },
  pro: { count: 8, depth: 5 },
  enterprise: { count: 20, depth: 10 },
  default: { count: 4, depth: 3 },
};

export interface BotTierLimits { count: number; depth: number }
export type BotTier = keyof typeof DOCUMENTED_BOT_TIER_LIMITS | string;

export interface ConfigureBotsParams {
  count: number;
  depth: number;
  scope?: unknown;
  root?: string;
  license?: ProLicenseContext | null;
  tier?: BotTier;
  tierLimits?: Record<string, Partial<BotTierLimits>>;
  seed?: number | string;
}

export interface BotConfig {
  requested: { count: number; depth: number; scope: unknown };
  capped: { count: number; depth: number };
  tier: string;
  tier_limits: BotTierLimits;
  caps_applied: { count: boolean; depth: boolean };
  seed: string | number | null;
  assignments: BotAssignment[];
  updated_at: string;
}

export interface BotAssignment {
  bot_id: string;
  index: number;
  depth: number;
  scope: unknown;
  seed: string;
}

export interface BotEvidenceRecord {
  bot_id: string;
  evidence_path: string;
  explored: true;
  findings: Array<Record<string, unknown>>;
  outcome: "found" | "explored_no_finding";
  summary: string;
  seed: string;
  assignment: BotAssignment;
}

export interface BotExplorationReport {
  schema_version: "lemma.pro.bots_exploration/v1";
  plan_seed: string | number | null;
  deterministic: true;
  bots: BotEvidenceRecord[];
  aggregate: {
    total_bots: number;
    explored: number;
    found: number;
    explored_no_finding: number;
    evidence_paths: string[];
  };
}

function assertLicensed(license: ProLicenseContext | null | undefined): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError("exploratory bot configuration");
}

function nowIso() { return new Date().toISOString(); }

function asPositiveInt(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new StateError(`${name} must be a non-negative integer`);
  return n;
}

export function resolveBotTierLimits(tier?: BotTier, overrides?: Record<string, Partial<BotTierLimits>>): BotTierLimits {
  const key = String(tier || "default");
  const base = DOCUMENTED_BOT_TIER_LIMITS[key] || DOCUMENTED_BOT_TIER_LIMITS.default!;
  const ov = overrides?.[key] || overrides?.default;
  const count = Math.max(1, Math.floor(Number(ov?.count ?? base.count) || base.count));
  const depth = Math.max(0, Math.floor(Number(ov?.depth ?? base.depth) || base.depth));
  return { count, depth };
}

export function computeBotAssignments(input: { count: number; depth: number; scope: unknown; seed?: number | string | null }): BotAssignment[] {
  const count = Math.max(0, Math.floor(input.count));
  const depth = Math.max(0, Math.floor(input.depth));
  const seedBase = input.seed ?? "default-seed";
  const assignments: BotAssignment[] = [];
  for (let i = 0; i < count; i++) {
    const h = createHash("sha256").update(JSON.stringify({ seed: seedBase, i, count, depth, scope: input.scope ?? null })).digest("hex");
    assignments.push({
      bot_id: `bot-${i + 1}-${h.slice(0, 8)}`,
      index: i,
      depth,
      scope: input.scope ?? null,
      seed: `${String(seedBase)}:${h.slice(0, 12)}`,
    });
  }
  return assignments;
}

export async function configureBots(params: ConfigureBotsParams): Promise<{ plan: SteeredPlan; bots: BotConfig }> {
  assertLicensed(params.license);
  const root = path.resolve(params.root ?? process.cwd());
  const countReq = asPositiveInt(params.count, "count");
  const depthReq = asPositiveInt(params.depth, "depth");
  const tier = String(params.tier || "default");
  const tierLimits = resolveBotTierLimits(tier, params.tierLimits);

  const cappedCount = Math.min(countReq, tierLimits.count);
  const cappedDepth = Math.min(depthReq, tierLimits.depth);
  const assignments = computeBotAssignments({ count: cappedCount, depth: cappedDepth, scope: params.scope ?? null, seed: params.seed ?? null });

  const bots: BotConfig = {
    requested: { count: countReq, depth: depthReq, scope: params.scope ?? null },
    capped: { count: cappedCount, depth: cappedDepth },
    tier,
    tier_limits: tierLimits,
    caps_applied: { count: countReq > tierLimits.count, depth: depthReq > tierLimits.depth },
    seed: params.seed ?? null,
    assignments,
    updated_at: nowIso(),
  };

  const store = new SteeredPlanStore({ root, license: params.license ?? null });
  const plan = await store.update({ bots: bots as unknown as Record<string, unknown> }, { reason: "configure_bots" });
  return { plan, bots };
}

export interface RunExploratoryBotsParams {
  root?: string;
  license?: ProLicenseContext | null;
  seed?: number | string;
  /** Injectable explorer for tests/determinism; returns findings per bot. */
  explore?: (assignment: BotAssignment, ctx: { root: string; evidenceDir: string }) => Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>>;
}

export async function runExploratoryBots(params: RunExploratoryBotsParams = {}): Promise<BotExplorationReport> {
  assertLicensed(params.license);
  const root = path.resolve(params.root ?? process.cwd());
  const store = new SteeredPlanStore({ root, license: params.license ?? null });
  const plan = await store.load();
  const cfg = (plan.bots || {}) as Partial<BotConfig>;
  const seed = params.seed ?? cfg.seed ?? null;
  // deterministic: derive assignments from plan config + seed (same inputs => same assignments)
  const assignments = computeBotAssignments({
    count: Number(cfg.capped?.count ?? (cfg.assignments?.length ?? 0)) || 0,
    depth: Number(cfg.capped?.depth ?? 0) || 0,
    scope: cfg.requested?.scope ?? null,
    seed,
  });

  const botsDir = path.join(root, BOTS_EVIDENCE_DIR);
  await ensureDir(botsDir);

  const records: BotEvidenceRecord[] = [];
  for (const assignment of assignments) {
    const evidenceDir = path.join(botsDir, assignment.bot_id);
    await ensureDir(evidenceDir);
    const findings = params.explore ? await params.explore(assignment, { root, evidenceDir }) : [];
    const safeFindings = Array.isArray(findings) ? findings.filter((f) => f && typeof f === "object") : [];
    const outcome: BotEvidenceRecord["outcome"] = safeFindings.length > 0 ? "found" : "explored_no_finding";
    const record: BotEvidenceRecord = {
      bot_id: assignment.bot_id,
      evidence_path: path.join(BOTS_EVIDENCE_DIR, assignment.bot_id, "evidence.json"),
      explored: true,
      findings: safeFindings as Array<Record<string, unknown>>,
      outcome,
      summary: outcome === "found" ? `Found ${safeFindings.length} finding(s).` : "Explored but no finding.",
      seed: assignment.seed,
      assignment,
    };
    await atomicWriteJson(path.join(evidenceDir, "evidence.json"), { schema_version: "lemma.pro.bot_evidence/v1", ...record });
    records.push(record);
  }

  const evidencePaths = records.map((r) => r.evidence_path);
  const found = records.filter((r) => r.outcome === "found").length;
  const exploredNoFinding = records.filter((r) => r.outcome === "explored_no_finding").length;
  return {
    schema_version: "lemma.pro.bots_exploration/v1",
    plan_seed: seed,
    deterministic: true,
    bots: records,
    aggregate: {
      total_bots: records.length,
      explored: records.length,
      found,
      explored_no_finding: exploredNoFinding,
      evidence_paths: evidencePaths,
    },
  };
}

export function formatBotsAggregateCitation(report: BotExplorationReport): string[] {
  return report.bots.map((b) => `${b.bot_id}: ${b.outcome} (${b.evidence_path})`);
}
