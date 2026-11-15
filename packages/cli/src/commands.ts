import { promises as fs } from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";

import {
  EXIT_CODES,
  EvidenceStore,
  Orchestrator,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateError,
  StateStore,
  buildReport,
  normalizeTarget,
  now as coreNow,
  severityRank,
  type RunStateDomain,
} from "@lemma/core";

import { CliUsageError, type CliCommandHandler, type CliCommandSpec } from "./index-types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

function toInt(value: string | undefined, flag: string): number {
  if (value === undefined) throw new CliUsageError(`Missing value for ${flag}`, { flag });
  const n = Number(value);
  if (!Number.isInteger(n)) throw new CliUsageError(`Invalid integer for ${flag}: ${value}`, { flag, value });
  return n;
}

function parseArgs(argv: string[]): { flags: Record<string, string | boolean | string[]>; positionals: string[] } {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        const prev = flags[k];
        if (prev === undefined) flags[k] = v;
        else if (Array.isArray(prev)) prev.push(v);
        else flags[k] = [String(prev), v];
        continue;
      }
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[k] = next;
        i += 1;
      } else {
        flags[k] = true;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const k = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[k] = next;
        i += 1;
      } else {
        flags[k] = true;
      }
      continue;
    }
    positionals.push(a);
  }
  return { flags, positionals };
}

function getFlag(flags: Record<string, string | boolean | string[]>, ...names: string[]): string | boolean | string[] | undefined {
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(flags, n)) return flags[n];
  }
  return undefined;
}

function getString(flags: Record<string, string | boolean | string[]>, ...names: string[]): string | undefined {
  const v = getFlag(flags, ...names);
  if (v === undefined || v === true || v === false) return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function getBool(flags: Record<string, string | boolean | string[]>, ...names: string[]): boolean {
  const v = getFlag(flags, ...names);
  if (v === true) return true;
  if (v === false || v === undefined) return false;
  if (typeof v === "string") return v === "true" || v === "1" || v === "yes";
  return Boolean(v);
}



function normalizeCliTarget(raw: string): Record<string, unknown> {
  const value = raw.trim();
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return { raw: value, kind: "url", resolved: value, source: null };
  }
  const resolved = path.resolve(value);
  // best-effort kind; orchestrator/core may refine, but keep populated
  let kind = "directory";
  try {
    // sync check is fine for CLI path
    const st = statSync(resolved);
    if (st.isFile()) kind = "file";
    else if (st.isDirectory()) kind = "directory";
  } catch {
    // leave as directory
  }
  return { raw: value, kind, resolved, source: null };
}
async function loadReportForState(root: string, state: RunStateDomain): Promise<Record<string, unknown>> {
  const evidence = new EvidenceStore(root, state.run_id);
  await evidence.init();
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = await evidence.finalize({ run_id: state.run_id });
  } catch {
    manifest = null;
  }
  const evSummary = evidence.summary();
  const summary: Record<string, unknown> = manifest && isRecord(manifest.summary) ? manifest.summary : (evSummary as unknown as Record<string, unknown>);
  const generatedAt = manifest && typeof manifest.generated_at === "string" ? manifest.generated_at : coreNow();
  return buildReport(state, RELEASE_CONFIDENCE, summary, generatedAt);
}

