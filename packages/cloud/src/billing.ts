import * as fs from "node:fs";
import * as path from "node:path";
import { now } from "@lemma/core";
import { LedgerStore } from "./ledger.js";
import { SignupStore } from "./signup.js";

export const BILLING_SCHEMA_VERSION = "quality-harness.billing/v1" as const;
export const DEFAULT_BILLING_STATE = path.join(".lemma", "billing", "state.json");
export const DEFAULT_BILLING_KILL = path.join(".lemma", "billing", "KILL");
export const GLOBAL_KILL = path.join(".lemma", "KILL");
export const DEFAULT_BILLING_LOCK = path.join(".lemma", "billing", "billing.lock");

export class BillingError extends Error { constructor(message: string) { super(message); this.name = "BillingError"; } }
export class BillingDisabled extends BillingError { constructor(message: string) { super(message); this.name = "BillingDisabled"; } }
export class BillingDegraded extends BillingError { constructor(message: string) { super(message); this.name = "BillingDegraded"; } }
export class BillingTransientError extends BillingError { constructor(message: string) { super(message); this.name = "BillingTransientError"; } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeText(value: unknown, limit = 500): string { return String(value ?? "").trim().slice(0, limit); }
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

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

export class BillingFeatureFlag {
  readonly enabled: boolean;
  readonly sandbox: boolean;
  readonly workspaces: readonly string[];
  readonly killSwitchPath?: string;

  constructor(opts: { enabled?: boolean; sandbox?: boolean; workspaces?: string[] | string; kill_switch_path?: string; killSwitchPath?: string } = {}) {
    this.enabled = Boolean(opts.enabled);
    this.sandbox = Boolean(opts.sandbox);
    let ws = opts.workspaces ?? [];
    if (typeof ws === "string") ws = ws.split(",").map((s) => s.trim()).filter(Boolean);
    this.workspaces = [...(ws as string[])].map((s) => String(s).trim()).filter(Boolean);
    const ksp = opts.kill_switch_path ?? opts.killSwitchPath;
    if (ksp) this.killSwitchPath = ksp;
  }

