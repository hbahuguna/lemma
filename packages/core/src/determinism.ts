import { createHash, randomUUID } from "node:crypto";

import { HarnessError } from "./errors.js";

export { HarnessError };

export type ClockMode = "real" | "frozen";
export const CLOCK_MODES = new Set<ClockMode>(["real", "frozen"]);

export function parseTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("expected an ISO-8601 timestamp");
    return new Date(value.getTime());
  }
  let raw: string;
  if (typeof value === "string") raw = value;
  else if (typeof value === "number") raw = String(value);
  else raw = "";
  const text = raw.trim();
  if (!text) throw new Error("expected an ISO-8601 timestamp");
  const normalized = text.endsWith("Z") ? `${text.slice(0, -1)}+00:00` : text;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new Error(`expected an ISO-8601 timestamp: ${text}`);
  return new Date(ms);
}

export function formatTimestamp(value: unknown): string {
  const d = parseTimestamp(value);
  // second precision UTC with Z suffix
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface Clock {
  now(): Date;
}

export interface Entropy {
  hexChars(length: number): string;
}

export class RealClock implements Clock {
  now(): Date {
    const d = new Date();
    d.setUTCMilliseconds(0);
    return d;
  }
}

export class FrozenClock implements Clock {
  private readonly value: Date;

  constructor(value: unknown) {
    this.value = parseTimestamp(value);
  }

  now(): Date {
    return new Date(this.value.getTime());
  }
}

export class RealEntropy implements Entropy {
  hexChars(length: number): string {
    if (length <= 0) return "";
    let out = randomUUID().replace(/-/g, "");
    while (out.length < length) out += randomUUID().replace(/-/g, "");
    return out.slice(0, length);
  }
}

export class SeededEntropy implements Entropy {
  private readonly seed: string;
  private counter: number;

  constructor(seed: number, counter = 0) {
    this.seed = String(seed);
    this.counter = Math.max(0, Math.trunc(counter || 0));
  }

  hexChars(length: number): string {
    if (length <= 0) return "";
    const chunks: string[] = [];
    let produced = 0;
    while (produced < length) {
      const digest = createHash("sha256")
        .update(`${this.seed}:${this.counter}`, "utf8")
        .digest("hex");
      chunks.push(digest);
      produced += digest.length;
      this.counter += 1;
    }
    return chunks.join("").slice(0, length);
  }

  getCounter(): number {
    return this.counter;
  }
}

export interface DeterminismOptions {
  seed?: number | null;
  clockMode?: ClockMode;
  frozenClock?: unknown;
  entropyCounter?: number;
}

export class Determinism {
  readonly clock: Clock;
  readonly entropy: Entropy;
  readonly seed: number | null;
  readonly clockMode: ClockMode;

  constructor(clock: Clock, entropy: Entropy, seed: number | null, clockMode: ClockMode) {
    this.clock = clock;
    this.entropy = entropy;
    this.seed = seed;
    this.clockMode = clockMode;
  }

  now(): string {
    return formatTimestamp(this.clock.now());
  }

  newId(prefix: string): string {
    return `${prefix}-${this.entropy.hexChars(10)}`;
  }

  runId(): string {
    const stamp = this.now().replace(/-/g, "").replace(/:/g, "");
    return `${stamp}-${this.entropy.hexChars(6)}`;
  }

  toJSON(): { seed: number | null; clock_mode: ClockMode; entropy: string } {
    return {
      seed: this.seed,
      clock_mode: this.clockMode,
      entropy: this.seed === null ? "real" : "seeded",
    };
  }
}

export const PRODUCTION = new Determinism(new RealClock(), new RealEntropy(), null, "real");

export function makeDeterminism(options: DeterminismOptions = {}): Determinism {
  const seed = options.seed ?? null;
  const clockMode = options.clockMode ?? "real";
  const frozenClock = options.frozenClock;
  const entropyCounter = options.entropyCounter ?? 0;

  if (!CLOCK_MODES.has(clockMode)) {
    throw new HarnessError("clock_mode must be one of: real, frozen");
  }
  if (seed !== null) {
    if (typeof seed === "boolean" || !Number.isInteger(seed)) {
      throw new HarnessError("seed must be an integer or null");
    }
  }
  let clock: Clock;
  if (clockMode === "frozen") {
    if (frozenClock === undefined || frozenClock === null) {
      throw new HarnessError("frozen_clock is required when clock_mode is 'frozen'");
    }
    try {
      clock = new FrozenClock(frozenClock);
    } catch (exc) {
      throw new HarnessError(`frozen_clock must be an ISO-8601 timestamp: ${String(exc)}`);
    }
  } else {
    if (frozenClock !== undefined && frozenClock !== null) {
      throw new HarnessError("frozen_clock requires clock_mode 'frozen'");
    }
    clock = new RealClock();
  }

  const entropy: Entropy = seed !== null ? new SeededEntropy(seed, entropyCounter) : new RealEntropy();
  return new Determinism(clock, entropy, seed, clockMode);
}

// Active determinism context (single-threaded JS equivalent of Python contextvars)
let activeDeterminism: Determinism = PRODUCTION;

export function setDeterminism(determinism: Determinism): Determinism {
  const prev = activeDeterminism;
  activeDeterminism = determinism;
  return prev;
}

export function resetDeterminism(previous: Determinism): void {
  activeDeterminism = previous;
}

export function currentDeterminism(): Determinism {
  return activeDeterminism;
}

export function now(): string {
  return currentDeterminism().now();
}

export function newId(prefix: string): string {
  return currentDeterminism().newId(prefix);
}

export function runId(): string {
  return currentDeterminism().runId();
}
