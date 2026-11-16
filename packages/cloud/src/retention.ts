import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { now, parseTimestamp } from "@lemma/core";
import { AuthStore } from "./auth.js";
import { BillingStore } from "./billing.js";
import { JobQueue } from "./queue.js";
import { QuotaStore } from "./quota.js";
import { SignupStore } from "./signup.js";

export const RETENTION_SCHEMA_VERSION = "quality-harness.retention/v1" as const;
export const MANIFEST_SCHEMA_VERSION = "quality-harness.export-manifest/v1" as const;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_EXPORTS = path.join(".lemma", "exports");
export const DEFAULT_DELETION_AUDIT = path.join(".lemma", "cloud", "deletion-audit.jsonl");
export const DEFAULT_AUDIT = DEFAULT_DELETION_AUDIT;
export const DEFAULT_SIGNING_KEY = path.join(".lemma", "cloud", "retention-signing.key");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, limit = 500): string {
  return String(value ?? "").trim().slice(0, limit);
}

function safeWorkspace(value: unknown): string {
  const text = safeText(value, 128);
  if (!text || text.includes("/") || text.includes("\\") || text.includes("..")) {
    throw new Error(`Invalid workspace id: ${String(value)}`);
  }
  return text;
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

function formatTimestamp(value?: unknown): string {
  if (value === undefined || value === null) return parseTimestamp(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return parseTimestamp(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function loadOrCreateSigningKey(filePath: string): Buffer {
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath);
    if (data.length) return data;
  }
  const key = crypto.randomBytes(32);
  atomicWriteBytes(filePath, key);
  return key;
}

function rmrf(target: string): void {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  out.sort();
  return out;
}

// Minimal ZIP (store/deflate via node zlib not necessary; use stored is fine but manifest must match bytes in archive)
import { deflateRawSync } from "node:zlib";

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function writeZip(archivePath: string, files: Array<{ name: string; data: Buffer }>): void {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const useDeflate = compressed.length < file.data.length;
    const method = useDeflate ? 8 : 0;
    const compData = useDeflate ? compressed : file.data;
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compData);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compData.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compData.length;
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const b of centralParts) centralSize += b.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  const out = Buffer.concat([...localParts, ...centralParts, eocd]);
  atomicWriteBytes(archivePath, out);
}

function readZipEntries(archivePath: string): Map<string, Buffer> {
  // Use unzip via node: no built-in; but we can rely on `unzip`? not guaranteed.
  // Implement minimal ZIP reader for central directory entries we create.
  const buf = fs.readFileSync(archivePath);
  // find EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Invalid zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let ptr = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("Invalid central directory");
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    // read local header
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid local header");
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compData);
    else if (method === 8) data = Buffer.from(require("node:zlib").inflateRawSync(compData));
    else throw new Error(`Unsupported compression method ${method}`);
    if (data.length !== uncompSize) throw new Error("Size mismatch during unzip");
    entries.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export interface RetentionStoreOptions {
  signup?: SignupStore;
  queue?: JobQueue;
  billing?: BillingStore;
  auth?: AuthStore;
  quota?: QuotaStore;
  defaultRetentionDays?: number;
  default_retention_days?: number;
  gracePeriodDays?: number;
  grace_period_days?: number;
  signingKey?: Buffer;
  signing_key?: Buffer;
  signingKeyPath?: string;
  signing_key_path?: string;
  exportsRoot?: string;
  exports_root?: string;
  auditPath?: string;
  audit_path?: string;
}

export class RetentionStore {
  readonly root: string;
  readonly signup: SignupStore;
  readonly queue: JobQueue;
  readonly billing: BillingStore;
  readonly auth: AuthStore;
  readonly quota: QuotaStore | null;
  readonly defaultRetentionDays: number;
  readonly gracePeriodDays: number;
  readonly exportsRoot: string;
  readonly auditPath: string;
  readonly signingKeyPath: string;
  readonly signingKey: Buffer;