  isEnabled(workspaceId: string): boolean {
    if (!this.enabled || !this.sandbox) return false;
    const key = safeText(workspaceId);
    if (!key) return false;
    if (!this.workspaces.length) return false;
    return this.workspaces.includes(key);
  }
  is_enabled(workspaceId: string) { return this.isEnabled(workspaceId); }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BillingFeatureFlag {
    const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
    const workspaces = String(env.QH_BILLING_WORKSPACES ?? env.LEMMA_BILLING_WORKSPACES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return new BillingFeatureFlag({
      enabled: truthy(env.QH_BILLING_ENABLED ?? env.LEMMA_BILLING_ENABLED),
      sandbox: truthy(env.QH_BILLING_SANDBOX ?? env.LEMMA_BILLING_SANDBOX),
      workspaces,
    });
  }
  static from_env(env?: NodeJS.ProcessEnv) { return BillingFeatureFlag.fromEnv(env); }

  static fromDict(data: unknown): BillingFeatureFlag {
    if (!isRecord(data)) throw new BillingError("Billing feature flag must be a mapping.");
    let ws = (data.workspaces ?? data.allowed_workspaces) as any;
    if (typeof ws === "string") ws = ws.split(",").map((s: string) => s.trim()).filter(Boolean);
    const killSwitchPath = data.kill_switch_path ? String(data.kill_switch_path) : undefined;
    return new BillingFeatureFlag({
      enabled: Boolean(data.enabled),
      sandbox: Boolean(data.sandbox),
      workspaces: (ws as string[] | undefined) ?? [],
      ...(killSwitchPath ? { kill_switch_path: killSwitchPath } : {}),
    });
  }
  static from_dict(data: unknown) { return BillingFeatureFlag.fromDict(data); }

  toDict(): Record<string, unknown> {
    return { enabled: this.enabled, sandbox: this.sandbox, workspaces: [...this.workspaces] };
  }
  to_dict() { return this.toDict(); }
}

export class SecretManager {
  get(_reference: string): string { throw new Error("Not implemented"); }
  has(reference: string): boolean { try { return Boolean(this.get(reference)); } catch { return false; } }
}

export class EnvSecretManager extends SecretManager {
  private env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) { super(); this.env = env; }
  override get(reference: string): string {
    const key = safeText(reference, 200);
    if (!key) throw new BillingError("A secret reference is required.");
    const value = this.env[key];
    if (!value) throw new BillingError(`Secret not found: ${key}`);
    return String(value);
  }
}

export class InMemorySecretManager extends SecretManager {
  private values: Map<string, string>;
  constructor(values: Record<string, string> = {}) { super(); this.values = new Map(Object.entries(values)); }
  override get(reference: string): string {
    const key = safeText(reference, 200);
    if (!this.values.has(key)) throw new BillingError(`Secret not found: ${key}`);
    return String(this.values.get(key));
  }
  set(reference: string, value: string): void { this.values.set(safeText(reference, 200), String(value)); }
}

export class FileSecretManager extends SecretManager {
  readonly path: string;
  constructor(filePath: string) { super(); this.path = path.resolve(filePath); }
  override get(reference: string): string {
    const key = safeText(reference, 200);
    if (!fs.existsSync(this.path)) throw new BillingError(`Secret store not found: ${this.path}`);
    let data: any;
    try { data = JSON.parse(fs.readFileSync(this.path, "utf8")); } catch (err) { throw new BillingError(`Secret store is unreadable: ${String(err)}`); }
    if (!isRecord(data) || !(key in data)) throw new BillingError(`Secret not found: ${key}`);
    return String((data as any)[key]);
  }
}

export interface BillingProvider {
  createCustomer(args: { workspace_id: string; name: string; idempotency_key: string; secret: string }): any;
  ensureSubscription(args: { workspace_id: string; customer_id: string; plan_id: string; idempotency_key: string; secret: string }): any;
  cancelSubscription?(args: { workspace_id: string; subscription_id: string; idempotency_key: string; secret: string; reason?: string }): any;
  reconcileInvoice(args: { workspace_id: string; period: string; invoice: Record<string, any>; idempotency_key: string; secret: string }): any;
}

export class SandboxBillingProvider implements BillingProvider {
  readonly root: string;
  readonly statePath: string;
  failReconcileTimes: number;
  failCustomerTimes: number;
  failSubscriptionTimes: number;

  constructor(root: string, opts: { fail_reconcile_times?: number; failReconcileTimes?: number; fail_customer_times?: number; failCustomerTimes?: number; fail_subscription_times?: number; failSubscriptionTimes?: number } = {}) {
    this.root = path.resolve(root);
    this.statePath = path.join(this.root, ".lemma", "billing", "sandbox-provider.json");
    this.failReconcileTimes = Number(opts.fail_reconcile_times ?? opts.failReconcileTimes ?? 0);
    this.failCustomerTimes = Number(opts.fail_customer_times ?? opts.failCustomerTimes ?? 0);
    this.failSubscriptionTimes = Number(opts.fail_subscription_times ?? opts.failSubscriptionTimes ?? 0);
  }

  private load(): any {
    if (!fs.existsSync(this.statePath)) return { customers: {}, subscriptions: {}, invoices: {}, attempts: {}, cancellations: {} };
    let data: any;
    try { data = JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch { data = {}; }
    if (!isRecord(data)) data = {};
    data.customers ??= {}; data.subscriptions ??= {}; data.invoices ??= {}; data.attempts ??= {}; data.cancellations ??= {};
    return data;
  }
  private save(data: any): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    chmodSafe(path.dirname(this.statePath), 0o700);
    atomicWrite(this.statePath, JSON.stringify(data, null, 2) + "\n");
  }
  private attempt(key: string, limit: number): void {
    const data = this.load();
    const attempts = Number(data.attempts[key] ?? 0) + 1;
    data.attempts[key] = attempts;
    this.save(data);
    if (attempts <= limit) throw new BillingTransientError(`Sandbox provider transient failure ${attempts} for ${key}`);
  }

