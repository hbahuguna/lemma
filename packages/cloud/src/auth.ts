import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { newId, now, parseTimestamp } from "@lemma/core";

export const AUTH_SCHEMA = "quality-harness.auth/v1" as const;
export const AUDIT_SCHEMA = "quality-harness.auth.audit/v1" as const;
export const DEFAULT_STORE = path.join(".lemma", "cloud", "auth.json");
export const DEFAULT_AUDIT = path.join(".lemma", "cloud", "auth-audit.jsonl");

export const SCOPE_RUN = "run" as const;
export const SCOPE_READ = "read" as const;
export const SCOPE_EXPORT = "export" as const;
export const SCOPE_ADMIN = "admin" as const;
export const SCOPES = [SCOPE_RUN, SCOPE_READ, SCOPE_EXPORT, SCOPE_ADMIN] as const;
export type AuthScope = (typeof SCOPES)[number];

export const KEY_PREFIX = "qh_";

const _UNSET = Symbol("UNSET");

export interface AuthErrorBody {
  status: number;
  status_code: number;
  error: {
    code: string;
    message: string;
    required_scope?: string;
  };
}

export class AuthError extends Error {
  readonly statusCode: number;
  readonly status: number;
  readonly code: string;
  readonly requiredScope: string;

  constructor(statusCode: number, code: string, message: string, options?: { requiredScope?: string }) {
    super(message);
    this.name = "AuthError";
    this.statusCode = Number(statusCode);
    this.status = this.statusCode;
    this.code = String(code);
    this.requiredScope = String(options?.requiredScope ?? "");
  }

  get headers(): Record<string, string> {
    if (this.statusCode === 401) {
      return { "WWW-Authenticate": 'Bearer realm="quality-harness"' };
    }
    return {};
  }

  toDict(): AuthErrorBody {
    const error: AuthErrorBody["error"] = {
      code: this.code,
      message: String(this.message),
    };
    if (this.requiredScope) {
      error.required_scope = this.requiredScope;
    }
    return {
      status: this.statusCode,
      status_code: this.statusCode,
      error,
    };
  }

  response(): AuthErrorBody {
    return this.toDict();
  }

  to_dict(): AuthErrorBody {
    return this.toDict();
  }
}

export interface AuthContextData {
  workspace_id: string;
  key_id: string;
  prefix: string;
  scopes: string[];
  authenticated_at: string;
}

export class AuthContext {
  readonly workspaceId: string;
  readonly keyId: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly authenticatedAt: string;

  constructor(data: {
    workspaceId: string;
    keyId: string;
    prefix: string;
    scopes: readonly string[];
    authenticatedAt: string;
  }) {
    this.workspaceId = data.workspaceId;
    this.keyId = data.keyId;
    this.prefix = data.prefix;
    this.scopes = [...data.scopes];
    this.authenticatedAt = data.authenticatedAt;
  }

  get workspace_id(): string { return this.workspaceId; }
  get key_id(): string { return this.keyId; }
  get authenticated_at(): string { return this.authenticatedAt; }

  hasScope(scope: string): boolean {
    return this.scopes.includes(SCOPE_ADMIN) || this.scopes.includes(scope);
  }

  require(scope: string): void {
    if (!this.hasScope(scope)) {
      throw new AuthError(403, "insufficient_scope", `The API key does not grant the required scope: ${scope}.`, {
        requiredScope: scope,
      });
    }
  }

  requireWorkspace(workspaceId: string): void {
    if (!workspaceId || String(workspaceId) !== this.workspaceId) {
      throw new AuthError(404, "workspace_not_found", "Workspace not found.");
    }
  }

  toDict(): AuthContextData {
    return {
      workspace_id: this.workspaceId,
      key_id: this.keyId,
      prefix: this.prefix,
      scopes: [...this.scopes],
      authenticated_at: this.authenticatedAt,
    };
  }

