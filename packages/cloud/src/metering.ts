import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { newId, now, parseTimestamp } from "@lemma/core";

export const METERING_SCHEMA_VERSION = "quality-harness.metering/v1" as const;
export const METERING_SCHEMA_INDEX_VERSION = "quality-harness.metering.schemas/v1" as const;

export const EVENT_RUN_STARTED = "run_started" as const;
export const EVENT_CHECK_EXECUTED = "check_executed" as const;
export const EVENT_BROWSER_MINUTE_CONSUMED = "browser_minute_consumed" as const;
export const EVENT_EVIDENCE_BYTE_STORED = "evidence_byte_stored" as const;
export const EVENT_EXPORT_GENERATED = "export_generated" as const;

export const EVENT_TYPES = [
  EVENT_RUN_STARTED,
  EVENT_CHECK_EXECUTED,
  EVENT_BROWSER_MINUTE_CONSUMED,
  EVENT_EVIDENCE_BYTE_STORED,
  EVENT_EXPORT_GENERATED,
] as const;

export type MeteringEventType = (typeof EVENT_TYPES)[number];

export const EVENT_UNITS: Record<MeteringEventType, string> = {
  [EVENT_RUN_STARTED]: "run",
  [EVENT_CHECK_EXECUTED]: "check",
  [EVENT_BROWSER_MINUTE_CONSUMED]: "minute",
  [EVENT_EVIDENCE_BYTE_STORED]: "byte",
  [EVENT_EXPORT_GENERATED]: "export",
};

export const REQUIRED_ENVELOPE_FIELDS = [
  "schema_version",
  "event_id",
  "event_type",
  "idempotency_key",
  "workspace",
  "run",
  "quantity",
  "unit",
  "timestamp",
  "source",
] as const;

export const REQUIRED_METADATA: Record<MeteringEventType, readonly string[]> = {
  [EVENT_RUN_STARTED]: ["workflow_id"],
  [EVENT_CHECK_EXECUTED]: ["check_id", "status"],
  [EVENT_BROWSER_MINUTE_CONSUMED]: ["mode"],
  [EVENT_EVIDENCE_BYTE_STORED]: ["kind", "path"],
  [EVENT_EXPORT_GENERATED]: ["format"],
};

export const SCHEMA_FILES: Record<string, string> = {
  envelope: "envelope.v1.schema.json",
  [EVENT_RUN_STARTED]: "run_started.v1.schema.json",
  [EVENT_CHECK_EXECUTED]: "check_executed.v1.schema.json",
  [EVENT_BROWSER_MINUTE_CONSUMED]: "browser_minute_consumed.v1.schema.json",
  [EVENT_EVIDENCE_BYTE_STORED]: "evidence_byte_stored.v1.schema.json",
  [EVENT_EXPORT_GENERATED]: "export_generated.v1.schema.json",
};

export const DEFAULT_SINK = path.join(".lemma", "metering", "events.jsonl");
export const DEFAULT_WORKSPACE = "local";
export const DEFAULT_SOURCE = "oss";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// repo root schemas: <repo>/schemas/metering from packages/cloud/src or dist
export const DEFAULT_SCHEMA_DIR = path.resolve(__dirname, "..", "..", "..", "schemas", "metering");

