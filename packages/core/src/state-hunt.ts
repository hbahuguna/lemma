import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { ensureDir, atomicWriteJson } from "./state.js";
import { redactUnknown } from "./redaction.js";
import { now as realNow } from "./determinism.js";

export type StateHuntSequenceKind = "multi-tab" | "reload" | "export-import" | "malformed-data";

export interface StateHuntSequence {
  id?: string;
  kind: StateHuntSequenceKind | string;
  label?: string;
  steps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface StateSnapshot {
  tab?: string | number;
  storage?: Record<string, unknown>;
  cookies?: unknown;
  dom?: Record<string, unknown>;
  apiEvents?: unknown[];
  exported?: unknown;
  imported?: unknown;
  malformed?: boolean;
  [key: string]: unknown;
}

export interface StateHuntStepResult {
  action: string;
  snapshot?: StateSnapshot;
  screenshot?: Uint8Array | Buffer | string; // bytes or base64/text placeholder
  notes?: string;
  invariantViolation?: { invariant: string; details?: string } | null;
}

export interface RunStateHuntParams {
  target: string;
  sequences?: StateHuntSequence[];
  maxSteps?: number;
  seed?: string | number;
  root?: string;
  runId?: string;
  wallClockMs?: number;
  clock?: "real" | "frozen";
  frozenNow?: string;
  nowMs?: () => number;
  stateDirName?: string;
  /**
   * Injectable step executor/capturer for deterministic and browser-backed runs.
   * Must return per-step snapshot and optional screenshot evidence.
   */
  executeStep?: (ctx: { sequence: PlannedSequence; stepIndex: number; action: string; previous?: StateSnapshot | null; seed: string; frozen: boolean }) => Promise<StateHuntStepResult> | StateHuntStepResult;
}

export interface PlannedStep {
  sequence_id: string;
  sequence_kind: string;
  index: number;
  action: string;
  label: string;
}

export interface PlannedSequence {
  id: string;
  kind: StateHuntSequenceKind | string;
  label: string;
  planned_steps: PlannedStep[];
}

export interface StateHuntFinding {
  id: string;
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  invariant: string;
  evidence: string[];
  sequence_id: string;
  step_index: number;
}

export interface StateHuntReport {
  schema_version: "lemma.state_hunt_report/v1";
  run_id: string;
  status: "completed" | "halted";
  target: string;
  coverage: {
    status: "UNCHANGED" | "CHANGED";
    sequences_exercised: number;
    steps_executed: number;
  };
  sequences_exercised: Array<{ id: string; kind: string; label: string; steps_executed: number }>;
  findings: StateHuntFinding[];
  halted_reason: string | null;
  deterministic: { seed: string; clock: "real" | "frozen"; frozen_now?: string };
  evidence: { directory: string; manifest: string; artifacts: string[] };
  [key: string]: unknown;
}

function hashSeed(seed: string | number | undefined, target: string): string {
  return createHash("sha256").update(String(seed ?? "0")).update("|").update(target).digest("hex").slice(0, 16);
}

function normalizeKind(k: any): StateHuntSequenceKind | string {
  const s = String(k || "").toLowerCase();
  if (s.includes("multi") && s.includes("tab")) return "multi-tab";
  if (s.includes("reload")) return "reload";
  if (s.includes("export") || s.includes("import")) return "export-import";
  if (s.includes("malformed")) return "malformed-data";
  if (["multi-tab", "reload", "export-import", "malformed-data"].includes(s)) return s as StateHuntSequenceKind;
  return s || "reload";
}

function boundedPlanner(_target: string, seed: string, sequences?: StateHuntSequence[]): PlannedSequence[] {
  const kinds: StateHuntSequenceKind[] = ["multi-tab", "reload", "export-import", "malformed-data"];
  const input: StateHuntSequence[] = Array.isArray(sequences) && sequences.length ? sequences : kinds.map(k => ({ kind: k }));
  const planned: PlannedSequence[] = [];
  for (let i = 0; i < input.length; i++) {
    const seq = input[i]!;
    const kind = normalizeKind(seq.kind);
    const id = String((seq as any).id || `${kind}-${i + 1}`);
    const label = String((seq as any).label || `${kind} sequence`);
    let actions: string[] = [];
    if (Array.isArray((seq as any).steps) && (seq as any).steps.length) {
      actions = (seq as any).steps.map((s: any, idx: number) => String(s?.action || s?.name || `${kind}-step-${idx + 1}`));
    } else if (kind === "multi-tab") {
      actions = ["open_tab_a", "mutate_state_tab_a", "open_tab_b", "sync_or_conflict_check", "close_tab_b"];
    } else if (kind === "reload") {
      actions = ["capture_initial_state", "mutate_state", "reload", "verify_state_persisted"];
    } else if (kind === "export-import") {
      actions = ["capture_initial_state", "export_state", "mutate_state", "import_state", "verify_restored_state"];
    } else if (kind === "malformed-data") {
      actions = ["seed_valid_state", "inject_malformed_stored_data", "reload_or_rehydrate", "observe_recovery_or_inconsistency"];
    } else {
      actions = ["capture_state", "mutate_state", "observe_state"];
    }
    const plannedSteps: PlannedStep[] = actions.map((a, idx) => ({
      sequence_id: id,
      sequence_kind: String(kind),
      index: idx + 1,
      action: a,
      label: `${label} / ${a}`,
    }));
    planned.push({ id, kind, label, planned_steps: plannedSteps });
  }
  // deterministic order based on seed + id
  return planned.sort((a, b) => {
    const ha = createHash("sha256").update(seed).update(a.id).digest("hex");
    const hb = createHash("sha256").update(seed).update(b.id).digest("hex");
    return ha.localeCompare(hb) || a.id.localeCompare(b.id);
  });
}

function defaultStepResult(action: string, prev: StateSnapshot | null, seed: string, stepNum: number): StateHuntStepResult {
  // deterministic simulated snapshot evolution
  const base = prev ? { ...prev } : { storage: { session: "active", count: 0 }, tab: "main" };
  const storage = { ...(base.storage as any || {}) };
  if (action.includes("mutate")) storage.count = Number(storage.count || 0) + 1;
  if (action.includes("export")) return { action, snapshot: { ...base, storage, exported: { ...storage, _seed: seed } }, screenshot: `screenshot:${action}:${stepNum}` };
  if (action.includes("import")) return { action, snapshot: { ...base, storage: { ...(base as any).exported, ...(storage || {}) }, imported: true }, screenshot: `screenshot:${action}:${stepNum}` };
  if (action.includes("malformed")) return { action, snapshot: { ...base, storage: { ...storage, corrupted: "}{bad" }, malformed: true }, screenshot: `screenshot:${action}:${stepNum}` };
  if (action.includes("reload") || action.includes("rehydrate")) return { action, snapshot: { ...base, storage }, screenshot: `screenshot:${action}:${stepNum}` };
  if (action.includes("open_tab_b")) return { action, snapshot: { ...base, storage, tab: "b", tabs: ["main", "b"] }, screenshot: `screenshot:${action}:${stepNum}` };
  return { action, snapshot: { ...base, storage }, screenshot: `screenshot:${action}:${stepNum}` };
}

function checkInvariant(kind: string, action: string, prev: StateSnapshot | null, curr: StateSnapshot | undefined): { invariant: string; details: string } | null {
  if (!curr) return null;
  // documented invariants: detect observed violations only
  if (kind === "reload" || kind === "export-import") {
    if (action.includes("reload") || action.includes("verify_restored") || action.includes("rehydrate")) {
      const prevCount = Number((prev?.storage as any)?.count ?? 0);
      const currCount = Number((curr.storage as any)?.count ?? 0);
      // violation if state was lost after reload/restore when it existed
      if (prevCount > 0 && currCount === 0 && !action.includes("import_state")) {
        return { invariant: "state_persistence_after_reload", details: `count lost across ${action} (${prevCount} -> ${currCount})` };
      }
    }
  }
  if (kind === "malformed-data") {
    if ((curr.malformed || String((curr.storage as any)?.corrupted || "").includes("bad")) && action.includes("observe")) {
      // malformed data observed and surfaced as inconsistent/corrupted state transition
      return { invariant: "malformed_stored_data_handling", details: "malformed stored data observed without clean recovery state" };
    }
  }
  if (kind === "multi-tab") {
    if (action.includes("sync") || action.includes("conflict")) {
      const prevCount = Number((prev?.storage as any)?.count ?? 0);
      const currCount = Number((curr.storage as any)?.count ?? 0);
      if (prevCount > 0 && currCount < 0) {
        return { invariant: "multi_tab_state_consistency", details: "inconsistent negative state observed" };
      }
    }
  }
  return null;
}

function validateReportShape(report: StateHuntReport): void {
  if (report.schema_version !== "lemma.state_hunt_report/v1") throw new StateError("Invalid StateHuntReport schema_version");
  if (!report.run_id) throw new StateError("Invalid StateHuntReport run_id");
  if (!["completed", "halted"].includes(report.status)) throw new StateError("Invalid StateHuntReport status");
  if (!report.coverage || !["UNCHANGED", "CHANGED"].includes(report.coverage.status)) throw new StateError("Invalid StateHuntReport coverage");
  if (!Array.isArray(report.sequences_exercised) || !Array.isArray(report.findings)) throw new StateError("Invalid StateHuntReport arrays");
  if (!report.evidence || !Array.isArray(report.evidence.artifacts)) throw new StateError("Invalid StateHuntReport evidence");
}

export async function runStateHunt(params: RunStateHuntParams): Promise<StateHuntReport> {
  if (!params || typeof params.target !== "string" || !params.target) throw new StateError("runStateHunt requires target");
  const root = path.resolve(params.root ?? process.cwd());
  const runId = params.runId || `state-hunt-${randomUUID()}`;
  const seed = hashSeed(params.seed, params.target);
  const maxSteps = Number.isInteger(params.maxSteps) && (params.maxSteps as number) > 0 ? (params.maxSteps as number) : 50;
  const wallClockMs = Number.isInteger(params.wallClockMs) && (params.wallClockMs as number) > 0 ? (params.wallClockMs as number) : 30_000;
  const frozen = params.clock === "frozen";
  const frozenNow = params.frozenNow ?? (frozen ? new Date(0).toISOString() : undefined);
  const nowMs = params.nowMs ?? (() => Date.now());
  const started = nowMs();
  const deadline = started + wallClockMs;

  const evidence = new EvidenceStore(root, runId, { stateDirName: params.stateDirName ?? ".lemma" });
  await evidence.init();
  const huntDir = path.join(root, ".lemma", "evidence", runId, "state-hunt");
  await ensureDir(huntDir);

  const plannedSequences = boundedPlanner(params.target, seed, params.sequences);
  const findings: StateHuntFinding[] = [];
  const exercised: Array<{ id: string; kind: string; label: string; steps_executed: number }> = [];
  const stepArtifactRefs: string[] = [];
  let stepsExecuted = 0;
  let haltedReason: string | null = null;
  let prevSnapshot: StateSnapshot | null = null;

  outer: for (const seq of plannedSequences) {
    let seqSteps = 0;
    for (const step of seq.planned_steps) {
      if (stepsExecuted >= maxSteps) { haltedReason = "maxSteps exceeded"; break outer; }
      if (nowMs() >= deadline) { haltedReason = "wallClockMs exceeded"; break outer; }

      const result = params.executeStep
        ? await params.executeStep({ sequence: seq, stepIndex: step.index, action: step.action, previous: prevSnapshot, seed, frozen })
        : defaultStepResult(step.action, prevSnapshot, seed, stepsExecuted + 1);

      const snapshot = redactUnknown(result.snapshot ?? {}) as StateSnapshot;
      // record per-step evidence: screenshot + storage/state snapshot (LEM-016 linkage via EvidenceStore)
      const stepBase = `${seq.id}-step-${String(step.index).padStart(2, "0")}-${step.action.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
      const shotName = `${stepBase}-screenshot`;
      const snapName = `${stepBase}-state-snapshot`;
      let shotRef: string;
      if (result.screenshot instanceof Uint8Array || Buffer.isBuffer(result.screenshot)) {
        shotRef = await evidence.saveBytes(shotName, Buffer.from(result.screenshot as any), "screenshot", `Screenshot for ${step.label}`, "state-hunt", ".png");
      } else {
        const shotPayload = { sequence: seq.id, step: step.index, action: step.action, screenshot: result.screenshot ?? `deterministic:${stepBase}`, deterministic: { seed, frozen, ...(frozenNow ? { frozen_now: frozenNow } : {}) } };
        shotRef = await evidence.saveJson(shotName, redactUnknown(shotPayload), "screenshot", `Screenshot/state capture for ${step.label}`, "state-hunt");
      }
      const snapPayload = {
        sequence: { id: seq.id, kind: seq.kind, label: seq.label },
        step: { index: step.index, action: step.action, label: step.label },
        state_snapshot: snapshot,
        deterministic: { seed, frozen, ...(frozenNow ? { frozen_now: frozenNow } : {}) },
      };
      const snapRef = await evidence.saveJson(snapName, snapPayload, "json", `Storage/state snapshot (LEM-016 evidence) for ${step.label}`, "state-hunt");
      stepArtifactRefs.push(shotRef, snapRef);

      const violation = result.invariantViolation ?? checkInvariant(String(seq.kind), step.action, prevSnapshot, snapshot);
      if (violation) {
        const fid = `state-hunt.${String(seq.kind)}.${step.action}.${createHash("sha256").update(seq.id).update(String(step.index)).update(violation.invariant).digest("hex").slice(0, 10)}`;
        findings.push({
          id: fid,
          severity: "high",
          title: `State invariant violated: ${violation.invariant}`,
          description: violation.details || `Observed state transition violating ${violation.invariant}`,
          invariant: violation.invariant,
          evidence: [snapRef, shotRef],
          sequence_id: seq.id,
          step_index: step.index,
        });
      }

      prevSnapshot = snapshot;
      stepsExecuted += 1;
      seqSteps += 1;
    }
    exercised.push({ id: seq.id, kind: String(seq.kind), label: seq.label, steps_executed: seqSteps });
  }

  // no-bug found: never reported as pass; report UNCHANGED coverage with exercised sequences
  const coverageStatus: "UNCHANGED" | "CHANGED" = findings.length > 0 ? "CHANGED" : "UNCHANGED";
  const status: "completed" | "halted" = haltedReason ? "halted" : "completed";

  const sequencesEvidence = plannedSequences.map(s => ({ id: s.id, kind: s.kind, label: s.label, planned_steps: s.planned_steps.length }));
  const seqRef = await evidence.saveJson("state-hunt-sequences", redactUnknown(sequencesEvidence), "json", "Exercised/planned state-hunt sequences", "state-hunt");
  const findingsRef = await evidence.saveJson("state-hunt-findings", redactUnknown(findings), "json", "State-hunt findings (violations only)", "state-hunt");

  const report: StateHuntReport = {
    schema_version: "lemma.state_hunt_report/v1",
    run_id: runId,
    status,
    target: params.target,
    coverage: { status: coverageStatus, sequences_exercised: exercised.length, steps_executed: stepsExecuted },
    sequences_exercised: exercised,
    findings,
    halted_reason: haltedReason,
    deterministic: { seed, clock: frozen ? "frozen" : "real", ...(frozenNow ? { frozen_now: frozenNow } : {}) },
    evidence: {
      directory: `.lemma/evidence/${runId}/state-hunt`,
      manifest: `.lemma/evidence/${runId}/manifest.json`,
      artifacts: Array.from(new Set([...stepArtifactRefs, seqRef, findingsRef])),
    },
  };

  validateReportShape(report);
  const reportPath = path.join(huntDir, "state-hunt-report.json");
  await atomicWriteJson(reportPath, redactUnknown(report));
  const repRef = await evidence.saveJson("state-hunt-report", redactUnknown(report), "json", "State hunt report", "state-hunt");
  report.evidence.artifacts = Array.from(new Set([...report.evidence.artifacts, repRef]));

  await evidence.finalize({ workflow: "state-hunt", status, target: params.target, seed, generated_at: frozenNow ?? realNow() });
  validateReportShape(report);
  return report;
}
