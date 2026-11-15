import {
  CheckOutcome,
  CheckStatus,
  Severity,
  Strength,
  sanitizeUrl,
  type Check,
  type FindingDraft,
} from "@lemma/core";

export interface BrowserNavigationResult {
  url: string;
  finalUrl: string;
  status?: number | null;
  headers?: Record<string, string>;
  error?: string;
}

export interface BrowserPageView {
  navigation: BrowserNavigationResult;
  snapshot: Record<string, unknown>;
  consoleMessages: Array<Record<string, unknown>>;
  pageErrors: Array<Record<string, unknown>>;
  networkEntries: Array<Record<string, unknown>>;
  cookies?: Array<Record<string, unknown>>;
  evidenceRefs: Record<string, string>;
  label?: string;
}

export const IMPLEMENTED_BROWSER_CHECKS = new Set([
  "browser.load",
  "browser.console",
  "browser.network",
  "browser.content",
  "browser.links",
  "browser.security",
  "browser.accessibility",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeNavigation(value: unknown): BrowserNavigationResult {
  const d = asRecord(value);
  const url = asString(d.url) || asString(d.requested_url) || asString(d.requestedUrl);
  const finalUrl = asString(d.finalUrl) || asString(d.final_url) || url;
  const statusValue = d.status;
  const headersRaw = asRecord(d.headers);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(headersRaw)) {
    headers[String(k).toLowerCase()] = String(v);
  }
  const navigation: BrowserNavigationResult = {
    url,
    finalUrl,
  };
  if (typeof statusValue === "number") navigation.status = statusValue;
  else if (statusValue === null) navigation.status = null;
  if (Object.keys(headers).length > 0) navigation.headers = headers;
  const error = asString(d.error);
  if (error) navigation.error = error;
  return navigation;
}

export function normalizePageView(value: unknown): BrowserPageView {
  const d = asRecord(value);
  const navigation = normalizeNavigation(d.navigation ?? d);
  const evidenceRefsRaw = asRecord(d.evidenceRefs ?? d.evidence_refs);
  const evidenceRefs: Record<string, string> = {};
  for (const [k, v] of Object.entries(evidenceRefsRaw)) {
    if (typeof v === "string" && v) evidenceRefs[k] = v;
  }
  const view: BrowserPageView = {
    navigation,
    snapshot: asRecord(d.snapshot),
    consoleMessages: asArray(d.consoleMessages ?? d.console_messages).map(asRecord),
    pageErrors: asArray(d.pageErrors ?? d.page_errors).map(asRecord),
    networkEntries: asArray(d.networkEntries ?? d.network_entries).map(asRecord),
    evidenceRefs,
  };
  const cookies = asArray(d.cookies).map(asRecord);
  if (cookies.length > 0) view.cookies = cookies;
  const label = asString(d.label);
  if (label) view.label = label;
  return view;
}

export function commonEvidence(view: BrowserPageView): string[] {
  const refs = view.evidenceRefs ?? {};
  const keys = ["screenshot", "headers", "console", "network", "snapshot", "cookies", "navigation"];
  return keys.map((k) => refs[k]).filter((v): v is string => typeof v === "string" && v.length > 0);
}

function baseOutcome(view: BrowserPageView): CheckOutcome {
  return new CheckOutcome({ status: CheckStatus.FAILED, evidence: commonEvidence(view) });
}

function evalLoad(view: BrowserPageView, navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const snap = view.snapshot ?? {};
  const finalUrl = navigation.finalUrl || navigation.url;

  if (navigation.error) {
    outcome.addFinding(
      "The live target could not be loaded",
      Severity.HIGH,
      "functional",
      "No customer can complete a journey if the page does not render.",
      sanitizeUrl(navigation.url),
      "Open the target URL in a clean browser session and observe the navigation error.",
      Strength.OBSERVED,
      "Confirm the service is reachable, the URL is correct, and TLS is valid.",
      "Re-run the harness and confirm a 2xx/3xx response and visible content.",
      ["runtime", "navigation"],
    );
    outcome.actual = `Navigation failed: ${navigation.error}`;
    return outcome;
  }

  if (navigation.status !== undefined && navigation.status !== null && navigation.status >= 400) {
    outcome.addFinding(
      `The live target returned HTTP ${navigation.status}`,
      navigation.status >= 500 ? Severity.HIGH : Severity.MEDIUM,
      "functional",
      "Customers see an error or an incomplete surface instead of the intended product.",
      sanitizeUrl(finalUrl),
      "Request the URL and inspect the status code and response body.",
      Strength.OBSERVED,
      "Fix the server route, dependency, or deployment failure and add a smoke check.",
      "Confirm a 2xx/3xx response and the expected page title.",
      ["runtime", "http-status"],
    );
  }

  const title = asString(snap.title).trim();
  if (!title) {
    outcome.addFinding(
      "The rendered page has no title",
      Severity.MEDIUM,
      "content",
      "Customers, tabs, and assistive technology lack a concise page identity.",
      sanitizeUrl(finalUrl),
      "Inspect document.title after load.",
      Strength.OBSERVED,
      "Set a unique, descriptive title for every route.",
      "Confirm the title is present and specific to the page.",
      ["content", "title"],
    );
  }

  const bodyLength = asNumber(snap.bodyTextLength ?? snap.body_text_length, 0);
  if (bodyLength < 20) {
    outcome.addFinding(
      "The rendered page has little or no visible content",
      Severity.MEDIUM,
      "functional",
      "A blank or placeholder page can look like a successful response while delivering nothing.",
      sanitizeUrl(finalUrl),
      "Load the page and inspect the visible body text.",
      Strength.OBSERVED,
      "Confirm data loading, error handling, and the empty-state experience.",
      "Confirm the page shows the intended content or an explicit empty state.",
      ["runtime", "empty-state"],
    );
  }

  const titlePreview = title.slice(0, 80);
  outcome.actual = `HTTP ${navigation.status}; title ${JSON.stringify(titlePreview)}; visible text length ${bodyLength}`;
  if (outcome.findings.length === 0) outcome.status = CheckStatus.PASSED;
  return outcome;
}

function evalConsole(view: BrowserPageView, navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const finalUrl = navigation.finalUrl || navigation.url;
  const errors: Array<Record<string, unknown>> = [];
  for (const item of view.consoleMessages ?? []) {
    if (asString(item.type) === "error") errors.push(item);
  }
  for (const item of view.pageErrors ?? []) errors.push(item);

  if (errors.length === 0) {
    outcome.actual = "No console errors or unhandled page errors were observed.";
    outcome.status = CheckStatus.PASSED;
    return outcome;
  }

  for (const item of errors.slice(0, 5)) {
    const text = asString(item.text).slice(0, 180);
    outcome.addFinding(
      `Runtime console error: ${text.slice(0, 80)}`,
      Severity.MEDIUM,
      "reliability",
      "A runtime exception can break interactive behavior that a static screenshot appears to pass.",
      sanitizeUrl(finalUrl),
      "Open the browser console and reproduce the page load.",
      Strength.OBSERVED,
      "Fix the exception and add a regression check around the affected interaction.",
      "Reload the page and confirm the console remains clean.",
      ["console", "runtime"],
    );
  }
  outcome.actual = `${errors.length} console/page error(s) observed.`;
  return outcome;
}

function evalNetwork(view: BrowserPageView, _navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const entries = view.networkEntries ?? [];
  const problems: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (entry.failed) {
      const failure = asString(entry.failure).toUpperCase();
      if (failure.includes("ERR_ABORTED")) continue;
      problems.push(entry);
      continue;
    }
    const status = entry.status;
    if (typeof status === "number" && status >= 400) {
      if (status === 404 && asString(entry.url).includes("favicon")) continue;
      problems.push(entry);
    }
  }

  if (problems.length === 0) {
    outcome.actual = `${entries.length} request(s); no failed or unexpected 4xx/5xx responses.`;
    outcome.status = CheckStatus.PASSED;
    return outcome;
  }

  for (const entry of problems.slice(0, 5)) {
    const status = entry.status;
    const severity = status === null || status === undefined || (typeof status === "number" && status >= 500)
      ? Severity.HIGH
      : Severity.MEDIUM;
    const method = asString(entry.method, "GET");
    const url = asString(entry.url).slice(0, 100);
    outcome.addFinding(
      `Network request failed: ${method} ${url}`,
      severity,
      "reliability",
      "A missing API or asset can leave a customer journey incomplete.",
      sanitizeUrl(asString(entry.url)),
      "Load the page and inspect the failed request in the network log.",
      Strength.OBSERVED,
      "Fix the endpoint, credential, or asset path; add a smoke assertion for the request.",
      "Confirm the request succeeds with a 2xx/3xx response.",
      ["network", "runtime"],
    );
  }
  outcome.actual = `${entries.length} request(s); ${problems.length} failed or non-success response(s).`;
  return outcome;
}