  to_dict(): AuthContextData {
    return this.toDict();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeScopes(scopes: string | Iterable<string> | null | undefined): string[] {
  if (scopes === null || scopes === undefined) {
    throw new Error("At least one scope is required.");
  }
  let values: string[];
  if (typeof scopes === "string") {
    values = scopes.split(",").map((s) => s.trim());
  } else {
    values = Array.from(scopes, (s) => String(s).trim());
  }
  values = values.filter(Boolean);
  if (values.length === 0) {
    throw new Error("At least one scope is required.");
  }
  const allowed = new Set<string>(SCOPES);
  const unknown = [...new Set(values.filter((v) => !allowed.has(v)))].sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown scope(s): ${unknown.join(", ")}. Allowed scopes: ${SCOPES.join(", ")}.`);
  }
  return SCOPES.filter((scope) => values.includes(scope));
}

export function normalizeExpiry(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const d = parseTimestamp(value);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch (err) {
    throw new Error(`expires_at must be an ISO-8601 timestamp: ${String(err)}`);
  }
}

function hashToken(token: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}:${token}`, "utf8").digest("hex");
}

function parsePrefix(token: string): string {
  if (!token.startsWith(KEY_PREFIX) || !token.includes(".")) {
    throw new AuthError(401, "malformed_api_key", "The API key is malformed.");
  }
  const [prefix] = token.split(".", 1);
  if (!prefix || !prefix.startsWith(KEY_PREFIX) || prefix.length <= KEY_PREFIX.length) {
    throw new AuthError(401, "malformed_api_key", "The API key is malformed.");
  }
  return prefix;
}

function atomicWrite(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
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
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function auditAppend(auditPath: string, record: Record<string, unknown>): void {
  const dir = path.dirname(auditPath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  const line = JSON.stringify(record) + "\n";
  let fd: number | undefined;
  try {
    fd = fs.openSync(auditPath, "a", 0o600);
    fs.writeSync(fd, line, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  try { fs.chmodSync(auditPath, 0o600); } catch { /* ignore */ }
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface KeyRecord {
  id: string;
  workspace_id: string;
  prefix: string;
  salt: string;
  hash_algorithm: string;
  key_hash: string;
  scopes: string[];
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string;
  rotated_from: string | null;
  [key: string]: unknown;
}

export interface RunClaimRecord {
  run_id: string;
  workspace_id: string;
  claimed_at: string;
  [key: string]: unknown;
}

interface AuthStoreData {
  schema_version: string;
  workspaces: Record<string, WorkspaceRecord>;
  keys: Record<string, KeyRecord>;
  runs: Record<string, RunClaimRecord>;
}

export interface PublicWorkspace {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface PublicKey {
  id: string;
  workspace_id: string;
  prefix: string;
  scopes: string[];
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string;
  rotated_from: string | null;
}

export interface IssuedKey extends PublicKey {
  secret: string;
}

export class AuthStore {
  readonly root: string;
  readonly storePath: string;
  readonly auditPath: string;

  constructor(
    root: string | { toString(): string },
    storePath?: string | { toString(): string },
    auditPath?: string | { toString(): string },
  ) {
    this.root = path.resolve(String(root));
    this.storePath = this.resolvePath(storePath ?? DEFAULT_STORE);
    this.auditPath = this.resolvePath(auditPath ?? DEFAULT_AUDIT);
  }

  private resolvePath(value: string | { toString(): string }): string {
    const p = path.resolve(this.root, String(value));
    if (path.isAbsolute(String(value))) return path.resolve(String(value));
    return p;
  }

  private empty(): AuthStoreData {
    return { schema_version: AUTH_SCHEMA, workspaces: {}, keys: {}, runs: {} };
  }

  private load(): AuthStoreData {
    if (!fs.existsSync(this.storePath)) return this.empty();
    let raw: string;
    try {
      raw = fs.readFileSync(this.storePath, "utf8");
    } catch (err) {
      throw new AuthError(500, "auth_store_unreadable", "The authentication store is unreadable.");
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new AuthError(500, "auth_store_unreadable", "The authentication store is unreadable.");
    }
    if (!isRecord(data)) {
      throw new AuthError(500, "auth_store_invalid", "The authentication store is invalid.");
    }
    if (data.schema_version !== AUTH_SCHEMA) {
      throw new AuthError(500, "auth_store_version", "Unsupported authentication store schema version.");
    }
    for (const field of ["workspaces", "keys", "runs"] as const) {
      if (!isRecord(data[field])) (data as any)[field] = {};
    }
    return data as unknown as AuthStoreData;
  }

  private save(data: AuthStoreData): void {
    const payload = JSON.stringify(data, null, 2) + "\n";
    atomicWrite(this.storePath, payload);
  }

  private audit(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const record: Record<string, unknown> = {
      schema_version: AUDIT_SCHEMA,
      event,
      timestamp: now(),
      ...fields,
    };
    auditAppend(this.auditPath, record);
    return record;
  }

  loadAudit(): Record<string, unknown>[] {
    if (!fs.existsSync(this.auditPath)) return [];
    const records: Record<string, unknown>[] = [];
    const text = fs.readFileSync(this.auditPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as unknown;
        if (isRecord(rec)) records.push(rec);
      } catch {
        // ignore
      }
    }
    return records;
  }

  private static publicWorkspace(record: WorkspaceRecord): PublicWorkspace {
    return {
      id: String(record.id ?? ""),
      name: String(record.name ?? ""),
      status: String(record.status ?? "active"),
      created_at: String(record.created_at ?? ""),
    };
  }

  private static publicKey(record: KeyRecord): PublicKey {
    return {
      id: String(record.id ?? ""),
      workspace_id: String(record.workspace_id ?? ""),
      prefix: String(record.prefix ?? ""),
      scopes: Array.isArray(record.scopes) ? [...record.scopes] : [],
      label: String(record.label ?? ""),
      created_at: String(record.created_at ?? ""),
      expires_at: (record.expires_at as string | null) ?? null,
      revoked_at: (record.revoked_at as string | null) ?? null,
      revoked_reason: String(record.revoked_reason ?? ""),
      rotated_from: (record.rotated_from as string | null) ?? null,
    };
  }

  private workspaceRecord(data: AuthStoreData, workspaceId: string): WorkspaceRecord {
    const ws = data.workspaces[String(workspaceId ?? "")];
    if (!ws || !isRecord(ws)) {
      throw new AuthError(404, "workspace_not_found", "Workspace not found.");
    }
    return ws;
  }

  private keyRecord(data: AuthStoreData, keyIdOrPrefix: string): KeyRecord {
    const value = String(keyIdOrPrefix ?? "").trim();
    if (!value) throw new AuthError(404, "key_not_found", "API key not found.");
    const direct = data.keys[value];
    if (direct && isRecord(direct)) return direct;
    for (const candidate of Object.values(data.keys)) {
      if (candidate && isRecord(candidate) && candidate.id === value) return candidate;
    }
    throw new AuthError(404, "key_not_found", "API key not found.");
  }

  createWorkspace(name = "", workspaceId?: string | null): PublicWorkspace {
    const data = this.load();
    const identifier = String(workspaceId ?? newId("ws")).trim();
    if (!identifier) throw new Error("A workspace id is required.");
    if (data.workspaces[identifier]) {
      throw new AuthError(409, "workspace_exists", "Workspace already exists.");
    }
    const record: WorkspaceRecord = {
      id: identifier,
      name: String(name || identifier),
      status: "active",
      created_at: now(),
    };
    data.workspaces[identifier] = record;
    this.save(data);
    this.audit("workspace_created", { workspace_id: identifier, name: record.name });
    return AuthStore.publicWorkspace(record);
  }

  getWorkspace(workspaceId: string): PublicWorkspace {
    return AuthStore.publicWorkspace(this.workspaceRecord(this.load(), workspaceId));
  }

  deleteWorkspace(workspaceId: string): boolean {
    const data = this.load();
    const identifier = String(workspaceId ?? "").trim();
    if (!data.workspaces[identifier]) return false;
    delete data.workspaces[identifier];
    data.keys = Object.fromEntries(
      Object.entries(data.keys).filter(([, rec]) => String(rec.workspace_id ?? "") !== identifier),
    );
    data.runs = Object.fromEntries(
      Object.entries(data.runs).filter(([, owner]) => String(owner.workspace_id ?? owner) !== identifier),
    ) as Record<string, RunClaimRecord>;
    this.save(data);
    this.audit("workspace_deleted", { workspace_id: identifier });
    return true;
  }

  listWorkspaces(): PublicWorkspace[] {
    const data = this.load();
    return Object.values(data.workspaces)
      .filter(isRecord)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((r) => AuthStore.publicWorkspace(r as WorkspaceRecord));
  }

  resolveWorkspace(principal: AuthContext | string, requestedWorkspaceId = ""): string {
    let workspaceId: string;
    if (principal instanceof AuthContext) {
      workspaceId = principal.workspaceId;
      if (requestedWorkspaceId) principal.requireWorkspace(requestedWorkspaceId);
    } else {
      workspaceId = String(principal ?? "").trim();
      if (!workspaceId) throw new AuthError(401, "missing_workspace", "A workspace is required.");
      if (requestedWorkspaceId && String(requestedWorkspaceId) !== workspaceId) {
        throw new AuthError(404, "workspace_not_found", "Workspace not found.");
      }
    }
    const workspace = this.workspaceRecord(this.load(), workspaceId);
    if (workspace.status !== "active") {
      throw new AuthError(403, "workspace_inactive", "The workspace is not active.");
    }
    return workspaceId;
  }

  private newPrefix(data: AuthStoreData): string {
    while (true) {
      const prefix = `${KEY_PREFIX}${crypto.randomBytes(6).toString("hex")}`;
      if (!data.keys[prefix]) return prefix;
    }
  }

  private makeKeyRecord(
    data: AuthStoreData,
    workspaceId: string,
    scopes: string | Iterable<string> | null | undefined,
    label = "",
    expiresAt: unknown = null,
    rotatedFrom: string | null = null,
  ): { record: KeyRecord; secret: string } {
    const normalizedScopes = normalizeScopes(scopes);
    const expiry = normalizeExpiry(expiresAt);
    const prefix = this.newPrefix(data);
    const salt = crypto.randomBytes(16).toString("hex");
    const secret = `${prefix}.${crypto.randomBytes(32).toString("base64url")}`;
    const keyId = newId("key");
    const record: KeyRecord = {
      id: keyId,
      workspace_id: String(workspaceId),
      prefix,
      salt,
      hash_algorithm: "sha256",
      key_hash: hashToken(secret, salt),
      scopes: normalizedScopes,
      label: String(label || ""),
      created_at: now(),
      expires_at: expiry,
      revoked_at: null,
      revoked_reason: "",
      rotated_from: rotatedFrom,
    };
    data.keys[prefix] = record;
    return { record, secret };
  }

  private auditCreated(record: KeyRecord): void {
    this.audit("api_key_created", {
      workspace_id: record.workspace_id,
      key_id: record.id,
      prefix: record.prefix,
      scopes: [...record.scopes],
      label: record.label,
      expires_at: record.expires_at,
      rotated_from: record.rotated_from,
    });
  }

  createKey(
    workspaceId: string,
    scopes: string | Iterable<string> | null | undefined = [SCOPE_RUN],
    label = "",
    expiresAt: unknown = null,
    rotatedFrom: string | null = null,
  ): IssuedKey {
    const data = this.load();
    this.workspaceRecord(data, workspaceId);
    const { record, secret } = this.makeKeyRecord(data, workspaceId, scopes, label, expiresAt, rotatedFrom);
    this.save(data);
    this.auditCreated(record);
    return { ...AuthStore.publicKey(record), secret };
  }

  listKeys(workspaceId?: string | null): PublicKey[] {
    const data = this.load();
    if (workspaceId !== undefined && workspaceId !== null) {
      this.workspaceRecord(data, String(workspaceId));
    }
    const records = Object.values(data.keys)
      .filter(isRecord)
      .filter((r) => workspaceId === undefined || workspaceId === null || r.workspace_id === workspaceId)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((r) => AuthStore.publicKey(r as KeyRecord));
    return records;
  }

  revokeKey(keyIdOrPrefix: string, reason = ""): PublicKey {
    const data = this.load();
    const record = this.keyRecord(data, keyIdOrPrefix);
    if (!record.revoked_at) {
      record.revoked_at = now();
      record.revoked_reason = String(reason || "");
      this.save(data);
      this.audit("api_key_revoked", {
        workspace_id: record.workspace_id,
        key_id: record.id,
        prefix: record.prefix,
        reason: record.revoked_reason,
      });
    }
    return AuthStore.publicKey(record);
  }

  rotateKey(
    keyIdOrPrefix: string,
    scopes?: string | Iterable<string> | null,
    label: string | typeof _UNSET = _UNSET,
    expiresAt: unknown = _UNSET,
  ): IssuedKey {
    const data = this.load();
    const old = this.keyRecord(data, keyIdOrPrefix);
    if (old.revoked_at) {
      throw new AuthError(409, "key_revoked", "The API key is already revoked.");
    }
    const workspaceId = String(old.workspace_id);
    const newScopes = scopes === undefined || scopes === null ? old.scopes : scopes;
    const newLabel = label === _UNSET ? old.label : (label as string);
    const newExpiry = expiresAt === _UNSET ? old.expires_at : expiresAt;
    const { record, secret } = this.makeKeyRecord(data, workspaceId, newScopes, String(newLabel ?? ""), newExpiry, String(old.id));
    old.revoked_at = now();
    old.revoked_reason = "rotated";
    this.save(data);
    this.auditCreated(record);
    this.audit("api_key_revoked", {
      workspace_id: workspaceId,
      key_id: old.id,
      prefix: old.prefix,
      reason: old.revoked_reason,
    });
    this.audit("api_key_rotated", {
      workspace_id: workspaceId,
      old_key_id: old.id,
      old_prefix: old.prefix,
      new_key_id: record.id,
      new_prefix: record.prefix,
    });
    return { ...AuthStore.publicKey(record), secret };
  }

  authenticate(token: string | null | undefined, requiredScope?: string | null): AuthContext {
    const t = String(token ?? "").trim();
    if (!t) {
      throw new AuthError(401, "missing_api_key", "An API key is required.");
    }
    const prefix = parsePrefix(t);
    const data = this.load();
    const record = data.keys[prefix];
    if (!record || !isRecord(record)) {
      throw new AuthError(401, "invalid_api_key", "The API key is invalid.");
    }
    const expected = String(record.key_hash ?? "");
    const actual = hashToken(t, String(record.salt ?? ""));
    if (!expected || expected.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
      throw new AuthError(401, "invalid_api_key", "The API key is invalid.");
    }
    if (record.revoked_at) {
      throw new AuthError(401, "revoked_api_key", "The API key has been revoked.");
    }
    const expiresAt = record.expires_at;
    if (expiresAt) {
      let expired = false;
      try {
        expired = parseTimestamp(expiresAt).getTime() <= parseTimestamp(now()).getTime();
      } catch {
        expired = true;
      }
      if (expired) {
        throw new AuthError(401, "expired_api_key", "The API key has expired.");
      }
    }
    const workspace = data.workspaces[String(record.workspace_id ?? "")];
    if (!workspace || !isRecord(workspace)) {
      throw new AuthError(401, "invalid_api_key", "The API key is invalid.");
    }
    if (workspace.status !== "active") {
      throw new AuthError(403, "workspace_inactive", "The workspace is not active.");
    }
    const context = new AuthContext({
      workspaceId: String(workspace.id ?? ""),
      keyId: String(record.id ?? ""),
      prefix: String(record.prefix ?? ""),
      scopes: Array.isArray(record.scopes) ? (record.scopes as string[]) : [],
      authenticatedAt: now(),
    });
    if (requiredScope) context.require(requiredScope);
    return context;
  }

  claimRun(workspaceId: string, runId: string): RunClaimRecord {
    const data = this.load();
    this.workspaceRecord(data, workspaceId);
    const identifier = String(runId ?? "").trim();
    if (!identifier) throw new Error("A run id is required.");
    const existing = data.runs[identifier];
    if (existing && isRecord(existing)) {
      if (String(existing.workspace_id) !== String(workspaceId)) {
        throw new AuthError(409, "run_already_claimed", "This run id is already claimed.");
      }
      return { ...(existing as RunClaimRecord) };
    }
    const record: RunClaimRecord = {
      run_id: identifier,
      workspace_id: String(workspaceId),
      claimed_at: now(),
    };
    data.runs[identifier] = record;
    this.save(data);
    this.audit("run_claimed", { workspace_id: String(workspaceId), run_id: identifier });
    return { ...record };
  }

  authorizeRun(
    principal: AuthContext | string,
    runId: string,
    requiredScope: string | null = SCOPE_READ,
  ): RunClaimRecord {
    let workspaceId: string;
    if (principal instanceof AuthContext) {
      workspaceId = principal.workspaceId;
      if (requiredScope) principal.require(requiredScope);
    } else {
      workspaceId = String(principal ?? "").trim();
      if (!workspaceId) throw new AuthError(401, "missing_workspace", "A workspace is required.");
    }
    const data = this.load();
    const record = data.runs[String(runId ?? "").trim()];
    if (!record || !isRecord(record) || String(record.workspace_id) !== workspaceId) {
      throw new AuthError(404, "run_not_found", "Run not found.");
    }
    return { ...(record as RunClaimRecord) };
  }

  workspaceForRun(runId: string): string | null {
    const record = this.load().runs[String(runId ?? "").trim()];
    if (!record || !isRecord(record)) return null;
    const ws = String(record.workspace_id ?? "");
    return ws || null;
  }

  // aliases
  create_api_key = this.createKey.bind(this);
  issue_key = this.createKey.bind(this);
  list_api_keys = this.listKeys.bind(this);
  revoke_api_key = this.revokeKey.bind(this);
  rotate_api_key = this.rotateKey.bind(this);
  authenticate_token = this.authenticate.bind(this);
  register_run = this.claimRun.bind(this);
  authorize_workspace = this.resolveWorkspace.bind(this);
}

export { _UNSET as AUTH_UNSET };
