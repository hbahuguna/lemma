import { CheckStatus, type Check, type Finding, type Risk, type Target } from "./models.js";

export const TEST_PLAN_SCHEMA_VERSION = "lemma.test_plan/v1" as const;

export type TestPlanProfile =
  | "browser"
  | "security"
  | "performance"
  | "api"
  | "accessibility"
  | "release"
  | "data"
  | "general";

export type TestPlanAutomation = "automated" | "assisted" | "coverage-gap";

export type TestPlanResultStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "skipped"
  | "error"
  | "planned_not_run"
  | "coverage_gap";

export interface TestPlanLinkedCheck {
  id: string;
  status: string;
}

export interface TestPlanResult {
  scenario_id: string;
  status: TestPlanResultStatus;
  check_ids: string[];
  linked_checks: TestPlanLinkedCheck[];
  evidence: string[];
  finding_ids: string[];
  detail: string;
  coverage_gap_reason: string;
}

export interface TestPlanScenario {
  id: string;
  title: string;
  category: string;
  priority: "P0" | "P1" | "P2";
  objective: string;
  preconditions: string[];
  steps: string[];
  expected_result: string;
  automation: TestPlanAutomation;
  check_hints: string[];
  check_ids: string[];
  result: TestPlanResult | null;
}

export interface TestPlanSourceFacts {
  target_root: string;
  source_files: number;
  test_files: number;
  markup_files: number;
  ci_files: number;
  manifests: number;
  has_markup: boolean;
  has_manifest: boolean;
}

export interface TestPlanSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  error: number;
  planned_not_run: number;
  coverage_gaps: number;
  executed: number;
  executed_pct: number;
}

export interface TestPlan {
  schema_version: typeof TEST_PLAN_SCHEMA_VERSION;
  intent: string;
  label: string;
  profile: TestPlanProfile;
  title: string;
  objective: string;
  target: { kind: string; raw: string; resolved: string };
  source_facts: TestPlanSourceFacts;
  scope_notes: string[];
  scenarios: TestPlanScenario[];
  summary: TestPlanSummary;
}

export interface BuildTestPlanParams {
  intent: string;
  target: Target;
  inventory?: Record<string, unknown>;
  checks?: readonly Check[];
  risks?: readonly Risk[];
  command?: string;
}

interface ScenarioTemplate {
  suffix: string;
  title: string;
  category: string;
  priority: "P0" | "P1" | "P2";
  objective: string;
  preconditions: string[];
  steps: string[];
  expected_result: string;
  automation: TestPlanAutomation;
  check_hints: string[];
}

interface ProfileTemplate {
  profile: TestPlanProfile;
  objective: string;
  scope_notes: string[];
  scenarios: ScenarioTemplate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";
}

/** Parse catalog and legacy intent strings without importing the agent catalog into core. */
export function intentLabel(intent: string): string {
  const text = asString(intent).trim();
  const patterns = [
    /^lemma\s+(.+?)\s+assessment$/i,
    /^assay\s+(.+?)\s+assessment$/i,
    /^(.+?)\s+category assessment$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().toLowerCase();
  }
  return text ? slug(text) : "general";
}

function profileForLabel(label: string): ProfileTemplate {
  const l = label.toLowerCase();
  if (/(^|-)browser$/.test(l) || l.includes("ui") || l.includes("ux") || l.includes("usability") || l.includes("demo")) {
    return browserProfile();
  }
  if (l.includes("security") || l.includes("privacy") || l.includes("auth")) {
    return securityProfile();
  }
  if (l.includes("performance") || l.includes("load") || l.includes("stress") || l.includes("network")) {
    return performanceProfile();
  }
  if (l.includes("api") || l.includes("integration") || l.includes("state") || l.includes("data")) {
    return apiProfile();
  }
  if (l.includes("accessib") || l.includes("intl") || l.includes("localization") || l.includes("content") || l.includes("geo")) {
    return accessibilityProfile();
  }
  if (l.includes("release") || l.includes("confidence") || l.includes("review") || l.includes("incident") || l.includes("manager")) {
    return releaseProfile();
  }
  return generalProfile();
}