function evalContent(view: BrowserPageView, navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const snap = view.snapshot ?? {};
  const finalUrl = navigation.finalUrl || navigation.url;
  const h1s = asArray(snap.h1s ?? snap.h1);
  const title = asString(snap.title).trim();

  if (h1s.length !== 1) {
    outcome.addFinding(
      `The page has ${h1s.length} primary heading(s) instead of one`,
      Severity.LOW,
      "content",
      "Customers and assistive technology receive an ambiguous page outline.",
      sanitizeUrl(finalUrl),
      "Inspect the rendered heading structure.",
      Strength.OBSERVED,
      "Use one descriptive h1 and a coherent heading hierarchy.",
      "Confirm one h1 and a logical outline in the accessibility tree.",
      ["content", "headings"],
    );
  }
  if (title && (title.length < 10 || title.length > 70)) {
    outcome.addFinding(
      "The page title is outside a useful length range",
      Severity.LOW,
      "content",
      "The page identity is truncated or too vague in tabs and search results.",
      sanitizeUrl(finalUrl),
      "Measure the rendered document title.",
      Strength.OBSERVED,
      "Write a concise, specific title between roughly 10 and 70 characters.",
      "Confirm the title remains readable when truncated.",
      ["content", "title"],
    );
  }
  const textLength = asNumber(snap.bodyTextLength ?? snap.body_text_length, 0);
  outcome.actual = `h1 count: ${h1s.length}; title length: ${title.length}; text length: ${textLength}`;
  if (outcome.findings.length === 0) outcome.status = CheckStatus.PASSED;
  return outcome;
}