export interface MeteringEvent {
  schema_version: string;
  event_id: string;
  event_type: string;
  idempotency_key: string;
  workspace: string;
  run: string;
  quantity: number;
  unit: string;
  timestamp: string;
  source: string;
  metadata: Record<string, unknown>;
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

export class MeteringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeteringError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function eventSchemaPaths(schemaDir: string = DEFAULT_SCHEMA_DIR): Record<string, string> {
  const dir = path.resolve(schemaDir);
  const paths: Record<string, string> = {};
  for (const [name, filename] of Object.entries(SCHEMA_FILES)) {
    paths[name] = path.join(dir, filename);
  }
  return paths;
}

export function validateEvent(event: unknown): string[] {
  if (!isRecord(event)) {
    return ["Event must be an object."];
  }

  const errors: string[] = [];
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!(field in event)) {
      errors.push(`missing required field: ${field}`);
      continue;
    }
    const value = event[field];
    if (value === null || value === undefined) {
      errors.push(`missing required field: ${field}`);
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      errors.push(`field must be a non-empty string: ${field}`);
    }
  }

  const eventType = asTrimmedString(event.event_type);
  if (eventType && !EVENT_TYPES.includes(eventType as MeteringEventType)) {
    errors.push(`unknown event_type: ${eventType}`);
  }

  const schemaVersion = event.schema_version;
  if (typeof schemaVersion === "string" && schemaVersion !== METERING_SCHEMA_VERSION) {
    // allow frozen contract strictness? assay required exact SCHEMA_VERSION; also accept lemma.metering/v1 for compatibility
    if (schemaVersion !== "lemma.metering/v1") {
      errors.push(`unsupported schema_version: ${schemaVersion}`);
    }
  }

  const quantity = event.quantity;
  if (typeof quantity === "boolean" || !isFiniteNumber(quantity)) {
    errors.push("quantity must be a finite number");
  } else if (eventType === EVENT_RUN_STARTED || eventType === EVENT_CHECK_EXECUTED || eventType === EVENT_EXPORT_GENERATED) {
    if (quantity !== 1) {
      errors.push(`${eventType} quantity must be 1`);
    }
  } else if (eventType === EVENT_BROWSER_MINUTE_CONSUMED) {
    if (quantity <= 0) {
      errors.push("browser_minute_consumed quantity must be > 0");
    }
  } else if (eventType === EVENT_EVIDENCE_BYTE_STORED) {
    if (quantity < 0 || !Number.isInteger(quantity)) {
      errors.push("evidence_byte_stored quantity must be a non-negative integer");
    }
  }

  const unit = asTrimmedString(event.unit);
  if (eventType && EVENT_TYPES.includes(eventType as MeteringEventType)) {
    const expectedUnit = EVENT_UNITS[eventType as MeteringEventType];
    if (unit && unit !== expectedUnit) {
      errors.push(`unit for ${eventType} must be ${expectedUnit}`);
    }
  }

  const timestamp = event.timestamp;
  if (typeof timestamp === "string" && timestamp.trim() !== "") {
    try {
      parseTimestamp(timestamp);
    } catch {
      errors.push("timestamp must be an ISO-8601 datetime");
    }
  }

  const metadata = event.metadata;
  if (metadata !== undefined && metadata !== null) {
    if (!isRecord(metadata)) {
      errors.push("metadata must be an object when present");
    } else if (eventType && EVENT_TYPES.includes(eventType as MeteringEventType)) {
      for (const key of REQUIRED_METADATA[eventType as MeteringEventType]) {
        const value = metadata[key];
        if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
          errors.push(`metadata.${key} is required for ${eventType}`);
        }
      }
    }
  } else if (eventType && EVENT_TYPES.includes(eventType as MeteringEventType)) {
    // metadata missing entirely: required keys missing
    for (const key of REQUIRED_METADATA[eventType as MeteringEventType]) {
      errors.push(`metadata.${key} is required for ${eventType}`);
    }
  }

  return errors;
}

