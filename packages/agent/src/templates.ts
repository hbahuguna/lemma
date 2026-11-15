import {
  ASSAY_COMMAND_CATALOG,
  assayIntent,
  buildCatalogInvocation,
  getAssayCommand,
  getCatalogCommandKind,
  type AssayCommand,
} from "./catalog.js";
import { CONTEXT_PROTOCOL, buildBrowserAgentPrompt } from "./browser-agent-prompt.js";

export interface CommandTemplateOptions {
  /** CLI executable/command name. Defaults to "lemma". */
  cli?: string;
  /** Personas directory path or placeholder. */
  personasDir?: string;
  /** State/evidence root (e.g. .lemma) for operational commands. */
  stateRoot?: string;
  /** Optional command description override. */
  description?: string;
}

export interface RenderedCommandTemplate {
  name: string;
  description: string;
  markdown: string;
  kind: "browser" | "demo" | "static" | "operational";
}

function frontmatter(description: string, body: string): string {
  return `---\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

function shellArgs(args: string[]): string {
  return args
    .map((a) => (/^[A-Za-z0-9._/:-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(" ");
}

export function renderBrowserPromptTemplateNotes(): string {
  return [
    "Use the host-native question tool for context gathering when available.",
    "Do not ask for or persist raw secrets/tokens; prefer secure env/secret references.",
    "Deterministic harness owns execution, evidence, and scoring; coverage gaps never pass.",
  ].join("\n- ");
}

export function renderCatalogCommandTemplate(
  commandName: string,
  options: CommandTemplateOptions = {},
): RenderedCommandTemplate | null {
  const command = getAssayCommand(commandName);
  if (!command) return null;
  const cli = options.cli ?? "lemma";
  const personasDir = options.personasDir ?? "<personas-dir>";
  const kind = getCatalogCommandKind(command.name);
  const intent = assayIntent(command.label);

  if (kind === "browser") {
    const description =
      options.description ?? "Run quality-harness live browser assessment (requires a URL)";
    const body = [
      `Run an **agent-driven, interactive** lemma browser assessment for: $ARGUMENTS`,
      "",
      "## Requirements",
      "- Require a reachable `http(s)` URL. If missing, explain that this command needs a URL and stop.",
      "- Use the shared browser agent prompt/invariants and context protocol. Continue iteratively in the same session; do not ask the user to rerun or restate the goal.",
      "- Prefer the native question tool for context gathering; never ask for raw tokens in prose. Use secure env/secret references when needed.",
      "",
      "## Initial assessment",
      "Build and run the initial live browser assessment command using the shared lemma command builders/catalog semantics:",
      `- CLI: \`${cli}\``,
      `- Personas dir: \`${personasDir}\``,
      `- Intent: \`${intent}\``,
      "- Include comprehensive browser defaults unless explicitly overridden; preserve explicit user flags/overrides.",
      "",
      "## Invariants",
      `- ${CONTEXT_PROTOCOL.split("\n").filter(Boolean)[0] ?? "Use native question tool for context gathering."}`,
      "- Deterministic harness owns execution, evidence, and scoring (fixed phases). Blocked/skipped/errored/refused are coverage gaps (never pass).",
      "- No repeated commands; record run IDs, executed checks/evidence, limitations/gaps, and concrete fixes.",
      "- Never persist or echo secrets/credentials/tokens.",
    ].join("\n");
    return { name: command.name, description, markdown: frontmatter(description, body), kind: "browser" };
  }

  if (kind === "demo") {
    const description =
      options.description ?? "Run quality-harness demo assessment (optional URL for live checks)";
    const staticInv = buildCatalogInvocation(command.name, "", personasDir);
    const liveExample = buildCatalogInvocation(command.name, "https://example.test", personasDir);
    const body = [
      `Run the lemma demo assessment for: $ARGUMENTS`,
      "",
      "Behavior:",
      "- If an `http(s)` URL is provided, run a **live browser** demo assessment with comprehensive browser defaults (no `--no-browser`).",
      "- If no URL is provided, run a **static** demo assessment (`--no-browser`).",
      "- Preserve explicit user flags/overrides and use shared command builders/catalog semantics.",
      "",
      "Reference invocations:",
      `- Static (no URL): \`${cli} ${shellArgs(staticInv?.invocation.args ?? [])}\``,
      `- Live (with URL): \`${cli} ${shellArgs((liveExample?.invocation.args ?? []).slice(0, 8))} ...\` (target becomes provided URL; no \`--no-browser\`)`,
      "",
      `Intent: \`${intent}\`  `,
      `Personas dir: \`${personasDir}\``,
    ].join("\n");
    return { name: command.name, description, markdown: frontmatter(description, body), kind: "demo" };
  }

  const description = options.description ?? `Run quality-harness ${command.label} assessment`;
  const inv = buildCatalogInvocation(command.name, "", personasDir);
  const body = [
    `Run the lemma assessment for **${command.label}**.`,
    "",
    "Execute a deterministic static run unless a specific command flow requires otherwise:",
    "",
    "```bash",
    `${cli} ${shellArgs(inv?.invocation.args ?? ["run", "--target", ".", "--no-browser", "--personas-dir", personasDir, "--intent", intent])}`,
    "```",
    "",
    "Notes:",
    "- Use shared command catalog/builders and keep stdout/report handling machine-safe.",
    "- Coverage gaps (blocked/skipped/errored/refused) never pass; report limitations honestly.",
  ].join("\n");
  return { name: command.name, description, markdown: frontmatter(description, body), kind: "static" };
}

