import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { now } from "./determinism.js";
import { redactUnknown } from "./redaction.js";

export const REGRESSION_LIFECYCLE_STEPS = ["candidate", "observed", "repeatable", "promoted"] as const;
export type RegressionLifecycleStep = (typeof REGRESSION_LIFECYCLE_STEPS)[number];

const STEP_INDEX: Record<RegressionLifecycleStep, number> = {
  candidate: 0,
  observed: 1,
  repeatable: 2,
  promoted: 3,
};

export interface RegressionObservation {
  id: string;
  fingerprint: string;
  observed_at: string;
  source?: string;
  evidence?: unknown;
}

export interface RegressionRecord {
  schema_version: "lemma.regression/v1";
  regression_id: string;
  finding_id: string;
  lifecycle_step: RegressionLifecycleStep | null;
  lifecycle_history: RegressionLifecycleStep[];
  fingerprint: string | null;
  observations: RegressionObservation[];
  repeatable_observations: number;
  promoted: boolean;
  promoted_at: string | null;
  updated_at: string;
  incident_ids: string[];
  linked_reports: string[];
}

export interface RegressionAuditEvent {
  schema_version: "lemma.regression.audit/v1";
  id: string;
  regression_id: string;
  finding_id: string;
  previous_state: {
    lifecycle_step: RegressionLifecycleStep | null;
    repeatable_observations: number;
    fingerprint: string | null;
  };
  new_state: {
    lifecycle_step: RegressionLifecycleStep;
    repeatable_observations: number;
    fingerprint: string | null;
  };
  timestamp: string;
}

export interface PromoteParams {
  findingId: string;
  lifecycleStep: RegressionLifecycleStep;
  /** Optional root directory containing .lemma (defaults to cwd). */
  root?: string;
  /** Optional state dir name (defaults to .lemma). */
  stateDirName?: string;
  /** Observation fingerprint; required context for repeatable/promoted semantics. */
  fingerprint?: string;
  /** Source/label for observation. */
  source?: string;
  /** Evidence refs/payload associated with observation (redacted before persistence in record metadata as refs only). */
  evidence?: unknown;
  /** Incident id linking this transition/promotion. */
  incidentId?: string;
  /** Report path/ref to link. */
  linkedReport?: string;
}

