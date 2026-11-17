import {
  LEMMA_COMMAND_CATALOG,
  ASSAY_COMMAND_CATALOG,
  lemmaIntent,
  buildCatalogInvocation,
  getLemmaCommand,
  getCatalogCommandKind,
  type AssayCommand,
} from "./catalog.js";

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
    .map((a) => (/^[A-Za-z0-9._/:=-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(" ");
}

export function renderBrowserPromptTemplateNotes(): string {
  return [
    "Do not ask for or persist raw secrets/tokens; prefer secure env/secret references.",
    "Deterministic harness owns execution, evidence, and scoring; coverage gaps never pass.",
  ].join("\n- ");
}

export function renderCatalogCommandTemplate(
  commandName: string,
  options: CommandTemplateOptions = {},
): RenderedCommandTemplate | null {
  const command = getLemmaCommand(commandName);
  if (!command) return null;
  const cli = options.cli ?? "lemma";
  const personasDir = options.personasDir ?? "<personas-dir>";
  const kind = getCatalogCommandKind(command.name);
  const intent = lemmaIntent(command.label);

  if (kind === "browser") {
    const description = options.description ?? "Run long-running comprehensive Lemma browser regression (requires a URL)";
    const body = [
      `Run a **long-running, comprehensive, agent-driven full browser regression** for: $ARGUMENTS`,
      "",
      "## Immediate first action (do not skip)",
      "- **Start now by executing** the Lemma browser CLI against the provided URL to open/capture the browser and collect evidence (do not only plan).",
      "- Example (adjust URL/flags as needed; headed by default, add `--headless` if no display):",
      "  ```bash",
      `  ${cli} browser <URL> --crawl --max-pages 25 --timeout-ms 120000`,
      "  ```",
      "- Record and report the command, run ID, status, and `.lemma/evidence/<run_id>/` path(s). If it fails or is blocked/unavailable, report the exact error/output as a coverage gap and continue with the best safe alternative.",
      "",
      "## Default mission (apply unless user explicitly narrows scope)",
      "- Target the provided reachable `http(s)` URL (e.g. https://testradius.dev) and **test all user-facing features**.",
      "- Crawl all reachable same-origin pages/routes (nav, footer, docs/help, forms, modals, and key user journeys). **Do not stop at the homepage**.",
      "- If the target source repo/workspace is available locally, inspect it first (routes, components, configs, feature flags, forms, auth/API flows, docs/tests) to build a complete feature inventory and map features to browser scenarios.",
      "",
      "## Test planning (before/during execution)",
      "- Produce a comprehensive, prioritized test plan covering all discovered features (landing/content, navigation, auth/signup/login/logout/reset if present, core workflows, forms/validation, search/filter/sort/pagination, CRUD actions, uploads/downloads, settings/profile, dashboards/reports, notifications/toasts, modals/dialogs, tabs/accordions/dropdowns/toggles, responsive/mobile behavior, error/empty states, and discoverable integrations).",
      "- For each feature/scenario include: goal, preconditions/test data, steps, expected result, and whether automatable now. Mark auth-gated/destructive/environment-dependent/not-automatable cases as explicit coverage gaps (never guess, never pass).",
      "",
      "## Execution (maximize automated coverage and runtime)",
      "- Run thorough, long browser passes (headed by default unless headless requested/no display). Use crawl/multi-page coverage and repeat across key routes/viewports where useful.",
      "- Collect evidence for every reachable page/route: navigation/load status and final URL, console/page errors, failed/4xx/5xx network requests, title/headings/content sanity, link integrity, and screenshots/DOM snapshots/manifests produced by Lemma.",
      "- Execute all automatable interaction flows supported by available Lemma browser/scenario tooling (clicks, navigation, form fills/submits, toggles/selects where supported). For flows not fully automatable, perform deepest safe verification possible and record exact gaps/blockers.",
      "- Run additional `lemma browser` passes per major section/route as needed (and/or multiple scoped runs) to increase coverage and duration. Record command, run ID, status, and evidence paths for every run.",
      "- Do not use real credentials or secrets. If auth/protected data is required, report blocked coverage gaps and test public/unauthenticated behavior. Use secure env/secret references only if explicitly configured.",
      "- Continue until all discovered public features/routes are tested or explicitly recorded as gaps.",
      "",
      "## Requirements",
      "- Require a reachable `http(s)` URL in $ARGUMENTS. If missing, explain that `/lemma-browser` needs a URL and stop.",
      "- Use the shared browser agent prompt/invariants. Continue iteratively in the same session; do not ask the user to rerun or restate the goal.",
      "- Never ask for raw tokens in prose; use secure env/secret references if credentials are explicitly required.",
      "",
      "## Invariants",
      "- Deterministic harness owns execution, evidence, and scoring (fixed phases). Blocked/skipped/errored/refused/unavailable are coverage gaps (never pass, never inflate confidence).",
      "- No repeated commands; do not invent findings, scores, decisions, or evidence.",
      "- Never persist or echo secrets/credentials/tokens.",
      "",
      "## Reporting",
      "- Return an evidence-backed regression report: feature inventory, executed checks/scenarios and status per page/route, findings (severity, repro, impacted feature/page, evidence paths), console/network error summary, coverage summary (tested vs blocked vs not automatable), total pages/routes checked, run IDs, and `.lemma/evidence/<run_id>/` locations.",
      `- Personas dir (if needed): \`${personasDir}\`. Intent: \`${intent}\`.`,
    ].join("\n");
    return { name: command.name, description, markdown: frontmatter(description, body), kind: "browser" };
  }

  if (kind === "demo") {
    const description = options.description ?? "Run Lemma demo assessment (optional URL for live checks)";
    const staticInv = buildCatalogInvocation(command.name, "", personasDir);
    const liveExample = buildCatalogInvocation(command.name, "https://example.test", personasDir);
    const body = [
      `Run the Lemma demo assessment for: $ARGUMENTS`,
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

  const description = options.description ?? `Run Lemma ${command.label} assessment`;
  const body = [
    `Run a Lemma **${command.label}** assessment for: $ARGUMENTS`,
    "",
    "## Goal",
    `- Produce a useful, evidence-backed assessment for this intent. Do **not** rely on a generic \`lemma run --intent "${intent}"\` if it produces 0 checks/evidence ("No handler registered"/unscored); perform direct analysis and collect evidence instead, and report limitations honestly.`,
    "- No secrets/tokens/credentials. Coverage gaps (blocked/skipped/errored/unavailable/refused) never pass and never inflate confidence.",
    "",
    "## Steps",
    "1. **Identify target/context**: parse `$ARGUMENTS` for URL(s), paths, scope, and goals. If a reachable `http(s)` URL is provided and relevant, treat it as a live target and also inspect local source in the current workspace.",
    "2. **Collect live/browser evidence when applicable** (for web/UI or runtime-observable concerns): run",
    "   ```bash",
    `   ${cli} browser <URL>`,
    "   ```",
    "   from the target workspace (results in `./.lemma/`, headed by default; add `--headless` if needed; requires Chrome/Chromium). Record command, run ID, status, and evidence paths. If blocked/unavailable, report as a coverage gap.",
    `3. **Inspect project source/config/artifacts** relevant to **${command.label}**: use available tools to read and search code, configs, tests, CI, docs, and existing \`.lemma/\` reports/evidence. Ground observations in cited files/paths (and lines/snippets where useful).`,
    `4. **Assess and report**: provide a structured assessment covering findings/issues (severity, impact, location/evidence, recommendation, verification), positive signals, and explicit coverage gaps/limitations. Tailor analysis to the **${command.label}** intent based on what can be observed.`,
    "5. **Optional CLI status** (if prior runs exist):",
    "   ```bash",
    `   ${cli} status --root .`,
    `   ${cli} report --root .`,
    "   ```",
    "   Use these to reference existing evidence; do not claim execution that did not occur.",
    "",
    "## Notes",
    `- Personas dir (if needed): \`${personasDir}\``,
    "- Do not invent findings, scores, decisions, or evidence. Prefer concrete, reproducible observations and clearly mark anything not executed/observable as a coverage gap.",
  ].join("\n");
  return { name: command.name, description, markdown: frontmatter(description, body), kind: "static" };
}

export function renderAllCatalogCommandTemplates(
  options: CommandTemplateOptions = {},
  catalog: readonly AssayCommand[] = LEMMA_COMMAND_CATALOG,
): RenderedCommandTemplate[] {
  return catalog
    .map((c) => renderCatalogCommandTemplate(c.name, options))
    .filter((t): t is RenderedCommandTemplate => Boolean(t));
}

export function renderOperationalCommandTemplate(
  name: string,
  options: CommandTemplateOptions = {},
): RenderedCommandTemplate {
  const cli = options.cli ?? "lemma";
  const stateRoot = options.stateRoot ?? ".lemma";
  const personasDir = options.personasDir ?? "<personas-dir>";
  const normalized = name.replace(/^assay-/, "lemma-").replace(/^assay$/, "lemma");

  if (normalized === "lemma") {
    const description = options.description ?? "Run Lemma autonomous assessment agent";
    const body = [
      "Run a Lemma assessment for: $ARGUMENTS",
      "",
      "- If the user asks for help/list/commands, show available Lemma command templates and usage.",
      "- For assessment goals, run through the host-neutral agent flow (bounded, deterministic-harness-owned, no invented findings/scores).",
      "- Use shared command builders/catalog; never request or persist raw secrets/tokens.",
      `- CLI: \`${cli}\`, personas dir: \`${personasDir}\`, state root: \`${stateRoot}\`.`,
    ].join("\n");
    return { name: "lemma", description, markdown: frontmatter(description, body), kind: "operational" };
  }

  if (normalized === "lemma-status") {
    const description = options.description ?? "Show Lemma run status";
    const body = [
      "Show persisted Lemma status.",
      "",
      "```bash",
      `${cli} status --root ${stateRoot}`,
      "```",
    ].join("\n");
    return { name: "lemma-status", description, markdown: frontmatter(description, body), kind: "operational" };
  }

  if (normalized === "lemma-report") {
    const description = options.description ?? "Print the Lemma report";
    const body = [
      "Print the latest (or specified) Lemma report.",
      "",
      "```bash",
      `${cli} report --root ${stateRoot}`,
      "```",
    ].join("\n");
    return { name: "lemma-report", description, markdown: frontmatter(description, body), kind: "operational" };
  }

  if (normalized === "lemma-abort") {
    const description = options.description ?? "Request a Lemma run abort/kill";
    const body = [
      "Request abort for the active Lemma run.",
      "",
      "```bash",
      `${cli} abort --root ${stateRoot} --reason "operator stop"`,
      "```",
    ].join("\n");
    return { name: "lemma-abort", description, markdown: frontmatter(description, body), kind: "operational" };
  }

  const description = options.description ?? "Verify Lemma evidence manifests and hashes";
  const body = [
    "Verify evidence manifests and hashes for a Lemma run.",
    "",
    "```bash",
    `${cli} verify-evidence --root ${stateRoot}`,
    "```",
  ].join("\n");
  return { name: "lemma-verify-evidence", description, markdown: frontmatter(description, body), kind: "operational" };
}

export function renderPromptTemplates() {
  return {
    contextProtocol: "",
  };
}

export function renderLemmaSkillTemplate(options: CommandTemplateOptions = {}): string {
  const cli = options.cli ?? "lemma";
  const personasDir = options.personasDir ?? "<personas-dir>";
  return [
    "---",
    "name: lemma",
    "description: Deterministic, evidence-backed release confidence assessments via Lemma CLI/agent workflows.",
    "---",
    "",
    "# Lemma skill",
    "",
    "Use Lemma to run deterministic, evidence-backed quality/release assessments. The harness owns phase ordering, execution, evidence, and scoring; agents/adapters must not invent findings, scores, or decisions.",
    "",
    "## Commands and modes",
    `- Primary CLI: \`${cli}\` (JSON report to stdout for \`run\`; progress/warnings to stderr).`,
    `- Personas dir (configurable): \`${personasDir}\`.`,
    "- Catalog assessments: 60 Lemma commands.",
    "  - `lemma-browser`: live browser assessment, requires `http(s)` URL.",
    "  - `lemma-demo`: static when no URL, live browser when URL provided.",
    "  - Other catalog commands: static intent-driven runs (`Lemma <label> assessment`).",
    "- Operational commands include status/report/abort/verify-evidence and other management surfaces as available.",
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

// compatibility export
export { ASSAY_COMMAND_CATALOG };
