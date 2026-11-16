import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  EntitlementVerification,
  PlanDowngradeError,
  QuotaPlan,
  QuotaStore,
  SignupStore,
  entitlements,
  verifyEntitlement,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-signup-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("LEM-117 self-serve signup and signed entitlements", () => {
  it("creates one workspace, owner key, and entitlement; replay is idempotent", async () => {
    const root = await makeTempDir();
    const store = new SignupStore(root);
    const plan = new QuotaPlan({ id: "free", version: "1", limits: { runs: { soft: 1, hard: 2 } } as any });
    const first = store.signup("req-1", { name: "Acme", plan, effective_at: "2026-11-12T00:00:00Z" });
    expect(first.status).toBe("created");
    expect(first.replayed).toBe(false);
    expect(first.workspace.name).toBe("Acme");
    expect(first.key.secret).toMatch(/^qh_/);
    expect(first.key.scopes).toEqual(["admin", "run", "read", "export"]);
    expect(first.plan.id).toBe("free");
    expect(first.entitlement.signature).toBeTruthy();
    expect(first.usage.usage.runs).toBe(0);
    expect(first.usage.remaining.runs).toBe(2);

    const data = store._load();
    expect(Object.keys(data.workspaces)).toHaveLength(1);
    expect(Object.keys(data.requests)).toHaveLength(1);

    const second = store.signup("req-1", { name: "Acme", plan });
    expect(second.status).toBe("replayed");
    expect(second.replayed).toBe(true);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.key.id).toBe(first.key.id);
    expect(second.key.secret).toBeNull();
    expect(Object.keys(store._load().workspaces)).toHaveLength(1);
    expect(Object.keys(store._load().requests)).toHaveLength(1);
  });

  it("exposes allowance/usage from first request and isolates unknown workspaces", async () => {
    const root = await makeTempDir();
    const store = new SignupStore(root);
    const plan = new QuotaPlan({ id: "free", limits: { checks: { soft: 5, hard: 10 } } as any });
    const result = store.signup("req-1", { plan });
    const usage = store.usage(result.workspace.id);
    expect(usage.usage.checks).toBe(0);
    expect(usage.remaining.checks).toBe(10);
    expect(usage.limits.checks.hard).toBe(10);
    expect(usage.plan.id).toBe("free");

    const other = store.signup("req-2", { name: "Other", plan });
    expect(other.workspace.id).not.toBe(result.workspace.id);
    expect(() => store.usage("ws_does_not_exist")).toThrow();
    expect(store.getSignup("ws_does_not_exist")).toBeNull();
  });

  it("records plan selection effective date/period and rejects downgrades below usage", async () => {
    const root = await makeTempDir();
    const store = new SignupStore(root);
    const plan = new QuotaPlan({ id: "free", limits: { runs: { hard: 2 } } as any });
    const result = store.signup("req-1", { plan, effective_at: "2026-11-12T00:00:00Z" });
    const newPlan = new QuotaPlan({ id: "pro", limits: { runs: { hard: 5 } } as any });
    const selection = store.selectPlan(result.workspace.id, newPlan, { effective_at: "2026-12-01T00:00:00Z" });
    expect(selection.status).toBe("plan_selected");
    expect(selection.plan.id).toBe("pro");
    expect(selection.effective_at).toBe("2026-12-01T00:00:00Z");
    expect(selection.period).toBe("2026-12");
    const record = store.getSignup(result.workspace.id);
    expect(record.plan.id).toBe("pro");
    expect(record.effective_at).toBe("2026-12-01T00:00:00Z");
    expect(record.plan_selections).toHaveLength(1);

    // downgrade below usage
    const root2 = await makeTempDir();
    const store2 = new SignupStore(root2);
    const r2 = store2.signup("req-d", { plan, effective_at: "2026-11-12T00:00:00Z" });
    new QuotaStore(root2, plan, { workspace: r2.workspace.id, enforce: true }).consume("runs", 2, { now: "2026-11-12T00:00:00Z" });
    expect(() => store2.selectPlan(r2.workspace.id, new QuotaPlan({ id: "tiny", limits: { runs: { hard: 1 } } as any }), { effective_at: "2026-11-12T00:00:00Z" })).toThrow(PlanDowngradeError);
  });

  it("issues and verifies signed entitlements; rejects tamper/expiry/wrong workspace/period", async () => {
    const root = await makeTempDir();
    const store = new SignupStore(root);
    const plan = new QuotaPlan({ id: "free", limits: { runs: { hard: 2 } } as any });
    const result = store.signup("req-1", { plan, effective_at: "2026-11-12T00:00:00Z" });
    const entitlement = result.entitlement;

    const v1 = store.verifyEntitlement(entitlement);
    expect(v1.valid).toBe(true);
    expect(Boolean(v1)).toBe(true); // truthy when valid
    expect(verifyEntitlement(entitlement, { signing_key: store.signingKey }).valid).toBe(true);

    const tampered = { ...entitlement, plan_id: "enterprise" };
    expect(store.verifyEntitlement(tampered).valid).toBe(false);

    const expired = store.issueEntitlement(result.workspace.id, plan, {
      period: "2026-10",
      effective_at: "2026-10-01T00:00:00Z",
      expires_at: "2026-10-31T00:00:00Z",
    });
    expect(store.verifyEntitlement(expired, { now: "2026-11-12T00:00:00Z" }).valid).toBe(false);
    expect(store.verifyEntitlement(expired, { now: "2026-10-15T00:00:00Z" }).valid).toBe(true);

    expect(store.verifyEntitlement(entitlement, { workspace_id: "ws_other" }).reason).toBe("workspace mismatch");
    expect(store.verifyEntitlement(entitlement, { period: "2026-12" }).reason).toBe("period mismatch");

    // root-based verification helper
    const vRoot = verifyEntitlement(entitlement, { root });
    expect(vRoot.valid).toBe(true);
  });

  it("exports entitlements compatibility surface", () => {
    expect(entitlements.SignupStore).toBe(SignupStore);
    expect(entitlements.verifyEntitlement).toBe(verifyEntitlement);
    expect(entitlements.EntitlementVerification).toBe(EntitlementVerification);
  });
});
