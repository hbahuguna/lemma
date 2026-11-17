import { browserInvocation, demoInvocation, type Invocation } from "./command-args.js";

export interface AssayCommand {
  name: string;
  label: string;
}

export type CatalogCommandKind = "browser" | "demo" | "static";

export interface CatalogInvocationResult {
  command: AssayCommand;
  intent: string;
  kind: CatalogCommandKind;
  invocation: Invocation;
}

/** Canonical 60-command lemma slash-command catalog (name/label). */
export const LEMMA_COMMAND_CATALOG: readonly AssayCommand[] = [
  { name: "lemma-manager", label: "manager" },
  { name: "lemma-full", label: "full" },
  { name: "lemma-test", label: "test" },
  { name: "lemma-functionality", label: "functionality" },
  { name: "lemma-browser", label: "browser" },
  { name: "lemma-issues", label: "issues" },
  { name: "lemma-demo", label: "demo" },
  { name: "lemma-more", label: "more" },
  { name: "lemma-help", label: "help" },
  { name: "lemma-accessibility", label: "accessibility" },
  { name: "lemma-ui", label: "ui" },
  { name: "lemma-ux", label: "ux" },
  { name: "lemma-usability", label: "usability" },
  { name: "lemma-personas", label: "personas" },
  { name: "lemma-compatibility", label: "compatibility" },
  { name: "lemma-intl", label: "intl" },
  { name: "lemma-localization", label: "localization" },
  { name: "lemma-content", label: "content" },
  { name: "lemma-geo", label: "geo" },
  { name: "lemma-security", label: "security" },
  { name: "lemma-security-review", label: "security-review" },
  { name: "lemma-privacy", label: "privacy" },
  { name: "lemma-state", label: "state" },
  { name: "lemma-reliability", label: "reliability" },
  { name: "lemma-performance", label: "performance" },
  { name: "lemma-load", label: "load" },
  { name: "lemma-stress", label: "stress" },
  { name: "lemma-networking", label: "networking" },
  { name: "lemma-api", label: "api" },
  { name: "lemma-data", label: "data" },
  { name: "lemma-failure", label: "failure" },
  { name: "lemma-proof", label: "proof" },
  { name: "lemma-confidence", label: "confidence" },
  { name: "lemma-confidence-init", label: "confidence-init" },
  { name: "lemma-confidence-plan", label: "confidence-plan" },
  { name: "lemma-review", label: "review" },
  { name: "lemma-skeptical-review", label: "skeptical-review" },
  { name: "lemma-release", label: "release" },
  { name: "lemma-release-review", label: "release-review" },
  { name: "lemma-incident", label: "incident" },
  { name: "lemma-eval", label: "eval" },
  { name: "lemma-eval-design-review", label: "eval-design-review" },
  { name: "lemma-statistical-review", label: "statistical-review" },
  { name: "lemma-agentic", label: "agentic" },
  { name: "lemma-chatbot", label: "chatbot" },
  { name: "lemma-bias", label: "bias" },
  { name: "lemma-tests", label: "tests" },
  { name: "lemma-generate", label: "generate" },
  { name: "lemma-map", label: "map" },
  { name: "lemma-full-report", label: "full-report" },
  { name: "lemma-stats", label: "stats" },
  { name: "lemma-integrations", label: "integrations" },
  { name: "lemma-ai-upgrade", label: "ai-upgrade" },
  { name: "lemma-auto", label: "auto" },
  { name: "lemma-background", label: "background" },
  { name: "lemma-forever", label: "forever" },
  { name: "lemma-settings", label: "settings" },
  { name: "lemma-human", label: "human" },
  { name: "lemma-pro", label: "pro" },
  { name: "lemma-hunt", label: "hunt" },
] as const;

/** @deprecated Use LEMMA_COMMAND_CATALOG. */
export const ASSAY_COMMAND_CATALOG: readonly AssayCommand[] = LEMMA_COMMAND_CATALOG;

const catalogByName = new Map<string, AssayCommand>(LEMMA_COMMAND_CATALOG.map((c) => [c.name, c]));
for (const c of LEMMA_COMMAND_CATALOG) {
  catalogByName.set(c.name.replace(/^lemma-/, "assay-"), c);
}

export function getLemmaCommand(name: string): AssayCommand | undefined {
  return catalogByName.get(name);
}

/** @deprecated Use getLemmaCommand. */
export function getAssayCommand(name: string): AssayCommand | undefined {
  return getLemmaCommand(name);
}

export function lemmaIntent(label: string): string {
  return `Lemma ${label} assessment`;
}

/** @deprecated Use lemmaIntent. */
export function assayIntent(label: string): string {
  return lemmaIntent(label);
}

export function getCatalogCommandKind(name: string): CatalogCommandKind {
  const cmd = getLemmaCommand(name);
  if (!cmd) return "static";
  if (cmd.label === "browser") return "browser";
  if (cmd.label === "demo") return "demo";
  return "static";
}

export function buildCatalogInvocation(
  commandName: string,
  text: string,
  personasDir: string,
): CatalogInvocationResult | null {
  const command = getLemmaCommand(commandName);
  if (!command) return null;
  const intent = lemmaIntent(command.label);
  const kind = getCatalogCommandKind(command.name);

  if (kind === "browser") {
    return { command, intent, kind, invocation: browserInvocation(text, personasDir) };
  }
  if (kind === "demo") {
    return { command, intent, kind, invocation: demoInvocation(text, personasDir) };
  }

  return {
    command,
    intent,
    kind,
    invocation: {
      args: [
        "run",
        "--target",
        ".",
        "--no-browser",
        "--personas-dir",
        personasDir,
        "--intent",
        intent,
      ],
    },
  };
}
