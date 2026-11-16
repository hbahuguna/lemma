import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  BillingFeatureFlag,
  BillingStore,
  InMemorySecretManager,
  QuotaPlan,
  QuotaStore,
  SandboxBillingProvider,
  SignupStore,
  verifyEntitlement,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-billing-regression-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

class StrictProvider extends SandboxBillingProvider {
  expectedCalls: string[];
  actualCalls: string[] = [];
  constructor(root: string, expectedCalls: string[]) {
    super(root);
    this.expectedCalls = [...expectedCalls];
  }
  private record(name: string) {
    this.actualCalls.push(name);
    if (!this.expectedCalls.includes(name)) {
      throw new Error(`Unexpected provider call: ${name}`);
    }
  }
  override createCustomer(args: any) { this.record("create_customer"); return super.createCustomer(args); }
  override ensureSubscription(args: any) { this.record("ensure_subscription"); return super.ensureSubscription(args); }
  override reconcileInvoice(args: any) { this.record("reconcile_invoice"); return super.reconcileInvoice(args); }
  override cancelSubscription(args: any) { this.record("cancel_subscription"); return super.cancelSubscription(args); }
}

const PLAN_TABLE = [
  { id: "free", version: "2026-11", limits: { runs: { soft: 1, hard: 2 }, checks: { hard: 10 } } },
  { id: "pro", version: "2026-11", limits: { runs: { soft: 10, hard: 100 }, checks: { hard: 1000 } } },
  { id: "enterprise", version: "2026-11", limits: { runs: { soft: 100, hard: 1000 }, checks: { hard: 10000 } } },
];

function plan(payload: any): QuotaPlan {
  return (QuotaPlan as any).fromDict ? (QuotaPlan as any).fromDict(payload) : (QuotaPlan as any).from_dict(payload);
}