  createCustomer(args: { workspace_id: string; name: string; idempotency_key: string; secret: string }): any {
    const key = String(args.idempotency_key);
    let data = this.load();
    if (data.customers[key]) return { ...data.customers[key] };
    this.attempt(`customer:${key}`, this.failCustomerTimes);
    data = this.load();
    if (data.customers[key]) return { ...data.customers[key] };
    const customer = { provider: "sandbox", customer_id: `cus_${args.workspace_id}`, workspace_id: args.workspace_id, name: safeText(args.name), idempotency_key: key, status: "created" };
    data.customers[key] = customer;
    this.save(data);
    return { ...customer };
  }
  create_customer(args: any) { return this.createCustomer(args); }

  ensureSubscription(args: { workspace_id: string; customer_id: string; plan_id: string; idempotency_key: string; secret: string }): any {
    const key = String(args.idempotency_key);
    let data = this.load();
    if (data.subscriptions[key]) return { ...data.subscriptions[key] };
    this.attempt(`subscription:${key}`, this.failSubscriptionTimes);
    data = this.load();
    if (data.subscriptions[key]) return { ...data.subscriptions[key] };
    const subscription = { provider: "sandbox", subscription_id: `sub_${args.workspace_id}`, workspace_id: args.workspace_id, customer_id: args.customer_id, plan_id: safeText(args.plan_id), idempotency_key: key, status: "active" };
    data.subscriptions[key] = subscription;
    this.save(data);
    return { ...subscription };
  }
  ensure_subscription(args: any) { return this.ensureSubscription(args); }

  cancelSubscription(args: { workspace_id: string; subscription_id: string; idempotency_key: string; secret: string; reason?: string }): any {
    const key = String(args.idempotency_key);
    const data = this.load();
    if (data.cancellations[key]) return { ...data.cancellations[key] };
    const result = { provider: "sandbox", workspace_id: args.workspace_id, subscription_id: args.subscription_id, idempotency_key: key, reason: safeText(args.reason, 500), status: "cancelled" };
    data.cancellations[key] = result;
    for (const sub of Object.values(data.subscriptions as Record<string, any>)) {
      if (isRecord(sub) && sub.subscription_id === args.subscription_id) sub.status = "cancelled";
    }
    this.save(data);
    return { ...result };
  }
  cancel_subscription(args: any) { return this.cancelSubscription(args); }

  reconcileInvoice(args: { workspace_id: string; period: string; invoice: Record<string, any>; idempotency_key: string; secret: string }): any {
    const key = String(args.idempotency_key);
    let data = this.load();
    if (data.invoices[key]) return { ...data.invoices[key] };
    this.attempt(`invoice:${key}`, this.failReconcileTimes);
    data = this.load();
    if (data.invoices[key]) return { ...data.invoices[key] };
    const ledgerTotal = Number(args.invoice.total ?? 0);
    const providerTotal = Math.round(ledgerTotal * 100) / 100;
    const matched = Math.abs(providerTotal - ledgerTotal) <= 0.005;
    const result = { provider: "sandbox", workspace_id: args.workspace_id, period: args.period, idempotency_key: key, invoice_id: String(args.invoice.invoice_id ?? ""), ledger_total: ledgerTotal, provider_total: providerTotal, matched, status: matched ? "reconciled" : "mismatch" };
    data.invoices[key] = result;
    this.save(data);
    if (!matched) throw new BillingError(`Sandbox invoice mismatch: ledger=${ledgerTotal}, provider=${providerTotal}`);
    return { ...result };
  }
  reconcile_invoice(args: any) { return this.reconcileInvoice(args); }
}

export interface BillingStoreOptions {
  feature_flag?: BillingFeatureFlag | Record<string, unknown>;
  featureFlag?: BillingFeatureFlag | Record<string, unknown>;
  secret_manager?: SecretManager;
  secretManager?: SecretManager;
  secret_ref?: string;
  secretRef?: string;
  provider?: BillingProvider;
  ledger?: LedgerStore;
  signup?: SignupStore;
  kill_switch_path?: string;
  killSwitchPath?: string;
  global_kill_switch_path?: string;
  globalKillSwitchPath?: string;
  state_path?: string;
  statePath?: string;
  lock_path?: string;
  lockPath?: string;
  max_retries?: number;
  maxRetries?: number;
  retry_delay_seconds?: number;
  retryDelaySeconds?: number;
}

export class BillingStore {
  readonly root: string;
  readonly featureFlag: BillingFeatureFlag;
  readonly secretManager: SecretManager;
  readonly secretRef: string;
  readonly ledger: LedgerStore;
  readonly signup: SignupStore;
  readonly provider: BillingProvider;
  readonly killSwitchPath: string;
  readonly globalKillSwitchPath: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly maxRetries: number;
  readonly retryDelaySeconds: number;