function browserProfile(): ProfileTemplate {
  return {
    profile: "browser",
    objective: "Verify observable browser behavior across the discovered target surface, with hashed evidence for every claim and explicit gaps for anything not executed.",
    scope_notes: [
      "Only public/safe flows are automated; authentication, destructive actions, and third-party systems remain explicit gaps unless explicitly configured.",
      "Source-derived routes and live DOM controls are scoped per route to avoid cross-route false positives.",
    ],
    scenarios: [
      {
        suffix: "discovery", title: "Discover target routes and source-backed features", category: "coverage", priority: "P0",
        objective: "Establish the complete test surface before interacting with it.",
        preconditions: ["A reachable http(s) URL is supplied.", "A source checkout is available in the working directory or via --source."],
        steps: ["Parse the landing page and same-origin links.", "Read source route/component manifests and build a deduplicated feature inventory.", "Map features to canonical routes."],
        expected_result: "Every discovered public route/feature appears in the plan or in an explicit coverage gap.",
        automation: "automated", check_hints: ["feature", "inventory", "browser.load", "browser.content"],
      },
      {
        suffix: "navigation", title: "Navigate every discovered public route", category: "navigation", priority: "P0",
        objective: "Confirm each in-scope route loads at its canonical URL.",
        preconditions: ["Route inventory exists."],
        steps: ["Open each in-scope route in the single headed browser session.", "Record requested URL, final URL, status, and title.", "Record unreachable or error-page routes as blocked gaps."],
        expected_result: "No route is silently skipped; redirects and blocked routes are explainable.",
        automation: "automated", check_hints: ["browser.load", "browser.links", "navigation"],
      },
      {
        suffix: "content", title: "Validate page content and headings", category: "content", priority: "P1",
        objective: "Detect empty, error, or unexpectedly changed views.",
        preconditions: ["Route is reachable."],
        steps: ["Read title and primary headings for each view.", "Compare with source-derived expectations where available.", "Capture DOM snapshots and screenshots."],
        expected_result: "Each view has plausible, attributable content and hashed evidence.",
        automation: "automated", check_hints: ["browser.content", "content"],
      },
      {
        suffix: "interactions", title: "Exercise source-backed interactions", category: "functional", priority: "P0",
        objective: "Verify clicks, form fills/submits, selects, toggles, sliders, and scrolls on their own routes.",
        preconditions: ["Feature-to-route map exists.", "Controls are visible and safe to activate."],
        steps: ["Resolve each control on its canonical route.", "Execute unique, non-destructive interactions.", "Capture before/after state, screenshots, DOM, and network evidence."],
        expected_result: "Executed interactions have evidence; disappeared or unsafe controls are skipped gaps.",
        automation: "automated", check_hints: ["browser.steps", "interaction", "functional"],
      },
      {
        suffix: "console", title: "Classify console and page errors", category: "runtime", priority: "P1",
        objective: "Separate product defects from intentional fixture errors and third-party telemetry outages.",
        preconditions: ["Console capture is enabled."],
        steps: ["Collect console messages and page errors from each crawled view.", "Classify known non-blocking fixtures/telemetry without suppressing genuine errors.", "Attach evidence to any retained finding."],
        expected_result: "Only explainable, product-relevant errors become findings; classified noise stays metadata.",
        automation: "assisted", check_hints: ["browser.console", "console"],
      },
      {
        suffix: "network", title: "Classify network failures", category: "runtime", priority: "P1",
        objective: "Explain failed requests without treating third-party outages as product failures.",
        preconditions: ["Network capture is enabled."],
        steps: ["Collect 4xx/5xx and failed requests per view.", "Classify favicon, telemetry, and intentional fixture failures.", "Retain product-impacting failures with evidence."],
        expected_result: "Network evidence is complete and classifications are visible.",
        automation: "assisted", check_hints: ["browser.network", "network"],
      },
      {
        suffix: "responsive", title: "Check responsive and focus behavior", category: "accessibility", priority: "P2",
        objective: "Identify overflow and keyboard-focus regressions on representative views.",
        preconditions: ["Browser runtime supports viewport/focus inspection."],
        steps: ["Inspect mobile viewport for horizontal overflow.", "Walk focus order on interactive views.", "Evidence each pass or gap."],
        expected_result: "Responsive/focus results are explicit; unavailable checks are gaps.",
        automation: "automated", check_hints: ["browser.overflow", "browser.focus_order", "browser.accessibility"],
      },
      {
        suffix: "links", title: "Check link integrity and new-tab safety", category: "navigation", priority: "P2",
        objective: "Detect broken links and unsafe new-tab behavior.",
        preconditions: ["Link inventory exists."],
        steps: ["Resolve same-origin links.", "Inspect target=_blank rel attributes.", "Record external/auth links without submitting credentials."],
        expected_result: "Broken or unsafe links are either evidenced as findings or listed as gaps.",
        automation: "automated", check_hints: ["browser.links", "links"],
      },
      {
        suffix: "security", title: "Apply bounded browser security checks", category: "security", priority: "P1",
        objective: "Observe non-destructive browser security signals only.",
        preconditions: ["Target is authorized."],
        steps: ["Inspect transport and security-relevant headers/forms where available.", "Do not exploit, brute-force, or submit real transactions.", "Record all out-of-scope checks as gaps."],
        expected_result: "No destructive testing occurs and every limitation is explicit.",
        automation: "assisted", check_hints: ["browser.security", "security"],
      },
      {
        suffix: "auth-gaps", title: "Record authentication and destructive-flow gaps", category: "coverage", priority: "P0",
        objective: "Make untested protected flows impossible to mistake for passes.",
        preconditions: ["Auth-gated or destructive controls are discovered."],
        steps: ["List each gated route/action.", "Record why it was not exercised.", "State the exact evidence needed to unblock."],
        expected_result: "Every gated or destructive flow appears as a coverage gap.",
        automation: "coverage-gap", check_hints: ["auth", "destructive", "gap"],
      },
      {
        suffix: "evidence", title: "Verify evidence integrity", category: "evidence", priority: "P0",
        objective: "Ensure every finding is backed by a hashed artifact.",
        preconditions: ["Evidence store is enabled."],
        steps: ["Check manifest entries and SHA-256 hashes.", "Confirm screenshots, DOM/network/console artifacts exist for executed steps.", "Redact secrets before persistence."],
        expected_result: "No finding lacks evidence; no raw secret appears in state or report.",
        automation: "automated", check_hints: ["evidence", "manifest", "redaction"],
      },
    ],
  };
}

