import * as fs from "node:fs";
import * as path from "node:path";
import { parseTimestamp } from "@lemma/core";

export const QUOTA_SCHEMA_VERSION = "quality-harness.quota/v1" as const;
export const PLAN_SCHEMA_VERSION = "quality-harness.quota-plan/v1" as const;
export const EVENT_SCHEMA_VERSION = "quality-harness.quota.events/v1" as const;

export const DEFAULT_QUOTA_STORE = path.join(".lemma", "quota", "usage.json");
export const DEFAULT_QUOTA_EVENTS = path.join(".lemma", "quota", "events.jsonl");
export const DEFAULT_QUOTA_LOCK = path.join(".lemma", "quota", "quota.lock");
export const DEFAULT_QUOTA_WORKSPACE = "local";

export const RESOURCE_RUNS = "runs" as const;
export const RESOURCE_CHECKS = "checks" as const;
export const RESOURCE_BROWSER_MINUTES = "browser_minutes" as const;
export const RESOURCE_EVIDENCE_BYTES = "evidence_bytes" as const;
export const RESOURCES = [
  RESOURCE_RUNS,
  RESOURCE_CHECKS,
  RESOURCE_BROWSER_MINUTES,
  RESOURCE_EVIDENCE_BYTES,
] as const;
export type QuotaResource = (typeof RESOURCES)[number];

export const RESOURCE_UNITS: Record<QuotaResource, string> = {
  [RESOURCE_RUNS]: "run",
  [RESOURCE_CHECKS]: "check",
  [RESOURCE_BROWSER_MINUTES]: "browser_minute",
  [RESOURCE_EVIDENCE_BYTES]: "byte",
};

export const RESOURCE_ALIASES: Record<string, QuotaResource> = {
  run: RESOURCE_RUNS,
  runs: RESOURCE_RUNS,
  check: RESOURCE_CHECKS,
  checks: RESOURCE_CHECKS,
  browser_minute: RESOURCE_BROWSER_MINUTES,
  browser_minutes: RESOURCE_BROWSER_MINUTES,
  "browser-minute": RESOURCE_BROWSER_MINUTES,
  "browser-minutes": RESOURCE_BROWSER_MINUTES,
  byte: RESOURCE_EVIDENCE_BYTES,
  bytes: RESOURCE_EVIDENCE_BYTES,
  evidence_byte: RESOURCE_EVIDENCE_BYTES,
  evidence_bytes: RESOURCE_EVIDENCE_BYTES,
  "evidence-byte": RESOURCE_EVIDENCE_BYTES,
  "evidence-bytes": RESOURCE_EVIDENCE_BYTES,
};

export const EVENT_RESOURCES: Record<string, QuotaResource> = {
  run_started: RESOURCE_RUNS,
  check_executed: RESOURCE_CHECKS,
  browser_minute_consumed: RESOURCE_BROWSER_MINUTES,
  evidence_byte_stored: RESOURCE_EVIDENCE_BYTES,
};

export const EVENT_SOFT_LIMIT = "quota_soft_limit" as const;
export const EVENT_HARD_LIMIT = "quota_hard_limit" as const;
export const QUOTA_EVENT_TYPES = [EVENT_SOFT_LIMIT, EVENT_HARD_LIMIT] as const;

const _QUANTITY_EPSILON = 1e-9;
const _WORKSPACE_UNSET = Symbol("WORKSPACE_UNSET");

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeResource(resource: string): QuotaResource {
  const value = String(resource ?? "").trim().toLowerCase();
  const mapped = RESOURCE_ALIASES[value];
  if (!mapped) {
    throw new Error(`Unknown quota resource '${resource}'. Allowed resources: ${RESOURCES.join(", ")}.`);
  }
  return mapped;
}

export function quotaResourceForEvent(eventType: string): QuotaResource | null {
  return EVENT_RESOURCES[String(eventType ?? "").trim()] ?? null;
}

export function workspaceFromContext(context: any): string {
  const workspace = context?.workspace_id ?? context?.workspaceId;
  if (!workspace) {
    throw new QuotaError("An authenticated workspace context is required before quota lookup.");
  }
  return String(workspace);
}

function validateQuantity(value: unknown, name = "quantity"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value)) {
    throw new Error(`${name} must be a number.`);
  }
  if (value < 0) throw new Error(`${name} must be greater than or equal to zero.`);
  return value;
}