function mixedContentUrls(snapshot: Record<string, unknown>, isHttps: boolean): string[] {
  if (!isHttps) return [];
  const urls: string[] = [];
  for (const script of asArray(snapshot.scripts)) {
    const value = typeof script === "string" ? script : asString(asRecord(script).src ?? asRecord(script).url ?? script);
    if (value.toLowerCase().startsWith("http://")) urls.push(value);
  }
  for (const link of asArray(snapshot.links).map(asRecord)) {
    const href = asString(link.href);
    if (href.toLowerCase().startsWith("http://")) urls.push(href);
  }
  for (const form of asArray(snapshot.forms).map(asRecord)) {
    const action = asString(form.action);
    if (action.toLowerCase().startsWith("http://")) urls.push(action);
  }
  return urls.slice(0, 20);
}

function evalSecurity(view: BrowserPageView, navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const finalUrl = navigation.finalUrl || navigation.url;
  const isHttps = finalUrl.toLowerCase().startsWith("https://");
  const headers = navigation.headers ?? {};
  const snapshot = view.snapshot ?? {};
  const cookies = view.cookies ?? [];

  const missing: string[] = [];
  if (isHttps && !("strict-transport-security" in headers)) {
    missing.push("Strict-Transport-Security");
  }
  if (!("content-security-policy" in headers) && !("content-security-policy-report-only" in headers)) {
    missing.push("Content-Security-Policy");
  }
  if (!("x-content-type-options" in headers)) {
    missing.push("X-Content-Type-Options");
  }
  if (
    !("x-frame-options" in headers) &&
    !asString(headers["content-security-policy"]).includes("frame-ancestors")
  ) {
    missing.push("frame protection (X-Frame-Options or CSP frame-ancestors)");
  }
  if (!("referrer-policy" in headers)) {
    missing.push("Referrer-Policy");
  }

  if (!isHttps) {
    outcome.addFinding(
      "The live target is served over plain HTTP",
      Severity.HIGH,
      "security",
      "Credentials, session cookies, and page content can be read or altered in transit.",
      sanitizeUrl(finalUrl),
      "Inspect the final URL scheme in the browser.",
      Strength.OBSERVED,
      "Serve the product over HTTPS and redirect HTTP traffic.",
      "Confirm HTTP redirects to HTTPS and HSTS is present.",
      ["transport", "tls"],
    );
  }

  if (missing.length > 0) {
    outcome.addFinding(
      `Baseline security headers are missing: ${missing.join(", ")}`,
      Severity.MEDIUM,
      "security",
      "The browser has fewer defenses against injection, MIME confusion, framing, and referrer leakage.",
      sanitizeUrl(finalUrl),
      "Inspect the response headers for the landing document.",
      Strength.OBSERVED,
      "Add the missing headers at the edge and tune CSP for the application's real resources.",
      "Re-request the page and confirm every baseline header is present.",
      ["headers", "hardening"],
    );
  }

  const mixed = mixedContentUrls(snapshot, isHttps);
  if (mixed.length > 0) {
    outcome.addFinding(
      "The page loads insecure resources or links on an HTTPS page",
      Severity.HIGH,
      "security",
      "Mixed content can be modified in transit or blocked by the browser.",
      sanitizeUrl(finalUrl),
      "Inspect script/link/form URLs that start with http:// on the page.",
      Strength.OBSERVED,
      "Serve every resource over HTTPS and update hard-coded URLs.",
      "Re-run the check and confirm no http:// resources remain.",
      ["mixed-content", "transport"],
    );
  }

  const insecureForms = asArray(snapshot.forms)
    .map(asRecord)
    .filter((form) => asString(form.action).toLowerCase().startsWith("http://"));
  if (insecureForms.length > 0) {
    outcome.addFinding(
      "A form submits over plain HTTP",
      Severity.HIGH,
      "security",
      "Form data, including credentials or payment details, can be intercepted.",
      sanitizeUrl(finalUrl),
      "Inspect form action attributes for http:// targets.",
      Strength.OBSERVED,
      "Submit forms to HTTPS endpoints only.",
      "Confirm the action is HTTPS and the browser does not warn.",
      ["forms", "transport"],
    );
  }

  const weakCookies = cookies.filter((cookie) => {
    const name = asString(cookie.name).toLowerCase();
    const sessionLike = ["session", "sid", "auth", "token", "jwt"].some((token) => name.includes(token));
    if (!sessionLike) return false;
    const secure = cookie.secure === true;
    const httpOnly = cookie.http_only === true || cookie.httpOnly === true;
    return !secure || !httpOnly;
  });
  if (weakCookies.length > 0) {
    const names = Array.from(new Set(weakCookies.map((c) => asString(c.name)).filter(Boolean))).sort();
    outcome.addFinding(
      "Session-like cookies lack Secure or HttpOnly flags",
      Severity.MEDIUM,
      "security",
      "Script or network access can steal a session that should be protected.",
      names.join(", "),
      "Inspect Set-Cookie/response cookie flags for session-like names.",
      Strength.OBSERVED,
      "Set Secure, HttpOnly, and an appropriate SameSite value.",
      "Re-load the page and confirm the flags on every session cookie.",
      ["cookies", "session"],
    );
  }

  outcome.actual = `HTTPS=${isHttps}; missing headers: ${missing.length > 0 ? missing.join(", ") : "none"}; mixed content: ${mixed.length}; weak cookies: ${weakCookies.length}`;
  if (outcome.findings.length === 0) outcome.status = CheckStatus.PASSED;
  return outcome;
}

