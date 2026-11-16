import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  BillingFeatureFlag,
  BillingStore,
  EVENT_RUN_STARTED,
  InMemorySecretManager,
  LedgerStore,
  PriceBook,
  SandboxBillingProvider,
  buildEvent,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-billing-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function seedInvoice(root: string, invoiceId = "inv-1", total = 1.5) {
  const ledger = new LedgerStore(root);
  const event = buildEvent(EVENT_RUN_STARTED, {
    run: "run-1",
    workspace: "ws_acme",
    source: "oss",
    idempotency_key: "run-1:start",
    timestamp: "2026-11-12T00:00:00Z",
    metadata: { workflow_id: "release" },
  });
  ledger.ingestEvent(event, new PriceBook({ prices: { run_started: total } as any, currency: "USD" }));
  return ledger.invoice("ws_acme", "2026-11", { invoice_id: invoiceId });
}

describe("LEM-118 feature-gated metered billing and kill switch", () => {
  it("does not create provider records when feature flag is off or workspace is not allow-listed", async () => {
    const root = await makeTempDir();
    const secrets = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const provider = new SandboxBillingProvider(root);
    const store = new BillingStore(root, {
      feature_flag: new BillingFeatureFlag({ enabled: false, sandbox: true, workspaces: ["ws_acme"] }),
      secret_manager: secrets,
      provider,
    });
    expect(store.billingEnabled("ws_acme")).toBe(false);
    expect(store.ensureCustomer("ws_acme").status).toBe("disabled");
    expect(store.ensureSubscription("ws_acme", { plan_id: "free" }).status).toBe("disabled");
    const invoice = seedInvoice(root);
    expect(store.syncInvoice("ws_acme", "2026-11", { invoice_id: invoice.invoice_id }).status).toBe("disabled");
    const providerStatePath = path.join(root, ".lemma", "billing", "sandbox-provider.json");
    const providerState = fs.existsSync(providerStatePath) ? JSON.parse(fs.readFileSync(providerStatePath, "utf8")) : {};
    expect(providerState.customers ?? {}).toEqual({});
    expect(providerState.subscriptions ?? {}).toEqual({});
    expect(providerState.invoices ?? {}).toEqual({});

    const scoped = new BillingStore(root, { feature_flag: new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] }), secret_manager: secrets, provider });
    expect(scoped.billingEnabled("ws_other")).toBe(false);
    expect(scoped.billingEnabled("ws_acme")).toBe(true);
  });

  it("reconciles sandbox invoices and makes customer/subscription idempotent", async () => {
    const root = await makeTempDir();
    const secrets = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const provider = new SandboxBillingProvider(root);
    const store = new BillingStore(root, {
      feature_flag: new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] }),
      secret_manager: secrets,
      provider,
    });

    const inv = seedInvoice(root, "inv-1", 1.234567);
    const result = store.syncInvoice("ws_acme", "2026-11", { invoice_id: inv.invoice_id });
    expect(result.status).toBe("reconciled");
    expect(result.billing.matched).toBe(true);
    expect(result.billing.ledger_total).toBe(1.234567);
    expect(result.billing.provider_total).toBe(1.23);

    const c1 = store.ensureCustomer("ws_acme", { name: "Acme" });
    const c2 = store.ensureCustomer("ws_acme", { name: "Acme" });
    expect(c1.customer_id).toBe(c2.customer_id);
    const s1 = store.ensureSubscription("ws_acme", { plan_id: "free" });
    const s2 = store.ensureSubscription("ws_acme", { plan_id: "free" });
    expect(s1.subscription_id).toBe(s2.subscription_id);

    seedInvoice(root, "inv-idem", 1.5);
  });

  it("retries transient failures, degrades on exhaustion, and preserves state", async () => {
    const root = await makeTempDir();
    const secrets = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const flag = new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] });

    const flaky = new SandboxBillingProvider(root, { fail_reconcile_times: 2 });
    const store = new BillingStore(root, { feature_flag: flag, secret_manager: secrets, provider: flaky, max_retries: 3 });
    const inv = seedInvoice(root, "inv-retry", 1.5);
    const ok = store.syncInvoice("ws_acme", "2026-11", { invoice_id: inv.invoice_id });
    expect(ok.status).toBe("reconciled");

    const root2 = await makeTempDir();
    const broken = new SandboxBillingProvider(root2, { fail_reconcile_times: 10 });
    const brokenStore = new BillingStore(root2, { feature_flag: flag, secret_manager: secrets, provider: broken, max_retries: 2 });
    const inv2 = seedInvoice(root2, "inv-broken", 1.5);
    const degraded = brokenStore.syncInvoice("ws_acme", "2026-11", { invoice_id: inv2.invoice_id });
    expect(degraded.status).toBe("degraded");
    expect(degraded.error).toBeTruthy();
    expect(brokenStore.status("ws_acme").last_status).toBe("degraded");
  });

  it("honors kill switch, idempotent invoice sync, secret non-persistence, and status", async () => {
    const root = await makeTempDir();
    const secrets = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const provider = new SandboxBillingProvider(root);
    const store = new BillingStore(root, {
      feature_flag: new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] }),
      secret_manager: secrets,
      provider,
    });

    store.disable("operator stop");
    expect(store.killSwitchActive()).toBe(true);
    const invKilled = seedInvoice(root, "inv-killed", 1.5);
    const killed = store.syncInvoice("ws_acme", "2026-11", { invoice_id: invKilled.invoice_id });
    expect(killed.status).toBe("disabled");
    expect(killed.billing_enabled).toBe(false);
    store.enableWrites();
    expect(store.killSwitchActive()).toBe(false);

    // fresh store for normal sync
    const root2 = await makeTempDir();
    const secrets2 = new InMemorySecretManager({ "billing/api_key": "secret-value" });
    const provider2 = new SandboxBillingProvider(root2);
    const store2 = new BillingStore(root2, {
      feature_flag: new BillingFeatureFlag({ enabled: true, sandbox: true, workspaces: ["ws_acme"] }),
      secret_manager: secrets2,
      provider: provider2,
    });
    const inv = seedInvoice(root2, "inv-idem", 1.5);
    const first = store2.syncInvoice("ws_acme", "2026-11", { invoice_id: inv.invoice_id });
    const second = store2.syncInvoice("ws_acme", "2026-11", { invoice_id: inv.invoice_id });
    expect(first.status).toBe("reconciled");
    expect(second.status).toBe("already_reconciled");

    const billingState = fs.readFileSync(path.join(root2, ".lemma", "billing", "state.json"), "utf8");
    const providerState = fs.readFileSync(path.join(root2, ".lemma", "billing", "sandbox-provider.json"), "utf8");
    expect(billingState).not.toContain("secret-value");
    expect(providerState).not.toContain("secret-value");

    const status = store2.status("ws_acme");
    expect(status.last_status).toBe("reconciled");
    expect(status.invoices[first.idempotency_key]).toBeTruthy();
  });
});