describe("LEM-121 billing and entitlement regression coverage", () => {
  it("issues and verifies signed entitlements for every plan and rejects tampering", async () => {
    for (const c of PLAN_TABLE) {
      const root = await makeTempDir();
      const store = new SignupStore(root);
      const p = plan(c);
      const result = store.signup(`req-${c.id}`, { name: c.id, plan: p, effective_at: "2026-11-12T00:00:00Z" });
      const entitlement = result.entitlement;
      expect((store as any).verifyEntitlement(entitlement).valid).toBe(true);
      expect(entitlement.plan_id).toBe(c.id);
      expect(entitlement.tier).toBe(c.id);
      expect(entitlement.plan_version).toBe(c.version);
      expect(entitlement.workspace_id).toBe(result.workspace.id);
      expect(entitlement.period).toBe("2026-11");
      for (const [resource, limit] of Object.entries(c.limits as Record<string, any>)) {
        expect(entitlement.limits[resource].hard).toBe(limit.hard ?? limit.limit);
      }
      const tampered = JSON.parse(JSON.stringify(entitlement));
      tampered.limits.runs.hard = 999999;
      expect((store as any).verifyEntitlement(tampered).valid).toBe(false);
    }
  });

  it("supports upgrade/downgrade plan selection and rejects downgrade below current usage", async () => {
    const root = await makeTempDir();
    const store = new SignupStore(root);
    const free = plan(PLAN_TABLE[0]);
    const pro = plan(PLAN_TABLE[1]);
    const result = store.signup("req-upgrade", { plan: free, effective_at: "2026-11-12T00:00:00Z" });
    const workspaceId = result.workspace.id;
    const upgraded = store.selectPlan(workspaceId, pro, { effective_at: "2026-12-01T00:00:00Z" });
    expect(upgraded.status).toBe("plan_selected");
    expect(upgraded.plan.id).toBe("pro");
    expect(upgraded.entitlement.plan_id).toBe("pro");
    const downgraded = store.selectPlan(workspaceId, free, { effective_at: "2027-01-01T00:00:00Z" });
    expect(downgraded.plan.id).toBe("free");

    const root2 = await makeTempDir();
    const store2 = new SignupStore(root2);
    const res2 = store2.signup("req-downgrade", { plan: pro, effective_at: "2026-11-12T00:00:00Z" });
    const ws2 = res2.workspace.id;
    const quota = new QuotaStore(root2, pro, { workspace: ws2, enforce: true } as any);
    quota.consume("runs", 5, { now: "2026-11-12T00:00:00Z" } as any);
    expect(() => store2.selectPlan(ws2, plan({ id: "tiny", limits: { runs: { hard: 1 } } }), { effective_at: "2026-11-12T00:00:00Z" })).toThrow();
  });

  it("handles subscription cancellation idempotently and payment failure degradation without provider invoice side effects", async () => {
    const root = await makeTempDir();
    const secrets = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const flag = new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] });
    const provider = new StrictProvider(root, ["create_customer", "ensure_subscription", "cancel_subscription"]);
    const billing = new BillingStore(root, { feature_flag: flag, secret_manager: secrets, provider } as any);
    billing.ensureCustomer("ws_acme", { name: "Acme" });
    billing.ensureSubscription("ws_acme", { plan_id: "pro" });
    const cancelled = billing.cancelSubscription("ws_acme", { reason: "customer request" });
    expect(cancelled.status).toBe("cancelled");
    expect((billing.status("ws_acme") as any).last_status).toBe("cancelled");
    const repeated = billing.cancelSubscription("ws_acme", { reason: "customer request" });
    expect(repeated.status).toBe("already_cancelled");
    expect(provider.actualCalls.filter((c) => c === "cancel_subscription").length).toBe(1);

    const root2 = await makeTempDir();
    const provider2 = new SandboxBillingProvider(root2, { fail_reconcile_times: 10 } as any);
    const billing2 = new BillingStore(root2, { feature_flag: flag, secret_manager: secrets, provider: provider2, max_retries: 1 } as any);
    const failed = billing2.recordPaymentFailure("ws_acme", { reason: "card declined", amount: 12.5, invoice_id: "inv-1" } as any);
    expect(failed.status).toBe("payment_failed");
    const st = billing2.status("ws_acme") as any;
    expect(st.last_status).toBe("payment_failed");
    expect(st.last_error).toBe("card declined");
    const providerStatePath = path.join(root2, ".lemma", "billing", "sandbox-provider.json");
    const providerState = fs.existsSync(providerStatePath) ? JSON.parse(fs.readFileSync(providerStatePath, "utf8")) : {};
    expect(providerState.invoices ?? {}).toEqual({});
  });

  it("makes no provider calls when feature flag is off and degrades on unexpected provider call", async () => {
    const root = await makeTempDir();
    const secrets = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const provider = new StrictProvider(root, []);
    const billing = new BillingStore(root, {
      feature_flag: new BillingFeatureFlag({ enabled: false, sandbox: true, workspaces: ["ws_acme"] }),
      secret_manager: secrets,
      provider,
    } as any);
    expect(billing.ensureCustomer("ws_acme").status).toBe("disabled");
    expect(billing.ensureSubscription("ws_acme", { plan_id: "pro" }).status).toBe("disabled");
    expect(billing.cancelSubscription("ws_acme").status).toBe("disabled");
    expect(provider.actualCalls).toEqual([]);

    const root2 = await makeTempDir();
    const provider2 = new StrictProvider(root2, ["create_customer"]);
    const billing2 = new BillingStore(root2, {
      feature_flag: new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] }),
      secret_manager: secrets,
      provider: provider2,
    } as any);
    const result = billing2.ensureSubscription("ws_acme", { plan_id: "pro" } as any);
    expect(result.status).toBe("degraded");
    expect(result.error?.type).toBeTruthy();
  });

  it("rejects entitlement scope/expiry mismatches and supports module-level verification", async () => {
    const root = await makeTempDir();
    const store = new SignupStore(root);
    const p = plan(PLAN_TABLE[0]);
    const result = store.signup("req-scope", { plan: p, effective_at: "2026-11-12T00:00:00Z" });
    const entitlement = result.entitlement;
    expect((store as any).verifyEntitlement(entitlement, { workspace_id: "ws_other" }).valid).toBe(false);
    expect((store as any).verifyEntitlement(entitlement, { period: "2026-12" }).valid).toBe(false);

    const expired = (store as any).issueEntitlement(result.workspace.id, p, {
      period: "2026-10",
      effective_at: "2026-10-01T00:00:00Z",
      expires_at: "2026-10-31T00:00:00Z",
      issued_at: "2026-10-01T00:00:00Z",
    });
    expect((store as any).verifyEntitlement(expired, { now: "2026-11-12T00:00:00Z" }).valid).toBe(false);

    const root2 = await makeTempDir();
    const store2 = new SignupStore(root2);
    const res2 = store2.signup("req-module", { plan: plan(PLAN_TABLE[1]), effective_at: "2026-11-12T00:00:00Z" });
    const verified = verifyEntitlement(res2.entitlement, { signing_key: (store2 as any).signingKey } as any);
    expect((verified as any).valid ?? Boolean(verified)).toBe(true);
  });
});