function evalAccessibility(view: BrowserPageView, navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const snapshot = view.snapshot ?? {};
  const finalUrl = navigation.finalUrl || navigation.url;

  const images = asArray(snapshot.images)
    .map(asRecord)
    .filter((item) => item.altPresent !== true);
  const unlabeled = asArray(snapshot.inputs).map(asRecord).filter((item) => {
    const type = asString(item.type).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
    return item.hasLabel !== true;
  });
  const unnamed = asArray(snapshot.controls)
    .map(asRecord)
    .filter((item) => asString(item.name).trim().length === 0);
  const duplicateIds = asArray(snapshot.duplicateIds ?? snapshot.duplicate_ids).map((item) => String(item));
  const positiveTabindex = asNumber(snapshot.positiveTabindex ?? snapshot.positive_tabindex, 0);
  const lang = asString(snapshot.lang).trim();

  const selectorList = (items: Record<string, unknown>[]) =>
    items.slice(0, 5).map((item) => asString(item.selector)).filter(Boolean).join(", ");

  if (images.length > 0) {
    outcome.addFinding(
      `${images.length} image(s) are missing an alt attribute`,
      Severity.MEDIUM,
      "accessibility",
      "Screen-reader users may miss information or hear an unhelpful URL.",
      selectorList(images),
      "Inspect the accessibility tree for images without an accessible name.",
      Strength.OBSERVED,
      'Add meaningful alt text, or alt="" for purely decorative images.',
      "Confirm every image has an intentional alternative in the browser tree.",
      ["a11y", "images"],
    );
  }
  if (unlabeled.length > 0) {
    outcome.addFinding(
      `${unlabeled.length} form control(s) may lack a programmatic label`,
      Severity.MEDIUM,
      "accessibility",
      "Assistive-technology users may not know what the field expects.",
      selectorList(unlabeled),
      "Inspect each control's accessible name and visible label.",
      Strength.OBSERVED,
      "Associate a persistent visible label; placeholders are not labels.",
      "Confirm every control has a meaningful accessible name.",
      ["a11y", "forms"],
    );
  }
  if (unnamed.length > 0) {
    outcome.addFinding(
      `${unnamed.length} interactive control(s) have no accessible name`,
      Severity.MEDIUM,
      "accessibility",
      "A keyboard or screen-reader user cannot tell what the control does.",
      selectorList(unnamed),
      "Inspect the accessibility tree for buttons and links with empty names.",
      Strength.OBSERVED,
      "Add visible text, aria-label, or aria-labelledby; icon-only controls need a name.",
      "Confirm every control announces a useful name and role.",
      ["a11y", "controls"],
    );
  }
  if (duplicateIds.length > 0) {
    outcome.addFinding(
      `${duplicateIds.length} duplicate element id(s) were found`,
      Severity.LOW,
      "accessibility",
      "Labels and references can point at the wrong element, confusing assistive technology.",
      duplicateIds.slice(0, 5).join(", "),
      "Inspect the DOM for repeated id values.",
      Strength.OBSERVED,
      "Make ids unique or use refs/relationships instead of global ids.",
      "Re-scan the DOM and confirm ids are unique.",
      ["a11y", "dom"],
    );
  }
  if (positiveTabindex > 0) {
    outcome.addFinding(
      "Positive tabindex values change the natural focus order",
      Severity.LOW,
      "accessibility",
      "Keyboard users can be sent to unexpected controls and lose context.",
      sanitizeUrl(finalUrl),
      "Tab through the page and compare focus order with the visual order.",
      Strength.OBSERVED,
      "Rely on DOM order; use tabindex 0 or -1 only where necessary.",
      "Confirm the focus order follows the reading order.",
      ["a11y", "keyboard"],
    );
  }
  if (!lang) {
    outcome.addFinding(
      "The document language is not declared",
      Severity.LOW,
      "accessibility",
      "Screen readers may pronounce content with the wrong language rules.",
      sanitizeUrl(finalUrl),
      "Inspect the html element's lang attribute.",
      Strength.OBSERVED,
      'Declare a valid language such as lang="en".',
      "Confirm the language is exposed in the accessibility tree.",
      ["a11y", "language"],
    );
  }

  outcome.actual = `${images.length} image(s) without alt; ${unlabeled.length} unlabeled control(s); ${unnamed.length} unnamed control(s); ${duplicateIds.length} duplicate id(s).`;
  outcome.metadata.manual_review_required = true;
  if (outcome.findings.length === 0) outcome.status = CheckStatus.PASSED;
  return outcome;
}

