/**
 * Deterministic source feature discovery.
 *
 * Produces a stable inventory of testable UI features (routes, buttons, inputs,
 * selects, toggles, forms) from repository source. No model, no network, and no
 * wall-clock input: the same tree always yields the same inventory.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FeatureLocation {
  path: string;
  line: number;
}

export type FeatureKind = "route" | "button" | "input" | "select" | "toggle" | "form" | "link";

export interface SourceFeature {
  id: string;
  kind: FeatureKind;
  label: string;
  selector_hint: string;
  route_hint: string;
  option_hint?: string;
  source: FeatureLocation;
}

export interface FeatureInventory {
  schema_version: "lemma.feature_inventory/v1";
  root: string;
  files_scanned: number;
  features: SourceFeature[];
}

export interface DiscoverFeaturesOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  include?: string[];
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".html", ".mdx"];
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".lemma", "dist", "build", "coverage", ".next", ".turbo", "out", "vendor",
]);
const DEFAULT_MAX_FILES = 600;
const DEFAULT_MAX_FILE_BYTES = 200_000;

function stableId(kind: string, label: string, route: string, sourcePath: string, line: number): string {
  const basis = `${kind}|${label}|${route}|${sourcePath}|${line}`;
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 10);
  const slug = `${kind}-${label || "unnamed"}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${slug || kind}-${hash}`;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", larr: "←", rarr: "→", times: "×", ndash: "–", mdash: "—",
};

function cleanLabel(value: string): string {
  return value
    // A JSX attribute containing `=>` can fool a simple tag regex; drop the
    // trailing expression fragment so the visible label remains.
    .replace(/^[\s\S]*?\}\s*>\s*/, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp|larr|rarr|times|ndash|mdash);/gi, (_, name: string) =>
      HTML_ENTITIES[name.toLowerCase()] ?? " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return m ? m[1]!.trim() : "";
}

