import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactText, redactUnknown } from "@lemma/core";

export type SlashCommandTarget = "manager" | "catalog" | "dashboard" | "unknown";

export interface SlashCommandArgSpec {
  name: string;
  required: boolean;
  description: string;
}

export interface SlashCommandSpec {
  command: string;
  aliases?: string[];
  target: Exclude<SlashCommandTarget, "unknown">;
  description: string;
  intent: string;
  catalog_intent?: string;
  dashboard_route?: string;
  arguments: SlashCommandArgSpec[];
  errors: string[];
}

export interface SlashCommandCatalog {
  schema_version: string;
  commands: SlashCommandSpec[];
}

export interface SlashCommandDecisionBase {
  raw: string;
  command: string | null;
  argsText: string;
  args: string[];
}

export interface SlashCommandKnownDecision extends SlashCommandDecisionBase {
  kind: "known";
  target: Exclude<SlashCommandTarget, "unknown">;
  spec: SlashCommandSpec;
  intent: string;
  catalog_intent?: string;
  dashboard_route?: string;
  parsed: {
    named: Record<string, string | undefined>;
    positional: string[];
  };
}

export interface SlashCommandUnknownDecision extends SlashCommandDecisionBase {
  kind: "unknown";
  target: "unknown";
  error: {
    type: "unknown_command";
    message: string;
    command: string | null;
    hints: string[];
  };
}

export type SlashCommandDecision = SlashCommandKnownDecision | SlashCommandUnknownDecision;

export interface SlashCommandRouteResult {
  decision: SlashCommandDecision;
  /** Redaction-safe user-visible message suitable for manager narration when unknown/helpful. */
  message?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function repoRootFromHere(): string {
  // packages/agent/src -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../");
}

function loadCatalogFromDisk(): SlashCommandCatalog {
  const candidates = [
    path.resolve(repoRootFromHere(), "schemas/agent/slash-commands.v1.json"),
    path.resolve(process.cwd(), "schemas/agent/slash-commands.v1.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed) && Array.isArray(parsed.commands)) {
        return parsed as unknown as SlashCommandCatalog;
      }
    } catch {
      // try next
    }
  }
  // Fallback minimal catalog (should not happen in-repo); keeps router functional.
  return {
    schema_version: "lemma.agent.slash_commands/v1",
    commands: [
      { command: "/lemma-help", target: "manager", description: "Show available lemma slash commands and usage hints.", intent: "manager.help", arguments: [], errors: [] },
    ],
  };
}

const DEFAULT_CATALOG = loadCatalogFromDisk();

function normalizeCommandToken(raw: string): string {
  return raw.trim().toLowerCase();
}

function buildIndex(catalog: SlashCommandCatalog): Map<string, SlashCommandSpec> {
  const index = new Map<string, SlashCommandSpec>();
  for (const spec of catalog.commands) {
    index.set(normalizeCommandToken(spec.command), spec);
    for (const alias of spec.aliases ?? []) index.set(normalizeCommandToken(alias), spec);
  }
  return index;
}

export function getSlashCommandCatalog(catalog: SlashCommandCatalog = DEFAULT_CATALOG): SlashCommandCatalog {
  return catalog;
}

export function listSlashCommandHints(catalog: SlashCommandCatalog = DEFAULT_CATALOG): string[] {
  return catalog.commands.map((c) => {
    const args = c.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
    const usage = args ? `${c.command} ${args}` : c.command;
    return `${usage} — ${c.description}`;
  });
}

function redactSafeText(value: string): string {
  let s = redactText(String(value ?? ""));
  // Ensure bearer secrets never survive in echoed args/errors
  s = s.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  return s;
}

function tokenizeArgs(argsText: string): string[] {
  // Simple shell-like split for host-neutral chat args (quotes supported)
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsText)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter((x) => x.length > 0);
}

function parseNamedArgs(spec: SlashCommandSpec, positional: string[]): Record<string, string | undefined> {
  const named: Record<string, string | undefined> = {};
  if (spec.arguments.length === 0) return named;
  // Convention: first declared arg receives remaining/first positional value when applicable.
  const first = spec.arguments[0];
  if (first) {
    if (spec.arguments.length === 1) {
      named[first.name] = positional.length ? positional.join(" ") : undefined;
    } else {
      named[first.name] = positional[0];
      for (let i = 1; i < spec.arguments.length; i++) {
        const a = spec.arguments[i]!;
        named[a.name] = positional[i];
      }
    }
  }
  return named;
}

export function routeSlashCommand(
  rawMessage: string,
  catalog: SlashCommandCatalog = DEFAULT_CATALOG,
): SlashCommandRouteResult {
  const raw = redactSafeText(String(rawMessage ?? ""));
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    const hints = listSlashCommandHints(catalog).map((h) => redactSafeText(h));
    const decision: SlashCommandUnknownDecision = {
      kind: "unknown",
      target: "unknown",
      raw,
      command: null,
      argsText: "",
      args: [],
      error: {
        type: "unknown_command",
        message: "Not a slash command.",
        command: null,
        hints,
      },
    };
    return { decision };
  }

  const firstSpace = trimmed.search(/\s/);
  const cmdToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).trim();
  const argsText = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  const args = tokenizeArgs(argsText).map((a) => redactSafeText(a));
  const index = buildIndex(catalog);
  const spec = index.get(normalizeCommandToken(cmdToken));

  if (!spec) {
    const hints = listSlashCommandHints(catalog).map((h) => redactSafeText(h));
    const decision: SlashCommandUnknownDecision = {
      kind: "unknown",
      target: "unknown",
      raw,
      command: redactSafeText(cmdToken),
      argsText: redactSafeText(argsText),
      args,
      error: {
        type: "unknown_command",
        message: `Unknown slash command: ${redactSafeText(cmdToken)}`,
        command: redactSafeText(cmdToken),
        hints,
      },
    };
    return {
      decision,
      message: redactSafeText(
        [
          `Unknown slash command: ${redactSafeText(cmdToken)}`,
          "Try `/lemma-help` for available commands:",
          ...hints.map((h) => `- ${h}`),
        ].join("\n"),
      ),
    };
  }

  const positional = args;
  const decision: SlashCommandKnownDecision = {
    kind: "known",
    target: spec.target,
    raw,
    command: spec.command,
    argsText: redactSafeText(argsText),
    args,
    spec: redactUnknown(spec) as SlashCommandSpec,
    intent: spec.intent,
    ...(spec.catalog_intent ? { catalog_intent: spec.catalog_intent } : {}),
    ...(spec.dashboard_route ? { dashboard_route: spec.dashboard_route } : {}),
    parsed: {
      named: parseNamedArgs(spec, positional),
      positional,
    },
  };
  return { decision };
}

export function isSlashCommand(message: string): boolean {
  return String(message ?? "").trim().startsWith("/");
}

export function formatHelpMessage(catalog: SlashCommandCatalog = DEFAULT_CATALOG): string {
  const hints = listSlashCommandHints(catalog).map((h) => redactSafeText(h));
  return redactSafeText(["Available lemma slash commands:", ...hints.map((h) => `- ${h}`)].join("\n"));
}

export function resolveDashboardUrl(route: string, opts?: { baseUrl?: string; token?: string }): string {
  // Token must never be embedded in visible transcript; manager/host UI channel may attach it.
  // Return route path only (token handled out-of-band by host/manager channel).
  const base = (opts?.baseUrl ?? "").replace(/\/+$/, "");
  const pathPart = route.startsWith("/") ? route : `/${route}`;
  return redactSafeText(`${base}${pathPart}` || pathPart);
}
