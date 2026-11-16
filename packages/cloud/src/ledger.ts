import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { newId, now, parseTimestamp } from "@lemma/core";
import { EVENT_TYPES, EVENT_UNITS, validateEvent } from "./metering.js";
import { quotaResourceForEvent } from "./quota.js";

export const LEDGER_SCHEMA_VERSION = "quality-harness.ledger/v1" as const;
export const PERIOD_SCHEMA_VERSION = "quality-harness.ledger.period/v1" as const;
export const INVOICE_SCHEMA_VERSION = "quality-harness.invoice/v1" as const;
export const PRICE_BOOK_SCHEMA_VERSION = "quality-harness.price-book/v1" as const;

export const DEFAULT_ENTRIES = path.join(".lemma", "ledger", "entries.jsonl");
export const DEFAULT_PERIODS = path.join(".lemma", "ledger", "periods.json");
export const DEFAULT_LOCK = path.join(".lemma", "ledger", "ledger.lock");

export const ENTRY_USAGE = "usage" as const;
export const ENTRY_CORRECTION = "correction" as const;
export const ENTRY_ADJUSTMENT = "adjustment" as const;
export const LEDGER_ENTRY_TYPES = [ENTRY_USAGE, ENTRY_CORRECTION, ENTRY_ADJUSTMENT] as const;

