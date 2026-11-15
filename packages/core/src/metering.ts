import * as fs from "node:fs/promises";
import * as path from "node:path";

export const METERING_SUMMARY_SCHEMA_VERSION = "quality-harness.metering/v1" as const;
export const DEFAULT_METERING_SINK = path.join(".lemma", "metering", "events.jsonl");

export interface MeteringEventRecord {
  schema_version?: string;
  event_id?: string;
  event_type?: string;
  idempotency_key?: string;
  workspace?: string;
  run?: string;
  quantity?: number;
  unit?: string;
  timestamp?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MeteringSummary {
  schema_version: string;
  sink: string;
  workspace: string;
  event_count: number;
  event_types: Record<string, number>;
  run_event_count: number;
  run_event_types: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortCountMap(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) out[key] = counts[key] ?? 0;
  return out;
}

export function dedupeMeteringEvents(events: readonly unknown[]): MeteringEventRecord[] {
  const kept: MeteringEventRecord[] = [];
  const seen = new Set<string>();
  for (const item of events) {
    if (!isRecord(item)) continue;
    const key = typeof item.idempotency_key === "string" ? item.idempotency_key : "";
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(item);
  }
  return kept;
}

export async function readMeteringEvents(sinkPath: string): Promise<MeteringEventRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(sinkPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const events: MeteringEventRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // skip malformed lines (append-only sink may have partial/corrupt trailing data in edge cases)
    }
  }
  return dedupeMeteringEvents(events);
}

export function summarizeMeteringEvents(
  events: readonly unknown[],
  runId: string,
  options?: { sink?: string; root?: string; workspace?: string; schemaVersion?: string },
): MeteringSummary {
  const deduped = dedupeMeteringEvents(events);
  const counts: Record<string, number> = {};
  const runCounts: Record<string, number> = {};
  let workspace = options?.workspace;
  for (const event of deduped) {
    const eventType = typeof event.event_type === "string" ? event.event_type : "";
    if (eventType) counts[eventType] = (counts[eventType] ?? 0) + 1;
    const eventRun = typeof event.run === "string" ? event.run : "";
    if (eventRun === runId && eventType) {
      runCounts[eventType] = (runCounts[eventType] ?? 0) + 1;
    }
    if (!workspace && typeof event.workspace === "string" && event.workspace) {
      workspace = event.workspace;
    }
  }

  let sinkDisplay = options?.sink ?? DEFAULT_METERING_SINK;
  if (options?.root && options.sink) {
    const rootAbs = path.resolve(options.root);
    const sinkAbs = path.resolve(options.root, options.sink);
    const rel = path.relative(rootAbs, sinkAbs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      sinkDisplay = rel;
    } else {
      sinkDisplay = options.sink;
    }
  }

  return {
    schema_version: options?.schemaVersion ?? METERING_SUMMARY_SCHEMA_VERSION,
    sink: sinkDisplay,
    workspace: workspace ?? "local",
    event_count: Object.values(counts).reduce((a, b) => a + b, 0),
    event_types: sortCountMap(counts),
    run_event_count: Object.values(runCounts).reduce((a, b) => a + b, 0),
    run_event_types: sortCountMap(runCounts),
  };
}

export async function summarizeMeteringSink(
  root: string,
  runId: string,
  options?: { sink?: string; workspace?: string; schemaVersion?: string },
): Promise<MeteringSummary> {
  const sinkPathInput = options?.sink ?? DEFAULT_METERING_SINK;
  const sinkAbs = path.isAbsolute(sinkPathInput) ? sinkPathInput : path.resolve(root, sinkPathInput);
  const events = await readMeteringEvents(sinkAbs);
  return summarizeMeteringEvents(events, runId, {
    sink: sinkPathInput,
    root,
    ...(options?.workspace ? { workspace: options.workspace } : {}),
    ...(options?.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
  });
}
