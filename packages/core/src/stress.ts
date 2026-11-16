import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { ensureDir, atomicWriteJson } from "./state.js";
import { redactUnknown } from "./redaction.js";
import { now as deterministicNow } from "./determinism.js";

export interface StressFinding {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  kind: "static_risk" | "bounded_loop" | "recovery";
  evidence: string[];
  location?: string;
  pattern?: string;
  metadata?: Record<string, unknown>;
}

export interface BoundedLoopConfig {
  iterations?: number;
  concurrency?: number;
  durationMs?: number;
  /** Injectable operation for deterministic tests. */
  operation?: () => Promise<unknown> | unknown;
}

export interface RecoveryExperiment {
  id?: string;
  label: string; // labelled recovery scenario (required)
  scenario?: string;
  action?: () => Promise<unknown> | unknown;
  recover?: () => Promise<unknown> | unknown;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface StressApproveContext {
  phase: "bounded_loop" | "recovery";
  experiment?: RecoveryExperiment;
  details?: Record<string, unknown>;
}

export type StressApproveDecision = boolean | { approved: boolean; reason?: string };

export interface RunStressReviewParams {
  root: string;
  target?: string | null;
  approve?: (ctx: StressApproveContext) => StressApproveDecision | Promise<StressApproveDecision>;
  runId?: string;
  boundedLoop?: BoundedLoopConfig;
  recoveryExperiments?: RecoveryExperiment[];
  /** Test hooks */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stateDirName?: string;
}

export interface StressReport {
  schema_version: "lemma.stress_report/v1";
  run_id: string;
  status: "completed" | "halted";
  target: string | null;
  phases: {
    static: { status: "completed"; files_scanned: number; findings_count: number };
    bounded_loop: { status: "skipped" | "completed" | "halted" | "declined"; reason?: string; iterations_completed?: number; concurrency_peak?: number; duration_ms?: number };
    recovery: { status: "skipped" | "completed" | "halted" | "declined"; experiments_run: number; experiments_declined: number };
  };
  findings: StressFinding[];
  experiments: Array<Record<string, unknown>>;
  evidence: { directory: string; manifest: string; artifacts: string[] };
  [key: string]: unknown;
}

function stableId(parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
  return parts[0] + "." + h;
}

async function walkFiles(root: string, limit = 200): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", ".lemma", "dist", "build", "coverage"]);
  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|rs|php|ya?ml|json|toml|ini|conf|config)$/i.test(e.name)) out.push(p);
      }
    }
  }
  await walk(root);
  return out.sort();
}

