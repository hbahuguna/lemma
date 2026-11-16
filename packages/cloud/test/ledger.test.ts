import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthStore,
  ENTRY_ADJUSTMENT,
  EVENT_BROWSER_MINUTE_CONSUMED,
  EVENT_CHECK_EXECUTED,
  EVENT_EVIDENCE_BYTE_STORED,
  EVENT_EXPORT_GENERATED,
  EVENT_RUN_STARTED,
  INVOICE_SCHEMA_VERSION,
  LedgerError,
  LedgerPeriodClosed,
  LedgerStore,
  PriceBook,
  SCOPE_READ,
  SCOPE_RUN,
  buildEvent,
  invoiceToCsv,
  normalizePeriod,
  periodBounds,
} from "../src/index.js";

const WORKSPACE = "ws_acme";
const PERIOD = "2026-11";
const TIMESTAMP = "2026-11-12T00:00:00Z";

const METADATA: Record<string, Record<string, unknown>> = {
  [EVENT_RUN_STARTED]: { workflow_id: "release-confidence" },
  [EVENT_CHECK_EXECUTED]: { check_id: "static.tests", status: "passed" },
  [EVENT_BROWSER_MINUTE_CONSUMED]: { mode: "desktop" },
  [EVENT_EVIDENCE_BYTE_STORED]: { kind: "text", path: ".lemma/evidence/run/check.txt" },
  [EVENT_EXPORT_GENERATED]: { format: "sarif" },
};

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function makeEvent(eventType: string, key: string, opts: { quantity?: number; workspace?: string; timestamp?: string; run?: string; metadata?: Record<string, unknown> } = {}) {
  return buildEvent(eventType, {
    run: opts.run ?? "run-1",
    workspace: opts.workspace ?? WORKSPACE,
    source: "oss",
    quantity: opts.quantity ?? (eventType === EVENT_BROWSER_MINUTE_CONSUMED ? 1.5 : eventType === EVENT_EVIDENCE_BYTE_STORED ? 100 : 1),
    idempotency_key: key,
    timestamp: opts.timestamp ?? TIMESTAMP,
    metadata: opts.metadata ?? METADATA[eventType] ?? {},
  } as any);
}

function priceBook(overrides: Record<string, number> = {}) {
  return new PriceBook({
    currency: "USD",
    prices: {
      [EVENT_RUN_STARTED]: 1.5,
      [EVENT_CHECK_EXECUTED]: 0.25,
      [EVENT_BROWSER_MINUTE_CONSUMED]: 0.1,
      [EVENT_EVIDENCE_BYTE_STORED]: 0.001,
      [EVENT_EXPORT_GENERATED]: 0.05,
      ...overrides,
    },
  });
}