function securityProfile(): ProfileTemplate {
  return {
    profile: "security",
    objective: "Assess security-relevant signals with deterministic, non-destructive checks and explicit gaps for anything requiring exploitation, credentials, or tenant access.",
    scope_notes: [
      "This is not a penetration test, certification, or authorization to exploit a target.",
      "Secrets and tokens are never captured verbatim; only redacted metadata may be persisted.",
    ],
    scenarios: [
      {
        suffix: "secrets", title: "Scan source for exposed credentials", category: "secrets", priority: "P0",
        objective: "Detect committed keys, tokens, cookies, authorization headers, and private keys.",
        preconditions: ["Source inventory is available."],
        steps: ["Run deterministic secret rules over tracked/source files.", "Apply precision filters and redact matched values.", "Emit evidence paths without raw secret content."],
        expected_result: "Any reported secret is precise, redacted, and evidence-linked; no raw value is persisted.",
        automation: "automated", check_hints: ["static.secrets", "secret", "redaction"],
      },
      {
        suffix: "unsafe", title: "Scan source for unsafe code patterns", category: "unsafe-code", priority: "P0",
        objective: "Identify deterministic unsafe-code indicators such as eval, shell invocation, or insecure deserialization.",
        preconditions: ["Source inventory is available."],
        steps: ["Run unsafe-code rules over source files.", "Inspect matched context without executing artifacts.", "Attach file/line evidence to findings."],
        expected_result: "Unsafe patterns are either evidenced or explicitly out of scope.",
        automation: "automated", check_hints: ["static.unsafe", "unsafe", "injection"],
      },
      {
        suffix: "auth", title: "Review authentication and session handling", category: "auth", priority: "P0",
        objective: "Assess observable auth/session controls without using real credentials.",
        preconditions: ["Auth code, configuration, or public forms are discoverable."],
        steps: ["Locate login/logout/session/token handling paths.", "Check for secure defaults and redaction.", "List live-auth testing as a gap when no safe fixture exists."],
        expected_result: "Auth gaps are explicit; no credential is requested, echoed, or stored.",
        automation: "assisted", check_hints: ["auth", "session", "browser.security"],
      },
      {
        suffix: "authorization", title: "Review authorization and tenant boundaries", category: "authorization", priority: "P0",
        objective: "Identify code paths where tenant or role scope could be bypassed.",
        preconditions: ["Source contains multi-tenant or role logic."],
        steps: ["Inspect tenant/role resolution sites.", "Check that identity comes from scoped tokens rather than request bodies.", "Record cross-tenant testing as a gap."],
        expected_result: "Tenant-boundary limitations are explicit and no other tenant is accessed.",
        automation: "assisted", check_hints: ["tenant", "authorization", "scope", "quota"],
      },
      {
        suffix: "transport", title: "Check transport and browser security signals", category: "runtime", priority: "P1",
        objective: "Observe headers, mixed content, and browser-reported security signals.",
        preconditions: ["A URL target is available."],
        steps: ["Inspect response headers and final URL.", "Collect browser security observations.", "Do not bypass TLS or validation errors."],
        expected_result: "Runtime security signals are evidenced or listed as gaps.",
        automation: "automated", check_hints: ["browser.security", "security", "ssrf"],
      },
      {
        suffix: "dependencies", title: "Inspect dependency and CI configuration", category: "supply-chain", priority: "P1",
        objective: "Check manifests, lockfiles, and CI configuration for security-relevant exposure.",
        preconditions: ["Manifest/lockfile/CI files are available."],
        steps: ["Read manifests and lockfiles for unsafe scripts or pinned sources.", "Inspect CI for secret handling and root scoping.", "Record unavailable package intelligence as a gap."],
        expected_result: "Findings cite configuration files; unavailable analysis is a gap.",
        automation: "assisted", check_hints: ["dependency", "manifest", "ci", "lockfile"],
      },
      {
        suffix: "privacy", title: "Review privacy and data exposure", category: "privacy", priority: "P1",
        objective: "Identify paths that could expose personal or protected data.",
        preconditions: ["Data models or storage code are available."],
        steps: ["Inspect storage, logging, and evidence persistence paths.", "Verify redaction before persistence.", "Mark production-data testing as a gap."],
        expected_result: "No private data is captured; exposure risks are evidence-linked or gapped.",
        automation: "assisted", check_hints: ["privacy", "redaction", "storage", "logging"],
      },
      {
        suffix: "destructive", title: "Guard against destructive and exploitative actions", category: "safety", priority: "P0",
        objective: "Prove that no check submits transactions, creates accounts, brute-forces, or exploits vulnerabilities.",
        preconditions: ["Check catalog is available."],
        steps: ["Review selected checks for mutation boundaries.", "Do not submit real forms or transactions.", "Record any unsafe automation as a blocked gap."],
        expected_result: "The assessment remains non-destructive and all excluded actions are listed as gaps.",
        automation: "coverage-gap", check_hints: ["destructive", "boundary", "mutation", "gap"],
      },
      {
        suffix: "evidence", title: "Verify security evidence and redaction", category: "evidence", priority: "P0",
        objective: "Ensure findings are hashed, attributable, and free of raw secrets.",
        preconditions: ["Evidence store is enabled."],
        steps: ["Verify manifest hashes and artifact presence.", "Scan persisted evidence/report for raw credentials.", "Quarantine contract-invalid persona output."],
        expected_result: "No raw secret reaches state, evidence, logs, stdout, or report.",
        automation: "automated", check_hints: ["evidence", "redaction", "manifest"],
      },
    ],
  };
}