function detectStaticRisks(filePath: string, content: string, rel: string): StressFinding[] {
  const findings: StressFinding[] = [];
  const lines = content.split(/\r?\n/);
  const add = (pattern: string, title: string, desc: string, severity: StressFinding["severity"], lineIdx: number, snippet: string) => {
    const id = `stress.static.${pattern}.${stableId([rel, String(lineIdx + 1), pattern])}`;
    findings.push({
      id,
      severity,
      title,
      description: desc,
      kind: "static_risk",
      evidence: [],
      location: `${rel}:${lineIdx + 1}`,
      pattern,
      metadata: { snippet: snippet.trim().slice(0, 120) },
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/while\s*\(\s*true\s*\)/.test(line) || /for\s*\(\s*;\s*;\s*\)/.test(line)) {
      add("unbounded_loop", "Potential unbounded loop", "Loop appears unbounded without explicit break/limit guard.", "high", i, line);
    }
    if (/\bretry\b/i.test(line) && !/backoff|sleep|delay|wait|jitter/i.test(line) && !/backoff|sleep|delay|wait|jitter/i.test(lines.slice(Math.max(0, i - 2), i + 3).join(" "))) {
      add("retry_without_backoff", "Retry without apparent backoff", "Retry-related logic detected without nearby backoff/sleep/delay signal.", "medium", i, line);
    }
    if (/\b(timeout|max|limit|cap|threshold)\b/i.test(line) && /=\s*(0|null|undefined|None|Infinity)/.test(line)) {
      add("missing_limit", "Limit/timeout appears disabled or missing", "A limit/timeout/cap appears unset or disabled.", "medium", i, line);
    }
  }

  // config-level missing limits heuristic
  if (/\.(ya?ml|json|toml|ini|conf|config)$/i.test(filePath)) {
    const lower = content.toLowerCase();
    if ((/retry/.test(lower) || /worker/.test(lower) || /concurr/.test(lower)) && !/max|limit|timeout|cap/.test(lower)) {
      const id = `stress.static.missing_limit_config.${stableId([rel, "config"])}`;
      findings.push({ id, severity: "low", title: "Config may be missing explicit limits", description: "Retry/worker/concurrency-related config detected without obvious max/limit/timeout/cap keys.", kind: "static_risk", evidence: [], location: rel, pattern: "missing_limit_config" });
    }
  }
  return findings;
}

async function runStaticPhase(root: string): Promise<{ findings: StressFinding[]; filesScanned: number }> {
  const files = await walkFiles(root);
  const findings: StressFinding[] = [];
  for (const f of files) {
    let content = "";
    try { content = await fs.readFile(f, "utf8"); } catch { continue; }
    if (content.length > 200_000) continue;
    const rel = path.relative(root, f).split(path.sep).join("/");
    findings.push(...detectStaticRisks(f, content, rel));
  }
  // stable ordering/dedupe by id
  const uniq = new Map<string, StressFinding>();
  for (const fnd of findings.sort((a,b)=>a.id.localeCompare(b.id))) if (!uniq.has(fnd.id)) uniq.set(fnd.id, fnd);
  return { findings: [...uniq.values()], filesScanned: files.length };
}

function normalizeApproval(decision: StressApproveDecision | undefined): { approved: boolean; reason?: string } {
  if (typeof decision === "boolean") return { approved: decision };
  if (decision && typeof decision === "object") return { approved: !!decision.approved, ...(decision.reason ? { reason: String(decision.reason) } : {}) };
  return { approved: false };
}

function validateReportShape(report: StressReport): void {
  if (report.schema_version !== "lemma.stress_report/v1") throw new StateError("Invalid StressReport schema_version");
  if (!report.run_id) throw new StateError("Invalid StressReport run_id");
  if (!["completed", "halted"].includes(report.status)) throw new StateError("Invalid StressReport status");
  if (!report.phases || !report.phases.static || !report.phases.bounded_loop || !report.phases.recovery) throw new StateError("Invalid StressReport phases");
  if (!Array.isArray(report.findings)) throw new StateError("Invalid StressReport findings");
  for (const f of report.findings) {
    if (!f || typeof f.id !== "string" || typeof f.title !== "string" || typeof f.severity !== "string" || !Array.isArray(f.evidence)) {
      throw new StateError("Invalid StressReport finding");
    }
  }
  if (!report.evidence || typeof report.evidence.directory !== "string" || typeof report.evidence.manifest !== "string" || !Array.isArray(report.evidence.artifacts)) {
    throw new StateError("Invalid StressReport evidence");
  }
}

export async function runStressReview(params: RunStressReviewParams): Promise<StressReport> {
  if (!params || typeof params.root !== "string") throw new StateError("runStressReview requires root");
  const root = path.resolve(params.root);
  const runId = params.runId || `stress-${randomUUID()}`;
  const nowMs = params.nowMs ?? (() => Date.now());
  const sleep = params.sleep ?? (async (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms))));

  const evidence = new EvidenceStore(root, runId, { stateDirName: params.stateDirName ?? ".lemma" });
  await evidence.init();
  const stressDir = path.join(root, ".lemma", "evidence", runId, "stress");
  await ensureDir(stressDir);

  // Static phase (always)
  const staticRes = await runStaticPhase(root);
  const findings: StressFinding[] = [...staticRes.findings];
  const experiments: Array<Record<string, unknown>> = [];

  let overallStatus: StressReport["status"] = "completed";
  let boundedStatus: StressReport["phases"]["bounded_loop"] = { status: "skipped", reason: "approve not provided" };
  let recoveryStatus: StressReport["phases"]["recovery"] = { status: "skipped", experiments_run: 0, experiments_declined: 0 };

  // Bounded-loop phase: runs only when approve is provided
  if (typeof params.approve === "function") {
    const decision = normalizeApproval(await params.approve({ phase: "bounded_loop", details: { target: params.target ?? null } }));
    if (!decision.approved) {
      boundedStatus = { status: "declined", reason: decision.reason || "declined" };
    } else {
      const cfg = params.boundedLoop ?? {};
      const iterations = Math.max(1, Math.min(Number(cfg.iterations ?? 10) || 10, 1000));
      const concurrency = Math.max(1, Math.min(Number(cfg.concurrency ?? 1) || 1, 50));
      const durationMs = Math.max(1, Math.min(Number(cfg.durationMs ?? 200) || 200, 60_000));
      const start = nowMs();
      const deadline = start + durationMs;
      let completedIters = 0;
      let peak = 0;
      let active = 0;
      let halted = false;
      const op = cfg.operation ?? (async () => { /* bounded no-op */ });
      const inFlight = new Set<Promise<void>>();

      const launch = () => {
        if (halted) return;
        if (nowMs() >= deadline) { halted = true; return; }
        active += 1; peak = Math.max(peak, active);
        const p = (async () => { try { await op(); } catch { /* recorded as evidence context only */ } })()
          .finally(() => { active -= 1; completedIters += 1; inFlight.delete(p); });
        inFlight.add(p);
      };

      while (completedIters + inFlight.size < iterations && !halted) {
        if (nowMs() >= deadline) { halted = true; break; }
        while (active < concurrency && (completedIters + inFlight.size) < iterations && !halted) {
          if (nowMs() >= deadline) { halted = true; break; }
          launch();
        }
        if (inFlight.size === 0) break;
        await Promise.race([...Array.from(inFlight), sleep(0)]);
      }
      await Promise.allSettled(Array.from(inFlight));
      const dur = Math.max(0, nowMs() - start);
      if (nowMs() >= deadline && (completedIters < iterations)) halted = true;
      if (halted) overallStatus = "halted";
      boundedStatus = {
        status: halted ? "halted" : "completed",
        iterations_completed: completedIters,
        concurrency_peak: peak,
        duration_ms: dur,
      };
      const bFinding: StressFinding = {
        id: `stress.bounded_loop.${stableId([runId, "bounded", String(iterations), String(concurrency)])}`,
        severity: "low",
        title: "Bounded stress loop executed",
        description: "An explicitly approved bounded local loop was executed and recorded as evidence (not a claim of production safety).",
        kind: "bounded_loop",
        evidence: [],
        metadata: { iterations, concurrency, durationMs, completed: completedIters, halted },
      };
      findings.push(bFinding);
      experiments.push({ kind: "bounded_loop", approved: true, iterations, concurrency, duration_cap_ms: durationMs, completed: completedIters, halted, duration_ms: dur });
    }
  }

  // Recovery phase: optional, requires explicit approval per experiment and labelled scenario
  const recovery = params.recoveryExperiments ?? [];
  if (recovery.length > 0) {
    let runCount = 0; let declinedCount = 0; let recHalted = false;
    for (const exp of recovery) {
      if (!exp || typeof exp.label !== "string" || !exp.label.trim()) {
        experiments.push({ kind: "recovery", status: "rejected", reason: "missing labelled recovery scenario" });
        declinedCount += 1;
        continue;
      }
      const decision = normalizeApproval(await (params.approve ? params.approve({ phase: "recovery", experiment: exp }) : Promise.resolve({ approved: false, reason: "no approve callback" })));
      if (!decision.approved) {
        declinedCount += 1;
        experiments.push({ kind: "recovery", label: exp.label, status: "declined", reason: decision.reason || "declined" });
        continue;
      }
      const start = nowMs();
      try {
        if (exp.action) await exp.action();
        if (exp.recover) await exp.recover();
      } catch (e: any) {
        recHalted = true;
        experiments.push({ kind: "recovery", label: exp.label, status: "halted", reason: e?.message || String(e) });
        break;
      }
      const recoveryTimeMs = Math.max(0, nowMs() - start);
      runCount += 1;
      experiments.push({ kind: "recovery", label: exp.label, status: "completed", recovery_time_ms: recoveryTimeMs, scenario: exp.scenario || exp.label });
      findings.push({
        id: `stress.recovery.${stableId([runId, exp.label, "recovery"])}`,
        severity: "low",
        title: `Recovery experiment recorded: ${exp.label}`,
        description: "Approved recovery experiment recorded as evidence with measured recovery time (not a claim).",
        kind: "recovery",
        evidence: [],
        metadata: { label: exp.label, recovery_time_ms: recoveryTimeMs },
      });
    }
    recoveryStatus = { status: recHalted ? "halted" : "completed", experiments_run: runCount, experiments_declined: declinedCount };
    if (recHalted) overallStatus = "halted";
  }

  // persist evidence
  const findingsPath = path.join(stressDir, "findings.json");
  const experimentsPath = path.join(stressDir, "experiments.json");
  await atomicWriteJson(findingsPath, redactUnknown(findings));
  await atomicWriteJson(experimentsPath, redactUnknown(experiments));

  const fRef = await evidence.saveJson("stress-findings", redactUnknown(findings), "json", "Stress static/bounded/recovery findings (evidence)", "stress");
  const eRef = await evidence.saveJson("stress-experiments", redactUnknown(experiments), "json", "Stress/recovery experiment records", "stress");

  // attach evidence refs to findings
  for (const f of findings) { if (!f.evidence.includes(fRef)) f.evidence.push(fRef); }

  const report: StressReport = {
    schema_version: "lemma.stress_report/v1",
    run_id: runId,
    status: overallStatus,
    target: params.target ?? null,
    phases: {
      static: { status: "completed", files_scanned: staticRes.filesScanned, findings_count: staticRes.findings.length },
      bounded_loop: boundedStatus,
      recovery: recoveryStatus,
    },
    findings,
    experiments: redactUnknown(experiments) as any,
    evidence: {
      directory: `.lemma/evidence/${runId}/stress`,
      manifest: `.lemma/evidence/${runId}/manifest.json`,
      artifacts: [fRef, eRef],
    },
  };

  validateReportShape(report);
  const reportPath = path.join(stressDir, "stress-report.json");
  await atomicWriteJson(reportPath, redactUnknown(report));
  const rRef = await evidence.saveJson("stress-report", redactUnknown(report), "json", "Stress risk report", "stress");
  report.evidence.artifacts = Array.from(new Set([...report.evidence.artifacts, rRef]));

  await evidence.finalize({ workflow: "stress", status: overallStatus, target: params.target ?? null, generated_at: deterministicNow() });
  validateReportShape(report);
  return report;
}
