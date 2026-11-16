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

/** Canonical 60-command assay/lemma slash-command catalog (name/label), in assay order (LEM-089 baseline + LEM-148 hunt). */
export const ASSAY_COMMAND_CATALOG: readonly AssayCommand[] = [
  { name: "assay-manager", label: "manager" },
  { name: "assay-full", label: "full" },
  { name: "assay-test", label: "test" },
  { name: "assay-functionality", label: "functionality" },
  { name: "assay-browser", label: "browser" },
  { name: "assay-issues", label: "issues" },
  { name: "assay-demo", label: "demo" },
  { name: "assay-more", label: "more" },
  { name: "assay-help", label: "help" },
  { name: "assay-accessibility", label: "accessibility" },
  { name: "assay-ui", label: "ui" },
  { name: "assay-ux", label: "ux" },
  { name: "assay-usability", label: "usability" },
  { name: "assay-personas", label: "personas" },
  { name: "assay-compatibility", label: "compatibility" },
  { name: "assay-intl", label: "intl" },
  { name: "assay-localization", label: "localization" },
  { name: "assay-content", label: "content" },
  { name: "assay-geo", label: "geo" },
  { name: "assay-security", label: "security" },
  { name: "assay-security-review", label: "security-review" },
  { name: "assay-privacy", label: "privacy" },
  { name: "assay-state", label: "state" },
  { name: "assay-reliability", label: "reliability" },
  { name: "assay-performance", label: "performance" },
  { name: "assay-load", label: "load" },
  { name: "assay-stress", label: "stress" },
  { name: "assay-networking", label: "networking" },
  { name: "assay-api", label: "api" },
  { name: "assay-data", label: "data" },
  { name: "assay-failure", label: "failure" },
  { name: "assay-proof", label: "proof" },
  { name: "assay-confidence", label: "confidence" },
  { name: "assay-confidence-init", label: "confidence-init" },
  { name: "assay-confidence-plan", label: "confidence-plan" },
  { name: "assay-review", label: "review" },
  { name: "assay-skeptical-review", label: "skeptical-review" },
  { name: "assay-release", label: "release" },
  { name: "assay-release-review", label: "release-review" },
  { name: "assay-incident", label: "incident" },
  { name: "assay-eval", label: "eval" },
  { name: "assay-eval-design-review", label: "eval-design-review" },
  { name: "assay-statistical-review", label: "statistical-review" },
  { name: "assay-agentic", label: "agentic" },
  { name: "assay-chatbot", label: "chatbot" },
  { name: "assay-bias", label: "bias" },
  { name: "assay-tests", label: "tests" },
  { name: "assay-generate", label: "generate" },
  { name: "assay-map", label: "map" },
  { name: "assay-full-report", label: "full-report" },
  { name: "assay-stats", label: "stats" },
  { name: "assay-integrations", label: "integrations" },
  { name: "assay-ai-upgrade", label: "ai-upgrade" },
  { name: "assay-auto", label: "auto" },
  { name: "assay-background", label: "background" },
  { name: "assay-forever", label: "forever" },
  { name: "assay-settings", label: "settings" },
  { name: "assay-human", label: "human" },
  { name: "assay-pro", label: "pro" },
  { name: "assay-hunt", label: "hunt" },
] as const;

const catalogByName = new Map(ASSAY_COMMAND_CATALOG.map((c) => [c.name, c]));

export function getAssayCommand(name: string): AssayCommand | undefined {
  return catalogByName.get(name);
}

export function assayIntent(label: string): string {
  return `Assay ${label} assessment`;
}

export function getCatalogCommandKind(name: string): CatalogCommandKind {
  if (name === "assay-browser") return "browser";
  if (name === "assay-demo") return "demo";
  return "static";
}

export function buildCatalogInvocation(
  commandName: string,
  text: string,
  personasDir: string,
): CatalogInvocationResult | null {
  const command = getAssayCommand(commandName);
  if (!command) return null;
  const intent = assayIntent(command.label);
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
