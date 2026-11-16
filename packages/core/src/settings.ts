import path from "node:path";

import { StateError } from "./errors.js";
import { redactUnknown } from "./redaction.js";
import { atomicWriteJson, readJsonFile } from "./state.js";
import type { StateStore } from "./state-store.js";

export const SETTINGS_SCHEMA_VERSION = "lemma.settings/v1" as const;

export interface SettingsBudget {
  minutes: number;
  maxChecks: number;
}

export interface SettingsFocus {
  project: string | null;
  url: string | null;
}

export interface SettingsAnalytics {
  enabled: boolean;
  endpoint: string | null;
}

export interface LemmaSettings {
  schema_version: typeof SETTINGS_SCHEMA_VERSION;
  budget: SettingsBudget;
  focus: SettingsFocus;
  analytics: SettingsAnalytics;
}

export const DEFAULT_SETTINGS: LemmaSettings = {
  schema_version: SETTINGS_SCHEMA_VERSION,
  budget: { minutes: 10, maxChecks: 20 },
  focus: { project: null, url: null },
  analytics: { enabled: false, endpoint: null },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new StateError(message, { code: "state_error", details });
}

function expectInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    fail(`Invalid settings field: ${name} must be a non-negative integer`, { field: name, value: v });
  }
  return v;
}

function expectBool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") {
    fail(`Invalid settings field: ${name} must be a boolean`, { field: name, value: v });
  }
  return v;
}

function expectNullableString(v: unknown, name: string): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  fail(`Invalid settings field: ${name} must be a string or null`, { field: name, value: v });
}

export function validateSettings(input: unknown): LemmaSettings {
  if (!isRecord(input)) fail("Settings must be an object", { value: input });
  if (input.schema_version !== SETTINGS_SCHEMA_VERSION) {
    fail(`Unsupported settings schema_version`, { schema_version: input.schema_version });
  }
  const budgetRaw = input.budget;
  const focusRaw = input.focus;
  const analyticsRaw = input.analytics;
  if (!isRecord(budgetRaw) || !isRecord(focusRaw) || !isRecord(analyticsRaw)) {
    fail("Settings budget/focus/analytics must be objects", {});
  }
  const budget: SettingsBudget = {
    minutes: expectInt(budgetRaw.minutes, "budget.minutes"),
    maxChecks: expectInt(budgetRaw.maxChecks, "budget.maxChecks"),
  };
  const focus: SettingsFocus = {
    project: expectNullableString(focusRaw.project, "focus.project"),
    url: expectNullableString(focusRaw.url, "focus.url"),
  };
  const analytics: SettingsAnalytics = {
    enabled: expectBool(analyticsRaw.enabled, "analytics.enabled"),
    endpoint: expectNullableString(analyticsRaw.endpoint, "analytics.endpoint"),
  };
  // reject unknown top-level or nested keys
  for (const k of Object.keys(input)) {
    if (!["schema_version", "budget", "focus", "analytics"].includes(k)) fail(`Unknown settings field: ${k}`, { field: k });
  }
  for (const k of Object.keys(budgetRaw)) if (!["minutes", "maxChecks"].includes(k)) fail(`Unknown settings field: budget.${k}`, { field: `budget.${k}` });
  for (const k of Object.keys(focusRaw)) if (!["project", "url"].includes(k)) fail(`Unknown settings field: focus.${k}`, { field: `focus.${k}` });
  for (const k of Object.keys(analyticsRaw)) if (!["enabled", "endpoint"].includes(k)) fail(`Unknown settings field: analytics.${k}`, { field: `analytics.${k}` });

  return { schema_version: SETTINGS_SCHEMA_VERSION, budget, focus, analytics };
}

export function settingsPath(store: Pick<StateStore, "lemmaDir">): string {
  return path.join(store.lemmaDir, "settings.json");
}

export async function loadSettings(store: StateStore): Promise<LemmaSettings> {
  const p = settingsPath(store);
  try {
    const data = await readJsonFile<unknown>(p);
    try {
      return validateSettings(data);
    } catch (err) {
      if (err instanceof StateError) {
        throw new StateError(`Corrupt or invalid settings at ${p}`, {
          code: "state_error",
          details: { path: p, reason: err.message, ...((err as any).details ?? {}) },
        });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof StateError) {
      const reason = (err.details as any)?.reason;
      if (reason === "ENOENT" || err.message.includes("not found")) {
        return { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_SETTINGS.budget }, focus: { ...DEFAULT_SETTINGS.focus }, analytics: { ...DEFAULT_SETTINGS.analytics } };
      }
      // CorruptStateError from readJsonFile is StateError subclass in our system? readJsonFile throws CorruptStateError; treat as typed state error
      throw new StateError(`Corrupt or unreadable settings at ${p}`, { code: "state_error", details: { path: p, reason: err instanceof Error ? err.message : String(err) } });
    }
    throw err;
  }
}

export async function saveSettings(
  store: StateStore,
  next: unknown,
  meta?: { source?: string },
): Promise<LemmaSettings> {
  await store.ensure();
  const validated = validateSettings(next);
  let previous: LemmaSettings | null = null;
  try {
    previous = await loadSettings(store);
  } catch {
    previous = null;
  }
  const p = settingsPath(store);
  await atomicWriteJson(p, validated);
  try {
    await store.appendEvent({
      event: "settings_changed",
      source: meta?.source ?? "unknown",
      path: ".lemma/settings.json",
      previous: redactUnknown(previous),
      next: redactUnknown(validated),
    });
  } catch {
    // audit logging must never break settings writes beyond appendEvent's own guarantees
  }
  return validated;
}