function performanceProfile(): ProfileTemplate {
  return {
    profile: "performance",
    objective: "Measure and bound performance behavior with deterministic checks, preserving completed work and reporting gaps when load generation is unavailable or unsafe.",
    scope_notes: ["Only safe, bounded load/stress signals are automated; production load tests require explicit authorization."],
    scenarios: [
      {
        suffix: "baseline", title: "Establish performance baseline", category: "baseline", priority: "P0",
        objective: "Record a reproducible baseline for the in-scope target.",
        preconditions: ["Target and environment are identified."],
        steps: ["Record target/configuration metadata.", "Run deterministic baseline checks where available.", "Record missing instrumentation as a gap."],
        expected_result: "A baseline or explicit gap is reported.",
        automation: "assisted", check_hints: ["performance", "baseline", "benchmark"],
      },
      {
        suffix: "load", title: "Exercise bounded load", category: "load", priority: "P1",
        objective: "Observe behavior under bounded concurrent demand.",
        preconditions: ["Load tool is available and target is safe to test."],
        steps: ["Apply the configured concurrency/duration.", "Collect latency and error signals.", "Stop on kill switch or quota failure."],
        expected_result: "Load results are attributable; unavailable load generation is a gap.",
        automation: "assisted", check_hints: ["load", "performance", "quota"],
      },
      {
        suffix: "stress", title: "Exercise bounded stress and recovery", category: "stress", priority: "P2",
        objective: "Observe degradation and recovery without destructive behavior.",
        preconditions: ["Stress tool is available and authorized."],
        steps: ["Increase demand within configured limits.", "Observe errors and recovery.", "Record unexecuted stress as a gap."],
        expected_result: "Stress evidence or its gap is explicit.",
        automation: "coverage-gap", check_hints: ["stress", "recovery", "gap"],
      },
      {
        suffix: "network", title: "Classify network failures under load", category: "network", priority: "P1",
        objective: "Separate product latency/errors from network noise.",
        preconditions: ["Network evidence is captured."],
        steps: ["Collect failed and slow requests.", "Classify third-party telemetry noise.", "Attach product-impacting evidence to findings."],
        expected_result: "Network evidence is complete and honest.",
        automation: "assisted", check_hints: ["browser.network", "network", "latency"],
      },
      {
        suffix: "quota", title: "Verify quota and kill-switch boundaries", category: "safety", priority: "P0",
        objective: "Ensure quota failures block only the exceeding action and halted runs stay halted.",
        preconditions: ["Quota/kill contracts are available."],
        steps: ["Inspect quota boundary handling.", "Confirm preserved completed work and accurate partial billing.", "Confirm halt forces hold with no auto-resume."],
        expected_result: "No quota or halt path can fabricate a pass.",
        automation: "automated", check_hints: ["quota", "kill", "halt", "meter"],
      },
      {
        suffix: "evidence", title: "Verify performance evidence", category: "evidence", priority: "P0",
        objective: "Tie every performance claim to hashed evidence.",
        preconditions: ["Evidence store is enabled."],
        steps: ["Check manifests and hashes.", "Confirm deterministic metadata and redaction.", "List missing measurements as gaps."],
        expected_result: "Every claim is evidence-backed or gapped.",
        automation: "automated", check_hints: ["evidence", "manifest", "redaction"],
      },
    ],
  };
}