  constructor(root: string, opts: BillingStoreOptions = {}) {
    this.root = path.resolve(root);
    const ff = opts.feature_flag ?? opts.featureFlag;
    if (ff instanceof BillingFeatureFlag) this.featureFlag = ff;
    else if (isRecord(ff)) this.featureFlag = BillingFeatureFlag.fromDict(ff);
    else this.featureFlag = BillingFeatureFlag.fromEnv();
    this.secretManager = opts.secret_manager ?? opts.secretManager ?? new EnvSecretManager();
    this.secretRef = safeText(opts.secret_ref ?? opts.secretRef ?? "billing/api_key", 200) || "billing/api_key";
    this.ledger = opts.ledger ?? new LedgerStore(this.root);
    this.signup = opts.signup ?? new SignupStore(this.root);
    this.provider = opts.provider ?? new SandboxBillingProvider(this.root);
    this.killSwitchPath = this.resolvePath(opts.kill_switch_path ?? opts.killSwitchPath ?? DEFAULT_BILLING_KILL);
    this.globalKillSwitchPath = this.resolvePath(opts.global_kill_switch_path ?? opts.globalKillSwitchPath ?? GLOBAL_KILL);
    this.statePath = this.resolvePath(opts.state_path ?? opts.statePath ?? DEFAULT_BILLING_STATE);
    this.lockPath = this.resolvePath(opts.lock_path ?? opts.lockPath ?? DEFAULT_BILLING_LOCK);
    this.maxRetries = Math.max(1, Number(opts.max_retries ?? opts.maxRetries ?? 1));
    this.retryDelaySeconds = Math.max(0, Number(opts.retry_delay_seconds ?? opts.retryDelaySeconds ?? 0));
  }

  private resolvePath(value: string): string {
    if (path.isAbsolute(value)) return path.resolve(value);
    return path.resolve(this.root, value);
  }

