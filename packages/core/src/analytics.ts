import { randomUUID } from "node:crypto";
import path from "node:path";

import { HarnessError } from "./errors.js";
import { atomicWriteFile, readJsonFile } from "./state.js";
import type { StateStore } from "./state-store.js";
import { loadSettings } from "./settings.js";

export const ANALYTICS_SCHEMA_VERSION = "lemma.analytics/v1" as const;
export const ANALYTICS_INSTALL_ID_FILE = "analytics-install-id";
export const DEFAULT_ANALYTICS_ENDPOINT = "https://analytics.lemma.dev/v1/events";

export type AnalyticsEventName =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "command_invoked"
  | "settings_toggled";

const EVENT_ALLOWLIST = new Set<AnalyticsEventName>([
  "run_started",
  "run_completed",
  "run_failed",
  "command_invoked",
  "settings_toggled",
]);

const PROPS_ALLOWLIST: Record<AnalyticsEventName, Record<string, "string" | "boolean" | "number">> = {
  run_started: { workflow: "string", resume: "boolean" },
  run_completed: { workflow: "string", status: "string", duration_ms: "number" },
  run_failed: { workflow: "string", status: "string" },
  command_invoked: { command: "string" },
  settings_toggled: { enabled: "boolean" },
};

export interface AnalyticsEvent {
  schema_version: typeof ANALYTICS_SCHEMA_VERSION;
  event: AnalyticsEventName;
  install_id: string;
  timestamp: string;
  props: Record<string, string | boolean | number>;
}

export interface RecordEventOptions {
  store: StateStore;
  now?: () => string;
  endpoint?: string | null;
  enabledOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  flushTimeoutMs?: number;
  stderr?: (msg: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function diag(stderr: ((msg: string) => void) | undefined, msg: string): void {
  try {
    (stderr ?? ((m: string) => process.stderr.write(m)))(`[lemma:analytics] ${msg}\n`);
  } catch {
    // never fail
  }
}

function envForcesOff(env: NodeJS.ProcessEnv): boolean {
  const v = String(env.LEMMA_ANALYTICS ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "disabled";
}

export function isAnalyticsEventName(name: string): name is AnalyticsEventName {
  return EVENT_ALLOWLIST.has(name as AnalyticsEventName);
}

export function stripAnalyticsProps(name: AnalyticsEventName, props: unknown): Record<string, string | boolean | number> {
  if (!isRecord(props)) return {};
  const allow = PROPS_ALLOWLIST[name];
  const out: Record<string, string | boolean | number> = {};
  for (const [k, t] of Object.entries(allow)) {
    if (!(k in props)) continue;
    const v = (props as Record<string, unknown>)[k];
    if (t === "string" && typeof v === "string") {
      // command/workflow/status are coarse labels; never allow paths/prompts/code blobs
      out[k] = v.length > 120 ? v.slice(0, 120) : v;
    } else if (t === "boolean" && typeof v === "boolean") {
      out[k] = v;
    } else if (t === "number" && typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.max(0, Math.round(v));
    }
  }
  return out;
}

export async function getOrCreateInstallId(store: Pick<StateStore, "lemmaDir" | "ensure">): Promise<string> {
  await store.ensure();
  const filePath = path.join(store.lemmaDir, ANALYTICS_INSTALL_ID_FILE);
  try {
    const existing = await readJsonFile<{ install_id?: string }>(filePath).catch(async () => {
      // support plain text uuid written atomically
      const fs = await import("node:fs/promises");
      const txt = (await fs.readFile(filePath, "utf8")).trim();
      return { install_id: txt };
    });
    const id = typeof existing.install_id === "string" ? existing.install_id.trim() : "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return id.toLowerCase();
    }
  } catch {
    // create new
  }
  const id = randomUUID();
  await atomicWriteFile(filePath, `${id}\n`, { encoding: "utf8" });
  return id;
}

async function isEnabled(store: StateStore, opts: RecordEventOptions): Promise<{ enabled: boolean; endpoint: string | null }> {
  const env = opts.env ?? process.env;
  if (envForcesOff(env)) return { enabled: false, endpoint: null };
  if (typeof opts.enabledOverride === "boolean") {
    return { enabled: opts.enabledOverride, endpoint: opts.endpoint ?? null };
  }
  try {
    const settings = await loadSettings(store);
    return { enabled: settings.analytics.enabled === true, endpoint: settings.analytics.endpoint ?? opts.endpoint ?? DEFAULT_ANALYTICS_ENDPOINT };
  } catch {
    return { enabled: false, endpoint: null };
  }
}

export async function flushAnalyticsEvents(
  events: AnalyticsEvent[],
  endpoint: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; stderr?: (msg: string) => void } = {},
): Promise<void> {
  if (events.length === 0) return;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== "function") {
    diag(opts.stderr, "No fetch implementation available; dropping analytics events.");
    return;
  }
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: ANALYTICS_SCHEMA_VERSION, events }),
      signal: controller.signal,
    }).catch((err) => {
      diag(opts.stderr, `Flush failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    diag(opts.stderr, `Flush error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

const buffers = new WeakMap<StateStore, { events: AnalyticsEvent[]; scheduled: boolean }>();

function getBuffer(store: StateStore): { events: AnalyticsEvent[]; scheduled: boolean } {
  let b = buffers.get(store);
  if (!b) { b = { events: [], scheduled: false }; buffers.set(store, b); }
  return b;
}

export async function recordEvent(name: string, props: unknown = undefined, options: RecordEventOptions): Promise<void> {
  if (!isAnalyticsEventName(name)) {
    throw new HarnessError(`Unknown analytics event: ${String(name)}`, { code: "harness_error", details: { event: String(name) } });
  }
  const store = options.store;
  const { enabled, endpoint } = await isEnabled(store, options).catch(() => ({ enabled: false, endpoint: null as string | null }));
  if (!enabled) return;

  try {
    const installId = await getOrCreateInstallId(store);
    const event: AnalyticsEvent = {
      schema_version: ANALYTICS_SCHEMA_VERSION,
      event: name,
      install_id: installId,
      timestamp: (options.now ?? (() => new Date().toISOString()))(),
      props: stripAnalyticsProps(name, props),
    };
    const buf = getBuffer(store);
    buf.events.push(event);
    if (!buf.scheduled) {
      buf.scheduled = true;
      const ep = (options.endpoint ?? endpoint ?? DEFAULT_ANALYTICS_ENDPOINT);
      const timeoutMs = options.flushTimeoutMs ?? 1000;
      // async flush with hard timeout; never fail caller/run
      setTimeout(() => {
        const pending = buf.events.splice(0, buf.events.length);
        buf.scheduled = false;
        void flushAnalyticsEvents(pending, ep, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), timeoutMs, ...(options.stderr ? { stderr: options.stderr } : {}) }).catch((err) => {
          diag(options.stderr, `Async flush error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 0);
    }
  } catch (err) {
    diag(options.stderr, `recordEvent failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function analyticsEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (envForcesOff(env)) return false;
  const v = String(env.LEMMA_ANALYTICS ?? "").trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true" || v === "enabled") return true;
  return null;
}