  constructor(root: string, opts: RetentionStoreOptions = {}) {
    this.root = path.resolve(root);
    this.signup = opts.signup ?? new SignupStore(this.root);
    this.queue = opts.queue ?? new JobQueue(this.root);
    this.billing = opts.billing ?? new BillingStore(this.root);
    this.auth = opts.auth ?? new AuthStore(this.root);
    this.quota = opts.quota ?? null;
    this.defaultRetentionDays = Number(opts.defaultRetentionDays ?? opts.default_retention_days ?? DEFAULT_RETENTION_DAYS);
    this.gracePeriodDays = Number(opts.gracePeriodDays ?? opts.grace_period_days ?? DEFAULT_GRACE_DAYS);
    this.exportsRoot = this.resolvePath(opts.exportsRoot ?? opts.exports_root ?? DEFAULT_EXPORTS);
    this.auditPath = this.resolvePath(opts.auditPath ?? opts.audit_path ?? DEFAULT_DELETION_AUDIT);
    this.signingKeyPath = this.resolvePath(opts.signingKeyPath ?? opts.signing_key_path ?? DEFAULT_SIGNING_KEY);
    const sk = opts.signingKey ?? opts.signing_key;
    this.signingKey = sk ? Buffer.from(sk) : loadOrCreateSigningKey(this.signingKeyPath);
  }