  private empty(): any { return { schema_version: BILLING_SCHEMA_VERSION, workspaces: {}, disabled_events: [] }; }
  private load(): any {
    if (!fs.existsSync(this.statePath)) return this.empty();
    let data: any;
    try { data = JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch (err) { throw new BillingError(`Billing state is unreadable: ${String(err)}`); }
    if (!isRecord(data)) throw new BillingError("Billing state must contain a JSON object.");
    if (data.schema_version !== BILLING_SCHEMA_VERSION) throw new BillingError("Unsupported billing schema version.");
    if (!isRecord(data.workspaces)) data.workspaces = {};
    if (!Array.isArray(data.disabled_events)) data.disabled_events = [];
    return data;
  }
  private save(data: any): void { atomicWrite(this.statePath, JSON.stringify(data, null, 2) + "\n"); }

  billingEnabled(workspaceId: string): boolean {
    const key = safeText(workspaceId);
    if (!key) return false;
    if (this.killSwitchActive()) return false;
    return this.featureFlag.isEnabled(key);
  }
  billing_enabled(workspaceId: string) { return this.billingEnabled(workspaceId); }

  killSwitchActive(): boolean {
    return fs.existsSync(this.killSwitchPath) || fs.existsSync(this.globalKillSwitchPath);
  }
  kill_switch_active() { return this.killSwitchActive(); }

  disable(reason = "operator disabled billing writes"): any {
    fs.mkdirSync(path.dirname(this.killSwitchPath), { recursive: true });
    const payload = JSON.stringify({ status: "disabled", reason: safeText(reason, 500), disabled_at: now() }) + "\n";
    fs.writeFileSync(this.killSwitchPath, payload, { encoding: "utf8", mode: 0o600 });
    chmodSafe(this.killSwitchPath, 0o600);
    return { schema_version: BILLING_SCHEMA_VERSION, status: "disabled", workspace: null, reason: safeText(reason, 500) };
  }

  enableWrites(): void { try { fs.unlinkSync(this.killSwitchPath); } catch { /* ignore */ } }
  enable_writes() { this.enableWrites(); }

  private workspaceState(data: any, workspaceId: string): any {
    data.workspaces ??= {};
    let state = data.workspaces[workspaceId];
    if (!isRecord(state)) {
      state = { workspace_id: workspaceId, customer_id: null, subscription_id: null, plan_id: null, invoices: {}, attempts: 0, last_status: "not_started", last_error: "", updated_at: "" };
      data.workspaces[workspaceId] = state;
    }
    if (!isRecord(state.invoices)) state.invoices = {};
    return state;
  }

  private idempotencyKey(action: string, workspaceId: string, period: string, invoiceId = ""): string {
    return `billing:${action}:${workspaceId}:${period}:${invoiceId || "default"}`;
  }

  private secret(secretRef?: string): string {
    const reference = safeText(secretRef ?? this.secretRef, 200);
    if (!reference) throw new BillingError("A secret reference is required.");
    return this.secretManager.get(reference);
  }

  private retry<T>(operation: () => T): T {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try { return operation(); } catch (err) {
        lastError = err;
        if (err instanceof BillingTransientError && attempt < this.maxRetries) {
          sleepSync(this.retryDelaySeconds * 1000);
          continue;
        }
        throw err;
      }
    }
    throw (lastError instanceof Error ? lastError : new BillingError("Billing operation did not run."));
  }

  private disabledResult(workspaceId: string, action: string): any {
    const data = this.load();
    const state = this.workspaceState(data, workspaceId);
    state.last_status = "disabled";
    state.last_error = "";
    state.updated_at = now();
    this.save(data);
    return { schema_version: BILLING_SCHEMA_VERSION, status: "disabled", action, workspace_id: workspaceId, billing_enabled: false, kill_switch_active: this.killSwitchActive(), feature_flag: this.featureFlag.toDict(), message: "Billing is disabled by feature flag or kill switch." };
  }

  private degradedResult(workspaceId: string, action: string, err: unknown, idempotencyKey: string, invoice?: any): any {
    const msg = safeText(err instanceof Error ? err.message : String(err), 500);
    const type = err instanceof Error ? err.name : "Error";
    return { schema_version: BILLING_SCHEMA_VERSION, status: "degraded", action, workspace_id: workspaceId, billing_enabled: this.billingEnabled(workspaceId), error: { type, message: msg }, idempotency_key: idempotencyKey, invoice_id: invoice?.invoice_id, message: "Billing provider failed; run and quota state are preserved." };
  }

  status(workspaceId: string): any {
    const key = safeText(workspaceId);
    const data = fs.existsSync(this.statePath) ? this.load() : this.empty();
    const state = data.workspaces[key];
    return {
      schema_version: BILLING_SCHEMA_VERSION,
      status: "ok",
      workspace_id: key,
      billing_enabled: this.billingEnabled(key),
      kill_switch_active: this.killSwitchActive(),
      feature_flag: this.featureFlag.toDict(),
      customer_id: isRecord(state) ? state.customer_id ?? null : null,
      subscription_id: isRecord(state) ? state.subscription_id ?? null : null,
      plan_id: isRecord(state) ? state.plan_id ?? null : null,
      last_status: isRecord(state) ? (state.last_status ?? "not_started") : "not_started",
      last_error: isRecord(state) ? (state.last_error ?? "") : "",
      invoices: isRecord(state) ? (state.invoices ?? {}) : {},
    };
  }