export function renderAllCatalogCommandTemplates(
  options: CommandTemplateOptions = {},
  catalog: readonly AssayCommand[] = ASSAY_COMMAND_CATALOG,
): RenderedCommandTemplate[] {
  return catalog
    .map((c) => renderCatalogCommandTemplate(c.name, options))
    .filter((t): t is RenderedCommandTemplate => Boolean(t));
}

export function renderOperationalCommandTemplate(
  name: "assay" | "assay-status" | "assay-report" | "assay-abort" | "assay-verify-evidence",
  options: CommandTemplateOptions = {},
): RenderedCommandTemplate {
  const cli = options.cli ?? "lemma";
  const stateRoot = options.stateRoot ?? ".lemma";
  const personasDir = options.personasDir ?? "<personas-dir>";

  if (name === "assay") {
    const description = options.description ?? "Run lemma autonomous assessment agent";
    const body = [
      "Run a lemma assessment for: $ARGUMENTS",
      "",
      "- If the user asks for help/list/commands, show available assay command templates and usage.",
      "- For assessment goals, run through the host-neutral agent flow (bounded, deterministic-harness-owned, no invented findings/scores).",
      "- Use shared command builders/catalog and context protocol; never request or persist raw secrets/tokens.",
      `- CLI: \`${cli}\`, personas dir: \`${personasDir}\`, state root: \`${stateRoot}\`.`,
    ].join("\n");
    return { name, description, markdown: frontmatter(description, body), kind: "operational" };
  }

  if (name === "assay-status") {
    const description = options.description ?? "Show lemma run status";
    const body = [
      "Show persisted lemma status.",
      "",
      "```bash",
      `${cli} status --root ${stateRoot}`,
      "```",
    ].join("\n");
    return { name, description, markdown: frontmatter(description, body), kind: "operational" };
  }

  if (name === "assay-report") {
    const description = options.description ?? "Print the lemma report";
    const body = [
      "Print the latest (or specified) lemma report.",
      "",
      "```bash",
      `${cli} report --root ${stateRoot}`,
      "```",
    ].join("\n");
    return { name, description, markdown: frontmatter(description, body), kind: "operational" };
  }

  if (name === "assay-abort") {
    const description = options.description ?? "Request a lemma run abort/kill";
    const body = [
      "Request abort for the active lemma run.",
      "",
      "```bash",
      `${cli} abort --root ${stateRoot} --reason "operator stop"`,
      "```",
    ].join("\n");
    return { name, description, markdown: frontmatter(description, body), kind: "operational" };
  }

  const description = options.description ?? "Verify lemma evidence manifest signatures and hashes";
  const body = [
    "Verify evidence manifests and hashes for a lemma run.",
    "",
    "```bash",
    `${cli} verify-evidence --root ${stateRoot}`,
    "```",
  ].join("\n");
  return { name, description, markdown: frontmatter(description, body), kind: "operational" };
}

export function renderPromptTemplates() {
  return {
    contextProtocol: CONTEXT_PROTOCOL,
    browserAgentPrompt: (input: Parameters<typeof buildBrowserAgentPrompt>[0]) =>
      buildBrowserAgentPrompt(input),
  };
}

export function renderLemmaSkillTemplate(options: CommandTemplateOptions = {}): string {
  const cli = options.cli ?? "lemma";
  const personasDir = options.personasDir ?? "<personas-dir>";
  return [
    "---",
    "name: lemma",
    "description: Deterministic, evidence-backed release confidence assessments via lemma CLI/agent workflows.",
    "---",
    "",
    "# Lemma skill",
    "",
    "Use lemma to run deterministic, evidence-backed quality/release assessments. The harness owns phase ordering, execution, evidence, and scoring; agents/adapters must not invent findings, scores, or decisions.",
    "",
    "## Commands and modes",
    `- Primary CLI: \`${cli}\` (JSON report to stdout for \`run\`; progress/warnings to stderr).`,
    `- Personas dir (configurable): \`${personasDir}\`.`,
    "- Catalog assessments: 59 assay-style commands.",
    "  - `assay-browser`: live browser assessment, requires `http(s)` URL.",
    "  - `assay-demo`: static when no URL, live browser when URL provided.",
    "  - Other catalog commands: static intent-driven runs (`Assay <label> assessment`).",
    "- Operational commands include status/report/abort/verify-evidence and other management surfaces as available.",
    "",
    "## Context protocol",
    CONTEXT_PROTOCOL,
    "",
    "## Safety and invariants",
    "- Deterministic harness owns execution, evidence, and scoring (fixed phases: Risk Analysis → Test Planning → Execution → Evidence Collection → Confidence Scoring).",
    "- Blocked/skipped/errored/refused checks are coverage gaps (never pass, never raise confidence).",
    "- Evidence must be hashed and attributable; do not claim unobserved behavior.",
    "- Never ask for, echo, or persist raw secrets/tokens/credentials; use secure env/secret references and redaction.",
    "- Bounded agent behavior: no repeated commands, respect allowlists/caps, report run IDs, executed work, gaps/limitations, and concrete fixes.",
    "",
  ].join("\n");
}
