import type { History } from "./schemas/state.js";

export interface TrendDiffResult {
  baseline: boolean;
  previous_run_id: string | null;
  new: string[];
  resolved: string[];
  persistent: string[];
  score_delta: number;
  coverage_delta: number;
}

export interface TrendDiffInput {
  runId?: string;
  targetRaw: string;
  findingFingerprints?: readonly string[];
  findings?: ReadonlyArray<{ fingerprint?: unknown } | null | undefined>;
  score?: number;
  confidence?: { score?: unknown } | null;
  history?: History | { runs?: readonly unknown[] } | readonly unknown[] | null;
  historyRuns?: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter((v) => typeof v === "string" && v.length > 0))).sort();
}

function currentFingerprints(input: TrendDiffInput): Set<string> {
  if (Array.isArray(input.findingFingerprints)) {
    return new Set(sortedUnique(input.findingFingerprints));
  }
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const fps: string[] = [];
  for (const f of findings) {
    if (!isRecord(f)) continue;
    const fp = asString(f.fingerprint);
    if (fp) fps.push(fp);
  }
  return new Set(sortedUnique(fps));
}

function currentScore(input: TrendDiffInput): number {
  const direct = asNumber(input.score);
  if (direct !== undefined) return direct;
  if (isRecord(input.confidence)) {
    const s = asNumber(input.confidence.score);
    if (s !== undefined) return s;
  }
  return 0;
}

function historyRuns(input: TrendDiffInput): readonly unknown[] {
  if (Array.isArray(input.historyRuns)) return input.historyRuns;
  const h = input.history;
  if (Array.isArray(h)) return h;
  if (isRecord(h) && Array.isArray(h.runs)) return h.runs;
  return [];
}

export function computeTrendDiff(input: TrendDiffInput): TrendDiffResult {
  const runId = asString(input.runId) ?? "";
  const targetRaw = asString(input.targetRaw) ?? "";
  const currentSet = currentFingerprints(input);
  const score = currentScore(input);

  let previous: Record<string, unknown> | null = null;
  for (const entry of historyRuns(input)) {
    if (!isRecord(entry)) continue;
    const entryRunId = asString(entry.run_id) ?? "";
    if (runId && entryRunId === runId) continue;
    const target = entry.target;
    if (!isRecord(target)) continue;
    if ((asString(target.raw) ?? "") !== targetRaw) continue;
    previous = entry;
    break;
  }

  if (!previous) {
    return {
      baseline: true,
      previous_run_id: null,
      new: [],
      resolved: [],
      persistent: [],
      score_delta: 0.0,
      coverage_delta: 0.0,
    };
  }

  const prevFingerprintsRaw = Array.isArray(previous.finding_fingerprints)
    ? previous.finding_fingerprints
    : [];
  const previousSet = new Set(sortedUnique(prevFingerprintsRaw.filter((v): v is string => typeof v === "string" && v.length > 0)));
  const previousScore = asNumber(previous.score) ?? 0;

  const newFps = sortedUnique(Array.from(currentSet).filter((fp) => !previousSet.has(fp)));
  const resolved = sortedUnique(Array.from(previousSet).filter((fp) => !currentSet.has(fp)));
  const persistent = sortedUnique(Array.from(currentSet).filter((fp) => previousSet.has(fp)));

  return {
    baseline: false,
    previous_run_id: asString(previous.run_id) ?? null,
    new: newFps,
    resolved,
    persistent,
    score_delta: round1(score - previousScore),
    coverage_delta: 0.0,
  };
}