  private resolvePath(value: string): string {
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.root, value);
  }

  policy(workspaceId: string): Record<string, unknown> {
    const workspaceKey = safeWorkspace(workspaceId);
    const record = this.signup.getSignup(workspaceKey) as any;
    let retentionDays = this.defaultRetentionDays;
    let planId: string | null = null;
    let isDefault = true;
    if (isRecord(record)) {
      if (record.retention_days !== undefined && record.retention_days !== null) {
        retentionDays = Number(record.retention_days);
        isDefault = retentionDays === this.defaultRetentionDays && !(record as any).retention_days_set;
      }
      const plan = (record as any).plan;
      if (isRecord(plan)) {
        planId = plan.id != null ? String(plan.id) : null;
        if (plan.retention_days !== undefined && plan.retention_days !== null && record.retention_days === undefined) {
          retentionDays = Number(plan.retention_days);
        }
      }
      if ((record as any).retention_days !== undefined) isDefault = false;
    }
    return {
      schema_version: RETENTION_SCHEMA_VERSION,
      workspace_id: workspaceKey,
      retention_days: retentionDays,
      grace_period_days: this.gracePeriodDays,
      plan_id: planId,
      default: isDefault,
    };
  }

  setRetention(workspaceId: string, retentionDays: number): Record<string, unknown> {
    const workspaceKey = safeWorkspace(workspaceId);
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days < 1) throw new Error("retention_days must be positive");
    const data = (this.signup as any)._load() as any;
    let record = data.workspaces?.[workspaceKey];
    if (!isRecord(record)) {
      record = { workspace_id: workspaceKey, name: workspaceKey, created_at: formatTimestamp() };
    }
    record.retention_days = Math.trunc(days);
    record.retention_days_set = true;
    record.updated_at = formatTimestamp();
    data.workspaces[workspaceKey] = record;
    (this.signup as any)._save(data);
    return this.policy(workspaceKey);
  }

  set_retention(workspaceId: string, retentionDays: number) { return this.setRetention(workspaceId, retentionDays); }

  private fileEntry(filePath: string, relative: string): { path: string; sha256: string; size: number } {
    const st = fs.statSync(filePath);
    return { path: relative, sha256: sha256File(filePath), size: st.size };
  }

  export(workspaceId: string, opts: { now?: unknown } = {}): Record<string, unknown> {
    const workspaceKey = safeWorkspace(workspaceId);
    const nowText = formatTimestamp(opts.now);
    const exportId = `export-${crypto.randomBytes(6).toString("hex")}`;
    const exportDir = path.join(this.exportsRoot, workspaceKey);
    fs.mkdirSync(exportDir, { recursive: true });
    chmodSafe(exportDir, 0o700);
    const archivePath = path.join(exportDir, `${exportId}.zip`);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-export-"));

    try {
      const tenantRoot = this.queue.tenantRootFor(workspaceKey);
      const files: Array<{ name: string; data: Buffer }> = [];
      const included: Array<{ path: string; sha256: string; size: number }> = [];

      if (fs.existsSync(tenantRoot)) {
        for (const filePath of walkFiles(tenantRoot)) {
          const rel = path.relative(tenantRoot, filePath).split(path.sep).join("/");
          if (!rel || rel.startsWith("../") || rel.includes("/../") || path.isAbsolute(rel)) continue;
          const dest = path.join(staging, "tenant", rel);
          copyFile(filePath, dest);
          included.push(this.fileEntry(dest, `tenant/${rel}`));
        }
      }

      const centralDir = path.join(staging, "central");
      fs.mkdirSync(centralDir, { recursive: true });

      const queueJobs = this.queue.listJobs(workspaceKey);
      const queuePath = path.join(centralDir, "queue-jobs.json");
      fs.writeFileSync(queuePath, JSON.stringify(queueJobs, null, 2) + "\n", "utf8");
      included.push(this.fileEntry(queuePath, "central/queue-jobs.json"));

      const billingStatus = this.billing.status(workspaceKey);
      const billingPath = path.join(centralDir, "billing-status.json");
      fs.writeFileSync(billingPath, JSON.stringify(billingStatus, null, 2) + "\n", "utf8");
      included.push(this.fileEntry(billingPath, "central/billing-status.json"));

      const signupRecord = this.signup.getSignup(workspaceKey);
      if (signupRecord !== null && signupRecord !== undefined) {
        const signupPath = path.join(centralDir, "signup.json");
        fs.writeFileSync(signupPath, JSON.stringify(signupRecord, null, 2) + "\n", "utf8");
        included.push(this.fileEntry(signupPath, "central/signup.json"));
      }

      const retentionPolicy = this.policy(workspaceKey);
      const policyPath = path.join(centralDir, "retention-policy.json");
      fs.writeFileSync(policyPath, JSON.stringify(retentionPolicy, null, 2) + "\n", "utf8");
      included.push(this.fileEntry(policyPath, "central/retention-policy.json"));

      const manifestBase = {
        schema_version: MANIFEST_SCHEMA_VERSION,
        export_id: exportId,
        workspace_id: workspaceKey,
        created_at: nowText,
        retention: retentionPolicy,
        files: included.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
      };
      const signature = crypto.createHmac("sha256", this.signingKey).update(stableStringify(manifestBase), "utf8").digest("hex");
      const manifest = { ...manifestBase, signature };
      const manifestPath = path.join(staging, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

      for (const f of included) {
        const stagingPath = path.join(staging, f.path);
        files.push({ name: f.path, data: fs.readFileSync(stagingPath) });
      }
      files.push({ name: "manifest.json", data: fs.readFileSync(manifestPath) });
      files.sort((a, b) => a.name.localeCompare(b.name));
      writeZip(archivePath, files);
      chmodSafe(archivePath, 0o600);

      return {
        schema_version: RETENTION_SCHEMA_VERSION,
        status: "exported",
        workspace_id: workspaceKey,
        export_id: exportId,
        archive: archivePath,
        manifest_signature: signature,
        file_count: included.length,
      };
    } finally {
      rmrf(staging);
    }
  }

  verifyExport(archivePath: string): Record<string, unknown> {
    const p = path.resolve(String(archivePath).replace(/^~/, os.homedir()));
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`Export archive not found: ${p}`);
    }
    let entries: Map<string, Buffer>;
    try {
      entries = readZipEntries(p);
    } catch {
      return { valid: false, reason: "unreadable archive" };
    }
    const names = Array.from(entries.keys());
    for (const name of names) {
      if (name.startsWith("/") || name.startsWith("../") || name.split("/").includes("..")) {
        return { valid: false, reason: `unsafe archive path ${name}` };
      }
    }
    if (!entries.has("manifest.json")) return { valid: false, reason: "missing manifest" };
    let manifest: any;
    try { manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")); } catch { return { valid: false, reason: "invalid manifest" }; }
    if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) return { valid: false, reason: "bad manifest schema" };
    const signature = String(manifest.signature ?? "");
    const base = { ...manifest }; delete base.signature;
    const expected = crypto.createHmac("sha256", this.signingKey).update(stableStringify(base), "utf8").digest("hex");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: "invalid signature" };
    }
    for (const entry of manifest.files ?? []) {
      const rel = String(entry.path ?? "");
      if (!entries.has(rel)) return { valid: false, reason: `missing file ${rel}` };
      if (rel.startsWith("/") || rel.startsWith("../") || rel.split("/").includes("..")) {
        return { valid: false, reason: `unsafe path ${rel}` };
      }
      const data = entries.get(rel)!;
      if (crypto.createHash("sha256").update(data).digest("hex") !== String(entry.sha256)) {
        return { valid: false, reason: `hash mismatch ${rel}` };
      }
      if (data.length !== Number(entry.size)) {
        return { valid: false, reason: `size mismatch ${rel}` };
      }
    }
    return {
      valid: true,
      reason: "ok",
      workspace_id: String(manifest.workspace_id ?? ""),
      file_count: Array.isArray(manifest.files) ? manifest.files.length : 0,
    };
  }
  verify_export(archivePath: string) { return this.verifyExport(archivePath); }

  softDelete(workspaceId: string, opts: { graceDays?: number; grace_days?: number; actor?: string; now?: unknown } = {}): Record<string, unknown> {
    const workspaceKey = safeWorkspace(workspaceId);
    const grace = Number(opts.graceDays ?? opts.grace_days ?? this.gracePeriodDays);
    if (grace < 0) throw new Error("grace_days cannot be negative");
    const nowText = formatTimestamp(opts.now);
    const hardAfter = new Date(parseTimestamp(nowText).getTime() + grace * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const data = (this.signup as any)._load() as any;
    let record = data.workspaces?.[workspaceKey];
    if (!isRecord(record)) {
      record = { workspace_id: workspaceKey, name: workspaceKey, created_at: formatTimestamp() };
    }
    if ((record as any).deleted_at) {
      return {
        schema_version: RETENTION_SCHEMA_VERSION,
        status: "already_soft_deleted",
        workspace_id: workspaceKey,
        deleted_at: (record as any).deleted_at,
        hard_delete_after: (record as any).hard_delete_after,
      };
    }
    record.deleted_at = nowText;
    record.hard_delete_after = hardAfter;
    record.deleted_by = safeText(opts.actor ?? "operator", 120);
    record.updated_at = nowText;
    data.workspaces[workspaceKey] = record;
    (this.signup as any)._save(data);
    this.audit("soft_deleted", workspaceKey, { actor: safeText(opts.actor ?? "operator", 120), deleted_at: nowText, hard_delete_after: hardAfter });
    return {
      schema_version: RETENTION_SCHEMA_VERSION,
      status: "soft_deleted",
      workspace_id: workspaceKey,
      deleted_at: nowText,
      hard_delete_after: hardAfter,
      grace_days: grace,
    };
  }
  soft_delete(workspaceId: string, opts: any = {}) { return this.softDelete(workspaceId, opts); }

  hardDelete(workspaceId: string, opts: { force?: boolean; actor?: string; now?: unknown } = {}): Record<string, unknown> {
    const workspaceKey = safeWorkspace(workspaceId);
    const nowText = formatTimestamp(opts.now);
    const data = (this.signup as any)._load() as any;
    const record = isRecord(data.workspaces?.[workspaceKey]) ? data.workspaces[workspaceKey] : { workspace_id: workspaceKey };
    const hardAfter = (record as any).hard_delete_after;
    if (!opts.force && hardAfter) {
      if (parseTimestamp(nowText).getTime() < parseTimestamp(hardAfter).getTime()) {
        throw new Error(`Workspace ${workspaceKey} is in its deletion grace period until ${hardAfter}.`);
      }
    }

    const removed: Record<string, unknown> = {
      tenant_root: false,
      queue_jobs: 0,
      billing_state: false,
      quota_state: false,
      cached_exports: 0,
      signup_state: false,
      auth_state: false,
    };

    const tenantRoot = this.queue.tenantRootFor(workspaceKey);
    if (fs.existsSync(tenantRoot)) {
      rmrf(tenantRoot);
      removed.tenant_root = true;
    }

    const exportsDir = path.join(this.exportsRoot, workspaceKey);
    if (fs.existsSync(exportsDir)) {
      const count = fs.readdirSync(exportsDir).filter((n) => n.endsWith(".zip")).length;
      removed.cached_exports = count;
      rmrf(exportsDir);
    }

    removed.queue_jobs = this.queue.deleteWorkspaceJobs(workspaceKey);
    removed.billing_state = Boolean(this.billing.deleteWorkspace(workspaceKey));

    // quota cleanup
    const quotaStorePath = path.join(this.root, ".lemma", "quota", "usage.json");
    if (fs.existsSync(quotaStorePath)) {
      try {
        const q = JSON.parse(fs.readFileSync(quotaStorePath, "utf8"));
        if (isRecord(q) && isRecord(q.workspaces) && workspaceKey in q.workspaces) {
          delete q.workspaces[workspaceKey];
          atomicWrite(quotaStorePath, JSON.stringify(q, null, 2) + "\n");
          removed.quota_state = true;
        }
      } catch { /* ignore */ }
    }

    if (isRecord(data.workspaces) && workspaceKey in data.workspaces) {
      delete data.workspaces[workspaceKey];
      (this.signup as any)._save(data);
      removed.signup_state = true;
    }

    try {
      removed.auth_state = Boolean((this.auth as any).deleteWorkspace?.(workspaceKey));
    } catch { removed.auth_state = false; }

    this.audit("hard_deleted", workspaceKey, { actor: safeText(opts.actor ?? "operator", 120), deleted_at: nowText, removed });
    return {
      schema_version: RETENTION_SCHEMA_VERSION,
      status: "deleted",
      workspace_id: workspaceKey,
      deleted_at: nowText,
      removed,
    };
  }
  hard_delete(workspaceId: string, opts: any = {}) { return this.hardDelete(workspaceId, opts); }
  delete(workspaceId: string, opts: any = {}) { return this.hardDelete(workspaceId, opts); }

  audit(event: string, workspaceId: string, fields: Record<string, unknown> = {}): void {
    const dir = path.dirname(this.auditPath);
    fs.mkdirSync(dir, { recursive: true });
    chmodSafe(dir, 0o700);
    const record = {
      schema_version: RETENTION_SCHEMA_VERSION,
      event,
      workspace_id: workspaceId,
      timestamp: formatTimestamp(),
      ...fields,
    };
    fs.appendFileSync(this.auditPath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    chmodSafe(this.auditPath, 0o600);
  }

  auditLog(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.auditPath)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const line of fs.readFileSync(this.auditPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { const parsed = JSON.parse(t); if (isRecord(parsed)) out.push(parsed); } catch { /* ignore */ }
    }
    return out;
  }
  audit_log() { return this.auditLog(); }
}

export const TenantRetentionStore = RetentionStore;
export const TenantExporter = RetentionStore;
export const TenantDeletion = RetentionStore;
export const RetentionManager = RetentionStore;
