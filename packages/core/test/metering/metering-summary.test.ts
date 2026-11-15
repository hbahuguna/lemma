import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  METERING_SUMMARY_SCHEMA_VERSION,
  readMeteringEvents,
  summarizeMeteringEvents,
  summarizeMeteringSink,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-metering-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-072 run-scoped and sink-wide metering summaries", () => {
  it("computes sink-wide and run-scoped counts/types with idempotency-key dedupe and deterministic ordering", () => {
    const events = [
      { schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "run_started", run: "run-1", workspace: "local", idempotency_key: "k1" },
      { schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "check_executed", run: "run-1", workspace: "local", idempotency_key: "k2" },
      { schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "evidence_byte_stored", run: "run-1", workspace: "local", idempotency_key: "k3" },
      { schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "check_executed", run: "run-2", workspace: "local", idempotency_key: "k4" },
      { schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "export_generated", run: "run-2", workspace: "local", idempotency_key: "k5" },
      { schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "check_executed", run: "run-1", workspace: "local", idempotency_key: "k2" }, // duplicate
    ];

    const run1 = summarizeMeteringEvents(events, "run-1", { sink: ".lemma/metering/events.jsonl" });
    expect(run1.schema_version).toBe(METERING_SUMMARY_SCHEMA_VERSION);
    expect(run1.sink).toBe(".lemma/metering/events.jsonl");
    expect(run1.workspace).toBe("local");
    expect(run1.event_count).toBe(5); // sink-wide, deduped
    expect(run1.run_event_count).toBe(3);
    expect(run1.event_types).toEqual({
      check_executed: 2,
      evidence_byte_stored: 1,
      export_generated: 1,
      run_started: 1,
    });
    expect(Object.keys(run1.event_types)).toEqual(["check_executed", "evidence_byte_stored", "export_generated", "run_started"]);
    expect(run1.run_event_types).toEqual({
      check_executed: 1,
      evidence_byte_stored: 1,
      run_started: 1,
    });
    expect(Object.keys(run1.run_event_types)).toEqual(["check_executed", "evidence_byte_stored", "run_started"]);

    const run2 = summarizeMeteringEvents(events, "run-2", { sink: ".lemma/metering/events.jsonl" });
    expect(run2.event_count).toBe(5);
    expect(run2.run_event_count).toBe(2);
    expect(run2.run_event_types).toEqual({ check_executed: 1, export_generated: 1 });
  });

  it("reads JSONL sink and summarizes shared sink across runs (run-scoped vs cumulative)", async () => {
    await withTempDir(async (root) => {
      const sinkRel = ".lemma/metering/events.jsonl";
      const sinkAbs = path.join(root, sinkRel);
      await mkdir(path.dirname(sinkAbs), { recursive: true });
      const lines = [
        JSON.stringify({ schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "run_started", run: "run-a", workspace: "ws", idempotency_key: "a1" }),
        JSON.stringify({ schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "check_executed", run: "run-a", workspace: "ws", idempotency_key: "a2" }),
        JSON.stringify({ schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "check_executed", run: "run-b", workspace: "ws", idempotency_key: "b1" }),
        "{bad json",
        JSON.stringify({ schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "evidence_byte_stored", run: "run-b", workspace: "ws", idempotency_key: "b2" }),
        JSON.stringify({ schema_version: METERING_SUMMARY_SCHEMA_VERSION, event_type: "check_executed", run: "run-a", workspace: "ws", idempotency_key: "a2" }),
      ];
      await writeFile(sinkAbs, lines.join("\n") + "\n", "utf8");

      const events = await readMeteringEvents(sinkAbs);
      expect(events).toHaveLength(4); // deduped + malformed skipped

      const first = await summarizeMeteringSink(root, "run-a", { sink: sinkRel });
      expect(first.sink).toBe(sinkRel);
      expect(first.workspace).toBe("ws");
      expect(first.event_count).toBe(4);
      expect(first.run_event_count).toBe(2);
      expect(first.run_event_types).toEqual({ check_executed: 1, run_started: 1 });

      const second = await summarizeMeteringSink(root, "run-b", { sink: sinkRel });
      expect(second.event_count).toBe(4);
      expect(second.run_event_count).toBe(2);
      expect(second.event_count).toBeGreaterThan(second.run_event_count - 0); // shared sink
      expect(second.event_types).toEqual({ check_executed: 2, evidence_byte_stored: 1, run_started: 1 });
      expect(second.run_event_types).toEqual({ check_executed: 1, evidence_byte_stored: 1 });
    });
  });

  it("handles missing sink and preserves explicit workspace/sink display", async () => {
    await withTempDir(async (root) => {
      const summary = await summarizeMeteringSink(root, "run-x", { sink: ".lemma/metering/missing.jsonl", workspace: "acme" });
      expect(summary.event_count).toBe(0);
      expect(summary.run_event_count).toBe(0);
      expect(summary.event_types).toEqual({});
      expect(summary.run_event_types).toEqual({});
      expect(summary.workspace).toBe("acme");
      expect(summary.sink).toBe(".lemma/metering/missing.jsonl");
    });
  });
});