  ensureCustomer(workspaceId: string, opts: { name?: string; secret_ref?: string; secretRef?: string } = {}): any {
    const key = safeText(workspaceId);
    if (!this.billingEnabled(key)) return this.disabledResult(key, "ensure_customer");
    const secret = this.secret(opts.secret_ref ?? opts.secretRef);
    const idempotencyKey = this.idempotencyKey("customer", key, "account", "");
    const data = this.load();
    const state = this.workspaceState(data, key);
    if (state.customer_id) { this.save(data); return { schema_version: BILLING_SCHEMA_VERSION, status: "existing", workspace_id: key, customer_id: state.customer_id, idempotency_key: idempotencyKey, billing_enabled: true }; }
    try {
      const providerResult = this.retry(() => (this.provider as any).createCustomer ? (this.provider as any).createCustomer({ workspace_id: key, name: opts.name || key, idempotency_key: idempotencyKey, secret }) : (this.provider as any).create_customer({ workspace_id: key, name: opts.name || key, idempotency_key: idempotencyKey, secret }));
      state.customer_id = providerResult.customer_id;
      state.last_status = "customer_ready";
      state.last_error = "";
      state.updated_at = now();
      this.save(data);
      return { schema_version: BILLING_SCHEMA_VERSION, status: "created", workspace_id: key, customer_id: state.customer_id, provider: providerResult, idempotency_key: idempotencyKey, billing_enabled: true };
    } catch (err) {
      const d = this.load();
      const s = this.workspaceState(d, key);
      s.last_status = "degraded";
      s.last_error = safeText(err instanceof Error ? err.message : String(err), 500);
      s.updated_at = now();
      this.save(d);
      return this.degradedResult(key, "ensure_customer", err, idempotencyKey);
    }
  }
  ensure_customer(workspaceId: string, opts: any = {}) { return this.ensureCustomer(workspaceId, opts); }

  ensureSubscription(workspaceId: string, opts: { plan_id?: string; planId?: string; secret_ref?: string; secretRef?: string } = {}): any {
    const key = safeText(workspaceId);
    const planId = safeText(opts.plan_id ?? opts.planId);
    if (!this.billingEnabled(key)) return this.disabledResult(key, "ensure_subscription");
    const secretRef = opts.secret_ref ?? opts.secretRef;
    const customer = this.ensureCustomer(key, { ...(secretRef ? { secret_ref: secretRef } : {}) });
    if (customer.status === "degraded") return customer;
    let customerId = customer.customer_id;
    if (!customerId) {
      const d = this.load();
      customerId = this.workspaceState(d, key).customer_id;
    }
    const idempotencyKey = this.idempotencyKey("subscription", key, planId, "");
    if (!customerId) return this.degradedResult(key, "ensure_subscription", new BillingError("No customer id is available."), idempotencyKey);
    const secret = this.secret(opts.secret_ref ?? opts.secretRef);
    const data = this.load();
    const state = this.workspaceState(data, key);
    if (state.subscription_id) { this.save(data); return { schema_version: BILLING_SCHEMA_VERSION, status: "existing", workspace_id: key, subscription_id: state.subscription_id, plan_id: state.plan_id, idempotency_key: idempotencyKey, billing_enabled: true }; }
    try {
      const providerResult = this.retry(() => (this.provider as any).ensureSubscription ? (this.provider as any).ensureSubscription({ workspace_id: key, customer_id: String(customerId), plan_id: planId, idempotency_key: idempotencyKey, secret }) : (this.provider as any).ensure_subscription({ workspace_id: key, customer_id: String(customerId), plan_id: planId, idempotency_key: idempotencyKey, secret }));
      state.subscription_id = providerResult.subscription_id;
      state.plan_id = planId;
      state.last_status = "subscription_ready";
      state.last_error = "";
      state.updated_at = now();
      this.save(data);
      return { schema_version: BILLING_SCHEMA_VERSION, status: "created", workspace_id: key, subscription_id: state.subscription_id, plan_id: state.plan_id, provider: providerResult, idempotency_key: idempotencyKey, billing_enabled: true };
    } catch (err) {
      const d = this.load();
      const s = this.workspaceState(d, key);
      s.last_status = "degraded";
      s.last_error = safeText(err instanceof Error ? err.message : String(err), 500);
      s.updated_at = now();
      this.save(d);
      return this.degradedResult(key, "ensure_subscription", err, idempotencyKey);
    }
  }
  ensure_subscription(workspaceId: string, opts: any = {}) { return this.ensureSubscription(workspaceId, opts); }

