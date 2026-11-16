import { promises as fs } from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";

import {
  EXIT_CODES,
  EvidenceStore,
  Orchestrator,
  RELEASE_CONFIDENCE,
  REPORT_SCHEMA,
  RunStatus,
  StateError,
  StateStore,
  SuppressionStore,
  buildJunit,
  buildReport,
  buildSarif,
  lintPersonas,
  loadPersonas,
  normalizeTarget,
  now as coreNow,
  runBugHunt,
  scaffoldPersona,
  severityRank,
  signReport,
  verifyEvidence,
  verifyReportSignature,
  writeCalibrationReport,
  loadSettings,
  saveSettings,
  validateSettings,
  type RunStateDomain,
} from "@lemma/core";

import { CliUsageError, type CliCommandHandler, type CliCommandSpec } from "./index-types.js";
import { demoCommand } from "./demo.js";
import { DEFAULT_HOST_INSTALL_LAYOUTS, HOST_IDS, isHostId, type HostId } from "@lemma/adapters-sdk";
import {
  ASSAY_COMMAND_CATALOG,
  renderAllCatalogCommandTemplates,
  renderLemmaSkillTemplate,
  renderOperationalCommandTemplate,
} from "@lemma/agent";
import {
  ProUnavailableError,
  compareRevisions,
  getSpecialistCommand,
  historyRead,
  inventoryListCheck,
  inventoryRead,
  listRevisions,
  runModelEval,
  runPropertyProof,
  runSpecialistCommand,
} from "@lemma/pro";

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

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
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
      // boolean-ish known flags handled by callers via getBool; default: consume next if value-like
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

