import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { newId, now, parseTimestamp } from "@lemma/core";
import { AuthStore, SCOPE_ADMIN, SCOPE_EXPORT, SCOPE_READ, SCOPE_RUN } from "./auth.js";
import { QuotaPlan, QuotaStore, RESOURCES, quotaPeriod } from "./quota.js";
import type { QuotaResource } from "./quota.js";

export const SIGNUP_SCHEMA_VERSION = "quality-harness.signup/v1" as const;
export const ENTITLEMENT_SCHEMA_VERSION = "quality-harness.entitlement/v1" as const;
export const DEFAULT_SIGNUP_STORE = path.join(".lemma", "cloud", "signup.json");
export const DEFAULT_SIGNING_KEY_PATH = path.join(".lemma", "cloud", "entitlement-signing.key");
export const DEFAULT_SIGNUP_LOCK = path.join(".lemma", "cloud", "signup.lock");

export class SignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignupError";
  }
}

export class EntitlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementError";
  }
}

export class PlanDowngradeError extends SignupError {
  constructor(message: string) {
    super(message);
    this.name = "PlanDowngradeError";
  }
}

export interface EntitlementVerificationResult {
  valid: boolean;
  reason: string;
  workspace_id?: unknown;
  period?: unknown;
  [key: string]: unknown;
}