export interface RegressionStoreOptions {
  root?: string;
  stateDirName?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function regressionIdFor(findingId: string): string {
  // stable per finding id (store keyed by finding/regression identity)
  return `reg_${stableHash([findingId])}`;
}

function auditId(regressionId: string, prev: string | null, next: string, seq: number): string {
  return `regevt_${stableHash([regressionId, prev ?? "none", next, String(seq), String(Date.now())])}_${seq}`;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function normalizeRecord(raw: any, regressionId: string, findingId: string): RegressionRecord {
  const history = Array.isArray(raw?.lifecycle_history) ? raw.lifecycle_history.filter((s: any): s is RegressionLifecycleStep => REGRESSION_LIFECYCLE_STEPS.includes(s)) : (Array.isArray(raw?.lifecycle) ? raw.lifecycle.filter((s: any): s is RegressionLifecycleStep => REGRESSION_LIFECYCLE_STEPS.includes(s)) : []);
  const step = (history.length ? history[history.length - 1] : (REGRESSION_LIFECYCLE_STEPS.includes(raw?.lifecycle_step) ? raw.lifecycle_step : null)) as RegressionLifecycleStep | null;
  const observations = Array.isArray(raw?.observations) ? raw.observations.filter(isRecord).map((o: any) => ({
    id: String(o.id ?? `obs_${stableHash([regressionId, String(o.fingerprint ?? ""), String(o.observed_at ?? "")])}`),
    fingerprint: String(o.fingerprint ?? ""),
    observed_at: String(o.observed_at ?? ""),
    ...(o.source != null ? { source: String(o.source) } : {}),
  })) : [];
  const repeatable = typeof raw?.repeatable_observations === "number"
    ? raw.repeatable_observations
    : (() => {
        const fp = observations.map((o: RegressionObservation) => o.fingerprint).filter(Boolean);
        const seen = new Set<string>();
        const dup = new Set<string>();
        for (const f of fp) { if (seen.has(f)) dup.add(f); else seen.add(f); }
        return dup.size > 0 ? 1 : 0;
      })();
  return {
    schema_version: "lemma.regression/v1",
    regression_id: regressionId,
    finding_id: String(raw?.finding_id ?? findingId),
    lifecycle_step: step,
    lifecycle_history: history,
    fingerprint: raw?.fingerprint == null ? null : String(raw.fingerprint),
    observations,
    repeatable_observations: Math.max(0, Number.isFinite(repeatable) ? repeatable : 0),
    promoted: step === "promoted" || raw?.promoted === true,
    promoted_at: raw?.promoted_at == null ? null : String(raw.promoted_at),
    updated_at: String(raw?.updated_at ?? ""),
    incident_ids: Array.isArray(raw?.incident_ids) ? raw.incident_ids.map(String) : [],
    linked_reports: Array.isArray(raw?.linked_reports) ? raw.linked_reports.map(String) : [],
  };
}

export class RegressionStore {
  readonly root: string;
  readonly stateDirName: string;
  readonly regressionsDir: string;

  constructor(options: RegressionStoreOptions = {}) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.stateDirName = options.stateDirName ?? ".lemma";
    this.regressionsDir = path.join(this.root, this.stateDirName, "regressions");
  }

  recordPath(regressionId: string): string {
    return path.join(this.regressionsDir, `${regressionId}.json`);
  }

  auditPath(regressionId: string): string {
    return path.join(this.regressionsDir, `${regressionId}.events.jsonl`);
  }

  async ensure(): Promise<void> {
    await ensureDir(this.regressionsDir);
  }

  async read(regressionId: string): Promise<RegressionRecord | null> {
    const p = this.recordPath(regressionId);
    if (!(await pathExists(p))) return null;
    const raw = await readJsonFile<any>(p);
    return normalizeRecord(raw, regressionId, String(raw?.finding_id ?? ""));
  }

  async readByFindingId(findingId: string): Promise<RegressionRecord | null> {
    return this.read(regressionIdFor(findingId));
  }

  async list(): Promise<RegressionRecord[]> {
    await this.ensure();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.regressionsDir);
    } catch {
      return [];
    }
    const out: RegressionRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".events.jsonl")) continue;
      const id = name.slice(0, -5);
      const rec = await this.read(id).catch(() => null);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.regression_id.localeCompare(b.regression_id));
  }

  async listPromoted(): Promise<RegressionRecord[]> {
    const all = await this.list();
    return all.filter((r) => r.promoted || r.lifecycle_step === "promoted");
  }

  /**
   * Promoted regressions as first-class checks eligible for continuous workflows (LEM-182, LEM-194).
   */
  async listPromotedRegressionChecks(): Promise<Array<{ id: string; kind: "regression"; finding_id: string; regression_id: string; fingerprint: string | null; lifecycle_step: RegressionLifecycleStep; title: string; promoted: true }>> {
    const promoted = await this.listPromoted();
    return promoted.map((r) => ({
      id: `regression:${r.regression_id}`,
      kind: "regression" as const,
      finding_id: r.finding_id,
      regression_id: r.regression_id,
      fingerprint: r.fingerprint,
      lifecycle_step: "promoted" as const,
      title: `Promoted regression ${r.regression_id} (finding ${r.finding_id})`,
      promoted: true as const,
    }));
  }

  private async appendAudit(regressionId: string, event: RegressionAuditEvent): Promise<void> {
    await this.ensure();
    await fs.appendFile(this.auditPath(regressionId), JSON.stringify(redactUnknown(event)) + "\n", "utf8");
  }

  async promote(params: PromoteParams): Promise<RegressionRecord> {
    const findingId = String(params.findingId || "").trim();
    if (!findingId) throw new StateError("promote requires findingId");
    const step = params.lifecycleStep;
    if (!REGRESSION_LIFECYCLE_STEPS.includes(step)) {
      throw new StateError(`Invalid lifecycleStep '${String(step)}'`);
    }
    await this.ensure();

    const regressionId = regressionIdFor(findingId);
    const current = (await this.read(regressionId)) ?? normalizeRecord(null, regressionId, findingId);
    const prevStep = current.lifecycle_step;
    const prevIndex = prevStep ? STEP_INDEX[prevStep] : -1;
    const nextIndex = STEP_INDEX[step];

    // Transition rules: no skip transitions
    if (nextIndex > prevIndex + 1) {
      throw new StateError(`Skip transition not allowed: ${prevStep ?? "none"} -> ${step}`, {
        details: { regression_id: regressionId, finding_id: findingId, previous: prevStep, requested: step },
      });
    }
    if (nextIndex < prevIndex) {
      throw new StateError(`Regression lifecycle cannot move backwards: ${prevStep} -> ${step}`, {
        details: { regression_id: regressionId, finding_id: findingId, previous: prevStep, requested: step },
      });
    }

    const fingerprint = params.fingerprint != null && String(params.fingerprint) ? String(params.fingerprint) : (current.fingerprint ?? null);
    let observations = [...current.observations];
    let repeatableObservations = current.repeatable_observations;
    const ts = now();

    const maybeAddObservation = (fp: string | null) => {
      if (!fp) return;
      const obs: RegressionObservation = {
        id: `obs_${stableHash([regressionId, fp, ts, String(observations.length)])}`,
        fingerprint: fp,
        observed_at: ts,
        ...(params.source ? { source: String(params.source) } : {}),
      };
      // avoid duplicate identical observation for same fingerprint+step event
      observations.push(obs);
      const sameFpCount = observations.filter((o) => o.fingerprint === fp).length;
      if (sameFpCount >= 2) repeatableObservations = Math.max(repeatableObservations, 1);
    };

    // Apply step-specific semantics (idempotent re-applying same step allowed only if identical state reached; but nextIndex==prevIndex means same step)
    if (nextIndex === prevIndex) {
      // idempotent: record observation if provided and same fingerprint context, but do not create new history/audit transition
      if (step === "observed" || step === "repeatable") maybeAddObservation(fingerprint);
      // promoted requires repeatable observation with same fingerprint already satisfied
      if (step === "promoted") {
        const hasRepeatableSameFp = fingerprint
          ? observations.filter((o) => o.fingerprint === fingerprint).length >= 2 || repeatableObservations >= 1
          : repeatableObservations >= 1;
        if (!hasRepeatableSameFp) {
          throw new StateError(`Cannot promote regression ${regressionId}: promoted requires a repeatable observation with same fingerprint`, {
            details: { regression_id: regressionId, finding_id: findingId, fingerprint },
          });
        }
      }
      const same: RegressionRecord = {
        ...current,
        fingerprint: fingerprint ?? current.fingerprint,
        observations,
        repeatable_observations: repeatableObservations,
        promoted: current.promoted || step === "promoted",
        promoted_at: current.promoted_at ?? (step === "promoted" ? ts : null),
        updated_at: ts,
        incident_ids: params.incidentId ? Array.from(new Set([...current.incident_ids, params.incidentId])) : current.incident_ids,
        linked_reports: params.linkedReport ? Array.from(new Set([...current.linked_reports, params.linkedReport])) : current.linked_reports,
      };
      await atomicWriteJson(this.recordPath(regressionId), redactUnknown(same));
      return same;
    }

    // forward transition by exactly one step
    if (step === "observed") {
      maybeAddObservation(fingerprint);
    } else if (step === "repeatable") {
      // repeatable implies at least observed twice with same fingerprint
      maybeAddObservation(fingerprint);
      if (fingerprint) {
        const sameFpCount = observations.filter((o) => o.fingerprint === fingerprint).length;
        if (sameFpCount < 2) maybeAddObservation(fingerprint); // ensure repeatable observation recorded
      }
      const sameFpCount = fingerprint ? observations.filter((o) => o.fingerprint === fingerprint).length : observations.length;
      if (sameFpCount >= 2) repeatableObservations = Math.max(repeatableObservations, 1);
    } else if (step === "promoted") {
      const hasRepeatableSameFp = fingerprint
        ? observations.filter((o) => o.fingerprint === fingerprint).length >= 2 || (current.fingerprint === fingerprint && repeatableObservations >= 1)
        : (current.lifecycle_history.includes("repeatable") && repeatableObservations >= 1);
      if (!hasRepeatableSameFp) {
        throw new StateError(`Cannot promote regression ${regressionId}: promoted requires a repeatable observation with same fingerprint`, {
          details: { regression_id: regressionId, finding_id: findingId, fingerprint, repeatable_observations: repeatableObservations },
        });
      }
    }

    const previous_state = {
      lifecycle_step: prevStep,
      repeatable_observations: current.repeatable_observations,
      fingerprint: current.fingerprint,
    };
    const new_state = {
      lifecycle_step: step,
      repeatable_observations: repeatableObservations,
      fingerprint: fingerprint ?? current.fingerprint,
    };
    const nextHistory = [...current.lifecycle_history, step];
    const event: RegressionAuditEvent = {
      schema_version: "lemma.regression.audit/v1",
      id: auditId(regressionId, prevStep, step, nextHistory.length),
      regression_id: regressionId,
      finding_id: findingId,
      previous_state,
      new_state,
      timestamp: ts,
    };

    const next: RegressionRecord = {
      schema_version: "lemma.regression/v1",
      regression_id: regressionId,
      finding_id: findingId,
      lifecycle_step: step,
      lifecycle_history: nextHistory,
      fingerprint: new_state.fingerprint,
      observations,
      repeatable_observations: repeatableObservations,
      promoted: step === "promoted" || current.promoted,
      promoted_at: step === "promoted" ? (current.promoted_at ?? ts) : current.promoted_at,
      updated_at: ts,
      incident_ids: params.incidentId ? Array.from(new Set([...current.incident_ids, params.incidentId])) : current.incident_ids,
      linked_reports: params.linkedReport ? Array.from(new Set([...current.linked_reports, params.linkedReport])) : current.linked_reports,
    };

    // atomic state write, then append audit event
    await atomicWriteJson(this.recordPath(regressionId), redactUnknown(next));
    await this.appendAudit(regressionId, event);
    return next;
  }
}

/**
 * Convenience helper for report linkage: list promoted regressions for a workspace root.
 */
export async function listPromotedRegressions(root: string, stateDirName = ".lemma"): Promise<RegressionRecord[]> {
  const store = new RegressionStore({ root, stateDirName });
  return store.listPromoted();
}

/**
 * Promoted regressions as first-class checks eligible for continuous workflows.
 */
export async function listPromotedRegressionChecks(root: string, stateDirName = ".lemma") {
  const store = new RegressionStore({ root, stateDirName });
  return store.listPromotedRegressionChecks();
}
