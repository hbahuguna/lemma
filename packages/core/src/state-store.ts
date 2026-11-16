import * as fs from "node:fs/promises";
import * as path from "node:path";

import { CorruptStateError, StateError } from "./errors.js";
import {
  HISTORY_SCHEMA_VERSION,
  type History,
  type RunState,
} from "./schemas/state.js";
import { Severity } from "./models.js";
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  readJsonFile,
} from "./state.js";

const LEGACY_HISTORY_SCHEMA = "quality-harness.history/v1" as const;

type HistoryEntry = History["runs"][number];

export interface PruneOptions {
  keepRuns?: number;
  olderThanDays?: number;
  dryRun?: boolean;
  now?: string | Date;
}

export interface PruneResult {
  removed: string[];
  retained: string[];
  dryRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNow(now?: string | Date): Date {
  if (now === undefined) return new Date();
  if (now instanceof Date) return now;
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new StateError("Invalid prune 'now' timestamp", { details: { now } });
  }
  return d;
}

function historySortKey(entry: HistoryEntry): [string, string] {
  const ts = entry.completed_at ?? entry.started_at ?? entry.recorded_at ?? "";
  const runId = entry.run_id ?? "";
  return [String(ts), String(runId)];
}

function compareHistoryDesc(a: HistoryEntry, b: HistoryEntry): number {
  const ka = historySortKey(a);
  const kb = historySortKey(b);
  if (ka[0] === kb[0]) return kb[1].localeCompare(ka[1]);
  return kb[0].localeCompare(ka[0]);
}

function normalizeHistory(data: unknown): History {
  if (!isRecord(data)) {
    throw new StateError("history.json must contain an object", { details: { path: "history.json" } });
  }
  const runsRaw = data.runs;
  if (!Array.isArray(runsRaw)) {
    throw new StateError("history.json must contain a 'runs' array", { details: { path: "history.json" } });
  }
  const schemaVersion = asString(data.schema_version);
  if (
    schemaVersion &&
    schemaVersion !== HISTORY_SCHEMA_VERSION &&
    schemaVersion !== LEGACY_HISTORY_SCHEMA
  ) {
    throw new StateError(`Unsupported history schema version: ${schemaVersion}`, {
      details: { schema_version: schemaVersion },
    });
  }
  const runs: HistoryEntry[] = runsRaw.filter((r): r is HistoryEntry => {
    return isRecord(r) && typeof r.run_id === "string" && typeof r.status === "string";
  });
  runs.sort(compareHistoryDesc);
  return {
    ...data,
    schema_version: HISTORY_SCHEMA_VERSION,
    runs,
  };
}

export class StateStore {
  readonly root: string;
  readonly lemmaDir: string;
  readonly progressPath: string;
  readonly eventsPath: string;
  readonly historyPath: string;
  readonly killPath: string;
  readonly evidenceRoot: string;
  readonly legacyDir: string | null;
  readonly legacyProgressPath: string | null;
  readonly legacyEventsPath: string | null;
  readonly legacyHistoryPath: string | null;
  readonly legacyKillPath: string | null;