function apiProfile(): ProfileTemplate {
  return {
    profile: "api",
    objective: "Verify API and integration contracts from source and observable requests without accessing other tenants or submitting unsafe transactions.",
    scope_notes: ["Real credentials, production tenants, and state-changing requests remain explicit gaps unless a safe fixture is supplied."],
    scenarios: [
      {
        suffix: "contract", title: "Validate API contract surface", category: "contract", priority: "P0",
        objective: "Discover routes/schemas and verify documented behavior where available.",
        preconditions: ["OpenAPI/schema/source route definitions are available."],
        steps: ["Parse route definitions and schemas.", "Map methods, parameters, and expected responses.", "List undocumented routes as gaps."],
        expected_result: "The tested API surface is explicit and attributable.",
        automation: "assisted", check_hints: ["openapi", "api", "contract", "route"],
      },
      {
        suffix: "validation", title: "Validate request and response shapes", category: "validation", priority: "P0",
        objective: "Check input validation and response schema conformance.",
        preconditions: ["Schemas or fixtures are available."],
        steps: ["Submit only synthetic/safe inputs where automation is allowed.", "Compare responses with schemas.", "Record destructive inputs as gaps."],
        expected_result: "Validation results cite evidence; unsafe probes are not executed.",
        automation: "coverage-gap", check_hints: ["validation", "schema", "generate", "gap"],
      },
      {
        suffix: "auth", title: "Check authentication and tenant scoping", category: "auth", priority: "P0",
        objective: "Confirm identity is resolved from scoped tokens before quota/evidence/job lookup.",
        preconditions: ["Auth and tenant code are available."],
        steps: ["Inspect tenant resolution sites.", "Reject request-body tenant ids when scoped tokens exist.", "Record live cross-tenant tests as gaps."],
        expected_result: "No request can switch tenants via body input; gaps remain visible.",
        automation: "assisted", check_hints: ["auth", "tenant", "scope", "ssrf"],
      },
      {
        suffix: "errors", title: "Check error semantics", category: "errors", priority: "P1",
        objective: "Verify typed, machine-readable errors with no stack traces in stdout.",
        preconditions: ["Error contracts are available."],
        steps: ["Inspect error types and CLI/API boundaries.", "Confirm stdout/stderr separation.", "Evidence any malformed response."],
        expected_result: "Errors are stable and machine-readable.",
        automation: "automated", check_hints: ["errors", "cli", "typed"],
      },
      {
        suffix: "idempotency", title: "Check idempotency and safe retries", category: "reliability", priority: "P1",
        objective: "Ensure retries cannot duplicate transactions or evidence.",
        preconditions: ["Mutation/retry paths are available."],
        steps: ["Inspect idempotency keys and replay protection.", "Do not submit real transactions.", "Record live mutation tests as gaps."],
        expected_result: "Retry safety is evidenced or explicitly gapped.",
        automation: "coverage-gap", check_hints: ["idempotency", "retry", "mutation", "gap"],
      },
      {
        suffix: "evidence", title: "Verify integration evidence", category: "evidence", priority: "P0",
        objective: "Tie integration claims to hashed, redacted evidence.",
        preconditions: ["Evidence store is enabled."],
        steps: ["Verify manifest hashes and artifacts.", "Redact headers, cookies, and tokens.", "List unavailable integrations as gaps."],
        expected_result: "No raw credential appears and all claims are attributable.",
        automation: "automated", check_hints: ["evidence", "redaction", "manifest", "integration"],
      },
    ],
  };
}

function accessibilityProfile(): ProfileTemplate {
  return {
    profile: "accessibility",
    objective: "Assess deterministic accessibility signals and clearly separate them from required human review.",
    scope_notes: ["Automated accessibility checks do not establish WCAG conformance; human review remains required."],
    scenarios: [
      {
        suffix: "markup", title: "Scan markup semantics", category: "markup", priority: "P0",
        objective: "Find missing labels, landmarks, alt text, and heading structure.",
        preconditions: ["Markup files are available."],
        steps: ["Run deterministic markup rules.", "Inspect matched context.", "Attach file/line evidence to findings."],
        expected_result: "Markup findings are precise and evidence-linked.",
        automation: "automated", check_hints: ["accessibility", "a11y", "markup"],
      },
      {
        suffix: "keyboard", title: "Check keyboard and focus order", category: "keyboard", priority: "P1",
        objective: "Observe focus order and keyboard reachability in the browser.",
        preconditions: ["Browser runtime is available."],
        steps: ["Walk focus order on representative views.", "Record traps or unreachable controls.", "Capture evidence or gaps."],
        expected_result: "Focus behavior is evidenced or gapped.",
        automation: "automated", check_hints: ["browser.focus_order", "focus", "keyboard"],
      },
      {
        suffix: "visual", title: "Check responsive/visual signals", category: "responsive", priority: "P1",
        objective: "Detect overflow and layout regressions at bounded viewports.",
        preconditions: ["Browser runtime supports viewports."],
        steps: ["Inspect mobile viewport.", "Capture screenshots and DOM metadata.", "Record unavailable viewports as gaps."],
        expected_result: "Visual signals are attributable.",
        automation: "automated", check_hints: ["browser.overflow", "responsive", "overflow"],
      },
      {
        suffix: "content", title: "Check readable content and localization", category: "content", priority: "P2",
        objective: "Check heading/content sanity and locale-specific text where present.",
        preconditions: ["Content views are reachable."],
        steps: ["Read titles/headings/text.", "Inspect locale/intl configuration.", "Record translation review as a gap."],
        expected_result: "Content observations are evidenced; human translation review is a gap.",
        automation: "assisted", check_hints: ["browser.content", "content", "intl", "localization"],
      },
      {
        suffix: "forms", title: "Check accessible form controls", category: "forms", priority: "P1",
        objective: "Verify labels, error messages, and focus behavior for forms.",
        preconditions: ["Forms are discoverable."],
        steps: ["Inspect form markup and live controls.", "Exercise safe fields only.", "Record destructive submissions as gaps."],
        expected_result: "Form accessibility findings/gaps are explicit.",
        automation: "assisted", check_hints: ["browser.steps", "form", "accessibility"],
      },
      {
        suffix: "human", title: "Record human review gap", category: "coverage", priority: "P0",
        objective: "Make the limits of automation explicit.",
        preconditions: ["Automated pass has completed."],
        steps: ["List checks requiring screen-reader/manual judgment.", "State required reviewer evidence.", "Never claim WCAG conformance from automation alone."],
        expected_result: "Human review is an explicit coverage gap.",
        automation: "coverage-gap", check_hints: ["human", "gap", "wcag"],
      },
    ],
  };
}