function evalLinks(view: BrowserPageView, navigation: BrowserNavigationResult): CheckOutcome {
  const outcome = baseOutcome(view);
  const snap = view.snapshot ?? {};
  const targetUrl = navigation.finalUrl || navigation.url;
  const isHttps = targetUrl.toLowerCase().startsWith("https://");
  const links = asArray(snap.links).map(asRecord);

  const empty: Record<string, unknown>[] = [];
  const insecure: Record<string, unknown>[] = [];
  const unsafeTarget: Record<string, unknown>[] = [];

  for (const item of links) {
    const href = asString(item.href).trim();
    const hrefLower = href.toLowerCase();
    if (href === "" || href === "#" || hrefLower.startsWith("javascript:")) {
      empty.push(item);
    }
    if (isHttps && hrefLower.startsWith("http://")) {
      insecure.push(item);
    }
    const target = asString(item.target).toLowerCase();
    const rel = asString(item.rel).toLowerCase();
    if (target === "_blank" && !rel.includes("noopener") && !rel.includes("noreferrer")) {
      unsafeTarget.push(item);
    }
  }

  const selectorList = (items: Record<string, unknown>[]) =>
    items.slice(0, 5).map((i) => asString(i.selector)).filter(Boolean).join(", ");

  if (empty.length > 0) {
    outcome.addFinding(
      `${empty.length} link(s) are empty, placeholder, or javascript: targets`,
      Severity.LOW,
      "functional",
      "A customer can hit a dead end or a control that looks interactive but does nothing.",
      selectorList(empty),
      "Inspect the href values in the rendered DOM.",
      Strength.OBSERVED,
      "Point links at a real destination or render a non-interactive element.",
      "Click each link and confirm a meaningful destination or disabled state.",
      ["links", "dead-end"],
    );
  }
  if (insecure.length > 0) {
    outcome.addFinding(
      `${insecure.length} link(s) point at plain HTTP from an HTTPS page`,
      Severity.MEDIUM,
      "security",
      "A customer can be downgraded to an interceptable destination.",
      selectorList(insecure),
      "Inspect the href values for http:// destinations.",
      Strength.OBSERVED,
      "Use HTTPS destinations and fix hard-coded URLs.",
      "Re-scan and confirm no http:// links remain.",
      ["links", "transport"],
    );
  }
  if (unsafeTarget.length > 0) {
    outcome.addFinding(
      `${unsafeTarget.length} new-tab link(s) omit noopener/noreferrer`,
      Severity.LOW,
      "security",
      "The opened page can access window.opener and navigate the original tab.",
      selectorList(unsafeTarget),
      'Inspect target="_blank" links and their rel attribute.',
      Strength.OBSERVED,
      'Add rel="noopener noreferrer" to new-tab links.',
      "Re-scan and confirm the relationship is present.",
      ["links", "tabnabbing"],
    );
  }

  outcome.actual = `${links.length} link(s); ${empty.length} placeholder; ${insecure.length} insecure; ${unsafeTarget.length} missing noopener.`;
  if (outcome.findings.length === 0) outcome.status = CheckStatus.PASSED;
  return outcome;
}

