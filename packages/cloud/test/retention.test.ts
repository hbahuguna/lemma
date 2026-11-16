import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { JobQueue } from "../src/queue.js";
import { SignupStore } from "../src/signup.js";
import { RetentionStore } from "../src/retention.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-retention-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function python3(args: string[], cwd?: string): string {
  return execFileSync("python3", args, { cwd, encoding: "utf8" });
}

describe("LEM-120 tenant retention, export, and deletion", () => {
  it("exposes explicit default policy and supports set retention", async () => {
    const root = await makeTempDir();
    const store = new RetentionStore(root);
    const policy = store.policy("ws_acme") as any;
    expect(policy.retention_days).toBe(30);
    expect(policy.grace_period_days).toBe(7);
    expect(policy.default).toBe(true);

    const updated = store.setRetention("ws_acme", 14) as any;
    expect(updated.retention_days).toBe(14);
    expect(updated.default).toBe(false);
  });

  it("exports signed manifest with tenant/central records and no cross-tenant paths, and verifies", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root);
    queue.submit("ws_acme", "/tmp/target");
    queue.submit("ws_other", "/tmp/other");
    const tenantRoot = queue.tenantRootFor("ws_acme");
    fs.mkdirSync(path.join(tenantRoot, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(tenantRoot, "evidence", "a.txt"), "secret", "utf8");

    const store = new RetentionStore(root, { queue });
    const result = store.export("ws_acme") as any;
    expect(result.status).toBe("exported");
    expect(fs.existsSync(result.archive)).toBe(true);
    const verification = store.verifyExport(result.archive) as any;
    expect(verification.valid).toBe(true);
    expect(verification.workspace_id).toBe("ws_acme");
    expect(verification.file_count).toBeGreaterThanOrEqual(4);

    // inspect zip names for isolation
    const listing = python3(["-m", "zipfile", "-l", result.archive]);
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("tenant/");
    expect(listing).toContain("central/queue-jobs.json");
    expect(listing).not.toContain("ws_other");

    const jobsJson = python3(["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.read('central/queue-jobs.json').decode())", result.archive]);
    expect(jobsJson).toContain("ws_acme");
    expect(jobsJson).not.toContain("ws_other");
  });

  it("rejects tampered or invalid exports", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root);
    const tenantRoot = queue.tenantRootFor("ws_acme");
    fs.mkdirSync(tenantRoot, { recursive: true });
    fs.writeFileSync(path.join(tenantRoot, "state.json"), "{}", "utf8");
    const store = new RetentionStore(root, { queue });
    const archive = (store.export("ws_acme") as any).archive as string;

    const tmp = await makeTempDir();
    const noManifest = path.join(tmp, "no-manifest.zip");
    python3(["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('tenant/state.json','{}')", noManifest]);
    expect((store.verifyExport(noManifest) as any).valid).toBe(false);

    const tampered = path.join(tmp, "tampered.zip");
    python3(["-c", `
import json, zipfile, sys
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst,'w') as zout:
  for info in zin.infolist():
    data = zin.read(info.filename)
    if info.filename == 'manifest.json':
      m = json.loads(data)
      m['workspace_id'] = 'ws_other'
      data = json.dumps(m, indent=2).encode()
    zout.writestr(info, data)
`, archive, tampered]);
    expect((store.verifyExport(tampered) as any).valid).toBe(false);
  });

  it("soft-deletes with grace/idempotency and hard-deletes after grace or force", async () => {
    const root = await makeTempDir();
    const signup = new SignupStore(root);
    const store = new RetentionStore(root, { signup });
    const soft = store.softDelete("ws_acme", { graceDays: 1, actor: "tester", now: "2026-11-16T00:00:00Z" }) as any;
    expect(soft.status).toBe("soft_deleted");
    expect(soft.hard_delete_after).toBeTruthy();

    const again = store.softDelete("ws_acme", { graceDays: 1 }) as any;
    expect(again.status).toBe("already_soft_deleted");

    expect(() => store.hardDelete("ws_acme", { now: "2026-11-16T12:00:00Z" })).toThrow();
    const hard = store.hardDelete("ws_acme", { force: true, actor: "tester", now: "2026-11-16T12:00:00Z" }) as any;
    expect(hard.status).toBe("deleted");
    const audit = store.auditLog() as any[];
    expect(audit.some((e) => e.event === "soft_deleted")).toBe(true);
    expect(audit.some((e) => e.event === "hard_deleted")).toBe(true);
  });

  it("hard delete removes tenant root, queue jobs, cached exports, tenant signup state and preserves audit without touching other tenants", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root);
    const signup = new SignupStore(root);
    (signup as any)._save({ schema_version: "quality-harness.signup/v1", requests: {}, workspaces: { ws_left: { workspace_id: "ws_left", name: "left" }, ws_right: { workspace_id: "ws_right", name: "right" } } });

    queue.submit("ws_left", "/tmp/left");
    queue.submit("ws_right", "/tmp/right");
    const leftRoot = queue.tenantRootFor("ws_left");
    const rightRoot = queue.tenantRootFor("ws_right");
    fs.mkdirSync(leftRoot, { recursive: true });
    fs.mkdirSync(rightRoot, { recursive: true });
    fs.writeFileSync(path.join(leftRoot, "state.json"), "{}", "utf8");
    fs.writeFileSync(path.join(rightRoot, "right.txt"), "right", "utf8");

    const store = new RetentionStore(root, { queue, signup });
    const exp = store.export("ws_left") as any;
    expect(fs.existsSync(exp.archive)).toBe(true);

    const result = store.hardDelete("ws_left", { force: true, actor: "tester" }) as any;
    expect(result.status).toBe("deleted");
    expect(result.removed.tenant_root).toBe(true);
    expect(result.removed.queue_jobs).toBeGreaterThanOrEqual(1);
    expect(result.removed.cached_exports).toBeGreaterThanOrEqual(1);
    expect(result.removed.signup_state).toBe(true);
    expect(fs.existsSync(leftRoot)).toBe(false);
    expect(fs.existsSync(exp.archive)).toBe(false);
    expect(queue.listJobs("ws_left")).toEqual([]);
    expect(store.auditLog().length).toBeGreaterThan(0);

    expect(fs.existsSync(rightRoot)).toBe(true);
    expect(fs.readFileSync(path.join(rightRoot, "right.txt"), "utf8")).toBe("right");
    expect(queue.listJobs("ws_right").length).toBe(1);
    expect(signup.getSignup("ws_right")).toBeTruthy();
  });
});