  constructor(root: string, options?: { stateDirName?: string; legacyStateDirName?: string | null }) {
    this.root = path.resolve(root);
    const dirName = options?.stateDirName ?? ".lemma";
    this.lemmaDir = path.join(this.root, dirName);
    this.progressPath = path.join(this.lemmaDir, "progress.json");
    this.eventsPath = path.join(this.lemmaDir, "events.jsonl");
    this.historyPath = path.join(this.lemmaDir, "history.json");
    this.killPath = path.join(this.lemmaDir, "KILL");
    this.evidenceRoot = path.join(this.lemmaDir, "evidence");

    const legacyName = options && Object.prototype.hasOwnProperty.call(options, "legacyStateDirName")
      ? options.legacyStateDirName
      : ".harness";
    if (legacyName && legacyName !== dirName) {
      this.legacyDir = path.join(this.root, legacyName);
      this.legacyProgressPath = path.join(this.legacyDir, "progress.json");
      this.legacyEventsPath = path.join(this.legacyDir, "events.jsonl");
      this.legacyHistoryPath = path.join(this.legacyDir, "history.json");
      this.legacyKillPath = path.join(this.legacyDir, "KILL");
    } else {
      this.legacyDir = null;
      this.legacyProgressPath = null;
      this.legacyEventsPath = null;
      this.legacyHistoryPath = null;
      this.legacyKillPath = null;
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async ensure(): Promise<void> {
    await ensureDir(this.lemmaDir);
    await ensureDir(this.evidenceRoot);
    const gitignorePath = path.join(this.lemmaDir, ".gitignore");
    try {
      await fs.access(gitignorePath);
    } catch {
      await atomicWriteFile(gitignorePath, "*\n!.gitignore\n");
    }
  }

  async exists(): Promise<boolean> {
    if (await this.pathExists(this.progressPath)) return true;
    if (this.legacyProgressPath && await this.pathExists(this.legacyProgressPath)) return true;
    return false;
  }

  async usingLegacyState(): Promise<boolean> {
    if (await this.pathExists(this.progressPath)) return false;
    return Boolean(this.legacyProgressPath && await this.pathExists(this.legacyProgressPath));
  }

  async saveProgress(state: RunState | Record<string, unknown>): Promise<void> {
    await this.ensure();
    const data: Record<string, unknown> = isRecord(state) ? { ...state } : {};
    if (!data.updated_at) {
      data.updated_at = new Date().toISOString();
    }
    await atomicWriteJson(this.progressPath, data);
  }

  async loadProgress<T = RunState>(): Promise<T> {
    const paths = [this.progressPath, ...(this.legacyProgressPath ? [this.legacyProgressPath] : [])];
    for (const pth of paths) {
      try {
        return await readJsonFile<T>(pth);
      } catch (err) {
        if (err instanceof CorruptStateError) throw err;
        if (err instanceof StateError) {
          const details = err.details;
          const reason = isRecord(details) ? asString(details.reason) : undefined;
          if (reason === "ENOENT" || err.message.includes("not found")) {
            continue;
          }
        }
        throw err;
      }
    }
    throw new StateError(
      this.legacyProgressPath
        ? `No progress state found at ${this.progressPath} (or legacy ${this.legacyProgressPath})`
        : `No progress state found at ${this.progressPath}`,
      { details: { path: this.progressPath, legacy_path: this.legacyProgressPath ?? null } },
    );
  }

  async clearProgress(): Promise<void> {
    try {
      await fs.unlink(this.progressPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new StateError(`Could not remove progress.json: ${String(err)}`, {
          details: { path: this.progressPath },
        });
      }
    }
  }

  async appendEvent(event: Record<string, unknown>): Promise<void> {
    try {
      await this.ensure();
      const record: Record<string, unknown> = { ...event };
      if (record.timestamp === undefined || record.timestamp === null || record.timestamp === "") {
        record.timestamp = new Date().toISOString();
      }
      const line = `${JSON.stringify(record)}\n`;
      await fs.appendFile(this.eventsPath, line, "utf8");
    } catch {
      // Audit/event logging must never crash state operations.
    }
  }

  async loadHistory(): Promise<History> {
    const paths = [this.historyPath, ...(this.legacyHistoryPath ? [this.legacyHistoryPath] : [])];
    for (const pth of paths) {
      try {
        const data = await readJsonFile<unknown>(pth);
        return normalizeHistory(data);
      } catch (err) {
        if (err instanceof CorruptStateError) {
          throw new StateError(`history.json is not valid JSON: ${err.message}`, {
            details: { path: pth },
          });
        }
        if (err instanceof StateError) {
          const details = err.details;
          const reason = isRecord(details) ? asString(details.reason) : undefined;
          if (reason === "ENOENT" || err.message.includes("not found")) {
            continue;
          }
        }
        throw err;
      }
    }
    return { schema_version: HISTORY_SCHEMA_VERSION, runs: [] };
  }

  async saveHistory(history: History): Promise<void> {
    await this.ensure();
    const normalized = normalizeHistory(history);
    await atomicWriteJson(this.historyPath, normalized);
  }

  private historyEntry(
    state: RunState | Record<string, unknown>,
    report?: Record<string, unknown>,
  ): HistoryEntry {
    const s: Record<string, unknown> = isRecord(state) ? state : {};
    const r = report;
    const decisionObj = isRecord(r?.decision) ? r.decision : undefined;
    const confidence = isRecord(s.confidence) ? s.confidence : undefined;
    const confidenceScore = confidence && typeof confidence.score === "number" ? confidence.score : undefined;
    const score = typeof s.score === "number" ? s.score : confidenceScore;
    const status = asString(s.status) ?? "unknown";
    let decision = asString(s.decision) ?? asString(decisionObj?.decision);
    if (!decision) {
      if (status === "halted" || status === "failed") decision = "hold";
      else {
        const gate = isRecord(confidence?.gate) ? confidence.gate : undefined;
        const gateStatus = asString(gate?.status);
        decision = gateStatus === "pass" ? "ship" : gateStatus === "fail" ? "hold" : "review";
      }
    }
    const runId = asString(s.run_id) ?? "";
    const evidencePath =
      asString(s.evidence_dir) ?? path.posix.join(".lemma", "evidence", runId);

    const findingCounts: Record<string, number> = {
      [Severity.CRITICAL]: 0,
      [Severity.HIGH]: 0,
      [Severity.MEDIUM]: 0,
      [Severity.LOW]: 0,
      [Severity.INFO]: 0,
    };
    const fingerprints = new Set<string>();
    if (Array.isArray(s.findings)) {
      for (const f of s.findings) {
        if (!isRecord(f)) continue;
        const sev = typeof f.severity === "string" ? f.severity : "";
        if (sev in findingCounts) findingCounts[sev] = (findingCounts[sev] ?? 0) + 1;
        const fp = typeof f.fingerprint === "string" ? f.fingerprint : "";
        if (fp) fingerprints.add(fp);
      }
    }

    const entry: Record<string, unknown> = {
      run_id: runId,
      status,
      recorded_at: new Date().toISOString(),
    };
    if (decision) entry.decision = decision;
    if (score !== undefined) entry.score = score;
    if (asString(s.workflow_id)) entry.workflow_id = asString(s.workflow_id);
    if (asString(s.workflow_version)) entry.workflow_version = asString(s.workflow_version);
    if (s.target !== undefined) entry.target = s.target;
    if (evidencePath) entry.evidence_path = evidencePath;
    entry.finding_counts = findingCounts;
    entry.finding_fingerprints = [...fingerprints].sort();
    const startedAt = asString(s.started_at);
    if (startedAt) entry.started_at = startedAt;
    if (s.completed_at === null || typeof s.completed_at === "string") {
      entry.completed_at = s.completed_at;
    }

    return entry as HistoryEntry;
  }

  async recordRun(
    state: RunState | Record<string, unknown>,
    report?: Record<string, unknown>,
  ): Promise<HistoryEntry> {
    const entry = this.historyEntry(state, report);
    if (!entry.run_id) {
      throw new StateError("Cannot record run history without run_id", { details: {} });
    }
    const history = await this.loadHistory();
    const runs = history.runs.filter((r) => r.run_id !== entry.run_id);
    runs.push(entry);
    runs.sort(compareHistoryDesc);
    await this.saveHistory({ ...history, schema_version: HISTORY_SCHEMA_VERSION, runs });
    return entry;
  }

  private protectedRunIds(runs: HistoryEntry[]): Set<string> {
    const protectedIds = new Set<string>();
    const first = runs[0];
    if (first) protectedIds.add(first.run_id);
    let latestCompletedSeen = false;
    for (const entry of runs) {
      if (entry.status === "halted") protectedIds.add(entry.run_id);
      if (!latestCompletedSeen && entry.status === "completed") {
        protectedIds.add(entry.run_id);
        latestCompletedSeen = true;
      }
    }
    return protectedIds;
  }

  private async removeEvidence(relativePath: unknown): Promise<void> {
    if (typeof relativePath !== "string" || relativePath.length === 0) return;
    if (path.isAbsolute(relativePath)) {
      throw new StateError(`Refusing to remove absolute evidence path: ${relativePath}`, {
        details: { path: relativePath },
      });
    }
    const evidenceRootResolved = path.resolve(this.evidenceRoot);
    const target = path.resolve(this.root, relativePath);
    const rel = path.relative(evidenceRootResolved, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new StateError(`Refusing to remove evidence outside .lemma/evidence: ${relativePath}`, {
        details: { path: relativePath },
      });
    }
    if (target === evidenceRootResolved) {
      throw new StateError("Refusing to remove the evidence root", {
        details: { path: relativePath },
      });
    }
    try {
      await fs.rm(target, { recursive: true, force: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw new StateError(`Could not remove evidence ${relativePath}: ${String(err)}`, {
        details: { path: relativePath },
      });
    }
  }

  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const { keepRuns, olderThanDays, dryRun = false } = options;
    if (keepRuns !== undefined && (!Number.isInteger(keepRuns) || keepRuns < 0)) {
      throw new StateError("keepRuns must be a non-negative integer", { details: { keepRuns } });
    }
    if (olderThanDays !== undefined && (!Number.isInteger(olderThanDays) || olderThanDays < 0)) {
      throw new StateError("olderThanDays must be a non-negative integer", {
        details: { olderThanDays },
      });
    }
    const now = parseNow(options.now);
    const history = await this.loadHistory();
    const runs = [...history.runs].sort(compareHistoryDesc);
    if (runs.length === 0) {
      return { removed: [], retained: [], dryRun };
    }
    const protectedIds = this.protectedRunIds(runs);
    const retained: HistoryEntry[] = [];
    const removed: HistoryEntry[] = [];

    for (let index = 0; index < runs.length; index++) {
      const entry = runs[index];
      if (!entry) continue;
      let keep = true;
      if (keepRuns !== undefined && index >= keepRuns) keep = false;
      if (olderThanDays !== undefined) {
        const ts = entry.completed_at ?? entry.started_at ?? entry.recorded_at;
        if (typeof ts === "string") {
          const d = new Date(ts);
          if (!Number.isNaN(d.getTime())) {
            const ageSeconds = (now.getTime() - d.getTime()) / 1000;
            if (ageSeconds > olderThanDays * 86400) keep = false;
          }
        }
      }
      if (protectedIds.has(entry.run_id)) keep = true;
      (keep ? retained : removed).push(entry);
    }

    if (!dryRun) {
      // Write index first so a crash never claims deleted evidence still exists.
      await this.saveHistory({ ...history, schema_version: HISTORY_SCHEMA_VERSION, runs: retained });
      for (const entry of removed) {
        const evidencePath = isRecord(entry) ? entry.evidence_path : undefined;
        await this.removeEvidence(evidencePath);
      }
    }

    return {
      removed: removed.map((e) => e.run_id),
      retained: retained.map((e) => e.run_id),
      dryRun,
    };
  }

  async requestKill(reason: string): Promise<void> {
    await this.ensure();
    await atomicWriteJson(this.killPath, { reason, requested_at: new Date().toISOString() });
  }

  async killRequest(): Promise<string | null> {
    const paths = [this.killPath, ...(this.legacyKillPath ? [this.legacyKillPath] : [])];
    for (const pth of paths) {
      try {
        const raw = await fs.readFile(pth, "utf8");
        const trimmed = raw.trim();
        if (!trimmed) return "Manual kill requested";
        try {
          const data = JSON.parse(trimmed) as unknown;
          if (isRecord(data)) {
            const reason = asString(data.reason);
            return reason && reason.length > 0 ? reason : "Manual kill requested";
          }
          return "Manual kill requested";
        } catch {
          return trimmed;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        return "Kill file exists but could not be read";
      }
    }
    return null;
  }

  async clearKill(): Promise<void> {
    try {
      await fs.unlink(this.killPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new StateError(`Could not clear kill file: ${String(err)}`, {
          details: { path: this.killPath },
        });
      }
    }
  }
}