export const runCommand: CliCommandHandler = async (argv, io) => {
  const { flags } = parseArgs(argv);
  const targetRaw = getString(flags, "target", "t");
  if (!targetRaw) throw new CliUsageError("Missing required --target", { flag: "target" });
  const root = path.resolve(getString(flags, "root") ?? ".");
  const intent = getString(flags, "intent", "i") ?? "Assess release readiness of the target.";
  const resume = getBool(flags, "resume");
  const quiet = getBool(flags, "quiet");
  const maxChecksStr = getString(flags, "max-checks");
  const maxChecks = maxChecksStr !== undefined ? toInt(maxChecksStr, "--max-checks") : 20;
  const seedStr = getString(flags, "seed");
  const seed = seedStr !== undefined ? toInt(seedStr, "--seed") : undefined;
  const clockMode = getString(flags, "clock-mode") as "real" | "frozen" | undefined;
  const frozenClock = getString(flags, "frozen-clock");
  const output = getString(flags, "output");
  const keepRunsStr = getString(flags, "keep-runs");
  const keepRuns = keepRunsStr !== undefined ? toInt(keepRunsStr, "--keep-runs") : undefined;
  const failOn = getString(flags, "fail-on") ?? "none";
  const minScoreStr = getString(flags, "min-score");
  const minScore = minScoreStr !== undefined ? toInt(minScoreStr, "--min-score") : undefined;

  const store = new StateStore(root);
  const log = (msg: string) => {
    if (!quiet) io.stderr(`[lemma] ${msg}\n`);
  };
  const orch = new Orchestrator({ store });
  log(resume ? "Resuming run..." : "Starting run...");
  const state = await orch.run({
    target: normalizeTarget(normalizeCliTarget(targetRaw)),
    intent,
    workflow: RELEASE_CONFIDENCE,
    maxChecks,
    resume,
    ...(seed !== undefined ? { seed } : {}),
    ...(clockMode ? { clockMode } : {}),
    ...(frozenClock !== undefined ? { frozenClock } : {}),
  });
  if (keepRuns !== undefined) {
    await store.prune({ keepRuns });
  }

  const report = await loadReportForState(root, state);
  if (output) {
    const outPath = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  }

  let policyFailed = false;
  if (failOn && failOn !== "none") {
    const threshold = severityRank(failOn);
    const findings = Array.isArray(report.findings) ? report.findings : [];
    for (const f of findings) {
      if (!isRecord(f)) continue;
      const sev = asString(f.severity);
      if (sev && severityRank(sev) >= threshold) {
        policyFailed = true;
        break;
      }
    }
  }
  const confidence: Record<string, unknown> = isRecord(report.confidence) ? report.confidence : {};
  const score = typeof confidence.score === "number" ? confidence.score : 0;
  if (minScore !== undefined && score < minScore) policyFailed = true;

  let exitCode: 0 | 1 | 2 | 3 = EXIT_CODES.pass;
  if (policyFailed) exitCode = EXIT_CODES.policyThresholdFailed;
  else if (state.status === RunStatus.HALTED) exitCode = EXIT_CODES.killSwitchHalt;
  else if (state.status === RunStatus.FAILED) exitCode = EXIT_CODES.harnessError;

  return { exitCode, stdoutJson: report };
};

