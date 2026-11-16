import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SCHEMA_DIR,
  DEFAULT_SINK,
  EVENT_BROWSER_MINUTE_CONSUMED,
  EVENT_CHECK_EXECUTED,
  EVENT_EVIDENCE_BYTE_STORED,
  EVENT_EXPORT_GENERATED,
  EVENT_RUN_STARTED,
  EVENT_TYPES,
  EVENT_UNITS,
  METERING_SCHEMA_VERSION,
  MeteringEmitter,
  MeteringError,
  REQUIRED_ENVELOPE_FIELDS,
  REQUIRED_METADATA,
  SCHEMA_FILES,
  buildEvent,
  defaultIdempotencyKey,
  eventSchemaPaths,
  validateEvent,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-metering-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function readEvents(root: string, sink: string = DEFAULT_SINK) {
  const p = path.isAbsolute(sink) ? sink : path.join(root, sink);
  const text = fs.readFileSync(p, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

describe("LEM-113 frozen metering event contract and local sink", () => {
  it("freezes event type names, units, required metadata, and envelope fields", () => {
    expect(EVENT_TYPES).toEqual([
      "run_started",
      "check_executed",
      "browser_minute_consumed",
      "evidence_byte_stored",
      "export_generated",
    ]);
    expect(EVENT_UNITS).toEqual({
      run_started: "run",
      check_executed: "check",
      browser_minute_consumed: "minute",
      evidence_byte_stored: "byte",
      export_generated: "export",
    });
    expect(REQUIRED_ENVELOPE_FIELDS).toEqual([
      "schema_version",
      "event_id",
      "event_type",
      "idempotency_key",
      "workspace",
      "run",
      "quantity",
      "unit",
      "timestamp",
      "source",
    ]);
    expect(REQUIRED_METADATA).toEqual({
      run_started: ["workflow_id"],
      check_executed: ["check_id", "status"],
      browser_minute_consumed: ["mode"],
      evidence_byte_stored: ["kind", "path"],
      export_generated: ["format"],
    });
  });

  it("exposes schema paths for envelope and every event type", () => {
    expect(Object.keys(SCHEMA_FILES).sort()).toEqual(["envelope", ...EVENT_TYPES].sort());
    const paths = eventSchemaPaths();
    for (const name of Object.keys(SCHEMA_FILES)) {
      const p = paths[name]!;
      expect(p).toBeTruthy();
      expect(fs.existsSync(p)).toBe(true);
      const schema = JSON.parse(fs.readFileSync(p, "utf8"));
      expect(typeof schema).toBe("object");
    }
    expect(fs.existsSync(path.join(DEFAULT_SCHEMA_DIR, "envelope.v1.schema.json"))).toBe(true);
  });

  it("builds and validates canonical envelopes for every event type with required metadata", () => {
    const metadata: Record<string, Record<string, unknown>> = {
      [EVENT_RUN_STARTED]: { workflow_id: "release-confidence" },
      [EVENT_CHECK_EXECUTED]: { check_id: "static.tests", status: "passed" },
      [EVENT_BROWSER_MINUTE_CONSUMED]: { mode: "desktop" },
      [EVENT_EVIDENCE_BYTE_STORED]: { kind: "text", path: ".lemma/evidence/x/a.txt" },
      [EVENT_EXPORT_GENERATED]: { format: "sarif" },
    };
    for (const eventType of EVENT_TYPES) {
      const quantity = eventType === EVENT_BROWSER_MINUTE_CONSUMED ? 0.5 : eventType === EVENT_EVIDENCE_BYTE_STORED ? 12 : 1;
      const event = buildEvent(eventType, {
        run: "run-1",
        workspace: "ws-1",
        source: "oss",
        quantity,
        metadata: metadata[eventType]!,
      });
      expect(validateEvent(event)).toEqual([]);
      for (const field of REQUIRED_ENVELOPE_FIELDS) {
        expect(event).toHaveProperty(field);
        expect((event as any)[field]).not.toBe("");
      }
      expect(event.event_type).toBe(eventType);
      expect(event.unit).toBe(EVENT_UNITS[eventType]);
    }
  });

  it("enforces per-type validation, metadata, quantity, and unit rules", () => {
    expect(() => buildEvent("unknown", { run: "run-1", metadata: {} as any })).toThrow(MeteringError);

    const base = buildEvent(EVENT_RUN_STARTED, {
      run: "run-1",
      workspace: "ws",
      source: "oss",
      metadata: { workflow_id: "w" },
    });
    expect(validateEvent({ ...base, workspace: "" })).toContain("field must be a non-empty string: workspace");
    expect(validateEvent({ ...base, schema_version: "bad/v1" })).toContain("unsupported schema_version: bad/v1");

    const check = buildEvent(EVENT_CHECK_EXECUTED, { run: "r", workspace: "w", source: "s", metadata: { check_id: "c", status: "passed" } });
    expect(validateEvent(check)).toEqual([]);
    expect(validateEvent({ ...check, quantity: 2 })).toContain("check_executed quantity must be 1");
    expect(validateEvent({ ...check, unit: "byte" })).toContain("unit for check_executed must be check");
    expect(validateEvent({ ...check, metadata: { check_id: "c" } })).toContain("metadata.status is required for check_executed");

    const browser = buildEvent(EVENT_BROWSER_MINUTE_CONSUMED, { run: "r", workspace: "w", source: "s", quantity: 0.25, metadata: { mode: "desktop" } });
    expect(validateEvent({ ...browser, quantity: 0 })).toContain("browser_minute_consumed quantity must be > 0");
    const evidence = buildEvent(EVENT_EVIDENCE_BYTE_STORED, { run: "r", workspace: "w", source: "s", quantity: 5, metadata: { kind: "text", path: "p" } });
    expect(validateEvent({ ...evidence, quantity: 1.5 })).toContain("evidence_byte_stored quantity must be a non-negative integer");
    const exp = buildEvent(EVENT_EXPORT_GENERATED, { run: "r", workspace: "w", source: "s", metadata: { format: "sarif" } });
    expect(validateEvent({ ...exp, quantity: 2 })).toContain("export_generated quantity must be 1");
    expect(validateEvent({ ...base, timestamp: "not-a-time" })).toContain("timestamp must be an ISO-8601 datetime");
  });

  it("computes stable default idempotency keys and auto-fills envelope fields", () => {
    const k1 = defaultIdempotencyKey("run-1", EVENT_CHECK_EXECUTED, 1, "check", { check_id: "a", status: "passed" });
    const k2 = defaultIdempotencyKey("run-1", EVENT_CHECK_EXECUTED, 1, "check", { status: "passed", check_id: "a" });
    expect(k1).toBe(k2);
    expect(k1.startsWith("run-1:check_executed:")).toBe(true);

    const event = buildEvent(EVENT_RUN_STARTED, { run: "run-2", workspace: "ws", source: "oss", metadata: { workflow_id: "w" } });
    expect(event.event_id).toBeTruthy();
    expect(event.idempotency_key).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
    expect(validateEvent(event)).toEqual([]);
  });

  it("appends to local JSONL sink, dedupes by idempotency in-memory and after reload", async () => {
    const root = await makeTempDir();
    const emitter = new MeteringEmitter(root, "run-1", { workspace: "ws-1", source: "oss" });
    const first = emitter.emit(EVENT_CHECK_EXECUTED, 1, "check", {
      idempotency_key: "run-1:check:static.tests",
      metadata: { check_id: "static.tests", status: "passed" },
    });
    const duplicate = emitter.emit(EVENT_CHECK_EXECUTED, 1, "check", {
      idempotency_key: "run-1:check:static.tests",
      metadata: { check_id: "static.tests", status: "passed" },
    });
    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].workspace).toBe("ws-1");

    const reloaded = new MeteringEmitter(root, "run-1", { workspace: "ws-1", source: "oss" });
    expect(
      reloaded.emit(EVENT_CHECK_EXECUTED, 1, "check", {
        idempotency_key: "run-1:check:static.tests",
        metadata: { check_id: "static.tests", status: "passed" },
      }),
    ).toBeNull();
    expect(readEvents(root)).toHaveLength(1);
  });

  it("supports configurable sink/workspace/source and deterministic sink-wide + run-scoped summaries", async () => {
    const root = await makeTempDir();
    const customSink = path.join(root, "custom", "usage.jsonl");
    const a = new MeteringEmitter(root, "run-a", { workspace: "acme", source: "oss", sink: customSink });
    a.emit(EVENT_RUN_STARTED, 1, "run", { metadata: { workflow_id: "release-confidence" } });
    a.emit(EVENT_CHECK_EXECUTED, 1, "check", { metadata: { check_id: "c1", status: "passed" } });
    a.emit(EVENT_EXPORT_GENERATED, 1, "export", { metadata: { format: "sarif" } });
    const b = new MeteringEmitter(root, "run-b", { workspace: "acme", source: "oss", sink: customSink });
    b.emit(EVENT_RUN_STARTED, 1, "run", { metadata: { workflow_id: "release-confidence" } });
    b.emit(EVENT_CHECK_EXECUTED, 1, "check", { metadata: { check_id: "c2", status: "failed" } });

    const events = readEvents(root, customSink);
    expect(events.every((e) => e.workspace === "acme")).toBe(true);
    const sa = a.summary();
    const sb = b.summary();
    expect(sa.schema_version).toBe(METERING_SCHEMA_VERSION);
    expect(sa.sink).toBe(path.join("custom", "usage.jsonl"));
    expect(sa.event_count).toBe(5);
    expect(sa.run_event_count).toBe(3);
    expect(sa.event_types).toEqual({ check_executed: 2, export_generated: 1, run_started: 2 });
    expect(sa.run_event_types).toEqual({ check_executed: 1, export_generated: 1, run_started: 1 });
    expect(sb.event_count).toBe(5);
    expect(sb.run_event_count).toBe(2);
    expect(sb.run_event_types).toEqual({ check_executed: 1, run_started: 1 });
    expect(Object.keys(sa.event_types)).toEqual([...Object.keys(sa.event_types)].sort());
  });

  it("exposes deduped events() view", async () => {
    const root = await makeTempDir();
    const emitter = new MeteringEmitter(root, "run-1", { workspace: "ws", source: "oss" });
    emitter.emit(EVENT_RUN_STARTED, 1, "run", { metadata: { workflow_id: "w" } });
    emitter.emit(EVENT_CHECK_EXECUTED, 1, "check", { metadata: { check_id: "a", status: "ok" } });
    const sink = path.join(root, DEFAULT_SINK);
    const lines = fs.readFileSync(sink, "utf8").trim().split("\n");
    fs.appendFileSync(sink, lines[0] + "\n");
    expect(emitter.events()).toHaveLength(2);
  });
});