function validateLimit(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number or null.`);
  }
  if (value < 0) throw new Error(`${name} must be greater than or equal to zero.`);
  return value;
}

function cleanQuantity(value: number): number {
  if (!Number.isInteger(value)) return Math.round(value * 1e9) / 1e9;
  return value;
}

function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unlimited";
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

function resourceHeader(resource: string): string {
  return resource.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("-");
}

export function quotaPeriod(now?: unknown): { key: string; start: string; end: string; reset_at: string } {
  const moment = parseTimestamp(now ?? new Date().toISOString());
  const start = new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    start: fmt(start),
    end: fmt(end),
    reset_at: fmt(end),
  };
}

export class QuotaLimit {
  readonly soft: number | null;
  readonly hard: number | null;

  constructor(soft: number | null = null, hard: number | null = null) {
    const s = validateLimit(soft, "soft");
    const h = validateLimit(hard, "hard");
    if (s !== null && h !== null && s > h) {
      throw new Error("soft limit cannot exceed hard limit");
    }
    this.soft = s;
    this.hard = h;
  }

  get unlimited(): boolean {
    return this.soft === null && this.hard === null;
  }

  toDict(): { soft: number | null; hard: number | null } {
    return { soft: this.soft, hard: this.hard };
  }
  to_dict() { return this.toDict(); }
}

export function coerceLimit(value: unknown): QuotaLimit {
  if (value instanceof QuotaLimit) return value;
  if (value === null || value === undefined) return new QuotaLimit();
  if (isRecord(value)) {
    const soft = (value.soft ?? value.soft_limit) as number | null | undefined;
    const hard = (value.hard ?? value.hard_limit ?? value.limit) as number | null | undefined;
    return new QuotaLimit(soft ?? null, hard ?? null);
  }
  return new QuotaLimit(null, validateLimit(value, "limit"));
}

export interface QuotaPlanDict {
  schema_version?: string;
  id?: string;
  version?: string;
  period?: string;
  limits?: Record<string, unknown>;
  allowances?: Record<string, unknown>;
  [key: string]: unknown;
}

export class QuotaPlan {
  readonly id: string;
  readonly version: string;
  readonly period: string;
  readonly limits: Map<QuotaResource, QuotaLimit>;

  constructor(opts: { id?: string; version?: string; period?: string; limits?: Record<string, unknown> | Map<string, unknown> } = {}) {
    if (String(opts.period ?? "monthly") !== "monthly") {
      throw new Error("Only monthly quota plans are supported.");
    }
    this.id = String(opts.id ?? "default");
    this.version = String(opts.version ?? "1.0");
    this.period = "monthly";
    const normalized = new Map<QuotaResource, QuotaLimit>();
    const limitsObj = opts.limits instanceof Map ? Object.fromEntries(opts.limits) : (opts.limits ?? {});
    for (const [key, value] of Object.entries(limitsObj)) {
      const resource = normalizeResource(key);
      normalized.set(resource, coerceLimit(value));
    }
    this.limits = normalized;
  }

  static fromDict(payload: unknown): QuotaPlan {
    if (!isRecord(payload)) throw new Error("Quota plan must be a JSON object.");
    let values = payload.limits ?? payload.allowances;
    if (values === undefined) {
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        const lk = k.trim().toLowerCase();
        if (lk in RESOURCE_ALIASES) flat[k] = v;
      }
      values = flat;
    }
    if (!isRecord(values)) throw new Error("Quota plan limits must be a JSON object.");
    return new QuotaPlan({
      id: String(payload.id ?? "default"),
      version: String(payload.version ?? "1.0"),
      period: String(payload.period ?? "monthly"),
      limits: values as Record<string, unknown>,
    });
  }

  static load(filePath: string): QuotaPlan {
    const value = path.resolve(filePath);
    let payload: unknown;
    try {
      payload = JSON.parse(fs.readFileSync(value, "utf8"));
    } catch (err: any) {
      if (err?.code === "ENOENT" || err instanceof SyntaxError) {
        throw new QuotaError(err instanceof SyntaxError ? `Quota plan ${value} is not valid JSON: ${String(err)}` : `Could not read quota plan ${value}: ${String(err)}`);
      }
      throw new QuotaError(`Could not read quota plan ${value}: ${String(err)}`);
    }
    if (!isRecord(payload)) throw new QuotaError(`Quota plan ${value} must contain a JSON object.`);
    try {
      return QuotaPlan.fromDict(payload);
    } catch (err) {
      throw new QuotaError(`Quota plan ${value} is invalid: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  limit(resource: string): QuotaLimit {
    return this.limits.get(normalizeResource(resource)) ?? new QuotaLimit();
  }

  toDict(): Record<string, unknown> {
    const limits: Record<string, unknown> = {};
    for (const [resource, limit] of [...this.limits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      limits[resource] = limit.toDict();
    }
    return {
      schema_version: PLAN_SCHEMA_VERSION,
      id: this.id,
      version: this.version,
      period: this.period,
      limits,
    };
  }
  to_dict() { return this.toDict(); }
}

export function coercePlan(value: unknown): QuotaPlan | null {
  if (value === null || value === undefined) return null;
  if (value instanceof QuotaPlan) return value;
  if (typeof value === "string") return QuotaPlan.load(value);
  if (isRecord(value)) return QuotaPlan.fromDict(value);
  throw new Error("Quota plan must be a QuotaPlan, mapping, path, or null.");
}

function headersFor(
  resource: string,
  opts: {
    used: number;
    limit: number | null;
    remaining: number | null;
    soft_limit: number | null;
    soft_remaining: number | null;
    period_start: string;
    period_end: string;
    enforced: boolean;
    allowed: boolean;
    retry_after?: number | null;
  },
): Record<string, string> {
  const suffix = resource ? resourceHeader(resource) : "";
  const headers: Record<string, string> = {
    "X-QH-Quota-Enforced": opts.enforced ? "true" : "false",
    "X-QH-Quota-Allowed": opts.allowed ? "true" : "false",
    "X-QH-Quota-Resource": resource || "",
    "X-QH-Quota-Used": formatQuantity(opts.used),
    "X-QH-Quota-Limit": formatQuantity(opts.limit),
    "X-QH-Quota-Remaining": formatQuantity(opts.remaining),
    "X-QH-Quota-Soft-Limit": formatQuantity(opts.soft_limit),
    "X-QH-Quota-Soft-Remaining": formatQuantity(opts.soft_remaining),
    "X-QH-Quota-Period-Start": opts.period_start,
    "X-QH-Quota-Period-End": opts.period_end,
    "X-QH-Quota-Reset": opts.period_end,
    "X-Quota-Resource": resource || "",
    "X-Quota-Used": formatQuantity(opts.used),
    "X-Quota-Limit": formatQuantity(opts.limit),
    "X-Quota-Remaining": formatQuantity(opts.remaining),
    "X-Quota-Reset": opts.period_end,
  };
  if (resource) {
    headers[`X-QH-Quota-Used-${suffix}`] = formatQuantity(opts.used);
    headers[`X-QH-Quota-Limit-${suffix}`] = formatQuantity(opts.limit);
    headers[`X-QH-Quota-Remaining-${suffix}`] = formatQuantity(opts.remaining);
    headers[`X-Quota-Used-${suffix}`] = formatQuantity(opts.used);
    headers[`X-Quota-Limit-${suffix}`] = formatQuantity(opts.limit);
    headers[`X-Quota-Remaining-${suffix}`] = formatQuantity(opts.remaining);
  }
  if (opts.retry_after !== undefined && opts.retry_after !== null) {
    headers["Retry-After"] = String(Math.max(0, Math.trunc(opts.retry_after)));
  }
  return headers;
}

export interface QuotaDecisionWarning {
  resource: string;
  soft_limit: number | null;
  used: number;
  period_start: string;
  period_end: string;
  reset_at: string;
  workspace: string;
}

export class QuotaDecision {
  allowed: boolean;
  enforced: boolean;
  resource: string;
  requested: number;
  used: number;
  limit: number | null;
  soft_limit: number | null;
  remaining: number | null;
  soft_remaining: number | null;
  period_start: string;
  period_end: string;
  reset_at: string;
  headers: Record<string, string>;
  warning: QuotaDecisionWarning | null;

  constructor(init: {
    allowed: boolean;
    enforced: boolean;
    resource: string;
    requested: number;
    used: number;
    limit?: number | null;
    soft_limit?: number | null;
    remaining?: number | null;
    soft_remaining?: number | null;
    period_start?: string;
    period_end?: string;
    reset_at?: string;
    headers?: Record<string, string>;
    warning?: QuotaDecisionWarning | null;
  }) {
    this.allowed = init.allowed;
    this.enforced = init.enforced;
    this.resource = init.resource;
    this.requested = init.requested;
    this.used = init.used;
    this.limit = init.limit ?? null;
    this.soft_limit = init.soft_limit ?? null;
    this.remaining = init.remaining ?? null;
    this.soft_remaining = init.soft_remaining ?? null;
    this.period_start = init.period_start ?? "";
    this.period_end = init.period_end ?? "";
    this.reset_at = init.reset_at ?? "";
    this.headers = { ...(init.headers ?? {}) };
    this.warning = init.warning ?? null;
  }

  get status_code(): number { return this.allowed ? 200 : 429; }
  get status(): number { return this.status_code; }

  toDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      schema_version: QUOTA_SCHEMA_VERSION,
      status: this.allowed ? "allowed" : "blocked",
      status_code: this.status_code,
      http_status: this.status_code,
      allowed: this.allowed,
      enforced: this.enforced,
      resource: this.resource,
      requested: this.requested,
      used: this.used,
      limit: this.limit,
      soft_limit: this.soft_limit,
      remaining: this.remaining,
      soft_remaining: this.soft_remaining,
      period_start: this.period_start,
      period_end: this.period_end,
      reset_at: this.reset_at,
      reset: this.reset_at,
      headers: { ...this.headers },
    };
    if (this.warning !== null) payload.warning = { ...this.warning };
    return payload;
  }
  to_dict() { return this.toDict(); }
}

