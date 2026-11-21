/**
 * Command argument builders ported from Lemma command-args semantics.
 * Pure/host-neutral: URL extraction and invocation builders for agent/adapter use.
 */

export const SUBCOMMANDS = new Set([
  "run",
  "plan",
  "status",
  "report",
  "abort",
  "personas",
  "verify-evidence",
  "auth",
  "quota",
  "ledger",
  "signup",
  "billing",
  "calibrate",
  "sarif",
  "junit",
  "sign-report",
  "verify-report",
  "prune",
]);

const BROWSER_BOOLEAN_FLAGS = new Set([
  "--headed",
  "--headless",
  "--mobile",
  "--mobile-pack",
  "--responsive",
  "--no-mobile",
  "--crawl",
  "--no-crawl",
  "--comprehensive",
  "--active",
  "--no-active",
  "--active-interactions",
  "--no-active-interactions",
  "--browser-har",
  "--browser-trace",
  "--browser-video",
]);

const BROWSER_VALUE_FLAGS = new Set([
  "--viewport",
  "--mobile-viewport",
  "--timeout",
  "--timeout-ms",
  "--kill-on",
  "--max-checks",
  "--max-pages",
  "--source",
  "--source-dir",
  "--fail-on",
  "--min-score",
  "--seed",
]);

export interface Invocation {
  args: string[];
  error?: string;
}

/** Return the first http(s) URL in a free-form request, if any. */
export function extractUrl(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s"'`<>]+/i.exec(text || "");
  if (!match) return null;
  return match[0].replace(/[),.;:!?]+$/g, "");
}

/** Return true when the value is an absolute http(s) URL. */
export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test((value || "").trim());
}

function browserExtraArgs(text: string, url: string): string[] {
  const index = text.indexOf(url);
  const remainder = index >= 0 ? text.slice(index + url.length) : "";
  const tokens = remainder.split(/\s+/).filter(Boolean);
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (BROWSER_BOOLEAN_FLAGS.has(token)) {
      args.push(token);
    } else if (BROWSER_VALUE_FLAGS.has(token) && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      if (next && !next.startsWith("-")) {
        args.push(token, next);
        i += 1;
      }
    }
  }
  return args;
}

/**
 * Bare `/lemma-browser <url>` defaults to a full browser assessment:
 * crawl same-origin surface and include mobile pack. Explicit flags win.
 */
function browserDefaults(text: string, url: string): string[] {
  const extra = browserExtraArgs(text, url);
  const defaults: string[] = [];
  const hasCrawlChoice =
    extra.includes("--crawl") ||
    extra.includes("--no-crawl") ||
    extra.includes("--comprehensive");
  const hasMobileChoice =
    extra.includes("--mobile") ||
    extra.includes("--mobile-pack") ||
    extra.includes("--responsive") ||
    extra.includes("--no-mobile") ||
    extra.includes("--comprehensive");
  const hasHeadChoice = extra.includes("--headed") || extra.includes("--headless");
  const hasActiveChoice = extra.includes("--active") || extra.includes("--no-active");
  const hasActiveInteractionsChoice =
    extra.includes("--active-interactions") || extra.includes("--no-active-interactions");
  if (!hasCrawlChoice) defaults.push("--crawl");
  if (!extra.includes("--max-pages")) defaults.push("--max-pages", "8");
  if (!hasMobileChoice) defaults.push("--mobile");
  if (!hasHeadChoice) defaults.push("--headed");
  if (!hasActiveChoice) defaults.push("--active");
  if (!hasActiveInteractionsChoice) defaults.push("--active-interactions");
  return defaults;
}

/**
 * Build a live browser regression run. `/lemma-browser` must call the `browser`
 * subcommand: only that path executes `browser.steps`, the deterministic
 * click/scroll/form/toggle/navigation regression with per-step evidence.
 * A generic `run --target … --active-interactions` never runs those checks.
 */
export function browserInvocation(text: string, _personasDir: string): Invocation {
  const trimmed = (text || "").trim();
  const url = extractUrl(trimmed);
  if (!url) {
    return {
      args: [],
      error:
        "`/lemma-browser` runs the live browser regression and needs a reachable URL.\n\n" +
        "Example:\n\n```\n/lemma-browser http://localhost:3000\n```\n\n" +
        "A directory target only records static scope. If a headed browser is unavailable, " +
        "the browser checks are reported as `blocked` coverage gaps, never as a pass.",
    };
  }
  const extra = browserExtraArgs(trimmed, url);
  return {
    args: [
      "browser",
      url,
      ...(extra.includes("--no-crawl") ? [] : ["--crawl"]),
      ...(extra.includes("--max-pages") ? [] : ["--max-pages", "80"]),
      ...(extra.includes("--timeout-ms") || extra.includes("--timeout") ? [] : ["--timeout-ms", "120000"]),
      ...extra,
    ],
  };
}

/** Demo-surface inventory by default; with URL runs live browser checks. */
export function demoInvocation(text: string, personasDir: string): Invocation {
  const trimmed = (text || "").trim();
  const url = extractUrl(trimmed);
  if (url) {
    return {
      args: [
        "run",
        "--target",
        url,
        "--personas-dir",
        personasDir,
        "--intent",
        "Lemma demo assessment",
        ...browserDefaults(trimmed, url),
        ...browserExtraArgs(trimmed, url),
      ],
    };
  }
  return {
    args: [
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      personasDir,
      "--intent",
      "Lemma demo assessment",
    ],
  };
}

/** Build generic `/lemma` invocation from CLI-style or free-form input. */
export function lemmaInvocation(text: string, personasDir: string): Invocation {
  const trimmed = (text || "").trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { args: ["run", "--target", ".", "--no-browser", "--personas-dir", personasDir] };
  }
  const first = tokens[0];
  if (first === "--version" || first === "-v") return { args: ["--version"] };
  if (first === "help" || first === "--help" || first === "-h") return { args: ["--help"] };
  if (first && SUBCOMMANDS.has(first)) return { args: tokens };
  const url = extractUrl(trimmed);
  if (url) {
    return {
      args: ["run", "--target", url, "--personas-dir", personasDir, "--intent", trimmed],
    };
  }
  return {
    args: [
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      personasDir,
      "--intent",
      trimmed,
    ],
  };
}


/** @deprecated Use lemmaInvocation. */
export { lemmaInvocation as assayInvocation };