describe("LEM-116 append-only ledger and invoice export", () => {
  it("parses/validates price books and period helpers", () => {
    const book = PriceBook.fromDict({
      schema_version: "quality-harness.price-book/v1",
      currency: "EUR",
      prices: { [EVENT_RUN_STARTED]: 1.5, [EVENT_CHECK_EXECUTED]: { unit_price: 0.25 } },
    } as any);
    expect(book.currency).toBe("EUR");
    expect(book.price(EVENT_RUN_STARTED)).toBe(1.5);
    expect(book.price(EVENT_CHECK_EXECUTED)).toBe(0.25);
    expect(book.price(EVENT_EXPORT_GENERATED)).toBe(0);

    const flat = PriceBook.fromDict({ [EVENT_RUN_STARTED]: 2.0 } as any);
    expect(flat.price(EVENT_RUN_STARTED)).toBe(2);
    expect(() => PriceBook.fromDict({ prices: { not_an_event: 1 } } as any)).toThrow(LedgerError);
    expect(() => PriceBook.fromDict({ prices: { [EVENT_RUN_STARTED]: -1 } } as any)).toThrow(LedgerError);

    expect(normalizePeriod(PERIOD)).toBe(PERIOD);
    expect(normalizePeriod("2026-11-12T00:00:00Z")).toBe(PERIOD);
    const bounds = periodBounds(PERIOD);
    expect(bounds.start).toBe("2026-11-01T00:00:00Z");
    expect(bounds.end).toBe("2026-12-01T00:00:00Z");
    expect(() => normalizePeriod("2026-13")).toThrow(LedgerError);
  });

  it("appends immutable hash-chained usage entries with idempotency and detects tampering", async () => {
    const root = await makeTempDir();
    const ledger = new LedgerStore(root);
    const event = makeEvent(EVENT_RUN_STARTED, "run-1:start", { quantity: 1 });
    const first = ledger.ingestEvent(event, priceBook());
    expect(first.created).toBe(true);
    expect(first.entry.workspace).toBe(WORKSPACE);
    expect(first.entry.period).toBe(PERIOD);
    expect(first.entry.quantity).toBe(1);
    expect(first.entry.unit_price).toBe(1.5);
    expect(first.entry.amount).toBe(1.5);
    expect(first.entry.sequence).toBe(1);
    expect(first.entry.previous_hash).toBe("");

    const dup = ledger.ingestEvent(event, priceBook());
    expect(dup.created).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(ledger.entries()).toHaveLength(1);

    const conflict = { ...event, quantity: 2, event_id: "usage-conflict" };
    expect(() => ledger.ingestEvent(conflict, priceBook())).toThrow(LedgerError);

    const entries = ledger.entries();
    (entries[0] as any).quantity = 999;
    expect(ledger.entries()[0]!.quantity).toBe(1); // copy
    expect(ledger.verify().ok).toBe(true);

    ledger.ingestEvent(makeEvent(EVENT_CHECK_EXECUTED, "run-1:two", { quantity: 1 }), priceBook());
    const lines = fs.readFileSync(ledger.entriesPath, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[0]!);
    tampered.quantity = 99;
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(ledger.entriesPath, lines.join("\n") + "\n");
    const v = ledger.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe("broken");
    expect(() => ledger.ingestEvent(makeEvent(EVENT_EXPORT_GENERATED, "run-1:three", { quantity: 1 }), priceBook())).toThrow(LedgerError);
  });

  it("rejects late usage after close but allows explicit late adjustment; close is idempotent", async () => {
    const root = await makeTempDir();
    const ledger = new LedgerStore(root);
    ledger.ingestEvent(makeEvent(EVENT_RUN_STARTED, "run-1:start", { quantity: 1 }), priceBook());
    const close = ledger.closePeriod(WORKSPACE, PERIOD, { closed_at: "2026-12-01T00:00:00Z", closed_by: "finance" });
    expect(close.created).toBe(true);
    expect(close.entry_count).toBe(1);
    expect(close.subtotal).toBe(1.5);

    const late = makeEvent(EVENT_CHECK_EXECUTED, "run-1:late", { quantity: 1, timestamp: "2026-11-30T23:59:59Z" });
    expect(() => ledger.ingestEvent(late, priceBook())).toThrow(LedgerPeriodClosed);
    const batch = ledger.ingestEvents([late], { priceBook: priceBook() });
    expect(batch.status).toBe("partial");
    expect(batch.rejected[0].code).toBe("period_closed");
    expect(ledger.entries()).toHaveLength(1);

    const adj = ledger.addLateAdjustment(WORKSPACE, PERIOD, close.close_id, EVENT_CHECK_EXECUTED, 1, { reason: "late metering event accepted after close", unit_price: 0.25 });
    expect(adj.entry.entry_type).toBe(ENTRY_ADJUSTMENT);
    expect(adj.entry.references).toEqual([close.close_id]);
    const invoice = ledger.invoice(WORKSPACE, PERIOD);
    expect(invoice.closed).toBe(true);
    expect(invoice.subtotal).toBe(1.5);
    expect(invoice.credits).toBe(0);
    expect(invoice.total).toBe(1.75);

    const repeated = ledger.closePeriod(WORKSPACE, PERIOD);
    expect(repeated.created).toBe(false);
    expect(repeated.close_id).toBe(close.close_id);
  });

  it("records corrections referencing originals and computes invoice/CSV/reconciliation", async () => {
    const root = await makeTempDir();
    const ledger = new LedgerStore(root);
    const events = [
      makeEvent(EVENT_RUN_STARTED, "run-1:run", { quantity: 1 }),
      makeEvent(EVENT_CHECK_EXECUTED, "run-1:check:1", { quantity: 1 }),
      makeEvent(EVENT_CHECK_EXECUTED, "run-1:check:2", { quantity: 1 }),
      makeEvent(EVENT_CHECK_EXECUTED, "run-1:check:3", { quantity: 1 }),
      makeEvent(EVENT_BROWSER_MINUTE_CONSUMED, "run-1:browser", { quantity: 1.5 }),
      makeEvent(EVENT_EVIDENCE_BYTE_STORED, "run-1:bytes", { quantity: 100 }),
      makeEvent(EVENT_EXPORT_GENERATED, "run-1:export", { quantity: 1 }),
    ];
    const result = ledger.ingestEvents(events, { priceBook: priceBook() });
    expect(result.ingested).toBe(7);
    expect(result.duplicates).toBe(0);

    const original = ledger.entries(WORKSPACE, PERIOD)[1]!;
    ledger.addCorrection(WORKSPACE, PERIOD, original.entry_id, -1, { reason: "duplicate check" });
    const invoice = ledger.invoice(WORKSPACE, PERIOD, { invoice_id: "inv-test", generated_at: "2026-12-01T00:00:00Z" });
    expect(invoice.schema_version).toBe(INVOICE_SCHEMA_VERSION);
    expect(invoice.subtotal).toBe(2.55);
    expect(invoice.credits).toBe(0.25);
    expect(invoice.total).toBe(2.3);

    const recon = ledger.reconcile(WORKSPACE, PERIOD, { invoice });
    expect(recon.ok).toBe(true);
    expect(recon.difference).toBe(0);

    const csv = invoiceToCsv(invoice);
    expect(csv).toContain("workspace,period,currency,row_type");
    expect(csv).toContain(WORKSPACE);
    expect(csv).toContain("line_item");
    expect(csv).toContain("correction");
    expect(csv).toContain("2.300000"); // total
  });

  it("reconciles duplicate, late, and corrected events and enforces auth-context workspace binding", async () => {
    const root = await makeTempDir();
    const ledger = new LedgerStore(root);
    const pb = priceBook();
    const first = makeEvent(EVENT_CHECK_EXECUTED, "run-1:check:1", { quantity: 1 });
    const second = makeEvent(EVENT_CHECK_EXECUTED, "run-1:check:2", { quantity: 1 });
    ledger.ingestEvent(first, pb);
    ledger.ingestEvent(second, pb);
    const dup = ledger.ingestEvent(first, pb);
    expect(dup.duplicate).toBe(true);

    const close = ledger.closePeriod(WORKSPACE, PERIOD, { closed_at: "2026-12-01T00:00:00Z" });
    const late = makeEvent(EVENT_CHECK_EXECUTED, "run-1:late", { quantity: 1, timestamp: "2026-11-20T00:00:00Z" });
    expect(() => ledger.ingestEvent(late, pb)).toThrow(LedgerPeriodClosed);
    ledger.addLateAdjustment(WORKSPACE, PERIOD, close.close_id, EVENT_CHECK_EXECUTED, 1, { reason: "late event", unit_price: 0.25 });
    const original = ledger.entries(WORKSPACE, PERIOD)[0]!;
    ledger.addCorrection(WORKSPACE, PERIOD, original.entry_id, -1, { reason: "duplicate event" });

    const invoice = ledger.invoice(WORKSPACE, PERIOD);
    expect(invoice.subtotal).toBe(0.5);
    expect(invoice.credits).toBe(0.25);
    expect(invoice.total).toBe(0.5);
    expect(ledger.reconcile(WORKSPACE, PERIOD, { invoice }).ok).toBe(true);

    // auth context binding (use open period for ws_acme context operations)
    const auth = new AuthStore(root);
    const ws = auth.createWorkspace("Acme", "ws_acme");
    auth.createWorkspace("Other", "ws_other");
    const ctx = auth.authenticate(auth.createKey(ws.id, [SCOPE_RUN, SCOPE_READ]).secret, SCOPE_RUN);
    const bound = LedgerStore.fromAuthContext(root, ctx);
    expect(bound.workspace).toBe("ws_acme");
    const boundEvent = makeEvent(EVENT_RUN_STARTED, "run-2:bound", { workspace: "ws_acme", run: "run-2", quantity: 1, timestamp: "2026-12-10T00:00:00Z" });
    expect(bound.ingestForContext(ctx, boundEvent, pb).created).toBe(true);
    expect(bound.entriesFor(ctx).length).toBeGreaterThan(0);
    expect(bound.invoiceFor(ctx, "2026-12").subtotal).toBe(1.5);
    const otherEvent = makeEvent(EVENT_RUN_STARTED, "run-3:other", { workspace: "ws_other", run: "run-3", quantity: 1, timestamp: "2026-12-10T00:00:00Z" });
    expect(() => bound.ingestForContext(ctx, otherEvent, pb)).toThrow(LedgerError);
  });
});