export const statusCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const store = new StateStore(root);
  if (getBool(flags, "all")) {
    const history = await store.loadHistory();
    const runs = history.runs ?? [];
    return {
      stdoutJson: {
        schema_version: "quality-harness.report/v1",
        status: "ok",
        count: runs.length,
        runs,
        root: store.root,
      },
    };
  }
  if (!(await store.exists())) {
    return {
      stdoutJson: {
        schema_version: "quality-harness.report/v1",
        status: "no_run",
        message: "No .lemma/progress.json exists yet.",
        blockers: [],
        blockers_by_persona: {},
        blockers_by_check: {},
        root: store.root,
      },
    };
  }
  const state = (await store.loadProgress<unknown>()) as RunStateDomain & Record<string, unknown>;
  const checks = Array.isArray(state.checks) ? state.checks : [];
  const findings = Array.isArray(state.findings) ? state.findings : [];
  const blockers = Array.isArray(state.blockers) ? state.blockers : [];
  const checksByStatus: Record<string, number> = {};
  for (const c of checks) {
    if (!isRecord(c)) continue;
    const s = asString(c.status) || "unknown";
    checksByStatus[s] = (checksByStatus[s] ?? 0) + 1;
  }
  const findingsBySeverity: Record<string, number> = {};
  for (const f of findings) {
    if (!isRecord(f)) continue;
    const sev = asString(f.severity) || "unknown";
    findingsBySeverity[sev] = (findingsBySeverity[sev] ?? 0) + 1;
  }
  const blockersByPersona: Record<string, number> = {};
  const blockersByCheck: Record<string, number> = {};
  for (const b of blockers) {
    if (!isRecord(b)) continue;
    const persona = asString(b.persona) || "unknown";
    const checkId = asString(b.check_id) || "unknown";
    blockersByPersona[persona] = (blockersByPersona[persona] ?? 0) + 1;
    blockersByCheck[checkId] = (blockersByCheck[checkId] ?? 0) + 1;
  }
  const target = isRecord(state.target) ? state.target : {};
  const runId = asString(state.run_id);
  const reportPath = path.join(store.evidenceRoot, runId, "manifest.json");
  return {
    stdoutJson: {
      schema_version: "quality-harness.report/v1",
      status: asString(state.status),
      run_id: runId,
      workflow_id: asString(state.workflow_id),
      workflow_version: asString(state.workflow_version),
      target,
      intent: asString(state.intent),
      current_phase: asString(state.current_phase),
      confidence: isRecord(state.confidence) ? state.confidence : {},
      checks_by_status: checksByStatus,
      findings_by_severity: findingsBySeverity,
      blockers,
      blockers_by_persona: blockersByPersona,
      blockers_by_check: blockersByCheck,
      kill_switch: isRecord(state.kill_switch) ? state.kill_switch : {},
      halted_reason: asString(state.halted_reason),
      report_path: reportPath,
      progress_path: store.progressPath,
      started_at: state.started_at ?? null,
      updated_at: state.updated_at ?? null,
      completed_at: state.completed_at ?? null,
    },
  };
};

export const reportCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const store = new StateStore(root);
  if (!(await store.exists())) {
    throw new StateError("No .lemma/progress.json exists yet; run `lemma run` first.", {
      details: { root: store.root },
    });
  }
  const state = (await store.loadProgress<unknown>()) as RunStateDomain;
  const report = await loadReportForState(root, state);
  return { stdoutJson: report };
};

export const abortCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const reason = getString(flags, "reason") ?? "Manual kill requested by the operator.";
  const store = new StateStore(root);
  await store.requestKill(reason);
  await store.appendEvent({ event: "manual_kill_requested", reason });
  return {
    stdoutJson: {
      schema_version: "quality-harness.report/v1",
      status: "kill_requested",
      reason,
      kill_path: store.killPath,
      requested_at: coreNow(),
    },
  };
};

export const pruneCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const keepRunsStr = getString(flags, "keep-runs");
  const olderStr = getString(flags, "older-than-days");
  const dryRun = getBool(flags, "dry-run");
  const keepRuns = keepRunsStr !== undefined ? toInt(keepRunsStr, "--keep-runs") : undefined;
  const olderThanDays = olderStr !== undefined ? toInt(olderStr, "--older-than-days") : undefined;
  const store = new StateStore(root);
  const pruneOpts: { keepRuns?: number; olderThanDays?: number; dryRun?: boolean } = { dryRun };
  if (keepRuns !== undefined) pruneOpts.keepRuns = keepRuns;
  if (olderThanDays !== undefined) pruneOpts.olderThanDays = olderThanDays;
  const result = await store.prune(pruneOpts);
  return {
    stdoutJson: {
      schema_version: "quality-harness.report/v1",
      status: dryRun ? "dry_run" : "pruned",
      root: store.root,
      removed: result.removed,
      retained: result.retained,
      count: result.retained.length,
    },
  };
};

export function coreCommandSpecs(): CliCommandSpec[] {
  return [
    { name: "run", description: "Run the release-confidence workflow.", handler: runCommand },
    { name: "status", description: "Print persisted run state or history.", handler: statusCommand },
    { name: "report", description: "Print the latest saved report.", handler: reportCommand },
    { name: "abort", description: "Request a manual kill of the current run.", handler: abortCommand },
    { name: "prune", description: "Prune historical runs and evidence.", handler: pruneCommand },
  ];
}