function releaseProfile(): ProfileTemplate {
  return {
    profile: "release",
    objective: "Produce an explainable release-readiness plan that ties confidence, gates, and the final decision to executed evidence and visible gaps.",
    scope_notes: ["The orchestrator, not a model, owns scoring and the release decision."],
    scenarios: [
      {
        suffix: "risk", title: "Rank risks and scope", category: "risk", priority: "P0",
        objective: "Identify what could block a release before selecting checks.",
        preconditions: ["Target/inventory/context are available."],
        steps: ["Analyze target and source inventory.", "Rank risks by domain and consequence.", "Map risks to planned checks."],
        expected_result: "Every material risk maps to a check or explicit gap.",
        automation: "automated", check_hints: ["risk", "inventory"],
      },
      {
        suffix: "coverage", title: "Verify planned coverage", category: "coverage", priority: "P0",
        objective: "Confirm the plan covers selected checks within budget and persona ownership.",
        preconditions: ["Check registry and personas are available."],
        steps: ["Select intent-linked checks.", "Enforce disjoint persona ownership and budget.", "List excluded checks as gaps."],
        expected_result: "Coverage totals reconcile with plan and report.",
        automation: "automated", check_hints: ["checks", "coverage", "persona", "budget"],
      },
      {
        suffix: "gates", title: "Evaluate gates and kill switch", category: "gates", priority: "P0",
        objective: "Ensure severity, policy, and halt semantics cannot be bypassed.",
        preconditions: ["Policy and findings are available."],
        steps: ["Apply severity gates without lowering findings.", "Confirm halted runs force hold.", "Confirm blocked checks never pass."],
        expected_result: "Gate outcome is explainable and conservative.",
        automation: "automated", check_hints: ["policy", "gate", "halt", "severity", "kill"],
      },
      {
        suffix: "evidence", title: "Verify evidence and redaction", category: "evidence", priority: "P0",
        objective: "Tie the decision to hashed evidence only.",
        preconditions: ["Evidence store is enabled."],
        steps: ["Verify manifests and hashes.", "Check redaction across state/report.", "Quarantine invalid persona findings."],
        expected_result: "No unevidenced or secret-bearing claim influences the decision.",
        automation: "automated", check_hints: ["evidence", "manifest", "redaction", "quarantine"],
      },
      {
        suffix: "decision", title: "Explain the final decision", category: "decision", priority: "P0",
        objective: "Make ship/review/hold reasoning inspectable.",
        preconditions: ["Scoring and coverage are complete."],
        steps: ["Reconcile score, coverage, findings, and limitations.", "State concrete fixes for open gaps.", "Preserve all run IDs."],
        expected_result: "The decision is reproducible from the report.",
        automation: "automated", check_hints: ["confidence", "decision", "score", "report"],
      },
      {
        suffix: "rollback", title: "Record rollback readiness gap", category: "coverage", priority: "P1",
        objective: "Make missing rollout/rollback evidence explicit.",
        preconditions: ["Release procedure may be absent."],
        steps: ["Look for documented rollback steps.", "If absent, mark a gap with the exact evidence needed.", "Do not infer readiness."],
        expected_result: "Rollback readiness is evidenced or gapped.",
        automation: "coverage-gap", check_hints: ["rollback", "gap", "release"],
      },
    ],
  };
}

function generalProfile(): ProfileTemplate {
  return {
    profile: "general",
    objective: "Produce a focused, evidence-backed assessment for the requested intent with explicit scope, risks, execution results, and coverage gaps.",
    scope_notes: ["Intent-specific checks are selected deterministically; unsupported scenarios are gaps, not passes."],
    scenarios: [
      {
        suffix: "scope", title: "Resolve target and scope", category: "coverage", priority: "P0",
        objective: "Establish exactly what was and was not assessed.",
        preconditions: ["Target and intent are supplied."],
        steps: ["Normalize the target.", "Read available source/inventory metadata.", "Record unavailable context as a gap."],
        expected_result: "Scope is unambiguous and attributable.",
        automation: "automated", check_hints: ["inventory", "target", "scope"],
      },
      {
        suffix: "risk", title: "Analyze intent-specific risks", category: "risk", priority: "P0",
        objective: "Rank risks relevant to the requested label.",
        preconditions: ["Target/inventory are available."],
        steps: ["Analyze target and source signals.", "Rank risks by consequence.", "Map risks to checks or gaps."],
        expected_result: "Risks explain why checks were selected.",
        automation: "automated", check_hints: ["risk", "inventory"],
      },
      {
        suffix: "source", title: "Inspect relevant source and configuration", category: "source", priority: "P1",
        objective: "Ground the assessment in repository files and configuration.",
        preconditions: ["Source checkout is available."],
        steps: ["Read relevant code, configs, tests, CI, and docs.", "Cite evidence paths.", "Record unavailable source as a gap."],
        expected_result: "Observations cite files or explicit gaps.",
        automation: "assisted", check_hints: ["static", "source", "ci", "config"],
      },
      {
        suffix: "functional", title: "Verify functional behavior", category: "functional", priority: "P0",
        objective: "Check that intended behavior works and failures are visible.",
        preconditions: ["Checks or runtime fixtures are available."],
        steps: ["Execute selected functional checks.", "Record pass/fail with evidence.", "Record skipped checks as gaps."],
        expected_result: "Functional results are honest and evidence-linked.",
        automation: "automated", check_hints: ["functional", "functionality", "test", "browser.steps"],
      },
      {
        suffix: "negative", title: "Verify error and empty states", category: "errors", priority: "P1",
        objective: "Ensure failures are typed, explainable, and non-destructive.",
        preconditions: ["Failure paths are discoverable."],
        steps: ["Inspect error handling and logs.", "Confirm no stack traces/secrets in stdout.", "Record unsafe probes as gaps."],
        expected_result: "Errors are machine-readable and safe.",
        automation: "assisted", check_hints: ["errors", "failure", "issues", "redaction"],
      },
      {
        suffix: "evidence", title: "Verify evidence and redaction", category: "evidence", priority: "P0",
        objective: "Ensure every claim is hashed, attributable, and redacted.",
        preconditions: ["Evidence store is enabled."],
        steps: ["Verify manifest hashes and artifacts.", "Scan report/state for secrets.", "List missing evidence as gaps."],
        expected_result: "No finding lacks evidence and no secret is persisted.",
        automation: "automated", check_hints: ["evidence", "manifest", "redaction"],
      },
      {
        suffix: "residual", title: "Record residual gaps and fixes", category: "coverage", priority: "P0",
        objective: "Leave no ambiguity about what remains unverified.",
        preconditions: ["Execution is complete."],
        steps: ["List blocked/skipped/errored/refused work.", "State unblock evidence for each gap.", "Provide concrete developer fixes."],
        expected_result: "Gaps and fixes are explicit.",
        automation: "coverage-gap", check_hints: ["gap", "blocked", "limitation"],
      },
    ],
  };
}