export function navigationFailedOutcome(
  check: Check,
  view: BrowserPageView,
): CheckOutcome {
  const nav = view.navigation;
  return new CheckOutcome({
    status: CheckStatus.BLOCKED,
    actual: `Navigation did not complete: ${nav.error || "unknown error"}`,
    evidence: [view.evidenceRefs?.navigation ?? ""].filter(Boolean),
    metadata: { limitation: nav.error || "Navigation did not complete" },
    blocker: {
      attempted_action: check.title || check.id,
      boundary: `Navigation did not complete: ${nav.error || "unknown error"}`,
      unblock_evidence: [
        "Restore the target URL or navigation path, then rerun the check.",
      ],
      covered_elsewhere: false,
      covered_by: [],
    },
  });
}

export function evaluateBrowserCheck(
  checkId: string,
  viewInput: BrowserPageView | Record<string, unknown>,
): CheckOutcome {
  const view = normalizePageView(viewInput);
  const navigation = view.navigation;

  // Runner-level rule: non-load checks are blocked when navigation failed.
  if (navigation.error && checkId !== "browser.load") {
    return new CheckOutcome({
      status: CheckStatus.BLOCKED,
      actual: `Navigation did not complete: ${navigation.error}`,
      evidence: [view.evidenceRefs?.navigation ?? ""].filter(Boolean),
      metadata: { limitation: navigation.error },
      blocker: {
        attempted_action: checkId,
        boundary: `Navigation did not complete: ${navigation.error}`,
        unblock_evidence: [
          "Restore the target URL or navigation path, then rerun the check.",
        ],
        covered_elsewhere: false,
        covered_by: [],
      },
    });
  }

  try {
    let outcome: CheckOutcome;
    switch (checkId) {
      case "browser.load":
        outcome = evalLoad(view, navigation);
        break;
      case "browser.console":
        outcome = evalConsole(view, navigation);
        break;
      case "browser.network":
        outcome = evalNetwork(view, navigation);
        break;
      case "browser.content":
        outcome = evalContent(view, navigation);
        break;
      case "browser.links":
        outcome = evalLinks(view, navigation);
        break;
      case "browser.security":
        outcome = evalSecurity(view, navigation);
        break;
      case "browser.accessibility":
        outcome = evalAccessibility(view, navigation);
        break;
      default:
        return new CheckOutcome({
          status: CheckStatus.ERROR,
          actual: `No browser evaluator is registered for '${checkId}'.`,
          evidence: commonEvidence(view),
        });
    }
    if (!outcome.evidence || outcome.evidence.length === 0) {
      outcome.evidence = commonEvidence(view);
    }
    return outcome;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new CheckOutcome({
      status: CheckStatus.ERROR,
      actual: `Browser check crashed: ${detail}`,
      evidence: commonEvidence(view),
      metadata: { error: detail },
    });
  }
}

