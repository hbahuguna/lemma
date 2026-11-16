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



export type ProSpecialistId = "confidence" | "security" | "performance" | "privacy";












export function parseTestsSlash(raw: string): { action?: string; format?: string; suite?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-tests") return null;
  const argText = rest.join(" ").trim();
  const parts = argText.split(/\s+/).filter(Boolean);
  const action = parts[0] && !parts[0].startsWith("--") ? parts[0] : undefined;
  const fmtM = argText.match(/(?:^|\s)--format\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const suiteM = argText.match(/(?:^|\s)--suite\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const format = fmtM ? (fmtM[1] || fmtM[2] || fmtM[3] || "").trim() || undefined : undefined;
  const suite = suiteM ? (suiteM[1] || suiteM[2] || suiteM[3] || "").trim() || undefined : undefined;
  return { ...(action ? { action } : {}), ...(format ? { format } : {}), ...(suite ? { suite } : {}) };
}


export function parseUpgradeSlash(raw: string): { kind?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-upgrade") return null;
  const argText = rest.join(" ").trim();
  const parts = argText.split(/\s+/).filter(Boolean);
  const kind = parts[0] && !parts[0].startsWith("--") ? parts[0] : undefined;
  return { ...(kind ? { kind } : {}) };
}

export function parseGenerateSlash(raw: string): { source?: string; maxTests?: number; url?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-generate") return null;
  const argText = rest.join(" ").trim();
  const srcM = argText.match(/(?:^|\s)--source\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const maxM = argText.match(/(?:^|\s)--max-tests\s+(\d+)/i);
  const urlM = argText.match(/(?:^|\s)--(?:url|target)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const source = srcM ? (srcM[1] || srcM[2] || srcM[3] || "").trim() || undefined : (argText && !argText.startsWith("--") ? argText.split(/\s+/)[0] : undefined);
  const url = urlM ? (urlM[1] || urlM[2] || urlM[3] || "").trim() || undefined : undefined;
  return {
    ...(source ? { source } : {}),
    ...(maxM ? { maxTests: parseInt(maxM[1]!, 10) } : {}),
    ...(url ? { url } : {}),
  };
}

export function parseHumanSlash(raw: string): { runId?: string; questions?: string; answers?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-human") return null;
  const argText = rest.join(" ").trim();
  const runM = argText.match(/(?:^|\s)--run(?:-id)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const qM = argText.match(/(?:^|\s)--questions\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const aM = argText.match(/(?:^|\s)--answers\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const runId = runM ? (runM[1] || runM[2] || runM[3] || "").trim() || undefined : undefined;
  const questions = qM ? (qM[1] || qM[2] || qM[3] || "").trim() || undefined : undefined;
  const answers = aM ? (aM[1] || aM[2] || aM[3] || "").trim() || undefined : undefined;
  return { ...(runId ? { runId } : {}), ...(questions ? { questions } : {}), ...(answers ? { answers } : {}) };
}

export function parseBrowserSlash(raw: string): { url?: string; checks?: string[] } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-browser") return null;
  const argText = rest.join(" ").trim();
  const urlM = argText.match(/(?:^|\s)--(?:url|target)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i) || argText.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const checksM = argText.match(/(?:^|\s)--checks?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const url = urlM ? (urlM[1] || urlM[2] || urlM[3] || "").trim() || undefined : undefined;
  const checks = checksM ? (checksM[1] || checksM[2] || checksM[3] || "").split(",").map(x=>x.trim()).filter(Boolean) : undefined;
  return { ...(url ? { url } : {}), ...(checks && checks.length ? { checks } : {}) };
}

export function parseAutoSlash(raw: string): { maxCycles?: number; resume?: boolean; runId?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-auto") return null;
  const argText = rest.join(" ").trim();
  const maxM = argText.match(/(?:^|\s)--max-cycles\s+(\d+)/i);
  const resume = /(?:^|\s)--resume(?:\s|$)/i.test(argText);
  const runM = argText.match(/(?:^|\s)--run(?:-id)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const runId = runM ? (runM[1] || runM[2] || runM[3] || "").trim() || undefined : undefined;
  return {
    ...(maxM ? { maxCycles: parseInt(maxM[1]!, 10) } : {}),
    ...(resume ? { resume: true } : {}),
    ...(runId ? { runId } : {}),
  };
}

export function parseMoreSlash(raw: string): { runId?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-more") return null;
  const argText = rest.join(" ").trim();
  const m = argText.match(/(?:^|\s)--run(?:-id)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const runId = m ? (m[1] || m[2] || m[3] || "").trim() || undefined : (argText && !argText.startsWith("--") ? argText : undefined);
  return { ...(runId ? { runId } : {}) };
}

export function parseModelEvalSlash(raw: string): { cases?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-eval" && c !== "/eval") return null;
  const argText = rest.join(" ").trim();
  const m = argText.match(/(?:^|\s)--cases\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const cases = m ? (m[1] || m[2] || m[3] || "").trim() || undefined : (argText && !argText.startsWith("--") ? argText : undefined);
  return {
    ...(cases ? { cases } : {}),
  };
}

export function parseProofSlash(raw: string): { property?: string; target?: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  if (c !== "/lemma-proof" && c !== "/proof") return null;
  const argText = rest.join(" ").trim();
  const get = (name: string): string | undefined => {
    const re = new RegExp(`(?:^|\\s)--${name}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "i");
    const m = argText.match(re);
    if (!m) return undefined;
    const v = (m[1] || m[2] || m[3] || "").trim();
    return v || undefined;
  };
  const property = get("property");
  const target = get("target") || (argText && !argText.startsWith("--") ? argText : undefined);
  return {
    ...(property ? { property } : {}),
    ...(target ? { target } : {}),
  };
}

export function parseProSpecialistSlash(raw: string): { specialist: ProSpecialistId; target: string } | null {
  const s = redactSafeText(String(raw || "")).trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  const c = (cmd || "").toLowerCase();
  const argText = rest.join(" ").trim();
  const map: Record<string, ProSpecialistId> = {
    "/lemma-confidence": "confidence",
    "/lemma-security": "security",
    "/lemma-performance": "performance",
    "/lemma-privacy": "privacy",
  };
  if (map[c]) return { specialist: map[c]!, target: argText || "." };
  if (c === "/lemma-pro" || c === "/pro") {
    const [sub, ...more] = argText.split(/\s+/);
    const subLc = (sub || "").toLowerCase() as ProSpecialistId;
    if (subLc === "confidence" || subLc === "security" || subLc === "performance" || subLc === "privacy") {
      return { specialist: subLc, target: more.join(" ").trim() || "." };
    }
  }
  return null;
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
  const proSpecialist = parseProSpecialistSlash(raw);
  const proof = parseProofSlash(raw);
  const modelEval = parseModelEvalSlash(raw);
  const more = parseMoreSlash(raw);
  const auto = parseAutoSlash(raw);
  const browser = parseBrowserSlash(raw);
  const human = parseHumanSlash(raw);
  const generate = parseGenerateSlash(raw);
  const tests = parseTestsSlash(raw);
  const upgrade = parseUpgradeSlash(raw);
  const isProof = spec.intent === "pro.proof" || proof !== null || spec.command === "/lemma-proof";
  const isModelEval = spec.intent === "pro.model_eval" || modelEval !== null || spec.command === "/lemma-eval";
  const isMore = more !== null || spec.command === "/lemma-more";
  const isAuto = auto !== null || spec.command === "/lemma-auto";
  const isBrowser = browser !== null || spec.command === "/lemma-browser";
  const isHuman = human !== null || spec.command === "/lemma-human";
  const isGenerate = generate !== null || spec.command === "/lemma-generate";
  const isTests = tests !== null || spec.command === "/lemma-tests";
  const isUpgrade = upgrade !== null || spec.command === "/lemma-upgrade";
  const decision: any = {
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
    ...(proSpecialist ? { pro_specialist: proSpecialist.specialist, pro_target: proSpecialist.target } : {}),
    ...(isProof
      ? {
          pro_proof: true,
          ...(proof?.property ? { proof_property: proof.property } : {}),
          ...(proof?.target ? { proof_target: proof.target } : {}),
        }
      : {}),
    ...(isModelEval
      ? {
          pro_model_eval: true,
          ...(modelEval?.cases ? { model_eval_cases: modelEval.cases } : {}),
        }
      : {}),
    ...(isMore
      ? {
          lemma_more: true,
          ...(more?.runId ? { more_run_id: more.runId } : {}),
        }
      : {}),
    ...(isAuto
      ? {
          lemma_auto: true,
          ...(auto?.maxCycles ? { auto_max_cycles: auto.maxCycles } : {}),
          ...(auto?.resume ? { auto_resume: true } : {}),
          ...(auto?.runId ? { auto_run_id: auto.runId } : {}),
        }
      : {}),
    ...(isBrowser
      ? {
          lemma_browser: true,
          ...(browser?.url ? { browser_target: browser.url } : {}),
          ...(browser?.checks ? { browser_checks: browser.checks } : {}),
        }
      : {}),
    ...(isHuman
      ? {
          lemma_human: true,
          ...(human?.runId ? { human_run_id: human.runId } : {}),
          ...(human?.questions ? { human_questions: human.questions } : {}),
          ...(human?.answers ? { human_answers: human.answers } : {}),
        }
      : {}),
    ...(isGenerate
      ? {
          lemma_generate: true,
          ...(generate?.source ? { generate_source: generate.source } : {}),
          ...(generate?.maxTests ? { generate_max_tests: generate.maxTests } : {}),
          ...(generate?.url ? { generate_url: generate.url } : {}),
        }
      : {}),
    ...(isTests
      ? {
          lemma_tests: true,
          ...(tests?.action ? { tests_action: tests.action } : {}),
          ...(tests?.format ? { tests_format: tests.format } : {}),
          ...(tests?.suite ? { tests_suite: tests.suite } : {}),
        }
      : {}),
    ...(isUpgrade
      ? {
          lemma_upgrade: true,
          ...(upgrade?.kind ? { upgrade_kind: upgrade.kind } : {}),
        }
      : {}),
  };
  let message: string | undefined;
  if ((spec.command === "/lemma-pro" || spec.intent === "dashboard.pro") && !proSpecialist) {
    // default to static summary (dashboard-off/agent-only); callers can override with dashboard-running context
    message = renderLemmaProSummary({ dashboardRunning: false, route: spec.dashboard_route ?? "/pro" });
  } else if (spec.command === "/lemma-help" || spec.intent === "manager.help") {
    message = formatHelpMessage(catalog);
  }
  return message ? { decision, message } : { decision };
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


export const LEMMA_PRO_LEARN_MORE_URL = "https://lemma.dev/pro" as const;

export function renderLemmaProSummary(opts?: { dashboardRunning?: boolean; dashboardBaseUrl?: string; route?: string }): string {
  const route = opts?.route ?? "/pro";
  const running = opts?.dashboardRunning === true;
  const base = (opts?.dashboardBaseUrl ?? "").replace(/\/+$/, "");
  const link = running ? `${base}${route.startsWith("/") ? route : `/${route}`}` || route : "";
  const lines = [
    "Lemma Pro (informational)",
    "- This is informational only: it does not start a checkout, does not collect data, and does not require an account.",
    "- Pro edition features (summary): team/release workflows, advanced reporting and review experiences, and hosted/support options where available.",
    "- Pricing summary: to be announced; see the learn-more link for current details.",
    `- Learn more: ${LEMMA_PRO_LEARN_MORE_URL}`,
  ];
  if (running && link) {
    lines.splice(1, 0, `- Dashboard (running): open ${link} (token-protected; token handled out-of-band).`);
  } else {
    lines.splice(1, 0, "- Dashboard is off: showing static summary (CLI/agent-only context).");
  }
  return redactSafeText(lines.join("\n"));
}