function sourceFacts(inventory: Record<string, unknown>): TestPlanSourceFacts {
  return {
    target_root: asString(inventory.root),
    source_files: count(inventory.source_files),
    test_files: count(inventory.test_files),
    markup_files: count(inventory.markup_files),
    ci_files: count(inventory.ci_files),
    manifests: count(inventory.manifests),
    has_markup: inventory.has_markup === true || count(inventory.markup_files) > 0,
    has_manifest: inventory.has_manifest === true || count(inventory.manifests) > 0,
  };
}

function linkChecksByHints(hints: readonly string[], checks: readonly Check[]): string[] {
  const lowered = hints.map((h) => h.toLowerCase());
  return checks
    .filter((check) => {
      const haystack = `${check.id} ${check.title} ${check.intent}`.toLowerCase();
      return lowered.some((hint) => haystack.includes(hint));
    })
    .slice(0, 4)
    .map((check) => check.id);
}

function linkChecks(template: ScenarioTemplate, checks: readonly Check[]): string[] {
  return linkChecksByHints(template.check_hints, checks);
}

function emptySummary(total: number): TestPlanSummary {
  return {
    total,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    error: 0,
    planned_not_run: total,
    coverage_gaps: total,
    executed: 0,
    executed_pct: 0,
  };
}

export function buildTestPlan(params: BuildTestPlanParams): TestPlan {
  const intent = asString(params.intent);
  const label = asString(params.command)?.trim() || intentLabel(intent);
  const template = profileForLabel(label);
  const checks = Array.isArray(params.checks) ? params.checks : [];
  const risks = Array.isArray(params.risks) ? params.risks : [];
  const facts = sourceFacts(params.inventory ?? {});
  const scenarios: TestPlanScenario[] = template.scenarios.map((item, index) => ({
    id: `TP-${slug(label)}-${String(index + 1).padStart(2, "0")}`,
    title: `${item.title} — ${label}`,
    category: item.category,
    priority: item.priority,
    objective: item.objective,
    preconditions: [...item.preconditions],
    steps: [...item.steps],
    expected_result: item.expected_result,
    automation: item.automation,
    check_hints: [...item.check_hints],
    check_ids: linkChecks(item, checks),
    result: null,
  }));
  const scopeNotes = [...template.scope_notes];
  if (facts.source_files > 0) scopeNotes.push(`Source inventory: ${facts.source_files} source file(s), ${facts.test_files} test file(s).`);
  if (facts.markup_files > 0) scopeNotes.push("Markup was discovered; UI assertions are included where the intent supports them.");
  if (risks.length > 0) scopeNotes.push(`${risks.length} risk(s) from Risk Analysis inform scenario priority.`);
  return {
    schema_version: TEST_PLAN_SCHEMA_VERSION,
    intent,
    label,
    profile: template.profile,
    title: `Comprehensive ${label} test plan`,
    objective: template.objective,
    target: {
      kind: asString(params.target?.kind),
      raw: asString(params.target?.raw),
      resolved: asString(params.target?.resolved),
    },
    source_facts: facts,
    scope_notes: scopeNotes,
    scenarios,
    summary: emptySummary(scenarios.length),
  };
}

function normalizeTestPlan(plan: TestPlan): TestPlan {
  return {
    ...plan,
    scope_notes: asStringArray(plan.scope_notes),
    scenarios: (Array.isArray(plan.scenarios) ? plan.scenarios : []).map((scenario) => ({
      ...scenario,
      preconditions: asStringArray(scenario.preconditions),
      steps: asStringArray(scenario.steps),
      check_hints: asStringArray(scenario.check_hints),
      check_ids: asStringArray(scenario.check_ids),
      result: scenario.result ?? null,
    })),
  };
}