export class EntitlementVerification implements EntitlementVerificationResult {
  valid: boolean;
  reason: string;
  workspace_id?: unknown;
  period?: unknown;
  [key: string]: unknown;
  constructor(init: EntitlementVerificationResult) {
    this.valid = Boolean(init.valid);
    this.reason = String(init.reason ?? "");
    Object.assign(this, init);
  }
  valueOf(): boolean { return this.valid; }
  [Symbol.toPrimitive](_hint: string): boolean { return this.valid; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, limit = 500): string {
  return String(value ?? "").trim().slice(0, limit);
}

function coerceNow(value?: unknown): string {
  if (value === undefined || value === null) return parseTimestamp(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return parseTimestamp(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const _PERIOD_RE = /^(\d{4})-(\d{2})$/;
function periodFor(value: unknown): { key: string; start: string; end: string } {
  const text = String(value ?? "").trim();
  const match = _PERIOD_RE.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const end = month === 12 ? new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0)) : new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    return { key: text, start: fmt(start), end: fmt(end) };
  }
  const qp = quotaPeriod(value);
  return { key: qp.key, start: qp.start, end: qp.end };
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

function canonical(value: unknown): string {
  return compactStableJson(value);
}

function chmodSafe(p: string, mode: number): void { try { fs.chmodSync(p, mode); } catch { /* ignore */ } }

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

function atomicWriteBytes(filePath: string, data: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chmodSafe(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeSync(fd, data);
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

function loadSigningKey(keyPath: string): Buffer {
  if (fs.existsSync(keyPath)) {
    const data = fs.readFileSync(keyPath);
    if (!data.length) throw new EntitlementError("The entitlement signing key is empty.");
    return data;
  }
  const key = crypto.randomBytes(32);
  atomicWriteBytes(keyPath, key);
  return key;
}

function signature(signingKey: Buffer, payload: Record<string, unknown>): string {
  const digest = crypto.createHmac("sha256", signingKey).update(canonical(payload), "utf8").digest();
  return digest.toString("base64url");
}

function safeMetadata(metadata?: Record<string, unknown> | null): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (v !== undefined && v !== null && v !== "") safe[String(k).slice(0, 80)] = String(v).slice(0, 200);
  }
  return safe;
}

function loadPlan(plan: unknown): QuotaPlan {
  if (plan instanceof QuotaPlan) return plan;
  if (plan === undefined || plan === null) return new QuotaPlan({ id: "default", version: "1", period: "monthly", limits: {} });
  if (typeof plan === "string") return QuotaPlan.load(plan);
  if (isRecord(plan)) return QuotaPlan.fromDict(plan);
  throw new SignupError("A quota plan must be a QuotaPlan, mapping, or path.");
}

export interface SignupStoreOptions {
  signing_key?: Buffer | string;
  signingKey?: Buffer | string;
  store_path?: string;
  storePath?: string;
  signing_key_path?: string;
  signingKeyPath?: string;
  lock_path?: string;
  lockPath?: string;
  auth_store?: AuthStore;
  authStore?: AuthStore;
}

interface SignupStoreData {
  schema_version: string;
  requests: Record<string, any>;
  workspaces: Record<string, any>;
}

export class SignupStore {
  readonly root: string;
  readonly storePath: string;
  readonly lockPath: string;
  readonly signingKeyPath: string;
  readonly auth: AuthStore;
  readonly signingKey: Buffer;

  constructor(root: string, opts: SignupStoreOptions = {}) {
    this.root = path.resolve(root);
    this.storePath = this.resolvePath(opts.store_path ?? opts.storePath ?? DEFAULT_SIGNUP_STORE);
    this.lockPath = this.resolvePath(opts.lock_path ?? opts.lockPath ?? DEFAULT_SIGNUP_LOCK);
    this.signingKeyPath = this.resolvePath(opts.signing_key_path ?? opts.signingKeyPath ?? DEFAULT_SIGNING_KEY_PATH);
    this.auth = opts.auth_store ?? opts.authStore ?? new AuthStore(this.root);
    const sk = opts.signing_key ?? opts.signingKey;
    if (sk === undefined || sk === null) {
      this.signingKey = loadSigningKey(this.signingKeyPath);
    } else if (typeof sk === "string") {
      const p = path.isAbsolute(sk) ? sk : path.resolve(this.root, sk);
      if (fs.existsSync(p)) this.signingKey = fs.readFileSync(p);
      else this.signingKey = Buffer.from(sk, "utf8");
    } else {
      this.signingKey = Buffer.from(sk);
    }
  }

  private resolvePath(value: string): string {
    if (path.isAbsolute(value)) return path.resolve(value);
    return path.resolve(this.root, value);
  }

  private empty(): SignupStoreData {
    return { schema_version: SIGNUP_SCHEMA_VERSION, requests: {}, workspaces: {} };
  }

  private load(): SignupStoreData {
    if (!fs.existsSync(this.storePath)) return this.empty();
    let data: any;
    try { data = JSON.parse(fs.readFileSync(this.storePath, "utf8")); } catch (err) { throw new SignupError(`The signup store is unreadable: ${String(err)}`); }
    if (!isRecord(data)) throw new SignupError("The signup store must contain a JSON object.");
    if (data.schema_version !== SIGNUP_SCHEMA_VERSION) throw new SignupError("Unsupported signup schema version.");
    if (!isRecord(data.requests)) data.requests = {};
    if (!isRecord(data.workspaces)) data.workspaces = {};
    return data as unknown as SignupStoreData;
  }

  private save(data: SignupStoreData): void {
    atomicWrite(this.storePath, JSON.stringify(data, null, 2) + "\n");
  }

  private usageSnapshot(workspaceId: string, plan: QuotaPlan, nowValue: unknown): any {
    const quota = new QuotaStore(this.root, plan, { workspace: workspaceId, enforce: true });
    return quota.snapshot(nowValue);
  }

  signup(requestId: string, opts: {
    name?: string; plan?: unknown; effective_at?: string; effectiveAt?: string; now?: unknown;
    workspace_id?: string; workspaceId?: string; owner_scopes?: string[]; ownerScopes?: string[];
    owner_label?: string; ownerLabel?: string;
  } = {}): any {
    const requestKey = safeText(requestId);
    if (!requestKey) throw new SignupError("A signup request id is required for idempotency.");
    const nowText = coerceNow(opts.now);
    const effectiveText = coerceNow(opts.effective_at ?? opts.effectiveAt ?? nowText);

    const data = this.load();
    if (data.requests[requestKey]) {
      const record = data.requests[requestKey];
      const wsRecord = data.workspaces[record.workspace_id] ?? {};
      const planObj = loadPlan(wsRecord.plan);
      const usage = this.usageSnapshot(record.workspace_id, planObj, nowText);
      return {
        schema_version: SIGNUP_SCHEMA_VERSION,
        status: "replayed",
        replayed: true,
        request_id: requestKey,
        workspace: { id: wsRecord.workspace_id, name: wsRecord.name ?? "" },
        key: { id: record.key_id, prefix: record.prefix, scopes: [...(record.scopes ?? [])], secret: null },
        plan: planObj.toDict(),
        effective_at: wsRecord.effective_at ?? effectiveText,
        entitlement: wsRecord.entitlement,
        usage,
      };
    }

    const workspace = this.auth.createWorkspace(opts.name || "Workspace", opts.workspace_id ?? opts.workspaceId);
    const scopes = [...(opts.owner_scopes ?? opts.ownerScopes ?? [SCOPE_ADMIN, SCOPE_RUN, SCOPE_READ, SCOPE_EXPORT])];
    const key = this.auth.createKey(workspace.id, scopes, opts.owner_label ?? opts.ownerLabel ?? "owner");
    const planObj = loadPlan(opts.plan);
    const period = periodFor(effectiveText);
    const entitlement = this.issueEntitlement(workspace.id, planObj, {
      period: period.key,
      effective_at: effectiveText,
      issued_at: nowText,
      signup_request_id: requestKey,
      key_id: key.id,
    });
    const quota = new QuotaStore(this.root, planObj, { workspace: workspace.id, enforce: true });
    quota.snapshot(effectiveText);

    const wsRecord = {
      workspace_id: workspace.id,
      name: workspace.name ?? opts.name ?? "Workspace",
      owner_key_id: key.id,
      default_key_id: key.id,
      plan: planObj.toDict(),
      effective_at: effectiveText,
      period: period.key,
      entitlement_id: entitlement.id,
      entitlement,
      created_at: nowText,
      updated_at: nowText,
      plan_selections: [],
      last_request_id: requestKey,
    };
    data.workspaces[workspace.id] = wsRecord;
    data.requests[requestKey] = {
      request_id: requestKey,
      workspace_id: workspace.id,
      key_id: key.id,
      prefix: key.prefix,
      scopes,
      plan_id: planObj.id,
      entitlement_id: entitlement.id,
      created_at: nowText,
    };
    this.save(data);

    const usage = this.usageSnapshot(workspace.id, planObj, nowText);
    return {
      schema_version: SIGNUP_SCHEMA_VERSION,
      status: "created",
      replayed: false,
      request_id: requestKey,
      workspace: { id: workspace.id, name: wsRecord.name },
      key: { id: key.id, prefix: key.prefix, scopes, secret: key.secret },
      plan: planObj.toDict(),
      effective_at: effectiveText,
      entitlement,
      usage,
    };
  }

  getSignup(workspaceId: string): any | null {
    const key = safeText(workspaceId);
    const data = this.load();
    const rec = data.workspaces[key];
    return rec ? JSON.parse(JSON.stringify(rec)) : null;
  }
  get_signup(workspaceId: string) { return this.getSignup(workspaceId); }
  getWorkspace(workspaceId: string) { return this.getSignup(workspaceId); }
  get_workspace(workspaceId: string) { return this.getSignup(workspaceId); }

  selectPlan(workspaceId: string, plan: unknown, opts: { effective_at?: string; effectiveAt?: string; now?: unknown; metadata?: Record<string, unknown> } = {}): any {
    const workspaceKey = safeText(workspaceId);
    if (!workspaceKey) throw new SignupError("A workspace id is required.");
    const nowText = coerceNow(opts.now);
    const effectiveText = coerceNow(opts.effective_at ?? opts.effectiveAt ?? nowText);
    const data = this.load();
    const record = data.workspaces[workspaceKey] as any;
    if (!isRecord(record)) throw new SignupError("Workspace not found.");
    const currentPlan = loadPlan(record.plan);
    const newPlan = loadPlan(plan);
    const currentUsage = (this.usageSnapshot(workspaceKey, currentPlan, nowText) as any).usage ?? {};
    for (const resource of RESOURCES as readonly QuotaResource[]) {
      const newLimit = newPlan.limit(resource).hard;
      const used = Number(currentUsage[resource] ?? 0);
      if (newLimit !== null && used > newLimit + 1e-9) {
        throw new PlanDowngradeError(`Plan ${newPlan.id} would downgrade below current usage for ${resource} (used=${used}, new_limit=${newLimit}).`);
      }
    }
    const period = periodFor(effectiveText);
    const quota = new QuotaStore(this.root, newPlan, { workspace: workspaceKey, enforce: true });
    quota.snapshot(effectiveText);
    const entitlement = this.issueEntitlement(workspaceKey, newPlan, {
      period: period.key,
      effective_at: effectiveText,
      issued_at: nowText,
      signup_request_id: safeText(record.last_request_id ?? ""),
      key_id: safeText(record.default_key_id ?? ""),
    });
    record.plan = newPlan.toDict();
    record.effective_at = effectiveText;
    record.period = period.key;
    record.entitlement_id = entitlement.id;
    record.entitlement = entitlement;
    record.updated_at = nowText;
    if (!Array.isArray(record.plan_selections)) record.plan_selections = [];
    (record.plan_selections as any[]).push({
      plan_id: newPlan.id,
      plan_version: newPlan.version,
      effective_at: effectiveText,
      period: period.key,
      selected_at: nowText,
      metadata: safeMetadata(opts.metadata),
    });
    data.workspaces[workspaceKey] = record;
    this.save(data);
    const usage = this.usageSnapshot(workspaceKey, newPlan, nowText);
    return {
      schema_version: SIGNUP_SCHEMA_VERSION,
      status: "plan_selected",
      workspace: { id: workspaceKey, name: record.name ?? "" },
      plan: newPlan.toDict(),
      effective_at: effectiveText,
      period: period.key,
      entitlement,
      usage,
    };
  }
  select_plan(workspaceId: string, plan: unknown, opts: any = {}) { return this.selectPlan(workspaceId, plan, opts); }

  usage(workspaceId: string, plan?: unknown, nowValue?: unknown): any {
    const workspaceKey = safeText(workspaceId);
    if (!workspaceKey) throw new SignupError("A workspace id is required.");
    const data = this.load();
    const record = data.workspaces[workspaceKey];
    if (!isRecord(record)) throw new SignupError("Workspace not found.");
    const planObj = loadPlan(plan !== undefined ? plan : record.plan);
    const nowText = coerceNow(nowValue);
    const snapshot = this.usageSnapshot(workspaceKey, planObj, nowText);
    return {
      schema_version: SIGNUP_SCHEMA_VERSION,
      status: "ok",
      workspace: { id: workspaceKey, name: record.name ?? "" },
      plan: planObj.toDict(),
      effective_at: record.effective_at,
      entitlement: record.entitlement,
      quota: snapshot,
      usage: (snapshot as any).usage ?? {},
      remaining: (snapshot as any).remaining ?? {},
      limits: (snapshot as any).limits ?? {},
      period: (snapshot as any).period,
    };
  }

  issueEntitlement(workspaceId: string, plan: unknown, opts: {
    period?: string; effective_at?: string; effectiveAt?: string; expires_at?: string; expiresAt?: string;
    issued_at?: string; issuedAt?: string; signup_request_id?: string; signupRequestId?: string; key_id?: string; keyId?: string; now?: unknown;
  } = {}): any {
    const workspaceKey = safeText(workspaceId);
    if (!workspaceKey) throw new SignupError("A workspace id is required.");
    const planObj = loadPlan(plan);
    const issuedText = coerceNow(opts.issued_at ?? opts.issuedAt ?? opts.now);
    const effectiveText = coerceNow(opts.effective_at ?? opts.effectiveAt ?? issuedText);
    const periodInfo = periodFor(opts.period ?? effectiveText);
    const expiryText = coerceNow(opts.expires_at ?? opts.expiresAt ?? periodInfo.end);
    const limits: Record<string, unknown> = {};
    for (const resource of RESOURCES as readonly QuotaResource[]) {
      limits[resource] = planObj.limit(resource).toDict();
    }
    const payload: Record<string, unknown> = {
      schema_version: ENTITLEMENT_SCHEMA_VERSION,
      id: newId("ent"),
      workspace_id: workspaceKey,
      plan_id: planObj.id,
      plan_version: planObj.version,
      tier: planObj.id,
      limits,
      period: periodInfo.key,
      period_start: periodInfo.start,
      period_end: periodInfo.end,
      effective_at: effectiveText,
      issued_at: issuedText,
      expires_at: expiryText,
      signup_request_id: safeText(opts.signup_request_id ?? opts.signupRequestId ?? ""),
      key_id: safeText(opts.key_id ?? opts.keyId ?? ""),
    };
    const entitlement: Record<string, unknown> = { ...payload, signature_algorithm: "HMAC-SHA256" };
    const signedPayload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entitlement)) {
      if (k !== "signature") signedPayload[k] = v;
    }
    entitlement.signature = signature(this.signingKey, signedPayload);
    return entitlement;
  }
  issue_entitlement(workspaceId: string, plan: unknown, opts: any = {}) { return this.issueEntitlement(workspaceId, plan, opts); }