  syncInvoice(workspaceId: string, period: string, opts: { invoice_id?: string; invoiceId?: string; secret_ref?: string; secretRef?: string } = {}): any {
    const key = safeText(workspaceId);
    const periodKey = safeText(period);
    if (!key || !periodKey) throw new BillingError("Workspace and period are required.");
    if (!this.billingEnabled(key)) return this.disabledResult(key, "sync_invoice");
    const secret = this.secret(opts.secret_ref ?? opts.secretRef);
    const invoice = this.ledger.invoice(key, periodKey, { invoice_id: opts.invoice_id ?? opts.invoiceId });
    const idempotencyKey = this.idempotencyKey("invoice", key, periodKey, String(invoice.invoice_id ?? ""));
    const existingData = this.load();
    const existingState = this.workspaceState(existingData, key);
    const existing = existingState.invoices[idempotencyKey];
    if (isRecord(existing) && existing.status === "reconciled") {
      return { schema_version: BILLING_SCHEMA_VERSION, status: "already_reconciled", workspace_id: key, period: periodKey, invoice_id: invoice.invoice_id, billing: existing, billing_enabled: true };
    }
    try {
      const providerResult = this.retry(() => (this.provider as any).reconcileInvoice ? (this.provider as any).reconcileInvoice({ workspace_id: key, period: periodKey, invoice, idempotency_key: idempotencyKey, secret }) : (this.provider as any).reconcile_invoice({ workspace_id: key, period: periodKey, invoice, idempotency_key: idempotencyKey, secret }));
      const data = this.load();
      const state = this.workspaceState(data, key);
      state.invoices[idempotencyKey] = providerResult;
      state.last_status = "reconciled";
      state.last_error = "";
      state.updated_at = now();
      this.save(data);
      return { schema_version: BILLING_SCHEMA_VERSION, status: "reconciled", workspace_id: key, period: periodKey, invoice_id: invoice.invoice_id, ledger_total: invoice.total, billing: providerResult, idempotency_key: idempotencyKey, billing_enabled: true };
    } catch (err) {
      const data = this.load();
      const state = this.workspaceState(data, key);
      state.last_status = "degraded";
      state.last_error = safeText(err instanceof Error ? err.message : String(err), 500);
      state.updated_at = now();
      state.invoices[idempotencyKey] = { status: "degraded", error: safeText(err instanceof Error ? err.message : String(err), 500), invoice_id: invoice.invoice_id, idempotency_key: idempotencyKey };
      this.save(data);
      return this.degradedResult(key, "sync_invoice", err, idempotencyKey, invoice);
    }
  }
  sync_invoice(workspaceId: string, period: string, opts: any = {}) { return this.syncInvoice(workspaceId, period, opts); }
  reconcilePeriod(workspaceId: string, period: string, opts: any = {}) { return this.syncInvoice(workspaceId, period, opts); }
  reconcile_period(workspaceId: string, period: string, opts: any = {}) { return this.syncInvoice(workspaceId, period, opts); }
}
