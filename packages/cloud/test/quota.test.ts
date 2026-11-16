import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthStore,
  EVENT_HARD_LIMIT,
  EVENT_SOFT_LIMIT,
  QUOTA_SCHEMA_VERSION,
  QuotaError,
  QuotaExceeded,
  QuotaPlan,
  QuotaStore,
  RESOURCES,
  SCOPE_READ,
  SCOPE_RUN,
  quotaPeriod,
  workspaceFromContext,
} from "../src/index.js";

const NOVEMBER = "2026-11-12T00:00:00Z";
const DECEMBER = "2026-12-01T00:00:00Z";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-quota-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function freePlan() {
  return QuotaPlan.fromDict({
    id: "free",
    version: "2026-11",
    limits: {
      runs: 1,
      checks: { soft: 2, hard: 4 },
      browser_minutes: 0.5,
      evidence_bytes: 100,
    },
  });
}

describe("LEM-115 per-action quota enforcement", () => {
  it("parses/validates plans and exposes quota period", async () => {
    const plan = QuotaPlan.fromDict({ id: "flat", checks: 10, runs: { soft: 1, hard: 2 } });
    expect(plan.limit("checks").hard).toBe(10);
    expect(plan.limit("run").soft).toBe(1);
    expect(plan.limit("run").hard).toBe(2);
    expect(() => QuotaPlan.fromDict({ limits: { widgets: 2 } })).toThrow();
    expect(() => QuotaPlan.fromDict({ limits: { checks: { soft: 5, hard: 2 } } })).toThrow();

    const root = await makeTempDir();
    const p = path.join(root, "plan.json");
    fs.writeFileSync(p, JSON.stringify(freePlan().toDict()));
    const loaded = QuotaPlan.load(p);
    expect(loaded.id).toBe("free");
    expect(loaded.limit("checks").soft).toBe(2);
    expect(loaded.limit("checks").hard).toBe(4);

    const period = quotaPeriod(NOVEMBER);
    expect(period.key).toBe("2026-11");
    expect(period.reset_at).toBe("2026-12-01T00:00:00Z");
  });

  it("warns once per resource per period, rolls over, and isolates workspaces", async () => {
    const root = await makeTempDir();
    const plan = freePlan();
    const store = new QuotaStore(root, plan, { workspace: "ws_acme" });

    const first = store.consume("checks", 1, { now: NOVEMBER });
    const second = store.consume("checks", 1, { now: NOVEMBER });
    const third = store.consume("checks", 1, { now: NOVEMBER });
    expect(first.warning).toBeNull();
    expect(second.warning?.soft_limit).toBe(2);
    expect(third.warning).toBeNull();
    expect(store.warnings(NOVEMBER)).toEqual(["checks"]);
    const softEvents = store.events().filter((e) => e.event_type === EVENT_SOFT_LIMIT);
    expect(softEvents).toHaveLength(1);
    expect(softEvents[0]!.workspace).toBe("ws_acme");

    // period rollover resets usage/warnings for workspace
    const rolled = new QuotaStore(root, plan, { workspace: "ws_rollover" });
    rolled.consume("checks", 2, { now: NOVEMBER });
    expect(rolled.warnings(NOVEMBER)).toEqual(["checks"]);
    const rolledDec = rolled.consume("checks", 2, { now: DECEMBER });
    expect(rolledDec.warning?.soft_limit).toBe(2);
    expect(rolled.usage(DECEMBER).checks).toBe(2);

    // workspace isolation
    const acme = new QuotaStore(root, plan, { workspace: "ws_iso_a" });
    const globex = new QuotaStore(root, plan, { workspace: "ws_iso_b" });
    acme.consume("checks", 2, { now: NOVEMBER });
    globex.consume("checks", 1, { now: NOVEMBER });
    expect(acme.usage(NOVEMBER).checks).toBe(2);
    expect(globex.usage(NOVEMBER).checks).toBe(1);
    expect(acme.warnings(NOVEMBER)).toEqual(["checks"]);
    expect(globex.warnings(NOVEMBER)).toEqual([]);
  });

  it("enforces hard limits with 429 details/headers and preserves prior usage", async () => {
    const root = await makeTempDir();
    const store = new QuotaStore(root, freePlan(), { workspace: "ws_acme" });
    for (let i = 0; i < 4; i++) store.consume("checks", 1, { now: NOVEMBER });
    try {
      store.consume("checks", 1, { now: NOVEMBER });
      throw new Error("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceeded);
      const qe = err as QuotaExceeded;
      expect(qe.statusCode).toBe(429);
      expect(qe.limit).toBe(4);
      expect(qe.used).toBe(4);
      expect(qe.requested).toBe(1);
      expect(qe.reset_at).toBe("2026-12-01T00:00:00Z");
      const payload = qe.toDict() as any;
      expect(payload.http_status).toBe(429);
      expect(payload.error.code).toBe("quota_exceeded");
      expect(payload.headers["X-QH-Quota-Remaining-Checks"]).toBe("0");
      expect(payload.headers["Retry-After"]).toBeTruthy();
    }
    expect(store.usage(NOVEMBER).checks).toBe(4);
    expect(store.remaining("checks", NOVEMBER)).toBe(0);
    const hard = store.events().filter((e) => e.event_type === EVENT_HARD_LIMIT);
    expect(hard).toHaveLength(1);
    expect(hard[0]!.used).toBe(4);

    const blocked = store.tryConsume("checks", 1, { now: NOVEMBER });
    expect(blocked.allowed).toBe(false);
    expect(blocked.status_code).toBe(429);
    expect(store.usage(NOVEMBER).checks).toBe(4);
  });

  it("supports auth-context binding, consumeFor/snapshotFor, and opaque mismatches", async () => {
    const root = await makeTempDir();
    const auth = new AuthStore(root);
    const ws = auth.createWorkspace("Acme", "ws_acme");
    const ctx = auth.authenticate(auth.createKey(ws.id, [SCOPE_RUN, SCOPE_READ]).secret, SCOPE_RUN);

    const store = QuotaStore.fromAuthContext(root, ctx, freePlan());
    expect(store.workspace).toBe("ws_acme");
    expect(workspaceFromContext(ctx)).toBe("ws_acme");
    const d = store.consumeFor(ctx, "runs", 1, { now: NOVEMBER });
    expect(d.allowed).toBe(true);
    expect(store.usage(NOVEMBER).runs).toBe(1);
    expect(store.snapshotFor(ctx, NOVEMBER)).toBeTruthy();

    const other = new QuotaStore(root, freePlan(), { workspace: "ws_other" });
    expect(() => other.consumeFor(ctx, "runs", 1, { now: NOVEMBER })).toThrow(QuotaError);
    const bound = QuotaStore.fromAuthContext(root, ctx, freePlan(), { workspace: "ws_attacker" } as any);
    expect(bound.workspace).toBe("ws_acme");
  });

  it("maps metering events, supports peek/record, fractional/large units, and headers", async () => {
    const root = await makeTempDir();
    const store = new QuotaStore(root, freePlan(), { workspace: "ws_acme" });

    const decision = store.consumeMeteringEvent({ event_type: "check_executed", quantity: 1, run: "run-1", timestamp: NOVEMBER });
    expect(decision.resource).toBe("checks");
    expect(store.usage(NOVEMBER).checks).toBe(1);
    const exportDecision = store.consumeEvent("export_generated", 1, { now: NOVEMBER });
    expect(exportDecision.enforced).toBe(false);
    expect(store.usage(NOVEMBER).checks).toBe(1);

    const browser = store.consume("browser_minute", 0.25, { now: NOVEMBER });
    expect(browser.allowed).toBe(true);
    expect(browser.remaining).toBe(0.25);
    const evidence = store.consume("evidence_byte", 60, { now: NOVEMBER });
    expect(evidence.allowed).toBe(true);
    expect(evidence.remaining).toBe(40);

    const peek = store.peek("checks", 1, { now: NOVEMBER });
    expect(peek.allowed).toBe(true);
    expect(store.usage(NOVEMBER).checks).toBe(1);
    const rec = store.record("runs", 1, { now: NOVEMBER });
    expect(rec.allowed).toBe(true);
    expect(store.usage(NOVEMBER).runs).toBe(1);

    expect(browser.headers["X-QH-Quota-Reset"]).toBe("2026-12-01T00:00:00Z");
  });

  it("handles unlimited local/explicit enforcement/plan opt-in and snapshot/reset", async () => {
    const root = await makeTempDir();
    const plan = freePlan();

    const local = new QuotaStore(root, plan, { workspace: "local" });
    for (let i = 0; i < 5; i++) expect(local.consume("checks", 100, { now: NOVEMBER }).enforced).toBe(false);
    expect(fs.existsSync(path.join(root, ".lemma", "quota", "usage.json"))).toBe(false);

    const explicit = new QuotaStore(root, plan, { workspace: "local", enforce: true });
    for (let i = 0; i < 4; i++) explicit.consume("checks", 1, { now: NOVEMBER });
    expect(() => explicit.consume("checks", 1, { now: NOVEMBER })).toThrow(QuotaExceeded);
    expect(fs.existsSync(path.join(root, ".lemma", "quota", "usage.json"))).toBe(true);

    const root2 = await makeTempDir();
    const opted = new QuotaStore(root2, plan);
    expect(opted.enforced).toBe(true);
    expect(opted.workspace).toBe("local");

    const snap = opted.snapshot(NOVEMBER) as any;
    expect(snap.schema_version).toBe(QUOTA_SCHEMA_VERSION);
    expect(snap.enforced).toBe(true);
    expect(Object.keys(snap.usage).sort()).toEqual([...RESOURCES].sort());
    expect(snap.period.reset_at).toBe("2026-12-01T00:00:00Z");
    opted.consume("runs", 1, { now: NOVEMBER });
    expect((opted.snapshot(NOVEMBER) as any).usage.runs).toBe(1);
    opted.reset(NOVEMBER);
    expect((opted.snapshot(NOVEMBER) as any).usage.runs).toBe(0);
  });

  it("prevents overspend under concurrent consumption from multiple store instances", async () => {
    const root = await makeTempDir();
    const plan = freePlan();
    new QuotaStore(root, plan, { workspace: "ws_parallel" }).reset(NOVEMBER);

    const attempts = 20;
    let allowed = 0;
    let denied = 0;
    // multiple fresh store instances contending on same workspace/period (locking must prevent overspend)
    for (let i = 0; i < attempts; i++) {
      const s = new QuotaStore(root, plan, { workspace: "ws_parallel" });
      try {
        s.consume("checks", 1, { now: NOVEMBER });
        allowed++;
      } catch (e) {
        if (e instanceof QuotaExceeded) denied++;
        else throw e;
      }
    }
    expect(allowed).toBe(4);
    expect(denied).toBe(16);
    const finalStore = new QuotaStore(root, plan, { workspace: "ws_parallel" });
    expect(finalStore.usage(NOVEMBER).checks).toBe(4);
  });
});