export function defaultIdempotencyKey(
  run: string,
  eventType: string,
  quantity: unknown,
  unit: string,
  metadata?: Record<string, unknown> | null,
): string {
  const stable = JSON.stringify(sortKeysDeep({
    run: String(run),
    event_type: String(eventType),
    quantity,
    unit: String(unit),
    metadata: metadata ?? {},
  }));
  const digest = crypto.createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 20);
  return `${run}:${eventType}:${digest}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

export interface BuildEventInput {
  event_id?: string;
  run: string;
  workspace?: string;
  source?: string;
  quantity?: number;
  unit?: string;
  idempotency_key?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  schema_version?: string;
}

export function buildEvent(
  eventType: string,
  input: BuildEventInput,
): MeteringEvent {
  if (!EVENT_TYPES.includes(eventType as MeteringEventType)) {
    throw new MeteringError(`Unknown metering event type: ${eventType}`);
  }
  const resolvedUnit = input.unit ?? EVENT_UNITS[eventType as MeteringEventType];
  const event: MeteringEvent = {
    schema_version: input.schema_version ?? METERING_SCHEMA_VERSION,
    event_id: input.event_id ?? newId("usage"),
    event_type: eventType,
    idempotency_key: String(input.idempotency_key ?? "").trim(),
    workspace: String(input.workspace ?? "").trim(),
    run: String(input.run ?? "").trim(),
    quantity: input.quantity ?? 1,
    unit: resolvedUnit,
    timestamp: input.timestamp ?? now(),
    source: String(input.source ?? "").trim(),
    metadata: { ...(input.metadata ?? {}) },
  };
  if (!event.idempotency_key) {
    event.idempotency_key = defaultIdempotencyKey(
      event.run,
      eventType,
      event.quantity,
      resolvedUnit,
      event.metadata,
    );
  }
  const errors = validateEvent(event);
  if (errors.length > 0) {
    throw new MeteringError(`Invalid metering event: ${errors.join("; ")}`);
  }
  return event;
}

function sortCountMap(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) out[key] = counts[key] ?? 0;
  return out;
}

function readEventsFromSink(sinkPath: string): MeteringEvent[] {
  if (!fs.existsSync(sinkPath)) return [];
  let text = "";
  try {
    text = fs.readFileSync(sinkPath, "utf8");
  } catch {
    return [];
  }
  const events: MeteringEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as unknown;
      if (isRecord(record)) events.push(record as MeteringEvent);
    } catch {
      // ignore invalid lines
    }
  }
  return events;
}

function dedupeByIdempotencyKey(events: readonly MeteringEvent[]): MeteringEvent[] {
  const kept: MeteringEvent[] = [];
  const keys = new Set<string>();
  for (const record of events) {
    const key = typeof record.idempotency_key === "string" ? record.idempotency_key : "";
    if (key && keys.has(key)) continue;
    if (key) keys.add(key);
    kept.push(record);
  }
  return kept;
}

function tryRelative(root: string, target: string): string {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return target;
  return rel;
}

export interface MeteringEmitterOptions {
  workspace?: string;
  source?: string;
  sink?: string | PathLike;
}

type PathLike = { toString(): string };

export class MeteringEmitter {
  readonly root: string;
  readonly runId: string;
  readonly workspace: string;
  readonly source: string;
  readonly sink: string;
  private seen: Set<string> = new Set();
  private knownSize = -1;

  constructor(
    root: string,
    runId: string,
    options: MeteringEmitterOptions = {},
  ) {
    this.root = path.resolve(root);
    const rid = String(runId ?? "").trim();
    if (!rid) throw new MeteringError("A run id is required for metering.");
    this.runId = rid;
    this.workspace = String(options.workspace ?? DEFAULT_WORKSPACE).trim() || DEFAULT_WORKSPACE;
    this.source = String(options.source ?? DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
    const sinkOpt = options.sink != null ? String(options.sink) : DEFAULT_SINK;
    this.sink = path.isAbsolute(sinkOpt) ? path.resolve(sinkOpt) : path.resolve(this.root, sinkOpt);
    this.refreshSeen();
  }

  private readEvents(): MeteringEvent[] {
    return readEventsFromSink(this.sink);
  }

  private refreshSeen(): void {
    let size = 0;
    try {
      size = fs.statSync(this.sink).size;
    } catch {
      size = 0;
    }
    if (size === this.knownSize) return;
    for (const record of this.readEvents()) {
      const key = record.idempotency_key;
      if (typeof key === "string" && key) this.seen.add(key);
    }
    this.knownSize = size;
  }

  events(): MeteringEvent[] {
    return dedupeByIdempotencyKey(this.readEvents());
  }

  emit(
    eventType: string,
    quantity: number = 1,
    unit?: string,
    options: {
      idempotency_key?: string;
      metadata?: Record<string, unknown>;
      timestamp?: string;
    } = {},
  ): MeteringEvent | null {
    const resolvedUnit = unit ?? (EVENT_TYPES.includes(eventType as MeteringEventType) ? EVENT_UNITS[eventType as MeteringEventType] : "");
    let key = String(options.idempotency_key ?? "").trim();
    if (!key) {
      key = defaultIdempotencyKey(this.runId, eventType, quantity, resolvedUnit, options.metadata);
    }
    this.refreshSeen();
    if (this.seen.has(key)) return null;

    const buildInput: BuildEventInput = {
      run: this.runId,
      workspace: this.workspace,
      source: this.source,
      quantity,
      unit: resolvedUnit,
      idempotency_key: key,
    };
    if (options.timestamp !== undefined) buildInput.timestamp = options.timestamp;
    if (options.metadata !== undefined) buildInput.metadata = options.metadata;
    const event = buildEvent(eventType, buildInput);
    this.append(event);
    this.seen.add(key);
    try {
      this.knownSize = fs.statSync(this.sink).size;
    } catch {
      this.knownSize = -1;
    }
    return event;
  }

  private append(event: MeteringEvent): void {
    fs.mkdirSync(path.dirname(this.sink), { recursive: true });
    const line = JSON.stringify(sortKeysDeep(event)) + "\n";
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.sink, "a");
      fs.writeSync(fd, line, undefined, "utf8");
      fs.fsyncSync(fd);
    } catch (err) {
      throw new MeteringError(`Could not write metering sink ${this.sink}: ${String(err)}`);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  summary(): MeteringSummary {
    const counts: Record<string, number> = {};
    const runCounts: Record<string, number> = {};
    for (const event of this.events()) {
      const et = String(event.event_type ?? "");
      counts[et] = (counts[et] ?? 0) + 1;
      if (String(event.run ?? "") === this.runId) {
        runCounts[et] = (runCounts[et] ?? 0) + 1;
      }
    }
    return {
      schema_version: METERING_SCHEMA_VERSION,
      sink: tryRelative(this.root, this.sink),
      workspace: this.workspace,
      event_count: Object.values(counts).reduce((a, b) => a + b, 0),
      event_types: sortCountMap(counts),
      run_event_count: Object.values(runCounts).reduce((a, b) => a + b, 0),
      run_event_types: sortCountMap(runCounts),
    };
  }
}