export class QuotaExceeded extends QuotaError {
  readonly decision: QuotaDecision;
  readonly statusCode = 429;
  readonly status = 429;
  readonly code = "quota_exceeded";
  readonly resource: string;
  readonly limit: number | null;
  readonly soft_limit: number | null;
  readonly used: number;
  readonly requested: number;
  readonly remaining: number | null;
  readonly reset_at: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly headers: Record<string, string>;
  readonly details: Record<string, unknown>;

  constructor(decision: QuotaDecision) {
    super(
      `Monthly quota exceeded for ${decision.resource}: limit ${formatQuantity(decision.limit)}, used ${formatQuantity(decision.used)}, requested ${formatQuantity(decision.requested)}; resets at ${decision.reset_at}.`,
    );
    this.name = "QuotaExceeded";
    this.decision = decision;
    this.resource = decision.resource;
    this.limit = decision.limit;
    this.soft_limit = decision.soft_limit;
    this.used = decision.used;
    this.requested = decision.requested;
    this.remaining = decision.remaining;
    this.reset_at = decision.reset_at;
    this.period_start = decision.period_start;
    this.period_end = decision.period_end;
    this.headers = { ...decision.headers };
    this.details = {
      resource: this.resource,
      limit: this.limit,
      soft_limit: this.soft_limit,
      used: this.used,
      requested: this.requested,
      remaining: this.remaining,
      reset_at: this.reset_at,
      period_start: this.period_start,
      period_end: this.period_end,
    };
  }

