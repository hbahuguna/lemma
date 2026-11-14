import { describe, expect, it } from "vitest";

import type { Determinism } from "../../src/index.js";
import {
  FrozenClock,
  HarnessError,
  RealClock,
  RealEntropy,
  SeededEntropy,
  currentDeterminism,
  formatTimestamp,
  makeDeterminism,
  newId,
  now,
  parseTimestamp,
  resetDeterminism,
  runId,
  setDeterminism,
} from "../../src/index.js";

describe("LEM-006 determinism", () => {
  it("exposes clock/entropy providers with assay-like semantics", () => {
    expect(typeof RealClock.prototype.now).toBe("function");
    expect(typeof FrozenClock.prototype.now).toBe("function");
    expect(typeof RealEntropy.prototype.hexChars).toBe("function");
    expect(typeof SeededEntropy.prototype.hexChars).toBe("function");

    const frozen = new FrozenClock("2026-11-14T00:00:00Z");
    expect(formatTimestamp(frozen.now())).toBe("2026-11-14T00:00:00Z");
    expect(parseTimestamp("2026-11-14T00:00:00Z").toISOString()).toBe("2026-11-14T00:00:00.000Z");

    const seeded = new SeededEntropy(1337);
    const a = seeded.hexChars(10);
    const b = seeded.hexChars(10);
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    expect(a).not.toBe(b); // advances counter
    expect(new SeededEntropy(1337).hexChars(10)).toBe(a);
  });

  it("same seed and frozen clock produce byte-identical deterministic outputs", () => {
    const make = () =>
      makeDeterminism({ seed: 1337, clockMode: "frozen", frozenClock: "2026-11-14T00:00:00Z" });
    const d1 = make();
    const d2 = make();

    const out = (d: Determinism) => ({
      run_id: d.runId(),
      ids: [d.newId("finding"), d.newId("check"), d.newId("finding")],
      now: d.now(),
      determinism: d.toJSON(),
      // stand-ins for stable report-relevant details derived only from deterministic providers
      findings: [{ id: d.newId("finding"), weight: 1.4 }],
      weights: [2.0, 1.0],
      phase_detail: { manifest_sha: d.entropy.hexChars(12) },
      confidence_breakdown: { score: 30.2, band: "low" },
    });

    const a = out(d1);
    const b = out(d2);
    expect(Buffer.from(JSON.stringify(a)).toString("hex")).toBe(
      Buffer.from(JSON.stringify(b)).toString("hex"),
    );
    expect(a).toEqual(b);
  });

  it("production defaults use real UTC and cryptographically random ids", () => {
    const d = makeDeterminism();
    expect(d.clockMode).toBe("real");
    expect(d.seed).toBeNull();
    expect(d.toJSON()).toEqual({ seed: null, clock_mode: "real", entropy: "real" });
    expect(d.clock).toBeInstanceOf(RealClock);
    expect(d.entropy).toBeInstanceOf(RealEntropy);

    const id1 = d.newId("run");
    const id2 = d.newId("run");
    expect(id1).not.toBe(id2);
    expect(d.runId()).toMatch(/^20\d{6}T\d{6}Z-[0-9a-f]{6}$/);
  });

  it("generated-at override concept: report field can differ while run timestamps come from clock", () => {
    const d = makeDeterminism({ seed: 7, clockMode: "frozen", frozenClock: "2026-11-14T00:00:00Z" });
    const prev = setDeterminism(d);
    try {
      const runTimestamp = now();
      const runIdentifier = runId();
      const generatedAtOverride = "2026-12-01T12:34:56Z"; // report-only override
      expect(runTimestamp).toBe("2026-11-14T00:00:00Z");
      expect(runIdentifier.startsWith("20261114T000000Z-")).toBe(true);
      expect(generatedAtOverride).not.toBe(runTimestamp);
      expect(now()).toBe("2026-11-14T00:00:00Z"); // clock unaffected
    } finally {
      resetDeterminism(prev);
    }
  });

  it("rejects invalid seed/clock combinations with typed errors", () => {
    expect(() => makeDeterminism({ clockMode: "nope" as never })).toThrow(HarnessError);
    expect(() => makeDeterminism({ seed: 1.5 })).toThrow(HarnessError);
    expect(() => makeDeterminism({ seed: true as never })).toThrow(HarnessError);
    expect(() => makeDeterminism({ clockMode: "frozen" })).toThrow(HarnessError);
    expect(() => makeDeterminism({ clockMode: "frozen", frozenClock: "not-a-date" })).toThrow(HarnessError);
    expect(() => makeDeterminism({ clockMode: "real", frozenClock: "2026-11-14T00:00:00Z" })).toThrow(HarnessError);

    try {
      makeDeterminism({ clockMode: "frozen" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      expect((e as Error).name).toBe("HarnessError");
      expect((e as Error).message).toContain("frozen_clock is required");
    }

    // active context helpers still work
    expect(typeof currentDeterminism().now()).toBe("string");
    expect(newId("x")).toMatch(/^x-[0-9a-f]{10}$/);
  });
});