export function evaluateBrowserCheckForCheck(
  check: Check,
  viewInput: BrowserPageView | Record<string, unknown>,
): CheckOutcome {
  const outcome = evaluateBrowserCheck(check.id, viewInput);
  // if navigation-failed blocker used generic attempted_action, prefer check title
  if (outcome.blocker && outcome.blocker.attempted_action === check.id) {
    outcome.blocker.attempted_action = check.title || check.id;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Bounded same-origin crawl (LEM-054)

const CRAWL_SKIP_TOKENS = [
  "/logout",
  "/signout",
  "/sign-out",
  "/delete",
  "/remove",
  "/unsubscribe",
  "/api/",
] as const;

const CRAWL_SKIP_SUFFIXES = [
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".xml",
  ".txt",
  ".csv",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pid",
  ".log",
  ".env",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".bak",
  ".lock",
  ".map",
  ".webmanifest",
] as const;

export function normalizeRoute(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (!parsed.pathname) parsed.pathname = "/";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function routeLabel(url: string, index: number): string {
  let pathname = "/";
  try {
    pathname = new URL(url).pathname || "/";
  } catch {
    pathname = "/";
  }
  const slug = pathname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return `route-${index}-${slug.slice(0, 40)}`;
}

/**
 * Return bounded, same-origin GET routes discovered from the seed page.
 *
 * Only links rendered on the seed page are followed. Forms, non-HTTP schemes,
 * external hosts, binary assets, API endpoints, and destructive actions are
 * excluded. Mirrors assay `BrowserController.discover_routes`.
 */
export function discoverRoutes(
  seedUrl: string,
  snapshot: Record<string, unknown>,
  maxPages: number,
): string[] {
  const limit = Math.max(0, Math.trunc(Number(maxPages)) - 1);
  if (limit <= 0) return [];
  const links = asArray(snapshot.links);
  if (links.length === 0) return [];

  let seed: URL;
  try {
    seed = new URL(seedUrl);
  } catch {
    return [];
  }
  if (seed.protocol !== "http:" && seed.protocol !== "https:") return [];
  const seedHost = seed.host.toLowerCase();

  const seen = new Set<string>([normalizeRoute(seed.toString())]);
  const routes: string[] = [];

  for (const rawItem of links) {
    if (routes.length >= limit) break;
    const item = asRecord(rawItem);
    if (item.download === true || (typeof item.download === "string" && item.download.length > 0)) continue;
    const href = asString(item.href).trim();
    if (!href || href.startsWith("#")) continue;
    const lowerHref = href.toLowerCase();
    if (
      lowerHref.startsWith("mailto:") ||
      lowerHref.startsWith("tel:") ||
      lowerHref.startsWith("javascript:") ||
      lowerHref.startsWith("data:") ||
      lowerHref.startsWith("blob:")
    ) {
      continue;
    }
    let absolute: URL;
    try {
      absolute = new URL(href, seed.toString());
    } catch {
      continue;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
    if (absolute.host.toLowerCase() !== seedHost) continue;
    const path = absolute.pathname || "/";
    const lowerPath = path.toLowerCase();
    if (CRAWL_SKIP_TOKENS.some((token) => lowerPath.includes(token))) continue;
    if (CRAWL_SKIP_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))) continue;
    const normalized = normalizeRoute(absolute.toString());
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    routes.push(normalized);
  }
  return routes;
}

function cloneFinding(finding: FindingDraft): FindingDraft {
  return {
    ...finding,
    evidence: Array.isArray(finding.evidence) ? [...finding.evidence] : [],
    tags: Array.isArray(finding.tags) ? [...finding.tags] : [],
  };
}

export function mergeBrowserOutcomes(outcomes: CheckOutcome[]): CheckOutcome {
  const merged = new CheckOutcome({ status: CheckStatus.PASSED, evidence: [], findings: [] });
  merged.metadata.crawled = true;
  merged.metadata.page_count = outcomes.length;
  merged.metadata.routes = outcomes.map((outcome) => ({
    page: asString(outcome.metadata.page),
    route: asString(outcome.metadata.route),
    status: outcome.status,
  }));

  const seen = new Map<string, FindingDraft>();
  let truncated = false;
  const pushEvidence = (paths: string[]) => {
    for (const path of paths) {
      if (path && !merged.evidence.includes(path)) {
        merged.evidence.push(path);
      }
    }
  };

  for (const outcome of outcomes) {
    for (const finding of outcome.findings) {
      const key = JSON.stringify([
        finding.title,
        finding.severity,
        finding.domain,
        finding.strength,
        finding.consequence,
        finding.remediation,
      ]);
      const existing = seen.get(key);
      if (!existing) {
        if (merged.findings.length >= 10) {
          truncated = true;
          continue;
        }
        const copy = cloneFinding(finding);
        seen.set(key, copy);
        merged.findings.push(copy);
      } else {
        if (finding.location && !existing.location.includes(finding.location)) {
          const combined = `${existing.location}${existing.location ? ", " : ""}${finding.location}`;
          existing.location = combined.slice(0, 800);
        }
        for (const ev of finding.evidence) {
          if (ev && !existing.evidence.includes(ev)) existing.evidence.push(ev);
        }
      }
    }
    pushEvidence(outcome.evidence);
  }

  const statuses = outcomes.map((o) => o.status);
  if (statuses.includes(CheckStatus.ERROR)) merged.status = CheckStatus.ERROR;
  else if (statuses.includes(CheckStatus.FAILED)) merged.status = CheckStatus.FAILED;
  else if (statuses.includes(CheckStatus.BLOCKED)) merged.status = CheckStatus.BLOCKED;
  else if (statuses.length > 0 && statuses.every((s) => s === CheckStatus.SKIPPED)) merged.status = CheckStatus.SKIPPED;
  else merged.status = CheckStatus.PASSED;

  const summary = outcomes.map((outcome) => {
    const page = asString(outcome.metadata?.page) || "page";
    return `${page}=${outcome.status} (${outcome.actual})`;
  });
  merged.actual = `${outcomes.length} route(s): ${summary.join(" | ")}`;
  if (merged.actual.length > 2000) merged.actual = `${merged.actual.slice(0, 1997)}...`;
  if (truncated) merged.metadata.findings_truncated = true;
  return merged;
}

export function evaluateBrowserCheckAcrossViews(
  check: Check,
  viewInputs: ReadonlyArray<BrowserPageView | Record<string, unknown>>,
): CheckOutcome {
  const views = viewInputs.map(normalizePageView);
  if (views.length === 0) {
    return new CheckOutcome({
      status: CheckStatus.BLOCKED,
      actual: "No browser page was captured for this check.",
      evidence: [],
      metadata: { limitation: "No browser page was captured." },
      blocker: {
        attempted_action: check.title || check.id,
        boundary: "No browser page was captured.",
        unblock_evidence: ["Restore navigation and rerun the check."],
        covered_elsewhere: false,
        covered_by: [],
      },
    });
  }

  const outcomes: CheckOutcome[] = [];
  const skipped: string[] = [];

  for (const view of views) {
    const nav = view.navigation;
    const route = sanitizeUrl(nav.finalUrl || nav.url);
    if (nav.error && check.id !== "browser.load") {
      skipped.push(sanitizeUrl(nav.url));
      continue;
    }
    const outcome = evaluateBrowserCheckForCheck(check, view);
    if (!outcome.metadata.route) outcome.metadata.route = route;
    if (!outcome.metadata.page) outcome.metadata.page = view.label ?? "landing";
    outcomes.push(outcome);
  }

  if (outcomes.length === 0) {
    return new CheckOutcome({
      status: CheckStatus.BLOCKED,
      actual: `No route could be evaluated: ${skipped.slice(0, 5).join("; ") || "navigation failed"}`,
      evidence: [],
      metadata: { limitation: "No route could be evaluated.", routes_not_evaluated: skipped },
      blocker: {
        attempted_action: check.title || check.id,
        boundary: "No route could be evaluated after navigation failures.",
        unblock_evidence: ["Restore the target routes and rerun the check."],
        covered_elsewhere: false,
        covered_by: [],
      },
    });
  }

  if (outcomes.length === 1) {
    const only = outcomes[0]!;
    only.metadata.crawled = views.length > 1;
    only.metadata.page_count = 1;
    if (skipped.length > 0) only.metadata.routes_not_evaluated = skipped;
    return only;
  }

  const merged = mergeBrowserOutcomes(outcomes);
  if (skipped.length > 0) merged.metadata.routes_not_evaluated = skipped;
  return merged;
}