  toDict(): Record<string, unknown> {
    const error = { code: this.code, message: this.message, ...this.details };
    return {
      schema_version: QUOTA_SCHEMA_VERSION,
      status: this.statusCode,
      status_code: this.statusCode,
      http_status: this.statusCode,
      allowed: false,
      enforced: this.decision.enforced,
      resource: this.resource,
      limit: this.limit,
      soft_limit: this.soft_limit,
      used: this.used,
      requested: this.requested,
      remaining: this.remaining,
      reset_at: this.reset_at,
      reset: this.reset_at,
      period_start: this.period_start,
      period_end: this.period_end,
      error,
      headers: { ...this.headers },
    };
  }
  to_dict() { return this.toDict(); }
  response() { return this.toDict(); }
}

// Synchronous critical section for quota state transitions.
// JS execution is single-threaded; operations use atomic file writes.
function withLock<T>(_lockPath: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(_lockPath), { recursive: true });
  try { fs.chmodSync(path.dirname(_lockPath), 0o700); } catch { /* ignore */ }
  return fn();
}

function atomicWrite(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeSync(fd, text, undefined, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

interface UsageState {
  period: string;
  period_start: string;
  period_end: string;
  plan_id: string;
  plan_version: string;
  usage: Record<string, number>;
  soft_warned: Record<string, boolean>;
  updated_at: string;
}

interface QuotaStoreData {
  schema_version: string;
  workspaces: Record<string, UsageState>;
}

export interface QuotaStoreOptions {
  workspace?: string | typeof _WORKSPACE_UNSET;
  enforce?: boolean | null;
  store_path?: string;
  storePath?: string;
  events_path?: string;
  eventsPath?: string;
  lock_path?: string;
  lockPath?: string;
}

export class QuotaStore {
  readonly root: string;
  readonly plan: QuotaPlan | null;
  readonly workspace: string;
  readonly enforced: boolean;
  readonly storePath: string;
  readonly eventsPath: string;
  readonly lockPath: string;
  readonly eventErrors: string[] = [];

  constructor(root: string, plan: unknown = null, options: QuotaStoreOptions = {}) {
    this.root = path.resolve(root);
    this.plan = coercePlan(plan);
    const workspaceOpt = options.workspace;
    const workspaceWasExplicit = workspaceOpt !== undefined && workspaceOpt !== _WORKSPACE_UNSET;
    this.workspace = !workspaceWasExplicit
      ? DEFAULT_QUOTA_WORKSPACE
      : (String(workspaceOpt || DEFAULT_QUOTA_WORKSPACE).trim() || DEFAULT_QUOTA_WORKSPACE);
    if (this.plan === null) {
      this.enforced = false;
    } else if (options.enforce !== undefined && options.enforce !== null) {
      this.enforced = Boolean(options.enforce);
    } else if (workspaceWasExplicit && this.workspace === DEFAULT_QUOTA_WORKSPACE) {
      this.enforced = false;
    } else {
      this.enforced = true;
    }
    this.storePath = this.resolvePath(options.store_path ?? options.storePath ?? DEFAULT_QUOTA_STORE);
    this.eventsPath = this.resolvePath(options.events_path ?? options.eventsPath ?? DEFAULT_QUOTA_EVENTS);
    this.lockPath = this.resolvePath(options.lock_path ?? options.lockPath ?? DEFAULT_QUOTA_LOCK);
  }

  private resolvePath(value: string): string {
    if (path.isAbsolute(value)) return path.resolve(value);
    return path.resolve(this.root, value);
  }

  static fromAuthContext(root: string, context: any, plan: unknown = null, kwargs: QuotaStoreOptions = {}): QuotaStore {
    const { workspace: _w, enforce, ...rest } = kwargs as any;
    return new QuotaStore(root, plan, {
      ...rest,
      workspace: workspaceFromContext(context),
      enforce: enforce ?? true,
    });
  }

  get unlimited(): boolean { return !this.enforced; }

  private empty(): QuotaStoreData {
    return { schema_version: QUOTA_SCHEMA_VERSION, workspaces: {} };
  }

  private load(): QuotaStoreData {
    if (!fs.existsSync(this.storePath)) return this.empty();
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
    } catch (err) {
      throw new QuotaError(`The quota store is unreadable: ${String(err)}`);
    }
    if (!isRecord(data)) throw new QuotaError("The quota store must contain a JSON object.");
    if (data.schema_version !== QUOTA_SCHEMA_VERSION) throw new QuotaError("Unsupported quota store schema version.");
    if (!isRecord(data.workspaces)) data.workspaces = {};
    return data as unknown as QuotaStoreData;
  }

  private save(data: QuotaStoreData): void {
    atomicWrite(this.storePath, JSON.stringify(data, null, 2) + "\n");
  }

  private appendEvent(eventType: string, args: { resource: string; decision: QuotaDecision; timestamp: string; metadata?: Record<string, unknown> }): void {
    const safeMetadata: Record<string, string> = {};
    for (const key of ["run", "event_type", "source", "plan_id"] as const) {
      const value = args.metadata?.[key];
      if (value !== undefined && value !== null && value !== "") safeMetadata[key] = String(value).slice(0, 200);
    }
    const record = {
      schema_version: EVENT_SCHEMA_VERSION,
      event_type: eventType,
      workspace: this.workspace,
      resource: args.resource,
      timestamp: args.timestamp,
      used: args.decision.used,
      requested: args.decision.requested,
      limit: args.decision.limit,
      soft_limit: args.decision.soft_limit,
      remaining: args.decision.remaining,
      reset_at: args.decision.reset_at,
      metadata: safeMetadata,
    };
    try {
      fs.mkdirSync(path.dirname(this.eventsPath), { recursive: true });
      try { fs.chmodSync(path.dirname(this.eventsPath), 0o700); } catch {}
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.eventsPath, "a", 0o600);
        fs.writeSync(fd, JSON.stringify(record) + "\n", undefined, "utf8");
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      }
      try { fs.chmodSync(this.eventsPath, 0o600); } catch {}
    } catch (err) {
      this.eventErrors.push(String(err));
    }
  }

  events(): Record<string, unknown>[] {
    if (!fs.existsSync(this.eventsPath)) return [];
    const out: Record<string, unknown>[] = [];
    try {
      for (const line of fs.readFileSync(this.eventsPath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (isRecord(rec)) out.push(rec);
        } catch {}
      }
    } catch { return out; }
    return out;
  }

  private stateFor(data: QuotaStoreData, period: { key: string; start: string; end: string }): { state: UsageState; rolled: boolean } {
    let state = data.workspaces[this.workspace] as UsageState | undefined;
    const rolled = !state || state.period !== period.key;
    if (rolled || !state) {
      state = {
        period: period.key,
        period_start: period.start,
        period_end: period.end,
        plan_id: this.plan?.id ?? "",
        plan_version: this.plan?.version ?? "",
        usage: Object.fromEntries(RESOURCES.map((r) => [r, 0])),
        soft_warned: {},
        updated_at: "",
      };
    } else {
      if (!isRecord(state.usage)) state.usage = {} as any;
      for (const r of RESOURCES) if (state.usage[r] === undefined) state.usage[r] = 0;
      if (!isRecord(state.soft_warned)) state.soft_warned = {};
      if (this.plan) { state.plan_id = this.plan.id; state.plan_version = this.plan.version; }
    }
    data.workspaces[this.workspace] = state;
    return { state, rolled };
  }

  private decision(opts: {
    plan: QuotaLimit; resource: QuotaResource; requested: number; used: number;
    period: { start: string; end: string; reset_at: string }; allowed: boolean;
    warning?: QuotaDecisionWarning | null; now?: unknown;
  }): QuotaDecision {
    const hard = opts.plan.hard;
    const soft = opts.plan.soft;
    let remaining: number | null = hard === null ? null : cleanQuantity(Math.max(hard - opts.used, 0));
    if (remaining !== null && Number.isInteger(remaining)) remaining = Math.trunc(remaining);
    let softRemaining: number | null = soft === null ? null : cleanQuantity(Math.max(soft - opts.used, 0));
    if (softRemaining !== null && Number.isInteger(softRemaining)) softRemaining = Math.trunc(softRemaining);
    let retryAfter: number | null = null;
    if (!opts.allowed) {
      try {
        const moment = parseTimestamp(opts.now ?? new Date().toISOString());
        const reset = parseTimestamp(opts.period.reset_at);
        retryAfter = Math.max(0, Math.ceil((reset.getTime() - moment.getTime()) / 1000));
      } catch { retryAfter = null; }
    }
    const headers = headersFor(opts.resource, {
      used: opts.used, limit: hard, remaining, soft_limit: soft, soft_remaining: softRemaining,
      period_start: opts.period.start, period_end: opts.period.end, enforced: this.enforced, allowed: opts.allowed, retry_after: retryAfter,
    });
    return new QuotaDecision({
      allowed: opts.allowed, enforced: this.enforced, resource: opts.resource, requested: opts.requested,
      used: opts.used, limit: hard, soft_limit: soft, remaining, soft_remaining: softRemaining,
      period_start: opts.period.start, period_end: opts.period.end, reset_at: opts.period.reset_at, headers, warning: opts.warning ?? null,
    });
  }

  private unlimitedDecision(resource: string, requested: number, now?: unknown): QuotaDecision {
    const period = quotaPeriod(now);
    const headers = headersFor(resource, {
      used: 0, limit: null, remaining: null, soft_limit: null, soft_remaining: null,
      period_start: period.start, period_end: period.end, enforced: false, allowed: true,
    });
    return new QuotaDecision({
      allowed: true, enforced: false, resource, requested, used: 0, limit: null, soft_limit: null,
      remaining: null, soft_remaining: null, period_start: period.start, period_end: period.end, reset_at: period.reset_at, headers,
    });
  }

  consume(resource: string, quantity: number = 1, opts: { run?: string; metadata?: Record<string, unknown>; now?: unknown } = {}): QuotaDecision {
    const canonical = normalizeResource(resource);
    const amount = validateQuantity(quantity);
    if (amount <= 0) throw new Error("quantity must be greater than zero for quota consumption.");
    if (!this.enforced || this.plan === null) return this.unlimitedDecision(canonical, amount, opts.now);

    const period = quotaPeriod(opts.now);
    const stamp = parseTimestamp(opts.now ?? new Date().toISOString()).toISOString().replace(/\.\d{3}Z$/, "Z");
    return withLock(this.lockPath, () => {
      const data = this.load();
      const { state, rolled } = this.stateFor(data, period);
      const usedBefore = (state.usage[canonical] as number) ?? 0;
      const planLimit = this.plan!.limit(canonical);
      const hard = planLimit.hard;
      if (hard !== null && usedBefore + amount > hard + _QUANTITY_EPSILON) {
        const decision = this.decision({ plan: planLimit, resource: canonical, requested: amount, used: usedBefore, period, allowed: false, now: opts.now });
        if (rolled) this.save(data);
        this.appendEvent(EVENT_HARD_LIMIT, { resource: canonical, decision, timestamp: stamp, metadata: { run: opts.run ? String(opts.run) : "", ...(opts.metadata ?? {}) } });
        throw new QuotaExceeded(decision);
      }

      let usedAfter: number = cleanQuantity(usedBefore + amount);
      if (Number.isInteger(usedBefore) && Number.isInteger(amount)) usedAfter = usedBefore + amount;
      state.usage[canonical] = usedAfter;
      state.updated_at = stamp;
      let warning: QuotaDecisionWarning | null = null;
      const soft = planLimit.soft;
      if (soft !== null && usedAfter + _QUANTITY_EPSILON >= soft && !state.soft_warned[canonical]) {
        state.soft_warned[canonical] = true;
        warning = {
          resource: canonical, soft_limit: soft, used: usedAfter,
          period_start: period.start, period_end: period.end, reset_at: period.reset_at, workspace: this.workspace,
        };
      }
      this.save(data);
      const decision = this.decision({ plan: planLimit, resource: canonical, requested: amount, used: usedAfter, period, allowed: true, warning, now: opts.now });
      if (warning !== null) {
        this.appendEvent(EVENT_SOFT_LIMIT, { resource: canonical, decision, timestamp: stamp, metadata: { soft_limit: soft, run: opts.run ? String(opts.run) : "", ...(opts.metadata ?? {}) } });
      }
      return decision;
    });
  }

  record(resource: string, quantity = 1, opts: any = {}) { return this.consume(resource, quantity, opts); }
  reserve(resource: string, quantity = 1, opts: any = {}) { return this.consume(resource, quantity, opts); }
  enforce(resource: string, quantity = 1, opts: any = {}) { return this.consume(resource, quantity, opts); }

  consumeFor(context: any, resource: string, quantity = 1, opts: any = {}): QuotaDecision {
    const workspace = workspaceFromContext(context);
    if (workspace !== this.workspace) {
      throw new QuotaError("The quota store does not belong to the authenticated workspace.");
    }
    return this.consume(resource, quantity, opts);
  }

  snapshotFor(context: any, now?: unknown): Record<string, unknown> {
    const workspace = workspaceFromContext(context);
    if (workspace !== this.workspace) {
      throw new QuotaError("The quota store does not belong to the authenticated workspace.");
    }
    return this.snapshot(now);
  }

  consumeEvent(eventType: string, quantity = 1, opts: any = {}): QuotaDecision {
    const resource = quotaResourceForEvent(eventType);
    if (resource === null) return this.unlimitedDecision("", quantity, opts.now);
    return this.consume(resource, quantity, opts);
  }

  consumeMeteringEvent(event: Record<string, unknown>): QuotaDecision {
    const eventType = String(event.event_type ?? "");
    const resource = quotaResourceForEvent(eventType);
    if (resource === null) return this.unlimitedDecision("", 0, event.timestamp);
    const quantity = (event.quantity as number) ?? 1;
    return this.consume(resource, quantity, { run: String(event.run ?? ""), metadata: { event_type: eventType }, now: event.timestamp });
  }

  peek(resource: string, quantity = 1, opts: { now?: unknown } = {}): QuotaDecision {
    const canonical = normalizeResource(resource);
    const amount = validateQuantity(quantity);
    if (amount <= 0) throw new Error("quantity must be greater than zero for a quota decision.");
    if (!this.enforced || this.plan === null) return this.unlimitedDecision(canonical, amount, opts.now);
    const period = quotaPeriod(opts.now);
    return withLock(this.lockPath, () => {
      const data = this.load();
      const { state } = this.stateFor(data, period);
      const used = (state.usage[canonical] as number) ?? 0;
      const planLimit = this.plan!.limit(canonical);
      const hard = planLimit.hard;
      const allowed = hard === null || used + amount <= hard + _QUANTITY_EPSILON;
      return this.decision({ plan: planLimit, resource: canonical, requested: amount, used, period, allowed, now: opts.now });
    });
  }
  check(resource: string, quantity = 1, opts: any = {}) { return this.peek(resource, quantity, opts); }

  tryConsume(resource: string, quantity = 1, opts: any = {}): QuotaDecision {
    try { return this.consume(resource, quantity, opts); } catch (err) {
      if (err instanceof QuotaExceeded) return err.decision;
      throw err;
    }
  }

  snapshot(now?: unknown): Record<string, unknown> {
    const period = quotaPeriod(now);
    if (!this.enforced || this.plan === null) {
      return {
        schema_version: QUOTA_SCHEMA_VERSION, status: "ok", enforced: false, unlimited: true, workspace: this.workspace,
        plan: null, period,
        limits: {}, usage: Object.fromEntries(RESOURCES.map((r) => [r, 0])),
        remaining: Object.fromEntries(RESOURCES.map((r) => [r, null])),
        soft_remaining: Object.fromEntries(RESOURCES.map((r) => [r, null])),
        soft_warnings: [],
        headers: headersFor("", { used: 0, limit: null, remaining: null, soft_limit: null, soft_remaining: null, period_start: period.start, period_end: period.end, enforced: false, allowed: true }),
      };
    }
    return withLock(this.lockPath, () => {
      const data = this.load();
      const { state } = this.stateFor(data, period);
      const usage: Record<string, number> = {};
      const limits: Record<string, unknown> = {};
      const remaining: Record<string, number | null> = {};
      const softRemaining: Record<string, number | null> = {};
      for (const resource of RESOURCES) {
        const u = (state.usage[resource] as number) ?? 0;
        usage[resource] = u;
        const pl = this.plan!.limit(resource);
        limits[resource] = pl.toDict();
        let rem: number | null = pl.hard === null ? null : cleanQuantity(Math.max(pl.hard - u, 0));
        if (rem !== null && Number.isInteger(rem)) rem = Math.trunc(rem);
        remaining[resource] = rem;
        let srem: number | null = pl.soft === null ? null : cleanQuantity(Math.max(pl.soft - u, 0));
        if (srem !== null && Number.isInteger(srem)) srem = Math.trunc(srem);
        softRemaining[resource] = srem;
      }
      return {
        schema_version: QUOTA_SCHEMA_VERSION, status: "ok", enforced: true, unlimited: false, workspace: this.workspace,
        plan: this.plan!.toDict(), period, limits, usage, remaining, soft_remaining: softRemaining,
        soft_warnings: Object.entries(state.soft_warned ?? {}).filter(([, v]) => v).map(([k]) => k).sort(),
        updated_at: state.updated_at ?? "",
        headers: headersFor("", { used: 0, limit: null, remaining: null, soft_limit: null, soft_remaining: null, period_start: period.start, period_end: period.end, enforced: true, allowed: true }),
      };
    });
  }

  summary(now?: unknown) { return this.snapshot(now); }
  warnings(now?: unknown): string[] { return (this.snapshot(now).soft_warnings as string[]) ?? []; }
  usage(now?: unknown): Record<string, number> { return { ...(this.snapshot(now).usage as Record<string, number>) }; }
  remaining(resource?: string | null, now?: unknown): any {
    const values = { ...(this.snapshot(now).remaining as Record<string, number | null>) };
    if (resource === undefined || resource === null) return values;
    return values[normalizeResource(resource)];
  }

  reset(now?: unknown): Record<string, unknown> {
    if (!this.enforced || this.plan === null) return this.snapshot(now);
    const period = quotaPeriod(now);
    return withLock(this.lockPath, () => {
      const data = this.load();
      const { state } = this.stateFor(data, period);
      state.usage = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
      state.soft_warned = {};
      state.updated_at = parseTimestamp(now ?? new Date().toISOString()).toISOString().replace(/\.\d{3}Z$/, "Z");
      this.save(data);
      return this.snapshot(now);
    });
  }
}

export { _WORKSPACE_UNSET as QUOTA_WORKSPACE_UNSET };