function getStringArray(flags: Record<string, string | boolean | string[]>, ...names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = flags[n];
    if (v === undefined || v === true || v === false) continue;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
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
  let kind = "directory";
  try {
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

async function loadLatestReport(root: string): Promise<Record<string, unknown>> {
  const store = new StateStore(root);
  if (!(await store.exists())) {
    throw new StateError("No .lemma/progress.json exists yet; run `lemma run` first.", { details: { root: store.root } });
  }
  const state = (await store.loadProgress<unknown>()) as RunStateDomain;
  return loadReportForState(root, state);
}

async function readKeyMaterial(value: string): Promise<string> {
  const p = path.resolve(process.cwd(), value);
  try {
    const st = await fs.stat(p);
    if (st.isFile()) return (await fs.readFile(p, "utf8")).trim();
  } catch {
    // treat as literal
  }
  const abs = path.isAbsolute(value) ? value : undefined;
  if (abs) {
    try {
      const st = await fs.stat(abs);
      if (st.isFile()) return (await fs.readFile(abs, "utf8")).trim();
    } catch {
      // literal
    }
  }
  return value;
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
  const confidence = isRecord(report.confidence) ? report.confidence : {};
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
  if (getBool(flags, "background")) {
    const bgDir = path.join(root, ".lemma", "background");
    const bgStatusPath = path.join(bgDir, "status.json");
    const bgEventsPath = path.join(bgDir, "events.jsonl");
    const bgSummaryPath = path.join(bgDir, "summary.json");
    const bgKillPath = path.join(bgDir, "KILL");
    const readJsonMaybe = async (p: string): Promise<unknown | null> => {
      try { return JSON.parse(await fs.readFile(p, "utf8")) as unknown; } catch { return null; }
    };
    const readEventsTail = async (p: string, limit = 50): Promise<unknown[]> => {
      try {
        const raw = await fs.readFile(p, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        return lines.slice(-limit).map((line) => {
          try { return JSON.parse(line) as unknown; } catch { return { raw: line }; }
        });
      } catch { return []; }
    };
    const bgStatus = await readJsonMaybe(bgStatusPath);
    const bgSummary = await readJsonMaybe(bgSummaryPath);
    const bgEvents = await readEventsTail(bgEventsPath, 50);
    let bgKill: unknown = null;
    try {
      const k = await fs.readFile(bgKillPath, "utf8");
      bgKill = k.trim() ? (() => { try { return JSON.parse(k); } catch { return k.trim(); } })() : null;
    } catch { bgKill = null; }
    return {
      stdoutJson: {
        schema_version: REPORT_SCHEMA,
        status: "ok",
        background: {
          root: bgDir,
          status: bgStatus,
          summary: bgSummary,
          events: bgEvents,
          kill: bgKill,
          paths: {
            status: bgStatusPath,
            events: bgEventsPath,
            summary: bgSummaryPath,
            kill: bgKillPath,
          },
        },
      },
    };
  }
  if (getBool(flags, "all")) {
    const history = await store.loadHistory();
    const runs = history.runs ?? [];
    return {
      stdoutJson: {
        schema_version: REPORT_SCHEMA,
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
        schema_version: REPORT_SCHEMA,
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
      schema_version: REPORT_SCHEMA,
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
  const report = await loadLatestReport(root);
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
      schema_version: REPORT_SCHEMA,
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
      schema_version: REPORT_SCHEMA,
      status: dryRun ? "dry_run" : "pruned",
      root: store.root,
      removed: result.removed,
      retained: result.retained,
      count: result.retained.length,
    },
  };
};

function resolvePersonasDir(root: string, personasDirArg: string | undefined): string {
  const raw = personasDirArg ?? "personas";
  if (path.isAbsolute(raw)) return raw;
  const cwdCandidate = path.resolve(process.cwd(), raw);
  const rootCandidate = path.resolve(root, raw);
  try {
    if (statSync(cwdCandidate).isDirectory()) return cwdCandidate;
  } catch {
    // fall through
  }
  return rootCandidate;
}

export const personasCommand: CliCommandHandler = async (argv) => {
  const { flags, positionals } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const personasDir = resolvePersonasDir(root, getString(flags, "personas-dir"));
  const action = positionals[0] ?? "list";
  const personaId = positionals[1];
  // support --action style is not in assay, but keep positional simple
  if (action !== "list" && action !== "lint" && action !== "scaffold") {
    // if user passed id as first positional to scaffold in some forms? keep strict-ish
  }

  if (action !== "scaffold" && personaId) {
    throw new CliUsageError("A persona id is only valid with 'personas scaffold <id>'.", { action, personaId });
  }

  if (action === "list") {
    const selected = csv(getString(flags, "select"));    const personas = await loadPersonas(personasDir, selected.length ? { selected, requireMinimum: 0 } : { requireMinimum: 0 });
    return {
      stdoutJson: {
        schema_version: "quality-harness.personas/v1",
        directory: personasDir,
        count: personas.length,
        personas: personas.map((persona) => ({
          id: persona.id,
          name: persona.name,
          version: persona.version,
          domains: persona.domains,
          tools: persona.tools,
          checks: persona.checks,
          path: persona.path,
          output_schema: persona.output_schema,
          blocker_schema: persona.blocker_schema,
          refusal_handling: persona.refusal,
        })),
      },
    };
  }

  if (action === "lint") {
    const { buildRegistry } = await import("@lemma/core");
    const registry = await buildRegistry({ root });
    const result = await lintPersonas(personasDir, registry.ids()) as unknown as Record<string, unknown>;
    result.root = root;
    const ok = result.status === "valid";
    return { stdoutJson: result, exitCode: ok ? EXIT_CODES.pass : EXIT_CODES.policyThresholdFailed };
  }

  if (action === "scaffold") {
    if (!personaId) throw new CliUsageError("personas scaffold requires a persona id.", { action });
    const domains = getStringArray(flags, "domain");
    const checks = getStringArray(flags, "check");
    const name = getString(flags, "name");
    const result = await scaffoldPersona(personaId, personasDir, {
      ...(name !== undefined ? { name } : {}),
      ...(domains.length ? { domains } : {}),
      ...(checks.length ? { checks } : {}),
      force: getBool(flags, "force"),
    }) as unknown as Record<string, unknown>;
    const status = asString(result.status);
    const exitCode = status === "created" || status === "overwritten" ? EXIT_CODES.pass : EXIT_CODES.harnessError;
    return { stdoutJson: result, exitCode };
  }

  throw new CliUsageError(`Unknown personas action: ${action}`, { action });
};

export const sarifCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const report = await loadLatestReport(root);
  const sarif = buildSarif(report);
  const output = getString(flags, "output");
  if (output) {
    const outPath = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(sarif, null, 2), "utf8");
    return { stdoutJson: { schema_version: REPORT_SCHEMA, status: "written", path: outPath, format: "sarif" } };
  }
  return { stdoutJson: sarif };
};

export const junitCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const report = await loadLatestReport(root);
  const xml = buildJunit(report);
  const output = getString(flags, "output");
  if (output) {
    const outPath = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, xml, "utf8");
    return { stdoutJson: { schema_version: REPORT_SCHEMA, status: "written", path: outPath, format: "junit" } };
  }
  // JSON-only stdout invariant: wrap XML
  return { stdoutJson: { schema_version: REPORT_SCHEMA, status: "ok", format: "junit", xml } };
};

