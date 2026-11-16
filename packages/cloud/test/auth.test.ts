import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_SCHEMA,
  AUTH_SCHEMA,
  AuthContext,
  AuthError,
  AuthStore,
  DEFAULT_AUDIT,
  DEFAULT_STORE,
  SCOPE_ADMIN,
  SCOPE_EXPORT,
  SCOPE_READ,
  SCOPE_RUN,
  SCOPES,
  normalizeScopes,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function expectNoWorkspaceData(payload: unknown, ...ids: string[]) {
  const text = JSON.stringify(payload);
  for (const id of ids) expect(text).not.toContain(id);
  expect(text).not.toContain('"workspace_id"');
}

describe("LEM-114 workspace auth, hashed scoped keys, and audit", () => {
  it("exports scopes/defaults and validates scope normalization", () => {
    expect(SCOPES).toEqual(["run", "read", "export", "admin"]);
    expect(DEFAULT_STORE).toBe(path.join(".lemma", "cloud", "auth.json"));
    expect(DEFAULT_AUDIT).toBe(path.join(".lemma", "cloud", "auth-audit.jsonl"));
    expect(normalizeScopes("read,run")).toEqual(["run", "read"]);
    expect(() => normalizeScopes("run,unknown")).toThrow(/Unknown scope/);
    expect(() => normalizeScopes([])).toThrow(/At least one scope/);
  });

  it("returns key secret once and persists only hash/salt metadata (never secret)", async () => {
    const root = await makeTempDir();
    const store = new AuthStore(root);
    const ws = store.createWorkspace("Acme", "ws_acme");
    const issued = store.createKey(ws.id, [SCOPE_RUN, SCOPE_READ], "ci");

    expect(issued.secret.startsWith(issued.prefix + ".")).toBe(true);
    expect(store.listKeys(ws.id)[0]!).not.toHaveProperty("secret");

    const rawStore = fs.readFileSync(store.storePath, "utf8");
    const rawAudit = fs.readFileSync(store.auditPath, "utf8");
    expect(rawStore).not.toContain(issued.secret);
    expect(rawAudit).not.toContain(issued.secret);
    const stored = JSON.parse(rawStore);
    expect(stored.schema_version).toBe(AUTH_SCHEMA);
    const keyRec = stored.keys[issued.prefix];
    expect(keyRec.hash_algorithm).toBe("sha256");
    expect(keyRec.key_hash).toBeTruthy();
    expect(keyRec.salt).toBeTruthy();
    expect(keyRec).not.toHaveProperty("secret");

    const created = store.loadAudit().filter((e) => e.event === "api_key_created");
    expect(created).toHaveLength(1);
    expect(created[0]!.schema_version).toBe(AUDIT_SCHEMA);
    expect(created[0]!).not.toHaveProperty("secret");
    expect(created[0]!).not.toHaveProperty("key_hash");

    const restarted = new AuthStore(root);
    const ctx = restarted.authenticate(issued.secret, SCOPE_RUN);
    expect(ctx.workspace_id).toBe("ws_acme");
    expect(restarted.storePath).toBe(store.storePath);
    expect(fs.readFileSync(restarted.storePath, "utf8")).not.toContain(issued.secret);
  });

  it("returns distinct typed failures without leaking workspace identifiers", async () => {
    const root = await makeTempDir();
    const store = new AuthStore(root);
    const ws = store.createWorkspace("Acme", "ws_private");
    const active = store.createKey(ws.id, [SCOPE_RUN]);
    const expired = store.createKey(ws.id, [SCOPE_RUN], "", "2000-01-01T00:00:00Z");
    const revoked = store.createKey(ws.id, [SCOPE_RUN]);
    store.revokeKey(revoked.id, "test");

    const cases: Array<{ name: string; fn: () => unknown; status: number; code: string }> = [
      { name: "missing", fn: () => store.authenticate(""), status: 401, code: "missing_api_key" },
      { name: "expired", fn: () => store.authenticate(expired.secret), status: 401, code: "expired_api_key" },
      { name: "revoked", fn: () => store.authenticate(revoked.secret), status: 401, code: "revoked_api_key" },
      { name: "scope", fn: () => store.authenticate(active.secret, SCOPE_EXPORT), status: 403, code: "insufficient_scope" },
      { name: "malformed", fn: () => store.authenticate("not-a-quality-harness-key"), status: 401, code: "malformed_api_key" },
      { name: "invalid", fn: () => store.authenticate("qh_000000000000.not-the-right-secret"), status: 401, code: "invalid_api_key" },
    ];

    for (const c of cases) {
      try {
        c.fn();
        throw new Error(`${c.name} should throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        const ae = err as AuthError;
        expect(ae.statusCode).toBe(c.status);
        expect(ae.code).toBe(c.code);
        expectNoWorkspaceData(ae.toDict(), ws.id);
        if (c.status === 401) expect(ae.headers["WWW-Authenticate"]).toBeTruthy();
      }
    }

    const ctx = store.authenticate(active.secret);
    try {
      ctx.require(SCOPE_EXPORT);
      throw new Error("should throw");
    } catch (err) {
      const ae = err as AuthError;
      expect(ae.statusCode).toBe(403);
      expectNoWorkspaceData(ae.toDict(), ws.id);
    }
  });

  it("enforces opaque cross-workspace/run authorization and claim conflicts", async () => {
    const root = await makeTempDir();
    const store = new AuthStore(root);
    const first = store.createWorkspace("First", "ws_first");
    const second = store.createWorkspace("Second", "ws_second");
    const firstCtx = store.authenticate(store.createKey(first.id, [SCOPE_READ]).secret);
    const secondCtx = store.authenticate(store.createKey(second.id, [SCOPE_READ]).secret);

    store.claimRun(first.id, "run-first");
    store.claimRun(second.id, "run-second");
    expect(store.authorizeRun(firstCtx, "run-first").run_id).toBe("run-first");

    let foreign: AuthError | undefined;
    let guessed: AuthError | undefined;
    try { store.authorizeRun(secondCtx, "run-first"); } catch (e) { foreign = e as AuthError; }
    try { store.authorizeRun(secondCtx, "run-guessed"); } catch (e) { guessed = e as AuthError; }
    expect(foreign?.statusCode).toBe(404);
    expect(guessed?.statusCode).toBe(404);
    expect(foreign?.toDict()).toEqual(guessed?.toDict());
    expectNoWorkspaceData(foreign?.toDict(), first.id, second.id);

    try {
      store.claimRun(second.id, "run-first");
      throw new Error("should throw");
    } catch (e) {
      const ae = e as AuthError;
      expect(ae.statusCode).toBe(409);
      expect(ae.code).toBe("run_already_claimed");
      expectNoWorkspaceData(ae.toDict(), first.id, second.id);
    }

    expect(store.resolveWorkspace(secondCtx)).toBe(second.id);
    try { store.resolveWorkspace(secondCtx, first.id); throw new Error("x"); } catch (e) {
      expect((e as AuthError).code).toBe("workspace_not_found");
      expectNoWorkspaceData((e as AuthError).toDict(), first.id, second.id);
    }
  });

  it("rotates keys atomically, revokes old key, audits lifecycle, and blocks reuse", async () => {
    const root = await makeTempDir();
    const store = new AuthStore(root);
    const ws = store.createWorkspace("Acme", "ws_rotate");
    const original = store.createKey(ws.id, [SCOPE_RUN, SCOPE_READ], "primary");
    const replacement = store.rotateKey(original.id);

    expect(replacement.rotated_from).toBe(original.id);
    expect(replacement.secret).toBeTruthy();
    expect(replacement.secret).not.toBe(original.secret);
    const keys = Object.fromEntries(store.listKeys(ws.id).map((k) => [k.id, k]));
    expect(keys[original.id]!.revoked_reason).toBe("rotated");
    expect(keys[original.id]!.revoked_at).toBeTruthy();

    try { store.authenticate(original.secret); throw new Error("x"); } catch (e) {
      expect((e as AuthError).code).toBe("revoked_api_key");
    }
    expect(store.authenticate(replacement.secret).workspace_id).toBe(ws.id);

    const rawStore = fs.readFileSync(store.storePath, "utf8");
    const rawAudit = fs.readFileSync(store.auditPath, "utf8");
    expect(rawStore).not.toContain(original.secret);
    expect(rawStore).not.toContain(replacement.secret);
    expect(rawAudit).not.toContain(original.secret);
    expect(rawAudit).not.toContain(replacement.secret);
    const events = store.loadAudit().map((e) => e.event);
    expect(events.filter((e) => e === "api_key_created")).toHaveLength(2);
    expect(events.filter((e) => e === "api_key_revoked")).toHaveLength(1);
    expect(events.filter((e) => e === "api_key_rotated")).toHaveLength(1);

    try { store.rotateKey(original.id); throw new Error("x"); } catch (e) {
      expect((e as AuthError).code).toBe("key_revoked");
    }
  });

  it("validates scopes, supports admin coverage, and persists across instances", async () => {
    const root = await makeTempDir();
    const store = new AuthStore(root);
    const ws = store.createWorkspace("Acme", "ws_scopes");
    expect(() => store.createKey(ws.id, [])).toThrow();
    expect(() => store.createKey(ws.id, ["superuser"] as any)).toThrow();

    const admin = store.createKey(ws.id, [SCOPE_ADMIN]);
    const adminCtx = store.authenticate(admin.secret);
    expect(adminCtx.hasScope(SCOPE_RUN)).toBe(true);
    expect(adminCtx.hasScope(SCOPE_EXPORT)).toBe(true);
    expect(store.authenticate(admin.secret, SCOPE_EXPORT).workspace_id).toBe(ws.id);

    store.claimRun(ws.id, "run-persisted");
    const restarted = new AuthStore(root);
    expect(restarted.workspaceForRun("run-persisted")).toBe(ws.id);
    expect(restarted.listWorkspaces().map((w) => w.id)).toContain(ws.id);
  });

  it("provides redacted AuthContext and workspace/key public views", async () => {
    const root = await makeTempDir();
    const store = new AuthStore(root);
    const ws = store.createWorkspace("Ctx", "ws_ctx");
    const key = store.createKey(ws.id, [SCOPE_RUN], "label");
    const ctx = store.authenticate(key.secret);
    expect(ctx).toBeInstanceOf(AuthContext);
    expect(ctx.toDict()).toEqual({
      workspace_id: "ws_ctx",
      key_id: key.id,
      prefix: key.prefix,
      scopes: [SCOPE_RUN],
      authenticated_at: ctx.authenticated_at,
    });
    expect(store.getWorkspace(ws.id)).toEqual({ id: "ws_ctx", name: "Ctx", status: "active", created_at: ws.created_at });
    const listed = store.listKeys(ws.id)[0]!;
    expect(listed).not.toHaveProperty("secret");
    expect(listed).not.toHaveProperty("key_hash");
    expect(listed).not.toHaveProperty("salt");
  });
});