const _SAFE_METADATA_KEYS = ["workflow_id", "check_id", "status", "mode", "kind", "format"] as const;
const _MONEY_PLACES = 6;
const _PERIOD_RE = /^(\d{4})-(\d{2})$/;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class LedgerPeriodClosed extends LedgerError {
  readonly workspace: string;
  readonly period: string;
  readonly code = "period_closed";
  constructor(workspace: string, period: string) {
    super(`Ledger period ${period} is closed for workspace ${workspace}.`);
    this.name = "LedgerPeriodClosed";
    this.workspace = workspace;
    this.period = period;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function money(value: unknown): number {
  const n = Number(value);
  return Math.round(n * 1_000_000) / 1_000_000;
}

function safeText(value: unknown, limit = 200): string {
  return String(value ?? "").trim().slice(0, limit);
}

function safeMetadata(metadata: unknown): Record<string, string> {
  if (!isRecord(metadata)) return {};
  const safe: Record<string, string> = {};
  for (const key of _SAFE_METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined && value !== null && value !== "") safe[key] = safeText(value);
  }
  return safe;
}

function formatTimestamp(value?: unknown): string {
  const d = parseTimestamp(value ?? now());
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function periodForTimestamp(timestamp: unknown): string {
  const moment = parseTimestamp(timestamp);
  return `${moment.getUTCFullYear()}-${String(moment.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function normalizePeriod(period: unknown): string {
  const text = safeText(period);
  if (!text) throw new LedgerError("A billing period is required.");
  const match = _PERIOD_RE.exec(text);
  if (match) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) throw new LedgerError("Billing period month must be between 01 and 12.");
    return text;
  }
  try {
    return periodForTimestamp(text);
  } catch (err) {
    throw new LedgerError(`Billing period must be YYYY-MM or an ISO-8601 timestamp: ${String(err)}`);
  }
}

export function periodBounds(period: unknown): { key: string; start: string; end: string; reset_at: string } {
  const key = normalizePeriod(period);
  const [ys, ms] = key.split("-");
  const year = Number(ys);
  const month = Number(ms);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = month === 12 ? new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0)) : new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { key, start: fmt(start), end: fmt(end), reset_at: fmt(end) };
}

function resolveContextWorkspace(context: any): string {
  const workspace = context?.workspace_id ?? context?.workspaceId;
  if (!workspace) throw new LedgerError("An authenticated workspace context is required before ledger access.");
  return safeText(workspace);
}

function chmodSafe(p: string, mode: number): void {
  try { fs.chmodSync(p, mode); } catch { /* ignore */ }
}

function atomicWrite(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chmodSafe(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeSync(fd, text, undefined, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    chmodSafe(tmp, 0o600);
    fs.renameSync(tmp, filePath);
    chmodSafe(filePath, 0o600);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function withLock<T>(_lockPath: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(_lockPath), { recursive: true });
  chmodSafe(path.dirname(_lockPath), 0o700);
  return fn();
}

export interface PriceBookData {
  schema_version?: string;
  version?: string;
  currency?: string;
  prices?: Record<string, unknown>;
  [key: string]: unknown;
}

export class PriceBook {
  readonly prices: Record<string, number>;
  readonly currency: string;
  readonly version: string;

  constructor(opts: { prices?: Record<string, unknown>; currency?: string; version?: string } = {}) {
    const normalized: Record<string, number> = {};
    for (const [key, value] of Object.entries(opts.prices ?? {})) {
      const eventType = safeText(key);
      if (!(EVENT_TYPES as readonly string[]).includes(eventType)) {
        throw new LedgerError(`Unknown price-book event type '${key}'. Allowed event types: ${EVENT_TYPES.join(", ")}.`);
      }
      const price = Number(value);
      if (!Number.isFinite(price)) throw new LedgerError(`price for ${eventType} must be a number.`);
      if (price < 0) throw new LedgerError(`Price for ${eventType} must be greater than or equal to zero.`);
      normalized[eventType] = price;
    }
    this.prices = normalized;
    const currency = safeText(opts.currency ?? "USD", 12);
    if (!currency) throw new LedgerError("Price-book currency must be a non-empty string.");
    this.currency = currency;
    this.version = safeText(opts.version ?? "v1", 40) || "v1";
  }

  price(eventType: string): number {
    return Number(this.prices[String(eventType)] ?? 0);
  }

  toDict(): Record<string, unknown> {
    const prices: Record<string, number> = {};
    for (const key of Object.keys(this.prices).sort()) prices[key] = this.prices[key]!;
    return { schema_version: PRICE_BOOK_SCHEMA_VERSION, version: this.version, currency: this.currency, prices };
  }
  to_dict() { return this.toDict(); }

  static fromDict(data: unknown): PriceBook {
    if (!isRecord(data)) throw new LedgerError("Price book must be a JSON object.");
    if (data.schema_version !== undefined && data.schema_version !== null && data.schema_version !== PRICE_BOOK_SCHEMA_VERSION) {
      throw new LedgerError(`Unsupported price-book schema version: ${String(data.schema_version)}`);
    }
    let raw = data.prices;
    if (raw === undefined || raw === null) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!["schema_version", "version", "currency"].includes(k)) rest[k] = v;
      }
      raw = rest;
    }
    if (!isRecord(raw)) throw new LedgerError("Price-book prices must be an object.");
    const prices: Record<string, unknown> = {};
    for (const [eventType, value] of Object.entries(raw)) {
      if (isRecord(value)) prices[eventType] = value.unit_price ?? value.price;
      else prices[eventType] = value;
    }
    return new PriceBook({ prices, currency: String(data.currency ?? "USD"), version: String(data.version ?? "v1") });
  }

  static load(filePath: string): PriceBook {
    let text: string;
    try { text = fs.readFileSync(filePath, "utf8"); } catch (err) { throw new LedgerError(`Could not read price book ${filePath}: ${String(err)}`); }
    let data: unknown;
    try { data = JSON.parse(text); } catch (err) { throw new LedgerError(`Price book is not valid JSON: ${String(err)}`); }
    return PriceBook.fromDict(data);
  }
}

export interface LedgerEntry {
  schema_version: string;
  entry_id: string;
  workspace: string;
  period: string;
  entry_type: string;
  event_type: string;
  resource: string;
  unit: string;
  quantity: number;
  unit_price: number;
  amount: number;
  currency: string;
  timestamp: string;
  recorded_at: string;
  source_event_id: string;
  source_idempotency_key: string;
  idempotency_key: string;
  references: string[];
  reason: string;
  metadata: Record<string, string>;
  sequence: number;
  previous_hash: string;
  entry_hash: string;
  [key: string]: unknown;
}


function compactStableJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(compactStableJson).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${compactStableJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function computeHash(entry: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(entry)) {
    if (key === "entry_hash") continue;
    payload[key] = entry[key];
  }
  return crypto.createHash("sha256").update(compactStableJson(payload), "utf8").digest("hex");
}

function formatMoneyCsv(value: unknown): string {
  return Number(value).toFixed(_MONEY_PLACES);
}

export class LedgerStore {
  readonly root: string;
  readonly entriesPath: string;
  readonly periodsPath: string;
  readonly lockPath: string;
  readonly workspace: string | null;
  readonly boundWorkspace: string | null;

  constructor(
    root: string,
    opts: { entries_path?: string; entriesPath?: string; periods_path?: string; periodsPath?: string; lock_path?: string; lockPath?: string; workspace?: string | null } = {},
  ) {
    this.root = path.resolve(root);
    this.entriesPath = this.resolvePath(opts.entries_path ?? opts.entriesPath ?? DEFAULT_ENTRIES);
    this.periodsPath = this.resolvePath(opts.periods_path ?? opts.periodsPath ?? DEFAULT_PERIODS);
    this.lockPath = this.resolvePath(opts.lock_path ?? opts.lockPath ?? DEFAULT_LOCK);
    const ws = safeText(opts.workspace ?? "");
    this.workspace = ws || null;
    this.boundWorkspace = this.workspace;
  }

  private resolvePath(value: string): string {
    if (path.isAbsolute(value)) return path.resolve(value);
    return path.resolve(this.root, value);
  }

  private workspaceOrBound(workspace?: string | null): string {
    const value = safeText(workspace ?? "") || this.workspace;
    if (!value) throw new LedgerError("A workspace is required for this ledger operation.");
    return value;
  }

  static fromAuthContext(root: string, context: any, opts: Record<string, unknown> = {}): LedgerStore {
    const { workspace: _w, ...rest } = opts as any;
    return new LedgerStore(root, { ...rest, workspace: resolveContextWorkspace(context) });
  }

  private repairTail(): void {
    if (!fs.existsSync(this.entriesPath)) return;
    let data: Buffer;
    try { data = fs.readFileSync(this.entriesPath); } catch (err) { throw new LedgerError(`Could not read ledger entries: ${String(err)}`); }
    if (data.length === 0 || data[data.length - 1] === 0x0a) return;
    const cutoff = data.lastIndexOf(0x0a);
    try {
      const fd = fs.openSync(this.entriesPath, "r+");
      try {
        fs.ftruncateSync(fd, cutoff >= 0 ? cutoff + 1 : 0);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } catch (err) { throw new LedgerError(`Could not repair the ledger tail: ${String(err)}`); }
  }

  private loadEntries(repair = false): LedgerEntry[] {
    if (!fs.existsSync(this.entriesPath)) return [];
    if (repair) this.repairTail();
    let text: string;
    try { text = fs.readFileSync(this.entriesPath, "utf8"); } catch (err) { throw new LedgerError(`Could not read ledger entries: ${String(err)}`); }
    if (text && !text.endsWith("\n")) {
      throw new LedgerError("Ledger entries end with an incomplete record; run a repair or inspect the file before appending.");
    }
    const entries: LedgerEntry[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch (err) { throw new LedgerError(`Ledger entry line ${i + 1} is not valid JSON: ${String(err)}`); }
      if (!isRecord(entry)) throw new LedgerError(`Ledger entry line ${i + 1} is not an object.`);
      if (entry.schema_version !== LEDGER_SCHEMA_VERSION) throw new LedgerError(`Ledger entry line ${i + 1} has an unsupported schema version.`);
      entries.push(entry as LedgerEntry);
    }
    return entries;
  }

  private appendLocked(entries: LedgerEntry[], entry: LedgerEntry): void {
    const problem = this.verifyChain(entries);
    if (problem) throw new LedgerError(`Ledger integrity check failed at ${problem[0]}: ${problem[1]}`);
    fs.mkdirSync(path.dirname(this.entriesPath), { recursive: true });
    chmodSafe(path.dirname(this.entriesPath), 0o700);
    const line = compactStableJson(entry) + "\n";
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.entriesPath, "a", 0o600);
      fs.writeSync(fd, line, undefined, "utf8");
      fs.fsyncSync(fd);
    } catch (err) { throw new LedgerError(`Could not append to the ledger: ${String(err)}`); }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    chmodSafe(this.entriesPath, 0o600);
  }

  private emptyPeriods(): { schema_version: string; periods: Record<string, Record<string, any>> } {
    return { schema_version: PERIOD_SCHEMA_VERSION, periods: {} };
  }

  private loadPeriods(): { schema_version: string; periods: Record<string, Record<string, any>> } {
    if (!fs.existsSync(this.periodsPath)) return this.emptyPeriods();
    let data: any;
    try { data = JSON.parse(fs.readFileSync(this.periodsPath, "utf8")); } catch (err) { throw new LedgerError(`The ledger period store is unreadable: ${String(err)}`); }
    if (!isRecord(data)) throw new LedgerError("The ledger period store is invalid.");
    if (data.schema_version !== PERIOD_SCHEMA_VERSION) throw new LedgerError(`Unsupported ledger period schema version: ${String(data.schema_version)}`);
    if (!isRecord(data.periods)) data.periods = {};
    return data as any;
  }

  private savePeriods(data: { schema_version: string; periods: Record<string, Record<string, any>> }): void {
    atomicWrite(this.periodsPath, JSON.stringify(data, null, 2) + "\n");
  }

  private verifyChain(entries: LedgerEntry[]): [string, string] | null {
    let previous = "";
    let expected = 1;
    for (const entry of entries) {
      const entryId = String(entry.entry_id ?? "");
      if (entry.sequence !== expected) return [entryId || "?", `sequence ${entry.sequence} is not ${expected}`];
      if (String(entry.previous_hash ?? "") !== previous) return [entryId || "?", "previous_hash does not match the prior entry"];
      if (String(entry.entry_hash ?? "") !== computeHash(entry as any)) return [entryId || "?", "entry hash does not match the stored payload"];
      previous = String(entry.entry_hash ?? "");
      expected += 1;
    }
    return null;
  }

  private closeRecord(periods: any, workspace: string, period: string): any | null {
    const rec = periods?.periods?.[workspace]?.[period];
    return isRecord(rec) ? rec : null;
  }

  private newEntry(entries: LedgerEntry[], args: {
    workspace: string; period: string; entry_type: string; event_type: string; unit: string;
    quantity: number; unit_price: number; currency: string; timestamp: string; recorded_at: string;
    source_event_id?: string; source_idempotency_key?: string; idempotency_key?: string;
    references?: string[]; reason?: string; metadata?: unknown;
  }): LedgerEntry {
    if (!(LEDGER_ENTRY_TYPES as readonly string[]).includes(args.entry_type)) throw new LedgerError(`Unknown ledger entry type: ${args.entry_type}`);
    if (!(EVENT_TYPES as readonly string[]).includes(args.event_type)) throw new LedgerError(`Unknown metering event type: ${args.event_type}`);
    const sequence = entries.length ? Number(entries[entries.length - 1]!.sequence) + 1 : 1;
    const previous_hash = entries.length ? String(entries[entries.length - 1]!.entry_hash ?? "") : "";
    const entry: any = {
      schema_version: LEDGER_SCHEMA_VERSION,
      entry_id: newId("ledger"),
      workspace: args.workspace,
      period: args.period,
      entry_type: args.entry_type,
      event_type: args.event_type,
      resource: quotaResourceForEvent(args.event_type) ?? "",
      unit: args.unit,
      quantity: args.quantity,
      unit_price: money(args.unit_price),
      amount: money(Number(args.quantity) * Number(args.unit_price)),
      currency: args.currency,
      timestamp: formatTimestamp(args.timestamp),
      recorded_at: formatTimestamp(args.recorded_at),
      source_event_id: safeText(args.source_event_id),
      source_idempotency_key: safeText(args.source_idempotency_key),
      idempotency_key: safeText(args.idempotency_key),
      references: (args.references ?? []).map((r) => safeText(r)).filter(Boolean),
      reason: safeText(args.reason, 500),
      metadata: safeMetadata(args.metadata),
      sequence,
      previous_hash,
    };
    entry.entry_hash = computeHash(entry);
    return entry as LedgerEntry;
  }

  entries(workspace?: string | null, period?: string | null): LedgerEntry[] {
    const expectedWorkspace = safeText(workspace ?? "") || this.workspace || null;
    const expectedPeriod = period ? normalizePeriod(period) : null;
    return withLock(this.lockPath, () => {
      const entries = this.loadEntries();
      return entries.filter((e) => {
        if (expectedWorkspace && e.workspace !== expectedWorkspace) return false;
        if (expectedPeriod && e.period !== expectedPeriod) return false;
        return true;
      }).map((e) => JSON.parse(JSON.stringify(e)));
    });
  }

  get(entryId: string): LedgerEntry | null {
    const id = safeText(entryId);
    return withLock(this.lockPath, () => {
      const entries = this.loadEntries();
      const found = entries.find((e) => e.entry_id === id);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    });
  }

  periods(workspace?: string | null): any[] {
    const expected = safeText(workspace ?? "") || this.workspace || null;
    return withLock(this.lockPath, () => {
      const data = this.loadPeriods();
      const result: any[] = [];
      for (const ws of Object.keys(data.periods).sort()) {
        if (expected && ws !== expected) continue;
        for (const period of Object.keys(data.periods[ws] ?? {}).sort()) {
          const rec = data.periods[ws]![period];
          if (isRecord(rec)) result.push(JSON.parse(JSON.stringify(rec)));
        }
      }
      return result;
    });
  }

  getClose(workspace: string | null | undefined, period: string): any | null {
    const ws = this.workspaceOrBound(workspace ?? null);
    const p = normalizePeriod(period);
    return withLock(this.lockPath, () => {
      const data = this.loadPeriods();
      const rec = this.closeRecord(data, ws, p);
      return rec ? JSON.parse(JSON.stringify(rec)) : null;
    });
  }
  get_close(workspace: string | null | undefined, period: string) { return this.getClose(workspace, period); }

  isClosed(workspace: string | null | undefined, period: string): boolean {
    return this.getClose(workspace, period) !== null;
  }
  is_closed(workspace: string | null | undefined, period: string) { return this.isClosed(workspace, period); }

  verify(): Record<string, unknown> {
    try {
      const entries = withLock(this.lockPath, () => this.loadEntries());
      const problem = this.verifyChain(entries);
      return {
        schema_version: LEDGER_SCHEMA_VERSION,
        status: problem ? "broken" : "ok",
        ok: !problem,
        entry_count: entries.length,
        broken_at: problem ? problem[0] : null,
        reason: problem ? problem[1] : "",
      };
    } catch (err) {
      return { schema_version: LEDGER_SCHEMA_VERSION, status: "broken", ok: false, entry_count: 0, broken_at: null, reason: String(err instanceof Error ? err.message : err) };
    }
  }

  ingestEvent(event: unknown, priceBook?: PriceBook | null): any {
    if (!isRecord(event)) throw new LedgerError("A metering event must be a JSON object.");
    const record = { ...event } as Record<string, any>;
    const errors = validateEvent(record);
    if (errors.length) throw new LedgerError(`Invalid metering event: ${errors.join("; ")}`);
    const workspace = safeText(record.workspace);
    if (!workspace) throw new LedgerError("A metering event requires a workspace.");
    if (this.workspace && workspace !== this.workspace) throw new LedgerError("The metering event workspace does not match the authenticated context.");
    const eventType = String(record.event_type);
    const period = periodForTimestamp(record.timestamp);
    const sourceKey = safeText(record.idempotency_key);
    const signature = { workspace, event_type: eventType, quantity: Number(record.quantity ?? 0), unit: String(record.unit ?? "") };
    return withLock(this.lockPath, () => {
      const entries = this.loadEntries(true);
      for (const existing of entries) {
        if (existing.entry_type === ENTRY_USAGE && existing.source_idempotency_key === sourceKey) {
          const existingSig = { workspace: existing.workspace, event_type: existing.event_type, quantity: Number(existing.quantity ?? 0), unit: existing.unit };
          if (JSON.stringify(existingSig) !== JSON.stringify(signature)) {
            throw new LedgerError(`Duplicate ledger event key '${sourceKey}' has a different payload.`);
          }
          return { schema_version: LEDGER_SCHEMA_VERSION, status: "duplicate", created: false, duplicate: true, entry: JSON.parse(JSON.stringify(existing)) };
        }
      }
      const periods = this.loadPeriods();
      if (this.closeRecord(periods, workspace, period) !== null) {
        throw new LedgerPeriodClosed(workspace, period);
      }
      const price = priceBook ? priceBook.price(eventType) : 0;
      const currency = priceBook ? priceBook.currency : "USD";
      const entry = this.newEntry(entries, {
        workspace, period, entry_type: ENTRY_USAGE, event_type: eventType, unit: String(record.unit),
        quantity: Number(record.quantity), unit_price: price, currency, timestamp: String(record.timestamp), recorded_at: now(),
        source_event_id: String(record.event_id ?? ""), source_idempotency_key: sourceKey, metadata: record.metadata,
      });
      this.appendLocked(entries, entry);
      return { schema_version: LEDGER_SCHEMA_VERSION, status: "appended", created: true, duplicate: false, entry: JSON.parse(JSON.stringify(entry)) };
    });
  }
  ingest_event(event: unknown, priceBook?: PriceBook | null) { return this.ingestEvent(event, priceBook); }

  ingestEvents(events: Iterable<unknown>, opts: { workspace?: string | null; price_book?: PriceBook | null; priceBook?: PriceBook | null; strict?: boolean } = {}): any {
    const expectedWorkspace = safeText(opts.workspace ?? "") || this.workspace || null;
    const priceBook = (opts.price_book ?? opts.priceBook) ?? null;
    const ingested: any[] = [];
    const rejected: any[] = [];
    let duplicates = 0;
    let skipped = 0;
    for (const event of events) {
      const eventWorkspace = isRecord(event) ? safeText(event.workspace) : "";
      if (expectedWorkspace && eventWorkspace !== expectedWorkspace) { skipped++; continue; }
      try {
        const result = this.ingestEvent(event, priceBook);
        if (result.duplicate) duplicates++; else ingested.push(result.entry);
      } catch (err) {
        if (opts.strict) throw err;
        if (err instanceof LedgerPeriodClosed) {
          rejected.push({ code: "period_closed", workspace: err.workspace, period: err.period, message: err.message, event_id: isRecord(event) ? safeText(event.event_id) : "", idempotency_key: isRecord(event) ? safeText(event.idempotency_key) : "" });
        } else {
          rejected.push({ code: "invalid_event", message: String(err instanceof Error ? err.message : err), event_id: isRecord(event) ? safeText(event.event_id) : "", idempotency_key: isRecord(event) ? safeText(event.idempotency_key) : "" });
        }
      }
    }
    return { schema_version: LEDGER_SCHEMA_VERSION, status: rejected.length ? "partial" : "ok", ingested: ingested.length, duplicates, skipped, rejected, entries: ingested };
  }
  ingest_events(events: Iterable<unknown>, opts: any = {}) { return this.ingestEvents(events, opts); }

  ingest(eventOrEvents: unknown, opts: any = {}): any {
    if (isRecord(eventOrEvents) && (eventOrEvents as any).event_type) return this.ingestEvent(eventOrEvents, opts?.priceBook ?? opts?.price_book ?? opts);
    if (isRecord(eventOrEvents) && !Array.isArray(eventOrEvents) && (eventOrEvents as any)[Symbol.iterator] === undefined) {
      // single event-like object
      return this.ingestEvent(eventOrEvents, opts?.priceBook ?? opts?.price_book ?? opts);
    }
    return this.ingestEvents(eventOrEvents as Iterable<unknown>, opts);
  }

  addAdjustment(workspace: string | null | undefined, period: string | null | undefined, eventType: string, quantity: number, opts: any = {}): any {
    let event_type = eventType;
    let qty = quantity;
    if (typeof eventType === "number" && (quantity === 0 || quantity === undefined)) {
      qty = eventType;
      event_type = "";
    }
    const workspaceId = this.workspaceOrBound(workspace ?? null);
    const moment = formatTimestamp(opts.timestamp ?? now());
    const periodId = period ? normalizePeriod(period) : periodForTimestamp(moment);
    const amount = Number(qty);
    if (!Number.isFinite(amount) || amount === 0) throw new LedgerError("An adjustment quantity must be non-zero.");
    const reasonText = safeText(opts.reason ?? opts.description, 500);
    if (!reasonText) throw new LedgerError("An adjustment requires a reason.");
    const collected: string[] = [...(opts.references ?? [])];
    for (const c of [opts.entry_id, opts.entryId, opts.original_entry_id, opts.originalEntryId, opts.close_id, opts.closeId]) {
      if (c) collected.push(String(c));
    }
    const referenceIds = collected.map((r) => safeText(r)).filter(Boolean);
    if (!referenceIds.length) throw new LedgerError("An adjustment must reference an entry or period close.");
    const key = safeText(opts.idempotency_key ?? opts.idempotencyKey ?? "");

    return withLock(this.lockPath, () => {
      const entries = this.loadEntries(true);
      const periodData = this.loadPeriods();
      const entryIndex = new Map(entries.map((e) => [String(e.entry_id), e]));
      const closeIndex = new Map<string, any>();
      for (const wsPeriods of Object.values(periodData.periods)) {
        for (const close of Object.values(wsPeriods as any)) {
          if (isRecord(close) && (close as any).close_id) closeIndex.set(String((close as any).close_id), close);
        }
      }

      if (key) {
        for (const existing of entries) {
          if (existing.idempotency_key === key) {
            if (existing.workspace === workspaceId && existing.period === periodId && existing.event_type === event_type && Number(existing.quantity) === amount) {
              return { schema_version: LEDGER_SCHEMA_VERSION, status: "duplicate", created: false, duplicate: true, entry: JSON.parse(JSON.stringify(existing)) };
            }
            throw new LedgerError(`Duplicate adjustment key '${key}' has a different payload.`);
          }
        }
      }

      const referencedEntries: LedgerEntry[] = [];
      for (const ref of referenceIds) {
        if (entryIndex.has(ref)) {
          const original = entryIndex.get(ref)!;
          if (original.workspace !== workspaceId) throw new LedgerError(`Adjustment reference '${ref}' belongs to another workspace.`);
          referencedEntries.push(original);
        } else if (closeIndex.has(ref)) {
          const close = closeIndex.get(ref);
          if (close.workspace !== workspaceId) throw new LedgerError(`Adjustment reference '${ref}' belongs to another workspace.`);
        } else {
          throw new LedgerError(`Adjustment reference '${ref}' does not exist in this ledger.`);
        }
      }

      let resolvedEventType = safeText(event_type);
      if (!resolvedEventType && referencedEntries.length) {
        const values = new Set(referencedEntries.map((e) => String(e.event_type)));
        if (values.size !== 1) throw new LedgerError("An adjustment referencing multiple event types must specify one.");
        resolvedEventType = [...values][0]!;
      }
      if (!(EVENT_TYPES as readonly string[]).includes(resolvedEventType)) throw new LedgerError("An adjustment requires a known metering event type.");

      let resolvedUnit = safeText(opts.unit) || (EVENT_UNITS as any)[resolvedEventType];
      if (referencedEntries.length) {
        const units = new Set(referencedEntries.map((e) => String(e.unit)));
        if (units.size !== 1) throw new LedgerError("An adjustment cannot mix units from multiple original entries.");
        const originalUnit = [...units][0]!;
        if (opts.unit && opts.unit !== originalUnit) throw new LedgerError(`Adjustment unit '${opts.unit}' does not match original unit '${originalUnit}'.`);
        resolvedUnit = originalUnit;
      }

      let resolvedPrice = opts.unit_price ?? opts.unitPrice;
      if (resolvedPrice === undefined || resolvedPrice === null) {
        if (referencedEntries.length) {
          const prices = new Set(referencedEntries.map((e) => Number(e.unit_price)));
          if (prices.size === 1) resolvedPrice = [...prices][0];
        }
        if (resolvedPrice === undefined || resolvedPrice === null) resolvedPrice = opts.price_book ? opts.price_book.price(resolvedEventType) : (opts.priceBook ? opts.priceBook.price(resolvedEventType) : 0);
      }
      resolvedPrice = Number(resolvedPrice);
      if (!Number.isFinite(resolvedPrice) || resolvedPrice < 0) throw new LedgerError("An adjustment unit price cannot be negative.");

      const currencies = new Set(referencedEntries.map((e) => String(e.currency ?? "USD")));
      if (currencies.size > 1) throw new LedgerError("An adjustment cannot reference entries in multiple currencies.");
      const currency = currencies.size === 1 ? [...currencies][0]! : (opts.price_book?.currency ?? opts.priceBook?.currency ?? "USD");

      let resolvedType = opts.entry_type ?? opts.entryType ?? null;
      if (!resolvedType) resolvedType = referencedEntries.length ? ENTRY_CORRECTION : ENTRY_ADJUSTMENT;
      if (resolvedType !== ENTRY_CORRECTION && resolvedType !== ENTRY_ADJUSTMENT) throw new LedgerError("An adjustment entry_type must be correction or adjustment.");

      const entry = this.newEntry(entries, {
        workspace: workspaceId, period: periodId, entry_type: resolvedType, event_type: resolvedEventType, unit: resolvedUnit,
        quantity: qty, unit_price: resolvedPrice, currency, timestamp: moment, recorded_at: now(),
        idempotency_key: key, references: referenceIds, reason: reasonText, metadata: opts.metadata,
      });
      this.appendLocked(entries, entry);
      return { schema_version: LEDGER_SCHEMA_VERSION, status: "appended", created: true, duplicate: false, entry: JSON.parse(JSON.stringify(entry)) };
    });
  }
  add_adjustment(workspace: any, period: any, eventType: any, quantity: any, opts: any = {}) { return this.addAdjustment(workspace, period, eventType, quantity, opts); }

  addCorrection(workspace: string | null | undefined, period: string | null | undefined, entryId: string, quantity: number, opts: any = {}): any {
    const o = { ...opts, entry_type: ENTRY_CORRECTION, references: [entryId] };
    delete o.entry_id; delete o.entryId; delete o.original_entry_id; delete o.originalEntryId; delete o.close_id; delete o.closeId;
    return this.addAdjustment(workspace, period, "", quantity, o);
  }
  add_correction(workspace: any, period: any, entryId: any, quantity: any, opts: any = {}) { return this.addCorrection(workspace, period, entryId, quantity, opts); }

  addLateAdjustment(workspace: string | null | undefined, period: string | null | undefined, closeId: string, eventType: string, quantity: number, opts: any = {}): any {
    const o = { ...opts, entry_type: ENTRY_ADJUSTMENT, references: [closeId] };
    delete o.entry_id; delete o.entryId; delete o.original_entry_id; delete o.originalEntryId; delete o.close_id; delete o.closeId;
    return this.addAdjustment(workspace, period, eventType, quantity, o);
  }
  add_late_adjustment(workspace: any, period: any, closeId: any, eventType: any, quantity: any, opts: any = {}) { return this.addLateAdjustment(workspace, period, closeId, eventType, quantity, opts); }

  adjust(workspace: any, period: any, eventType: any, quantity: any, opts: any = {}) { return this.addAdjustment(workspace, period, eventType, quantity, opts); }
  correct(workspace: any, period: any, eventType: any, quantity: any, opts: any = {}) { return this.addAdjustment(workspace, period, eventType, quantity, opts); }

  closePeriod(workspace: string, period: string, opts: { closed_by?: string; closedBy?: string; closed_at?: string; closedAt?: string } = {}): any {
    const workspaceId = this.workspaceOrBound(workspace);
    const periodId = normalizePeriod(period);
    const moment = formatTimestamp(opts.closed_at ?? opts.closedAt ?? now());
    return withLock(this.lockPath, () => {
      const entries = this.loadEntries(true);
      const periods = this.loadPeriods();
      const existing = this.closeRecord(periods, workspaceId, periodId);
      if (existing) {
        const result = JSON.parse(JSON.stringify(existing));
        result.created = false;
        return result;
      }
      const invoice = this.buildInvoice(entries, periods, workspaceId, periodId, { invoice_id: "close-preview", generated_at: moment });
      const record = {
        schema_version: PERIOD_SCHEMA_VERSION,
        close_id: newId("close"),
        workspace: workspaceId,
        period: periodId,
        period_start: invoice.period_start,
        period_end: invoice.period_end,
        closed_at: moment,
        closed_by: safeText(opts.closed_by ?? opts.closedBy ?? ""),
        entry_count: invoice.entry_count,
        last_entry_hash: entries.length ? String(entries[entries.length - 1]!.entry_hash ?? "") : "",
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        credits: invoice.credits,
        total: invoice.total,
      };
      if (!periods.periods[workspaceId]) periods.periods[workspaceId] = {};
      periods.periods[workspaceId]![periodId] = record;
      this.savePeriods(periods);
      const result = JSON.parse(JSON.stringify(record));
      result.created = true;
      return result;
    });
  }
  close_period(workspace: string, period: string, opts: any = {}) { return this.closePeriod(workspace, period, opts); }
  close(workspace: string, period: string, opts: any = {}) { return this.closePeriod(workspace, period, opts); }

  private buildInvoice(entries: LedgerEntry[], periods: any, workspace: string, period: string, opts: { invoice_id?: string; invoiceId?: string; generated_at?: string; generatedAt?: string } = {}): any {
    const problem = this.verifyChain(entries);
    if (problem) throw new LedgerError(`Ledger integrity check failed at ${problem[0]}: ${problem[1]}`);
    const usage = entries.filter((e) => e.workspace === workspace && e.period === period && e.entry_type === ENTRY_USAGE).sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const adjustments = entries.filter((e) => e.workspace === workspace && e.period === period && (e.entry_type === ENTRY_CORRECTION || e.entry_type === ENTRY_ADJUSTMENT)).sort((a, b) => Number(a.sequence) - Number(b.sequence));

    const groups = new Map<string, any>();
    for (const entry of usage) {
      const key = `${entry.event_type}|${entry.unit}|${Number(entry.unit_price)}|${entry.currency}`;
      const group = groups.get(key) ?? { event_type: entry.event_type, unit: entry.unit, unit_price: Number(entry.unit_price), currency: entry.currency, quantity: 0, amount: 0, entry_count: 0 };
      group.quantity += Number(entry.quantity);
      group.amount += Number(entry.amount);
      group.entry_count += 1;
      groups.set(key, group);
    }
    const lineItems = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => ({ ...g, quantity: money(g.quantity), amount: money(g.amount) }));

    const adjustmentRows = adjustments.map((entry) => ({
      entry_id: String(entry.entry_id), entry_type: String(entry.entry_type), event_type: String(entry.event_type), unit: String(entry.unit),
      quantity: money(entry.quantity), unit_price: money(entry.unit_price), amount: money(entry.amount), currency: String(entry.currency),
      reason: String(entry.reason ?? ""), references: [...(entry.references ?? [])], recorded_at: String(entry.recorded_at ?? ""),
    }));

    const subtotal = money(lineItems.reduce((s, i) => s + Number(i.amount), 0));
    const adjustmentTotal = money(adjustmentRows.reduce((s, i) => s + Number(i.amount), 0));
    const credits = money(adjustmentRows.filter((i) => Number(i.amount) < 0).reduce((s, i) => s + Math.abs(Number(i.amount)), 0));
    const total = money(subtotal + adjustmentTotal);
    const currencies = new Set([...usage, ...adjustments].map((e) => String(e.currency ?? "USD")));
    if (currencies.size > 1) throw new LedgerError("Cannot render one invoice for entries in multiple currencies.");
    const currency = currencies.size === 1 ? [...currencies][0]! : "USD";
    const close = this.closeRecord(periods, workspace, period);
    const bounds = periodBounds(period);
    return {
      schema_version: INVOICE_SCHEMA_VERSION,
      invoice_id: safeText(opts.invoice_id ?? opts.invoiceId) || newId("inv"),
      status: close ? "closed" : "open",
      workspace, period,
      period_start: bounds.start, period_end: bounds.end, reset_at: bounds.reset_at,
      generated_at: formatTimestamp(opts.generated_at ?? opts.generatedAt ?? now()),
      closed: !!close,
      close_id: close ? String(close.close_id ?? "") : "",
      currency,
      entry_count: usage.length + adjustments.length,
      line_items: lineItems,
      adjustments: adjustmentRows,
      subtotal, credits, adjustments_total: adjustmentTotal, total,
    };
  }

  invoice(workspace: string, period: string, opts: any = {}): any {
    const ws = this.workspaceOrBound(workspace);
    const p = normalizePeriod(period);
    return withLock(this.lockPath, () => {
      const entries = this.loadEntries(true);
      const periods = this.loadPeriods();
      return this.buildInvoice(entries, periods, ws, p, opts);
    });
  }

  reconcile(workspace: string, period: string, opts: { invoice?: any; invoice_id?: string } = {}): any {
    const ws = this.workspaceOrBound(workspace);
    const p = normalizePeriod(period);
    const rendered = opts.invoice ? { ...opts.invoice } : this.invoice(ws, p, { invoice_id: opts.invoice_id });
    const entries = this.entries(ws, p);
    const ledgerTotal = money(entries.reduce((s, e) => s + Number(e.quantity) * Number(e.unit_price), 0));
    const invoiceTotal = money(rendered.total ?? 0);
    const difference = money(ledgerTotal - invoiceTotal);
    const ok = Math.abs(difference) <= 10 ** -_MONEY_PLACES;
    return { schema_version: LEDGER_SCHEMA_VERSION, status: ok ? "ok" : "mismatch", ok, workspace: ws, period: p, entry_count: entries.length, ledger_total: ledgerTotal, invoice_total: invoiceTotal, difference, invoice_id: String(rendered.invoice_id ?? "") };
  }

  private ensureContext(context: any, workspace: string): string {
    const resolved = resolveContextWorkspace(context);
    if (this.workspace && this.workspace !== resolved) throw new LedgerError("The ledger store is bound to another workspace.");
    if (safeText(workspace) !== resolved) throw new LedgerError("The ledger request workspace does not match the authenticated context.");
    return resolved;
  }

  ingestForContext(context: any, event: any, priceBook?: PriceBook | null): any {
    this.ensureContext(context, isRecord(event) ? String(event.workspace ?? "") : "");
    return this.ingestEvent(event, priceBook);
  }
  ingest_for_context(context: any, event: any, priceBook?: PriceBook | null) { return this.ingestForContext(context, event, priceBook); }

  addAdjustmentFor(context: any, period: string, eventType: string, quantity: number, opts: any = {}): any {
    const workspace = resolveContextWorkspace(context);
    const o = { ...opts }; delete o.workspace;
    return this.addAdjustment(workspace, period, eventType, quantity, o);
  }
  add_adjustment_for(context: any, period: string, eventType: string, quantity: number, opts: any = {}) { return this.addAdjustmentFor(context, period, eventType, quantity, opts); }

  closeFor(context: any, period: string, opts: any = {}) { return this.closePeriod(resolveContextWorkspace(context), period, opts); }
  close_for(context: any, period: string, opts: any = {}) { return this.closeFor(context, period, opts); }

  invoiceFor(context: any, period: string, opts: any = {}) { return this.invoice(resolveContextWorkspace(context), period, opts); }
  invoice_for(context: any, period: string, opts: any = {}) { return this.invoiceFor(context, period, opts); }

  entriesFor(context: any, period?: string | null) { return this.entries(resolveContextWorkspace(context), period); }
  entries_for(context: any, period?: string | null) { return this.entriesFor(context, period); }

  periodsFor(context: any) { return this.periods(resolveContextWorkspace(context)); }
  periods_for(context: any) { return this.periodsFor(context); }

  append(eventOrEvents: any, opts: any = {}) { return this.ingest(eventOrEvents, opts); }
  list_entries(workspace?: string | null, period?: string | null) { return this.entries(workspace, period); }
  list_periods(workspace?: string | null) { return this.periods(workspace); }

  exportInvoice(workspace?: string | null, period?: string | null, opts: { format?: string } & Record<string, any> = {}): any {
    const ws = this.workspaceOrBound(workspace ?? null);
    if (!period) throw new LedgerError("An invoice requires a period.");
    const p = normalizePeriod(period);
    const inv = this.invoice(ws, p, opts);
    if (opts.format === "csv") return invoiceToCsv(inv);
    return inv;
  }
}

export function invoiceToCsv(invoice: Record<string, any>): string {
  const lines: string[] = [];
  const row = (vals: any[]) => vals.map((v) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(",");
  lines.push(row(["workspace", "period", "currency", "row_type", "event_type", "unit", "quantity", "unit_price", "amount", "reference", "description"]));
  const workspace = String(invoice.workspace ?? "");
  const period = String(invoice.period ?? "");
  const currency = String(invoice.currency ?? "USD");
  for (const item of (invoice.line_items ?? [])) {
    lines.push(row([workspace, period, currency, "line_item", item.event_type ?? "", item.unit ?? "", formatMoneyCsv(item.quantity ?? 0), formatMoneyCsv(item.unit_price ?? 0), formatMoneyCsv(item.amount ?? 0), "", ""]));
  }
  for (const item of (invoice.adjustments ?? [])) {
    lines.push(row([workspace, period, currency, item.entry_type ?? "adjustment", item.event_type ?? "", item.unit ?? "", formatMoneyCsv(item.quantity ?? 0), formatMoneyCsv(item.unit_price ?? 0), formatMoneyCsv(item.amount ?? 0), (item.references ?? []).join(","), item.reason ?? ""]));
  }
  for (const rowType of ["subtotal", "credits", "adjustments_total", "total"]) {
    lines.push(row([workspace, period, currency, rowType, "", "", "", "", formatMoneyCsv(invoice[rowType] ?? 0), "", ""]));
  }
  return lines.join("\n") + "\n";
}

// aliases
export const UsageLedger = LedgerStore;
export const Ledger = LedgerStore;