  private resolveSigningKey(signingKey?: Buffer | string | null): Buffer {
    if (signingKey === undefined || signingKey === null) return this.signingKey;
    if (typeof signingKey === "string") {
      const p = path.isAbsolute(signingKey) ? signingKey : path.resolve(this.root, signingKey);
      if (fs.existsSync(p)) return fs.readFileSync(p);
      return Buffer.from(signingKey, "utf8");
    }
    return Buffer.from(signingKey);
  }

  verifyEntitlement(entitlement: unknown, opts: { signing_key?: Buffer | string; signingKey?: Buffer | string; now?: unknown; workspace_id?: string; workspaceId?: string; period?: string } = {}): EntitlementVerification {
    if (!isRecord(entitlement)) return new EntitlementVerification({ valid: false, reason: "entitlement must be a mapping" });
    const key = this.resolveSigningKey(opts.signing_key ?? opts.signingKey);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entitlement)) {
      if (k !== "signature") payload[k] = v;
    }
    const expected = signature(key, payload);
    const got = String(entitlement.signature ?? "");
    if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      return new EntitlementVerification({ valid: false, reason: "invalid signature", workspace_id: entitlement.workspace_id });
    }
    const wsOpt = opts.workspace_id ?? opts.workspaceId;
    if (wsOpt !== undefined && wsOpt !== null && safeText(wsOpt) !== safeText(entitlement.workspace_id)) {
      return new EntitlementVerification({ valid: false, reason: "workspace mismatch", workspace_id: entitlement.workspace_id });
    }
    if (opts.period !== undefined && opts.period !== null && String(opts.period) !== String(entitlement.period)) {
      return new EntitlementVerification({ valid: false, reason: "period mismatch", workspace_id: entitlement.workspace_id });
    }
    const expiry = entitlement.expires_at;
    if (expiry) {
      const nowText = coerceNow(opts.now ?? now());
      try {
        if (parseTimestamp(nowText).getTime() > parseTimestamp(expiry).getTime()) {
          return new EntitlementVerification({ valid: false, reason: "expired", workspace_id: entitlement.workspace_id });
        }
      } catch {
        return new EntitlementVerification({ valid: false, reason: "invalid expiry", workspace_id: entitlement.workspace_id });
      }
    }
    return new EntitlementVerification({ valid: true, reason: "ok", workspace_id: entitlement.workspace_id, period: entitlement.period });
  }
  verify_entitlement(entitlement: unknown, opts: any = {}) { return this.verifyEntitlement(entitlement, opts); }

  // for tests parity
  _load(): SignupStoreData { return this.load(); }
  _usage_snapshot(workspaceId: string, plan: QuotaPlan, nowValue: unknown) { return this.usageSnapshot(workspaceId, plan, nowValue); }
}

export function verifyEntitlement(entitlement: unknown, opts: { signing_key?: Buffer | string; signingKey?: Buffer | string; root?: string; now?: unknown; workspace_id?: string; workspaceId?: string; period?: string } = {}): EntitlementVerification {
  const sk = opts.signing_key ?? opts.signingKey;
  if ((sk === undefined || sk === null) && !opts.root) {
    throw new EntitlementError("A signing key or root is required to verify an entitlement.");
  }
  const storeRoot = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "lemma-signup-verify-"));
  const storeOpts: SignupStoreOptions = {};
  if (sk !== undefined && sk !== null) storeOpts.signing_key = sk;
  const store = new SignupStore(storeRoot, storeOpts);
  return store.verifyEntitlement(entitlement, opts);
}
export const verify_entitlement = verifyEntitlement;

// aliases
export const SignupManager = SignupStore;
export const EntitlementStore = SignupStore;
export const OnboardingStore = SignupStore;