function resultStatus(checks: readonly Check[]): TestPlanResultStatus {
  if (checks.length === 0) return "coverage_gap";
  const statuses = new Set(checks.map((check) => String(check.status).toLowerCase()));
  if (statuses.has(CheckStatus.FAILED)) return "failed";
  if (statuses.has(CheckStatus.ERROR)) return "error";
  if (statuses.has(CheckStatus.BLOCKED)) return "blocked";
  if (statuses.has(CheckStatus.SKIPPED)) return "skipped";
  if (statuses.has(CheckStatus.PLANNED) || statuses.has(CheckStatus.RUNNING)) return "planned_not_run";
  if (statuses.has(CheckStatus.PASSED)) return "passed";
  return "coverage_gap";
}

function summarize(scenarios: readonly TestPlanScenario[]): TestPlanSummary {
  const counts = {
    passed: 0, failed: 0, blocked: 0, skipped: 0, error: 0, planned_not_run: 0, coverage_gaps: 0,
  };
  for (const scenario of scenarios) {
    const status = scenario.result?.status ?? "coverage_gap";
    if (status === "coverage_gap") counts.coverage_gaps += 1;
    else counts[status] += 1;
  }
  const executed = counts.passed + counts.failed;
  const total = scenarios.length;
  return {
    total,
    ...counts,
    executed,
    executed_pct: total ? Math.round((executed / total) * 1000) / 10 : 0,
  };
}

/** Attach deterministic execution results. This never upgrades a gap to a pass. */
export function finalizeTestPlan(
  plan: TestPlan,
  checks: readonly Check[] = [],
  findings: readonly Finding[] = [],
): TestPlan {
  const normalized = normalizeTestPlan(plan);
  const checkById = new Map(checks.map((check) => [check.id, check]));
  const findingsByCheck = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = asString(finding.check_id);
    if (!key) continue;
    const list = findingsByCheck.get(key) ?? [];
    list.push(finding);
    findingsByCheck.set(key, list);
  }

  const scenarios = normalized.scenarios.map((scenario) => {
    const linkedIds = Array.from(new Set([
      ...scenario.check_ids,
      ...linkChecksByHints(scenario.check_hints, checks),
    ]));
    const linked = linkedIds
      .map((id) => checkById.get(id))
      .filter((check): check is Check => Boolean(check));
    const status = scenario.automation === "coverage-gap" ? "coverage_gap" : resultStatus(linked);
    const findingIds = Array.from(new Set([
      ...linked.flatMap((check) => check.finding_ids ?? []),
      ...linked.flatMap((check) => (findingsByCheck.get(check.id) ?? []).map((finding) => finding.id)),
    ]));
    const evidence = Array.from(new Set(linked.flatMap((check) => check.evidence ?? [])));
    const details = linked
      .map((check) => `${check.id}: ${check.actual || check.skip_reason || check.status}`)
      .filter((line) => line.trim().length > 0);
    const gapReason = status === "coverage_gap"
      ? scenario.automation === "coverage-gap"
        ? "Scenario is intentionally reported as a coverage gap and was not executed."
        : "No executed check was linked to this scenario."
      : "";
    return {
      ...scenario,
      result: {
        scenario_id: scenario.id,
        status,
        check_ids: linked.map((check) => check.id),
        linked_checks: linked.map((check) => ({ id: check.id, status: check.status })),
        evidence,
        finding_ids: findingIds,
        detail: details.join(" | "),
        coverage_gap_reason: gapReason,
      } satisfies TestPlanResult,
    };
  });

  return { ...normalized, scenarios, summary: summarize(scenarios) };
}

function evidencePaths(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(evidencePaths);
  if (isRecord(value)) return Object.values(value).flatMap(evidencePaths);
  return [];
}

/** Adapt host observation records to the shared check contract used for results. */
export function checksFromObservations(observations: ReadonlyArray<Record<string, unknown>>): Check[] {
  return observations.map((observation) => ({
    id: asString(observation.check_id, asString(observation.id)),
    title: asString(observation.title, asString(observation.check_id)),
    domain: asString(observation.domain, "functional"),
    persona: asString(observation.persona),
    kind: asString(observation.kind, "browser"),
    intent: asString(observation.intent),
    expected: "",
    base_weight: 1,
    status: asString(observation.status, "planned"),
    weight: 1,
    actual: asString(observation.actual),
    evidence: Array.from(new Set(evidencePaths(observation.evidence))),
    finding_ids: Array.from(new Set([
      ...asStringArray(observation.finding_ids),
      ...(Array.isArray(observation.findings)
        ? observation.findings
            .map((finding) => (isRecord(finding) ? asString(finding.id) : typeof finding === "string" ? finding : ""))
            .filter((id) => id.length > 0)
        : []),
    ])),
    skip_reason: asString(observation.skip_reason),
    started_at: null,
    completed_at: null,
    metadata: {},
  }));
}

/** Build a plan and attach observation results for hosts like `lemma browser`. */
export function testPlanFromObservations(
  params: BuildTestPlanParams,
  observations: ReadonlyArray<Record<string, unknown>>,
): TestPlan {
  return finalizeTestPlan(buildTestPlan(params), checksFromObservations(observations));
}
