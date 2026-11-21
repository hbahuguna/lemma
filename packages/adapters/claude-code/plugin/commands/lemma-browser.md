---
description: Run long-running comprehensive Lemma browser regression (requires a URL)
---

Run a **long-running, comprehensive, agent-driven full browser regression** for: $ARGUMENTS

## Step 1 — create and show the browser test plan first (do not skip)
- **Create the deterministic browser test plan before any execution** and show it to the user. Run:
  ```bash
  lemma plan --target <URL> --intent "Lemma browser assessment" --command browser
  ```
- The plan must cover route discovery, navigation, page content, source-backed clicks/form fills/selects/toggles/sliders/scrolls, console/network classification, links/new-tab safety, responsive/focus behavior, auth/destructive gaps, and hashed evidence integrity.
- Present the plan as a prioritized checklist with objective, preconditions, steps, expected result, automation status, and explicit coverage gaps. Do not execute the browser regression until the plan has been shown.

## Step 2 — execute the planned browser regression once
- **Start the planned execution** by running the Lemma browser CLI against the provided URL to open/capture the browser and collect evidence.
- Run in a **headed/visible browser at all times** (never use `--headless`, never use `--no-browser`).
- The CLI reference below is concrete and executable in this environment; run it as-is (replace `<URL>` with the URL from `$ARGUMENTS`).
- **Do not substitute** `lemma run`, `lemma hunt`, or any other subcommand. `/lemma-browser` must call the `browser` subcommand; only `lemma browser` executes the headed browser regression with clicks, form fills, toggles, scrolls, and navigation.
  ```bash
  lemma browser <URL> --crawl --max-pages 80 --timeout-ms 120000
  ```
- Record and report the command, run ID, status, and `.lemma/evidence/<run_id>/` path(s). If it fails or is blocked/unavailable, report the exact error/output as a coverage gap and continue with the best safe alternative.
- **Verify the interaction regression actually ran:** inspect the run's JSON and confirm `observations` includes `browser.steps`, and that `.lemma/evidence/<run_id>/` contains `feature-inventory.json` (source-derived features), `auto-interactions-*-interaction-plan.json`, `auto-interactions-*-interaction-results.json`, and per-step screenshots. If those artifacts are missing, no source-backed clicks/scrolls/form fills/toggles/navigation ran — report a coverage gap and rerun with the exact `browser` command above.
- The browser harness scans the current repo source by default (use `--source <dir>` to point at a different checkout). It generates one unique interaction per discovered feature/route and deduplicates steps across crawled pages — do not rerun the same URL repeatedly to fake coverage.

## Default mission (apply unless user explicitly narrows scope)
- Target the provided reachable `http(s)` URL (e.g. https://testradius.dev) and **test all user-facing features**.
- Crawl all reachable same-origin pages/routes (nav, footer, docs/help, forms, modals, and key user journeys). **Do not stop at the homepage**.
- If the target source repo/workspace is available locally, inspect it first (routes, components, configs, feature flags, forms, auth/API flows, docs/tests) to build a complete feature inventory and map features to browser scenarios.

## Test planning contract
- The CLI creates the plan deterministically in the fixed Test Planning phase before Execution; never hand-write results or let a model set status, evidence, or confidence.
- Enrich the plan from local source and live discovery, but preserve its scenarios: landing/content, navigation, auth/signup/login/logout/reset if present, core workflows, forms/validation, search/filter/sort/pagination, CRUD actions, uploads/downloads, settings/profile, dashboards/reports, notifications/toasts, modals/dialogs, tabs/accordions/dropdowns/toggles, responsive/mobile behavior, error/empty states, and discoverable integrations.
- Each scenario includes objective, preconditions/test data, steps, expected result, automation status, linked check IDs, and explicit coverage gaps. Auth-gated/destructive/environment-dependent/not-automatable cases are gaps (never guesses, never passes).

## Execution (maximize automated coverage and runtime)
- Run thorough, long browser passes in a **headed/visible browser at all times** (never `--headless`, never `--no-browser`). Use crawl/multi-page coverage and repeat across key routes/viewports where useful.
- Collect evidence for every reachable page/route: navigation/load status and final URL, console/page errors, failed/4xx/5xx network requests, title/headings/content sanity, link integrity, and screenshots/DOM snapshots/manifests produced by Lemma.
- Execute all automatable interaction flows supported by available Lemma browser/scenario tooling (clicks, navigation, form fills/submits, toggles/selects where supported). For flows not fully automatable, perform deepest safe verification possible and record exact gaps/blockers.
- Prefer **one** long `lemma browser` pass with crawl enabled. The harness deduplicates source-backed steps across crawled pages; do not rerun the same URL/flags merely to extend runtime. A second pass is only justified for a distinct target, viewport, or explicitly missing coverage — record its command, run ID, status, and evidence paths.
- Do not use real credentials or secrets. If auth/protected data is required, report blocked coverage gaps and test public/unauthenticated behavior. Use secure env/secret references only if explicitly configured.
- Continue until all discovered public features/routes are tested or explicitly recorded as gaps.

## Requirements
- Require a reachable `http(s)` URL in $ARGUMENTS. If missing, explain that `/lemma-browser` needs a URL and stop.
- Use the shared browser agent prompt/invariants. Continue iteratively in the same session; do not ask the user to rerun or restate the goal.
- Never run with `--headless` or `--no-browser` for `/lemma-browser`; always use a headed/visible browser.
- Never ask for raw tokens in prose; use secure env/secret references if credentials are explicitly required.

## Invariants
- Deterministic harness owns execution, evidence, and scoring (fixed phases). Blocked/skipped/errored/refused/unavailable are coverage gaps (never pass, never inflate confidence).
- No repeated commands; do not invent findings, scores, decisions, or evidence.
- Never persist or echo secrets/credentials/tokens.

## Reporting
- Return an evidence-backed regression report that starts with the comprehensive browser test plan, then a result table for every scenario (status, linked checks, evidence paths, findings, and gap reason), followed by the feature inventory, findings, console/network summary, coverage totals, pages/routes checked, run IDs, and `.lemma/evidence/<run_id>/` locations.
- Read `test_plan` from the final browser JSON; do not invent or omit scenarios. Show blocked/skipped/errored/coverage-gap scenarios as gaps, never passes.
- Personas dir (if needed): `<personas-dir>`. Intent: `Lemma browser assessment`.