function collectFiles(root: string, options: DiscoverFeaturesOptions): string[] {
  const exts = new Set((options.include?.length ? options.include : DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function featureFromMatch(
  kind: FeatureKind,
  label: string,
  selector: string,
  route: string,
  rel: string,
  line: number,
  optionHint = "",
): SourceFeature {
  return {
    id: stableId(kind, label, route, rel, line),
    kind,
    label,
    selector_hint: selector,
    route_hint: route,
    ...(optionHint ? { option_hint: optionHint } : {}),
    source: { path: rel, line },
  };
}

function scanContent(content: string, rel: string): SourceFeature[] {
  const features: SourceFeature[] = [];
  const lineAt = (text: string, index: number): number => text.slice(0, index).split(/\r?\n/).length;
  const add = (kind: FeatureKind, label: string, selector: string, route: string, index: number, optionHint = ""): void => {
    const clean = cleanLabel(label);
    if (!clean && !selector) return;
    features.push(featureFromMatch(kind, clean, selector, route, rel, lineAt(content, index), optionHint));
  };

  // Routes (framework-agnostic, conservative patterns)
  const routePatterns = [
    /<Route[^>]*\bpath\s*=\s*["'`]([^"'`]+)["'`][^>]*>/g,
    /\b(?:path|route)\s*:\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:app|router|server)\.(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const re of routePatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const route = m[1]!.trim();
      if (!route || route.includes("${") || route === "*") continue;
      add("route", route, "", route, m.index);
    }
  }

  // Buttons and button-like controls
  const buttonRe = /<button\b([^>]*)>([\s\S]{0,200}?)<\/button>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = buttonRe.exec(content))) {
    const attrs = bm[1] ?? "";
    const label = cleanLabel(bm[2] ?? "") || attr(attrs, "aria-label") || attr(attrs, "data-testid") || attr(attrs, "title");
    const selector = attr(attrs, "data-testid")
      ? `[data-testid="${attr(attrs, "data-testid")}"]`
      : attr(attrs, "id") ? `#${attr(attrs, "id")}` : "";
    add("button", label, selector, "", bm.index);
  }
  const roleButtonRe = /\brole\s*=\s*["']button["'][^>]*\b(?:aria-label|data-testid)\s*=\s*["']([^"']+)["']/gi;
  let rbm: RegExpExecArray | null;
  while ((rbm = roleButtonRe.exec(content))) {
    add("button", rbm[1]!, "", "", rbm.index);
  }

  // Inputs
  const inputRe = /<input\b([^>]*)\/?>/gi;
  let im: RegExpExecArray | null;
  while ((im = inputRe.exec(content))) {
    const attrs = im[1] ?? "";
    const type = attr(attrs, "type") || "text";
    if (["hidden", "file", "submit", "button", "image"].includes(type.toLowerCase())) continue;
    const label = attr(attrs, "aria-label") || attr(attrs, "placeholder") || attr(attrs, "name") || attr(attrs, "id");
    const selector = attr(attrs, "data-testid")
      ? `[data-testid="${attr(attrs, "data-testid")}"]`
      : attr(attrs, "name") ? `[name="${attr(attrs, "name")}"]` : attr(attrs, "id") ? `#${attr(attrs, "id")}` : "";
    add("input", label || type, selector, "", im.index);
  }

  // Selects
  const selectRe = /<select\b([^>]*)>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = selectRe.exec(content))) {
    const attrs = sm[1] ?? "";
    const label = attr(attrs, "aria-label") || attr(attrs, "name") || attr(attrs, "id");
    const selector = attr(attrs, "data-testid")
      ? `[data-testid="${attr(attrs, "data-testid")}"]`
      : attr(attrs, "name") ? `[name="${attr(attrs, "name")}"]` : "";
    const optionMatch = /<option\b[^>]*>\s*([^<]{1,40})/i.exec(content.slice(sm.index + sm[0].length, sm.index + sm[0].length + 500));
    add("select", label || "select", selector, "", sm.index, cleanLabel(optionMatch?.[1] ?? ""));
  }

  // Toggles (switch/checkbox/radio/aria-pressed/aria-expanded)
  const toggleRe = /<(?:button|input|div|span)\b([^>]*(?:role\s*=\s*["'](?:switch|checkbox)["']|type\s*=\s*["'](?:checkbox|radio)["']|aria-(?:pressed|expanded)\s*=)[^>]*)>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = toggleRe.exec(content))) {
    const attrs = tm[1] ?? "";
    const label = attr(attrs, "aria-label") || attr(attrs, "data-testid") || attr(attrs, "name") || attr(attrs, "id");
    const selector = attr(attrs, "data-testid")
      ? `[data-testid="${attr(attrs, "data-testid")}"]`
      : attr(attrs, "name") ? `[name="${attr(attrs, "name")}"]` : "";
    add("toggle", label || "toggle", selector, "", tm.index);
  }

  // Forms
  const formRe = /<form\b([^>]*)>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(content))) {
    const attrs = fm[1] ?? "";
    const label = attr(attrs, "aria-label") || attr(attrs, "id") || attr(attrs, "name") || "form";
    const selector = attr(attrs, "data-testid") ? `[data-testid="${attr(attrs, "data-testid")}"]` : "";
    add("form", label, selector, "", fm.index);
  }

  // Links with stable text/testid
  const linkRe = /<a\b([^>]*)>([\s\S]{0,160}?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(content))) {
    const attrs = lm[1] ?? "";
    const href = attr(attrs, "href");
    const label = cleanLabel(lm[2] ?? "") || attr(attrs, "aria-label") || href;
    const selector = attr(attrs, "data-testid") ? `[data-testid="${attr(attrs, "data-testid")}"]` : "";
    add("link", label, selector, href, lm.index);
  }

  return features;
}

/** Scan a repository tree for testable UI features. */
export function discoverFeatures(root: string, options: DiscoverFeaturesOptions = {}): FeatureInventory {
  const absRoot = path.resolve(root);
  const files = collectFiles(absRoot, options);
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const all: SourceFeature[] = [];
  for (const file of files) {
    let content: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > maxBytes) continue;
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(absRoot, file).split(path.sep).join("/");
    all.push(...scanContent(content, rel));
  }

  const seen = new Set<string>();
  const features = all
    .filter((f) => {
      // Collapse the same control declared in multiple components: repeated
      // labels with no route/testID distinction would otherwise produce
      // duplicate browser steps across crawled pages.
      const key = `${f.kind}|${f.label.toLowerCase()}|${f.route_hint}|${f.selector_hint.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.label.localeCompare(b.label) ||
      a.source.path.localeCompare(b.source.path) ||
      a.source.line - b.source.line ||
      a.id.localeCompare(b.id),
    );

  return {
    schema_version: "lemma.feature_inventory/v1",
    root: absRoot,
    files_scanned: files.length,
    features,
  };
}