export const signReportCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const keyArg = getString(flags, "key");
  if (!keyArg) throw new CliUsageError("Missing required --key", { flag: "key" });
  const report = await loadLatestReport(root);
  const key = await readKeyMaterial(keyArg);
  const signature = signReport(report, key);
  const outputArg = getString(flags, "output");
  const outPath = outputArg
    ? (path.isAbsolute(outputArg) ? outputArg : path.resolve(process.cwd(), outputArg))
    : path.join(root, "report.sig");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${signature}\n`, "utf8");
  return { stdoutJson: { schema_version: REPORT_SCHEMA, status: "signed", signature, path: outPath } };
};

export const verifyReportCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const keyArg = getString(flags, "key");
  const sigArg = getString(flags, "signature");
  if (!keyArg) throw new CliUsageError("Missing required --key", { flag: "key" });
  if (!sigArg) throw new CliUsageError("Missing required --signature", { flag: "signature" });
  const report = await loadLatestReport(root);
  const key = await readKeyMaterial(keyArg);
  let signature = sigArg;
  const sigPath = path.resolve(process.cwd(), sigArg);
  try {
    const st = await fs.stat(sigPath);
    if (st.isFile()) signature = (await fs.readFile(sigPath, "utf8")).trim();
  } catch {
    // treat as literal signature
  }
  const valid = verifyReportSignature(report, signature, key);
  return {
    exitCode: valid ? EXIT_CODES.pass : EXIT_CODES.policyThresholdFailed,
    stdoutJson: { schema_version: REPORT_SCHEMA, status: valid ? "valid" : "invalid", verified: valid },
  };
};

export const suppressCommand: CliCommandHandler = async (argv) => {
  const { flags, positionals } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const action = positionals[0];
  if (!action || !["add", "list", "remove"].includes(action)) {
    throw new CliUsageError("suppress requires action: add, list, or remove", { action });
  }
  const store = new SuppressionStore(root);
  if (action === "list") {
    const suppressions = await store.load();
    return { stdoutJson: { schema_version: "quality-harness.suppressions/v1", status: "ok", count: suppressions.length, suppressions } };
  }
  if (action === "add") {
    const fingerprint = getString(flags, "fingerprint") ?? positionals[1];
    const owner = getString(flags, "owner");
    const reason = getString(flags, "reason");
    const ticket = getString(flags, "ticket") ?? "";
    const expires = getString(flags, "expires") ?? getString(flags, "expires-at") ?? getString(flags, "expires_at");
    if (!fingerprint) throw new CliUsageError("suppress add requires --fingerprint", { flag: "fingerprint" });
    if (!owner) throw new CliUsageError("suppress add requires --owner", { flag: "owner" });
    if (!reason) throw new CliUsageError("suppress add requires --reason", { flag: "reason" });
    if (!expires) throw new CliUsageError("suppress add requires --expires", { flag: "expires" });
    const record = await store.add(fingerprint, owner, reason, ticket, expires);
    return { stdoutJson: { schema_version: "quality-harness.suppressions/v1", status: "added", suppression: record } };
  }
  // remove
  const fingerprint = getString(flags, "fingerprint") ?? positionals[1];
  if (!fingerprint) throw new CliUsageError("suppress remove requires --fingerprint", { flag: "fingerprint" });
  const record = await store.remove(fingerprint);
  return { stdoutJson: { schema_version: "quality-harness.suppressions/v1", status: "removed", suppression: record } };
};

export const calibrateCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const fixturesArg = getString(flags, "fixtures-dir") ?? "calibration/fixtures";
  const outputArg = getString(flags, "output") ?? "calibration-report.json";
  const fixturesDir = path.isAbsolute(fixturesArg) ? fixturesArg : ((): string => {
    const cwdCandidate = path.resolve(process.cwd(), fixturesArg);
    const rootCandidate = path.resolve(root, fixturesArg);
    try { if (statSync(cwdCandidate).isDirectory()) return cwdCandidate; } catch { /* */ }
    return rootCandidate;
  })();
  const output = path.isAbsolute(outputArg) ? outputArg : path.resolve(process.cwd(), outputArg);
  const report = await writeCalibrationReport(fixturesDir, output);
  return { stdoutJson: report };
};

export const verifyEvidenceCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  let runId = getString(flags, "run-id") ?? getString(flags, "run_id");
  if (!runId) {
    const store = new StateStore(root);
    if (await store.exists()) {
      try {
        const state = await store.loadProgress<Record<string, unknown>>();
        if (typeof state.run_id === "string" && state.run_id) runId = state.run_id;
      } catch {
        // fall through
      }
    }
    if (!runId) {
      // fallback to newest evidence directory
      const evidenceRoot = path.join(root, ".lemma", "evidence");
      try {
        const entries = await fs.readdir(evidenceRoot, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        runId = dirs[dirs.length - 1];
      } catch {
        runId = undefined;
      }
    }
  }
  if (!runId) {
    throw new StateError("No run id or evidence directory found.", { details: { root } });
  }
  const result = await verifyEvidence(root, runId) as unknown as Record<string, unknown>;
  // ensure command field present
  result.command = "verify-evidence";
  result.run_id = runId;
  if (result.tampered) {
    result.confidence_cap = 0.0;
    result.decision = "hold";
    return { exitCode: EXIT_CODES.policyThresholdFailed, stdoutJson: result };
  }
  return { exitCode: EXIT_CODES.pass, stdoutJson: result };
};


async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(s);
      await fs.symlink(target, d);
    } else {
      await fs.mkdir(path.dirname(d), { recursive: true });
      await fs.copyFile(s, d);
    }
  }
}

export const migrateStateCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const fromName = getString(flags, "from") ?? ".harness";
  const toName = getString(flags, "to") ?? ".lemma";
  const dryRun = getBool(flags, "dry-run");
  const force = getBool(flags, "force");

  if (!fromName || !toName || fromName === toName) {
    throw new CliUsageError("migrate-state requires distinct --from and --to state directory names", {
      from: fromName,
      to: toName,
    });
  }

  const fromDir = path.join(root, fromName);
  const toDir = path.join(root, toName);

  let fromStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    fromStat = await fs.stat(fromDir);
  } catch {
    fromStat = null;
  }
  if (!fromStat || !fromStat.isDirectory()) {
    throw new StateError(`Legacy state directory not found: ${fromDir}`, { details: { from: fromDir } });
  }

  let toExists = false;
  try {
    await fs.access(toDir);
    toExists = true;
  } catch {
    toExists = false;
  }

  if (toExists && !force) {
    return {
      stdoutJson: {
        schema_version: REPORT_SCHEMA,
        status: "exists",
        command: "migrate-state",
        root,
        from: fromDir,
        to: toDir,
        dry_run: dryRun,
        migrated: false,
        message: "Destination state directory already exists; use --force to overwrite.",
      },
    };
  }

  if (!dryRun) {
    if (toExists && force) {
      await fs.rm(toDir, { recursive: true, force: true });
    }
    await copyDirRecursive(fromDir, toDir);
  }

  return {
    stdoutJson: {
      schema_version: REPORT_SCHEMA,
      status: dryRun ? "dry_run" : "migrated",
      command: "migrate-state",
      root,
      from: fromDir,
      to: toDir,
      dry_run: dryRun,
      force,
      migrated: !dryRun,
    },
  };
};


const SUPPORTED_INSTALL_HOSTS = HOST_IDS;
type InstallHost = HostId;

function isInstallHost(v: string): v is InstallHost {
  return isHostId(v);
}

function installLayout(host: InstallHost): { commandsDir: string; skillPath: string } {
  return DEFAULT_HOST_INSTALL_LAYOUTS[host];
}

export const installCommand: CliCommandHandler = async (argv) => {
  const { flags, positionals } = parseArgs(argv);
  const hostArg = positionals[0];
  if (!hostArg) {
    throw new CliUsageError("install requires a host argument", { hosts: [...SUPPORTED_INSTALL_HOSTS] });
  }
  if (!isInstallHost(hostArg)) {
    throw new CliUsageError(`Unsupported install host: ${hostArg}`, {
      host: hostArg,
      hosts: [...SUPPORTED_INSTALL_HOSTS],
    });
  }
  const dirArg = getString(flags, "dir") ?? getString(flags, "root") ?? process.cwd();
  const targetDir = path.isAbsolute(dirArg) ? dirArg : path.resolve(process.cwd(), dirArg);
  const dryRun = getBool(flags, "dry-run");
  const force = getBool(flags, "force");
  const cli = getString(flags, "cli") ?? "lemma";
  const personasDir = getString(flags, "personas-dir") ?? "personas";
  const stateRoot = getString(flags, "state-root") ?? ".lemma";

  const layout = installLayout(hostArg);
  const templateOpts = { cli, personasDir, stateRoot };

  const assets: Array<{ relPath: string; content: string }> = [];
  for (const cmd of ASSAY_COMMAND_CATALOG) {
    const rendered = renderAllCatalogCommandTemplates(templateOpts, [cmd])[0];
    if (rendered) {
      assets.push({ relPath: path.join(layout.commandsDir, `${rendered.name}.md`), content: rendered.markdown });
    }
  }
  for (const name of ["assay", "assay-status", "assay-report", "assay-abort", "assay-verify-evidence"] as const) {
    const rendered = renderOperationalCommandTemplate(name, templateOpts);
    assets.push({ relPath: path.join(layout.commandsDir, `${rendered.name}.md`), content: rendered.markdown });
  }
  assets.push({ relPath: layout.skillPath, content: renderLemmaSkillTemplate(templateOpts) });

  const written: string[] = [];
  const skipped: string[] = [];
  const planned: string[] = [];

  for (const asset of assets) {
    const absPath = path.join(targetDir, asset.relPath);
    planned.push(asset.relPath);
    let exists = false;
    try {
      await fs.stat(absPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !force) {
      skipped.push(asset.relPath);
      continue;
    }
    if (!dryRun) {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, asset.content, "utf8");
    }
    written.push(asset.relPath);
  }

  return {
    stdoutJson: {
      schema_version: REPORT_SCHEMA,
      status: dryRun ? "dry_run" : "installed",
      command: "install",
      host: hostArg,
      dir: targetDir,
      dry_run: dryRun,
      force,
      planned: planned.length,
      written: written.length,
      skipped: skipped.length,
      files: { planned, written, skipped },
    },
  };
};

export const huntCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const targetRaw = getString(flags, "target", "t");
  if (!targetRaw) throw new CliUsageError("Missing required --target", { flag: "target" });
  const root = path.resolve(getString(flags, "root", "cwd") ?? ".");
  const maxStepsStr = getString(flags, "max-steps");
  const maxSteps = maxStepsStr !== undefined ? toInt(maxStepsStr, "--max-steps") : 20;
  const wallClockMsStr = getString(flags, "wall-clock-ms");
  const wallClockBudgetMs = wallClockMsStr !== undefined ? toInt(wallClockMsStr, "--wall-clock-ms") : 30_000;
  const seedStr = getString(flags, "seed");
  const seed = seedStr !== undefined ? toInt(seedStr, "--seed") : undefined;
  const clockMode = getString(flags, "clock-mode") as "real" | "frozen" | undefined;
  const frozenClock = getString(flags, "frozen-clock");
  const personasDir = getString(flags, "personas-dir");
  const scenarioText = getString(flags, "scenario");
  const scenarioFile = getString(flags, "scenario-file");
  let scenarioPlan: string | undefined = scenarioText;
  if (scenarioFile) {
    const p = path.isAbsolute(scenarioFile) ? scenarioFile : path.resolve(process.cwd(), scenarioFile);
    scenarioPlan = await fs.readFile(p, "utf8");
  }

  const result = await runBugHunt({
    target: normalizeCliTarget(targetRaw),
    root,
    maxSteps,
    wallClockBudgetMs,
    ...(seed !== undefined ? { seed } : {}),
    ...((clockMode || frozenClock) ? { clock: { ...(clockMode ? { mode: clockMode } : {}), frozen: frozenClock ?? null } } : {}),
    ...(personasDir ? { personasDir } : {}),
    ...(scenarioPlan ? { scenarioPlan } : {}),
  });

  const code =
    result.status === "halted"
      ? EXIT_CODES.killSwitchHalt
      : result.status === "failed"
        ? EXIT_CODES.harnessError
        : EXIT_CODES.pass;
  return { exitCode: code, stdoutJson: result as unknown as Record<string, unknown> };
};


export const settingsCommand: CliCommandHandler = async (argv) => {
  const { flags } = parseArgs(argv);
  const root = path.resolve(getString(flags, "root") ?? ".");
  const store = new StateStore(root);
  await store.ensure();
  const setJson = getString(flags, "set-json", "set");
  const reset = getBool(flags, "reset");

  if (reset) {
    const saved = await saveSettings(store, {
      schema_version: "lemma.settings/v1",
      budget: { minutes: 10, maxChecks: 20 },
      focus: { project: null, url: null },
      analytics: { enabled: false, endpoint: null },
    }, { source: "cli" });
    return { stdoutJson: { ok: true, command: "settings", settings: saved, path: ".lemma/settings.json" } };
  }

  if (setJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(setJson);
    } catch {
      throw new CliUsageError("Invalid JSON for --set-json/--set", { flag: "set-json" });
    }
    // allow partial merge if object provided without schema_version? AC expects schema-validated writes; merge onto current for convenience
    let candidate: unknown = parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cur = await loadSettings(store);
      const p = parsed as Record<string, unknown>;
      if (!("schema_version" in p)) {
        candidate = {
          schema_version: "lemma.settings/v1",
          budget: { ...cur.budget, ...(isRecord(p.budget) ? p.budget : {}) },
          focus: { ...cur.focus, ...(isRecord(p.focus) ? p.focus : {}) },
          analytics: { ...cur.analytics, ...(isRecord(p.analytics) ? p.analytics : {}) },
        };
      }
    }
    const saved = await saveSettings(store, candidate, { source: "cli" });
    return { stdoutJson: { ok: true, command: "settings", settings: saved, path: ".lemma/settings.json" } };
  }

  // flag-based updates
  const hasUpdates = [
    "budget-minutes", "budget-max-checks", "focus-project", "focus-url", "analytics-enabled", "analytics-endpoint"
  ].some((k) => getFlag(flags, k) !== undefined);
  if (hasUpdates) {
    const cur = await loadSettings(store);
    const next = {
      schema_version: "lemma.settings/v1",
      budget: { ...cur.budget },
      focus: { ...cur.focus },
      analytics: { ...cur.analytics },
    } as any;
    const bm = getString(flags, "budget-minutes");
    const bmc = getString(flags, "budget-max-checks");
    const fp = getString(flags, "focus-project");
    const fu = getString(flags, "focus-url");
    const ae = getFlag(flags, "analytics-enabled");
    const aep = getString(flags, "analytics-endpoint");
    if (bm !== undefined) next.budget.minutes = Number(bm);
    if (bmc !== undefined) next.budget.maxChecks = Number(bmc);
    if (fp !== undefined) next.focus.project = fp === "" || fp === "null" ? null : fp;
    if (fu !== undefined) next.focus.url = fu === "" || fu === "null" ? null : fu;
    if (ae !== undefined) next.analytics.enabled = ae === true || ae === "true" || ae === "1" || ae === "yes";
    if (aep !== undefined) next.analytics.endpoint = aep === "" || aep === "null" ? null : aep;
    const saved = await saveSettings(store, validateSettings(next), { source: "cli" });
    return { stdoutJson: { ok: true, command: "settings", settings: saved, path: ".lemma/settings.json" } };
  }

  const settings = await loadSettings(store);
  return { stdoutJson: { ok: true, command: "settings", settings, path: ".lemma/settings.json" } };
};



export const proCommand: CliCommandHandler = async (argv) => {
  const { flags, positionals } = parseArgs(argv);
  const sub = positionals[0] ?? "";
  if (!sub) {
    throw new CliUsageError("Missing subcommand. Usage: lemma pro <confidence|security|performance|privacy|proof|inventory|history|eval> [options]", { command: "pro" });
  }

  const root = path.resolve(getString(flags, "root") ?? process.cwd());

  // License resolution reusing LEM-114/LEM-117 contract-shaped inputs (no parallel auth).
  let license: any = null;
  const entitlementJson = getString(flags, "entitlement-json") ?? process.env.LEMMA_PRO_ENTITLEMENT_JSON;
  const entitlementFile = getString(flags, "entitlement-file") ?? process.env.LEMMA_PRO_ENTITLEMENT_FILE;
  try {
    if (entitlementJson) {
      license = { entitlement: JSON.parse(entitlementJson) };
      if (isRecord(license.entitlement) && isRecord((license.entitlement as any).verification)) {
        license = { verification: (license.entitlement as any).verification, entitlement: (license.entitlement as any).entitlement ?? null };
      } else if (isRecord(license.entitlement) && (license.entitlement as any).valid !== undefined && (license.entitlement as any).schema_version === undefined) {
        license = { verification: license.entitlement };
      }
    } else if (entitlementFile) {
      const p = path.isAbsolute(entitlementFile) ? entitlementFile : path.resolve(process.cwd(), entitlementFile);
      const raw = await fs.readFile(p, "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed) && (parsed as any).valid !== undefined && !("schema_version" in (parsed as any))) {
        license = { verification: parsed };
      } else if (isRecord(parsed) && (parsed as any).verification) {
        license = { verification: (parsed as any).verification, entitlement: (parsed as any).entitlement ?? null, auth: (parsed as any).auth ?? null };
      } else {
        license = { entitlement: parsed };
      }
    }
  } catch {
    license = null;
  }

  if (sub === "proof") {
    const property = getString(flags, "property");
    const targetRaw = getString(flags, "target", "t") ?? positionals[1];
    if (!property) throw new CliUsageError("Missing required --property for `lemma pro proof`", { flag: "property" });
    if (!targetRaw) throw new CliUsageError("Missing required --target for `lemma pro proof`", { flag: "target" });
    let scope: any = undefined;
    let assumptions: any = undefined;
    const scopeJson = getString(flags, "scope-json");
    const assumptionsJson = getString(flags, "assumptions-json");
    if (scopeJson) { try { scope = JSON.parse(scopeJson); } catch { throw new CliUsageError("Invalid JSON for --scope-json", { flag: "scope-json" }); } }
    if (assumptionsJson) { try { assumptions = JSON.parse(assumptionsJson); } catch { throw new CliUsageError("Invalid JSON for --assumptions-json", { flag: "assumptions-json" }); } }
    const backend = getString(flags, "backend");
    const recomputeStaleness = getBool(flags, "recompute-staleness") || getBool(flags, "check-staleness");
    try {
      const result = await runPropertyProof({
        property,
        target: String(targetRaw),
        ...(scope !== undefined ? { scope } : {}),
        ...(assumptions !== undefined ? { assumptions } : {}),
        backend: backend ?? null,
        license,
        root,
        cwd: root,
        recomputeStaleness,
      });
      return { stdoutJson: result };
    } catch (err) {
      if (err instanceof ProUnavailableError) throw err;
      throw err;
    }
  }

  if (sub === "inventory") {
    const action = positionals[1] ?? "show";
    if (action === "show") {
      const inv = await inventoryRead({ projectRoot: root, license });
      return { stdoutJson: inv };
    }
    if (action === "list") {
      const checkId = getString(flags, "check");
      if (!checkId) {
        throw new CliUsageError("Missing required --check for `lemma pro inventory list`", { flag: "check" });
      }
      const result = await inventoryListCheck({ projectRoot: root, license, checkId });
      return { stdoutJson: result };
    }
    throw new CliUsageError(`Unknown pro inventory action: ${action}`, { action, allowed: ["show", "list"] });
  }

  if (sub === "history") {
    const action = positionals[1] ?? "show";
    if (action === "show") {
      const windowStr = getString(flags, "window", "n");
      if (windowStr === undefined) {
        throw new CliUsageError("Missing required --window for `lemma pro history show`", { flag: "window" });
      }
      const window = toInt(windowStr, "--window");
      const hist = await historyRead({ projectRoot: root, license, window });
      return { stdoutJson: hist };
    }
    throw new CliUsageError(`Unknown pro history action: ${action}`, { action, allowed: ["show"] });
  }

  if (sub === "eval") {
    const action = positionals[1];
    if (action === "revisions") {
      const caseId = getString(flags, "case", "case-id");
      if (!caseId) throw new CliUsageError("Missing required --case for `lemma pro eval revisions`", { flag: "case" });
      const runId = getString(flags, "run-id", "run");
      const result = await listRevisions({ caseId, projectRoot: root, license, ...(runId ? { runId } : {}) } as any);
      return { stdoutJson: result };
    }
    if (action === "compare") {
      const caseId = getString(flags, "case", "case-id");
      const from = getString(flags, "from");
      const to = getString(flags, "to");
      if (!caseId) throw new CliUsageError("Missing required --case for `lemma pro eval compare`", { flag: "case" });
      if (!from) throw new CliUsageError("Missing required --from for `lemma pro eval compare`", { flag: "from" });
      if (!to) throw new CliUsageError("Missing required --to for `lemma pro eval compare`", { flag: "to" });
      const runId = getString(flags, "run-id", "run");
      const result = await compareRevisions({ caseId, from, to, projectRoot: root, license, ...(runId ? { runId } : {}) } as any);
      return { stdoutJson: result };
    }

    const cases = getString(flags, "cases", "cases-dir") ?? (action && !action.startsWith("-") ? action : positionals[2]);
    const baselinePath = getString(flags, "baseline", "baseline-path");
    const endpoint = getString(flags, "endpoint");
    const seedStr = getString(flags, "seed");
    const clockMode = getString(flags, "clock-mode") as "real" | "frozen" | undefined;
    const frozenClock = getString(flags, "frozen-clock");
    const modelConfig: any = {};
    if (baselinePath) modelConfig.baselinePath = path.isAbsolute(baselinePath) ? baselinePath : path.resolve(process.cwd(), baselinePath);
    if (endpoint === "none" || endpoint === "unconfigured") modelConfig.endpoint = null;
    if (endpoint === "stub") {
      modelConfig.stub = true;
      modelConfig.endpoint = { invoke: ({ case: c }: any) => ({ output: { stub: true, id: c.id }, pass: true, rationale: "stub pass" }) };
    }
    const result = await runModelEval({
      ...(cases ? { cases } : {}),
      modelConfig: Object.keys(modelConfig).length ? modelConfig : null,
      ...(seedStr !== undefined ? { seed: toInt(seedStr, "--seed") } : {}),
      ...(clockMode || frozenClock ? { clock: { ...(clockMode ? { mode: clockMode } : {}), ...(frozenClock ? { frozen: frozenClock } : {}) } } : {}),
      license,
      projectRoot: root,
    } as any);
    return { stdoutJson: result };
  }

  const spec = getSpecialistCommand(sub);
  if (!spec) {
    throw new CliUsageError(`Unknown pro subcommand/specialist: ${sub}`, { subcommand: sub, allowed: ["confidence", "security", "performance", "privacy", "proof", "inventory", "history", "eval"] });
  }

  const targetRaw = getString(flags, "target", "t") ?? ".";
  const personasDir = getString(flags, "personas-dir");
  const maxChecksStr = getString(flags, "max-checks");
  const wallClockStr = getString(flags, "wall-clock-budget-ms", "wall-clock-ms");
  const seedStr = getString(flags, "seed");
  const clockMode = getString(flags, "clock-mode") as "real" | "frozen" | undefined;
  const frozenClock = getString(flags, "frozen-clock");
  const noBrowser = getBool(flags, "no-browser");

  try {
    const result = await runSpecialistCommand({
      specialist: spec.id,
      target: normalizeCliTarget(targetRaw),
      root,
      ...(personasDir ? { personasDir: path.isAbsolute(personasDir) ? personasDir : path.resolve(process.cwd(), personasDir) } : {}),
      license,
      ...(maxChecksStr !== undefined ? { maxChecks: toInt(maxChecksStr, "--max-checks") } : {}),
      ...(wallClockStr !== undefined ? { wallClockBudgetMs: toInt(wallClockStr, "--wall-clock-budget-ms") } : {}),
      ...(seedStr !== undefined ? { seed: toInt(seedStr, "--seed") } : {}),
      ...(clockMode ? { clockMode } : {}),
      ...(frozenClock ? { frozenClock } : {}),
      ...(noBrowser ? { noBrowser: true } : {}),
      intent: spec.intent,
    });
    return { stdoutJson: result.report && Object.keys(result.report).length ? result.report : (result as any) };
  } catch (err) {
    if (err instanceof ProUnavailableError) throw err;
    throw err;
  }
};


export function coreCommandSpecs(): CliCommandSpec[] {
  return [
    { name: "run", description: "Run the release-confidence workflow.", handler: runCommand },
    { name: "status", description: "Print persisted run state or history.", handler: statusCommand },
    { name: "report", description: "Print the latest saved report.", handler: reportCommand },
    { name: "abort", description: "Request a manual kill of the current run.", handler: abortCommand },
    { name: "prune", description: "Prune historical runs and evidence.", handler: pruneCommand },
    { name: "personas", description: "List, lint, or scaffold persona contracts.", handler: personasCommand },
    { name: "sarif", description: "Export the latest report as SARIF.", handler: sarifCommand },
    { name: "junit", description: "Export the latest report as JUnit XML.", handler: junitCommand },
    { name: "sign-report", description: "Sign the latest report.", handler: signReportCommand },
    { name: "verify-report", description: "Verify a report signature.", handler: verifyReportCommand },
    { name: "suppress", description: "Manage finding suppressions.", handler: suppressCommand },
    { name: "suppressions", description: "Alias for suppress.", handler: suppressCommand },
    { name: "calibrate", description: "Run calibration fixtures and emit a report.", handler: calibrateCommand },
    { name: "verify-evidence", description: "Verify evidence manifest and artifacts for a run.", handler: verifyEvidenceCommand },
    { name: "install", description: "Install lemma host integration assets for a target host.", handler: installCommand },
    { name: "migrate-state", description: "Migrate legacy .harness state to .lemma with a safe copy shim.", handler: migrateStateCommand },
    { name: "hunt", description: "Run the bounded stateful bug-hunting workflow.", handler: huntCommand },
    { name: "settings", description: "View or update lemma settings.", handler: settingsCommand },
    { name: "demo", description: "Generate a disposable, test-only demo project for trying lemma.", handler: demoCommand },
    { name: "pro", description: "Run entitlement-gated Pro workflows (specialists: confidence|security|performance|privacy, proof, inventory, history, eval).", handler: proCommand },
  ];
}
