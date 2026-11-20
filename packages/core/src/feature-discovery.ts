/**
 * Deterministic source feature discovery with route-to-component graph mapping.
 *
 * Scans repository UI source files to build a stable inventory of testable
 * frontend routes and interactive controls (buttons, toggles/switches, inputs,
 * textareas, selects/comboboxes, tabs, accordions, sliders, forms, links),
 * propagating route context from router declarations down through imported JSX
 * child components. No model, no network, and no wall-clock input.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FeatureLocation {
  path: string;
  line: number;
}

export type FeatureKind =
  | "route"
  | "button"
  | "input"
  | "select"
  | "toggle"
  | "form"
  | "link"
  | "tab"
  | "accordion"
  | "slider";

export interface SourceFeature {
  id: string;
  kind: FeatureKind;
  label: string;
  selector_hint: string;
  route_hint: string;
  routes?: string[];
  option_hint?: string;
  input_type?: string;
  placeholder?: string;
  required?: boolean;
  auth_required?: boolean;
  shared_layout?: boolean;
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

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".html", ".mdx", ".erb", ".csv", ".rb"];
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".lemma", "dist", "build", "coverage", ".next", ".turbo", "out", "vendor",
]);
const NON_APP_UI_PATH_RE = /(^|\/)(?:__tests__|tests?|test-fixtures|fixtures|migrations|drizzle|prisma)(\/|$)|\.(?:test|spec|stories|d)\.[a-z0-9]+$/i;
const BACKEND_DIR_RE = /(^|\/)(?:api-server|backend|server)(\/|$)|(?:^|\/)server\.rb$/i;
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
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  larr: "←",
  rarr: "→",
  times: "×",
  minus: "−",
  ndash: "–",
  mdash: "—",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#39|amp|lt|gt|quot|apos|nbsp|larr|rarr|times|minus|ndash|mdash);/gi, (_, name: string) =>
    HTML_ENTITIES[name.toLowerCase()] ?? " ",
  );
}

/**
 * Extract fallback string literal from a JSX ternary/logical expression such as
 * `{loading ? "Redirecting…" : signup ? "Sign up" : "Continue with GitHub"}`.
 */
function extractJsxExpressionLabel(raw: string): string {
  const exprRe = /\{([^{}]{1,260})\}/g;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = exprRe.exec(raw))) {
    const body = m[1] ?? "";
    if (!/[?:]/.test(body)) continue;
    const strRe = /["']([^"'\\]{2,60})["']/g;
    let sm: RegExpExecArray | null;
    const literals: string[] = [];
    while ((sm = strRe.exec(body))) {
      const lit = (sm[1] ?? "").trim();
      // Skip CSS utility fragments and URL/key tokens.
      if (!lit || /^[-_#/]|^(?:px-|py-|bg-|text-|border-|flex|grid|w-|h-|mt-|mb-|ml-|mr-)/.test(lit)) continue;
      if (/\s/.test(lit) || /^[A-Z][a-zA-Z0-9]+$/.test(lit)) literals.push(lit);
    }
    if (literals.length > 0) {
      candidates.push(literals[literals.length - 1]!);
    }
  }
  return candidates.join(" ").trim();
}

function cleanLabel(value: string): string {
  const stripped = decodeEntities(
    value
      .replace(/^[\s\S]*?\}\s*>\s*/, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\{[^}]*\}/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (stripped) return stripped.slice(0, 80);
  const fallback = decodeEntities(extractJsxExpressionLabel(value)).replace(/\s+/g, " ").trim();
  return fallback.slice(0, 80);
}

function attr(tagAttrs: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*["']([^"']*)["']`, "i").exec(tagAttrs);
  if (direct?.[1] !== undefined) return direct[1].trim();
  const braced = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*\\{\\s*["'\`]([^"'\`$}]*)["'\`]\\s*\\}`, "i").exec(tagAttrs);
  return braced?.[1]?.trim() ?? "";
}

function hasBoolAttr(tagAttrs: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*\\{\\s*false\\s*\\}`, "i").test(tagAttrs)) return false;
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$|=|/)`, "i").test(tagAttrs);
}

interface ScannedTag {
  name: string;
  attrs: string;
  selfClosing: boolean;
  openStart: number;
  openEnd: number;
  closeEnd: number;
  innerRaw: string;
}

/**
 * Brace- and quote-balanced JSX/HTML tag scanner so arrow functions (`onClick={() => ...}`)
 * inside attributes never prematurely terminate an opening tag.
 */
function scanTags(content: string): ScannedTag[] {
  const out: ScannedTag[] = [];
  const len = content.length;
  let i = 0;

  while (i < len) {
    const lt = content.indexOf("<", i);
    if (lt < 0) break;
    const next = content[lt + 1];
    if (!next || next === "/" || next === "!" || next === "?") {
      i = lt + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      i = lt + 1;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < len && /[A-Za-z0-9.:_-]/.test(content[nameEnd]!)) nameEnd++;
    const name = content.slice(lt + 1, nameEnd);
    const afterName = content[nameEnd];
    if (afterName && !/[\s/>]/.test(afterName)) {
      i = nameEnd;
      continue;
    }

    let pos = nameEnd;
    let braceDepth = 0;
    let quote: string | null = null;
    let foundClose = -1;
    const maxScan = Math.min(len, lt + 2500);
    while (pos < maxScan) {
      const ch = content[pos]!;
      if (quote) {
        if (ch === "\\") {
          pos += 2;
          continue;
        }
        if (ch === quote) quote = null;
        pos++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        pos++;
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        pos++;
        continue;
      }
      if (ch === "}") {
        if (braceDepth > 0) braceDepth--;
        pos++;
        continue;
      }
      if (ch === ">" && braceDepth === 0) {
        foundClose = pos;
        break;
      }
      pos++;
    }

    if (foundClose < 0) {
      i = nameEnd;
      continue;
    }

    const rawAttrs = content.slice(nameEnd, foundClose);
    const trimmedAttrs = rawAttrs.trimEnd();
    const selfClosing = trimmedAttrs.endsWith("/");
    const attrs = selfClosing ? trimmedAttrs.slice(0, -1) : rawAttrs;
    const openEnd = foundClose + 1;
    let closeEnd = openEnd;
    let innerRaw = "";

    if (!selfClosing) {
      const isHtmlVoid = /^(?:input|img|br|hr|meta|link|area|base|col|embed|param|source|track|wbr)$/i.test(name);
      if (!isHtmlVoid) {
        const searchWindow = content.slice(openEnd, Math.min(len, openEnd + 1800));
        const closeRe = /^[A-Z]/.test(name)
          ? new RegExp(`<\\/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`)
          : new RegExp(`<\\/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`, "i");
        const cm = closeRe.exec(searchWindow);
        if (cm) {
          innerRaw = searchWindow.slice(0, cm.index);
          closeEnd = openEnd + cm.index + cm[0].length;
        }
      }
    }

    out.push({ name, attrs, selfClosing, openStart: lt, openEnd, closeEnd, innerRaw });
    i = openEnd;
  }

  return out;
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

const RESOLVE_EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

function resolveImportTarget(fromRel: string, spec: string, fileSet: Set<string>, srcRoots: string[]): string | null {
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/i, "");
    for (const ext of RESOLVE_EXTS) {
      candidates.push(`${base}${ext}`);
      if (stripped !== base) candidates.push(`${stripped}${ext}`);
    }
  } else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const rest = spec.slice(2).replace(/\.(?:js|jsx|mjs|cjs)$/i, "");
    // Prefer the closest `src/` ancestor to `fromRel` in monorepos.
    const orderedRoots = [...srcRoots].sort((a, b) => {
      const aMatch = fromRel.startsWith(`${a}/`) ? 0 : 1;
      const bMatch = fromRel.startsWith(`${b}/`) ? 0 : 1;
      return aMatch - bMatch || b.length - a.length || a.localeCompare(b);
    });
    for (const sr of orderedRoots) {
      const base = sr ? `${sr}/${rest}` : rest;
      for (const ext of RESOLVE_EXTS) candidates.push(`${base}${ext}`);
    }
  } else {
    return null;
  }

  for (const cand of candidates) {
    const norm = path.posix.normalize(cand);
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

function parseLocalImports(content: string, fromRel: string, fileSet: Set<string>, srcRoots: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const importRe = /\bimport\s+([\s\S]{1,300}?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content))) {
    const clause = (m[1] ?? "").trim();
    const spec = (m[2] ?? "").trim();
    if (!spec || /^type\b/.test(clause)) continue;
    const resolved = resolveImportTarget(fromRel, spec, fileSet, srcRoots);
    if (!resolved) continue;

    // Default import (before `{` or `,`)
    const braceIdx = clause.indexOf("{");
    const prefix = (braceIdx >= 0 ? clause.slice(0, braceIdx) : clause).replace(/,/g, "").trim();
    if (prefix && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prefix)) {
      map.set(prefix, resolved);
    }
    if (braceIdx >= 0) {
      const closeIdx = clause.indexOf("}", braceIdx);
      const named = closeIdx > braceIdx ? clause.slice(braceIdx + 1, closeIdx) : "";
      for (const part of named.split(",")) {
        const clean = part.replace(/\btype\s+/g, "").trim();
        if (!clean) continue;
        const asParts = clean.split(/\s+as\s+/);
        const local = (asParts[1] ?? asParts[0] ?? "").trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) {
          map.set(local, resolved);
        }
      }
    }
  }
  return map;
}

const AUTH_GUARD_RE = /\b(?:ProtectedRoute|PrivateRoute|RequireAuth|AuthGuard|AuthenticatedRoute)\b/;
const ROUTER_WRAPPER_NAMES = new Set([
  "Route",
  "Switch",
  "Routes",
  "ProtectedRoute",
  "PrivateRoute",
  "RequireAuth",
  "AuthGuard",
  "AuthenticatedRoute",
  "Suspense",
  "ErrorBoundary",
  "Redirect",
  "Navigate",
]);

interface DiscoveredRouteEntry {
  path: string;
  rel: string;
  line: number;
  authRequired: boolean;
  componentRels: string[];
  /** Route inferred from a page/snapshot filename rather than a router declaration. */
  fileScoped?: boolean;
}

interface CanonicalRouteEntry {
  path: string;
  authRequired: boolean;
  sourceRel: string;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Read only the first N CSV cells so note/credential columns never leave the parser. */
function parseCsvPrefix(line: string, count: number): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length && out.length < count; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (out.length < count) out.push(cell.trim());
  return out;
}

function normalizeRouteKey(route: string): string {
  return route
    .split(/[?#]/)[0]!
    .replace(/\/+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Canonical frontend routes declared by repository route catalogs. `examples.csv`
 * is read via a two-column prefix so credentials/notes are never captured.
 */
function collectCanonicalRoutes(fileContents: Map<string, string>): Map<string, CanonicalRouteEntry> {
  const routes = new Map<string, CanonicalRouteEntry>();
  const add = (path: string, sourceRel: string, authRequired = false): void => {
    if (!/^\//.test(path) || /[:*${]/.test(path)) return;
    const clean = path.split(/[?#]/)[0] || "/";
    const key = normalizeRouteKey(clean) || "root";
    if (!routes.has(key)) {
      routes.set(key, { path: clean, authRequired, sourceRel });
    } else if (authRequired) {
      const existing = routes.get(key)!;
      routes.set(key, { ...existing, authRequired: true });
    }
  };

  for (const [rel, content] of fileContents) {
    const normalizedRel = rel.replace(/\\/g, "/");
    if (/(?:^|\/)examples\.csv$/i.test(normalizedRel)) {
      for (const line of content.split(/\r?\n/)) {
        const cells = parseCsvPrefix(line, 2);
        if (cells[0]?.toLowerCase() === "title" || !cells[1]) continue;
        add(cells[1], rel, /(?:basic|digest)_auth|download_secure|two_factor/i.test(cells[1]));
      }
    }
    if (/(?:^|\/)pages\.rb$/i.test(normalizedRel)) {
      const routeRe = /^\s*["']([^"']+)["']\s*=>/gm;
      let m: RegExpExecArray | null;
      while ((m = routeRe.exec(content))) {
        add(m[1] ?? "", rel, /(?:basic|digest)_auth|download_secure|two_factor/i.test(m[1] ?? ""));
      }
    }
  }
  return routes;
}

/**
 * Template files whose filename is not the canonical route. These are common in
 * server-rendered fixtures where an index catalog or a named error view backs a
 * differently named public route.
 */
const SOURCE_FILE_ROUTE_ALIASES: Record<string, string> = {
  examples: "/",
  two_factor_code: "/two_factor",
  upload_error: "/upload",
};

/** Map `spec/contract/snapshots/jqueryui_menu.html` to canonical `/jqueryui/menu`. */
function routeForSourceFile(rel: string, canonicalRoutes: Map<string, CanonicalRouteEntry>): CanonicalRouteEntry | null {
  if (NON_APP_UI_PATH_RE.test(rel) || BACKEND_DIR_RE.test(rel)) return null;
  const normalizedRel = rel.replace(/\\/g, "/");
  const base = path.posix.basename(rel).replace(/\.[a-z0-9]+$/i, "");
  if (!base || /^(?:layout|application|app|index|home|default)$/i.test(base)) return null;
  // Only server-rendered page views use filename aliases; never map a route
  // catalog like examples.csv onto the homepage itself.
  if (/(?:^|\/)views\/[^/]+\.erb$/i.test(normalizedRel)) {
    const alias = SOURCE_FILE_ROUTE_ALIASES[base];
    if (alias) {
      return {
        path: alias,
        authRequired: /(?:basic|digest)_auth|download_secure|two_factor/i.test(alias),
        sourceRel: rel,
      };
    }
  }
  const entry = canonicalRoutes.get(normalizeRouteKey(`/${base}`));
  return entry ?? null;
}

function extractRoutesFromFile(
  content: string,
  rel: string,
  tags: ScannedTag[],
  importMap: Map<string, string>,
  canonicalRoutes: Map<string, CanonicalRouteEntry>,
): DiscoveredRouteEntry[] {
  if (NON_APP_UI_PATH_RE.test(rel) || BACKEND_DIR_RE.test(rel)) return [];
  const entries: DiscoveredRouteEntry[] = [];

  for (const tag of tags) {
    if (tag.name !== "Route") continue;
    const routePath = attr(tag.attrs, "path");
    if (!routePath || routePath === "*" || routePath.includes("${")) continue;
    // Find full `<Route ...>...</Route>` block (may contain nested tags beyond simple innerRaw)
    const blockSlice = tag.selfClosing
      ? tag.attrs
      : content.slice(tag.openStart, Math.min(content.length, tag.openStart + 1200));
    const closeRoute = /<\/Route\s*>/.exec(blockSlice);
    const routeScope = closeRoute ? blockSlice.slice(0, closeRoute.index) : `${tag.attrs} ${tag.innerRaw}`;
    // Auth guards often wrap <Route> (e.g. <ProtectedRoute><Route .../></ProtectedRoute>),
    // so inspect ancestor tags as well as the route's own subtree.
    const ancestorNames = tags
      .filter((t) => t !== tag && t.openStart < tag.openStart && t.closeEnd >= tag.closeEnd && /^[A-Z]/.test(t.name))
      .map((t) => t.name)
      .join(" ");
    const authRequired = AUTH_GUARD_RE.test(routeScope) || AUTH_GUARD_RE.test(ancestorNames);

    const componentRels = new Set<string>();
    const compRefRe = /<([A-Z][A-Za-z0-9_$]*)\b|\b(?:component|element)\s*=\s*\{\s*<?([A-Z][A-Za-z0-9_$]*)/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRefRe.exec(routeScope))) {
      const compName = cm[1] || cm[2] || "";
      if (!compName || ROUTER_WRAPPER_NAMES.has(compName)) continue;
      const targetRel = importMap.get(compName);
      if (targetRel) componentRels.add(targetRel);
    }

    entries.push({
      path: routePath,
      rel,
      line: lineAt(content, tag.openStart),
      authRequired,
      componentRels: Array.from(componentRels),
    });
  }

  // Router config objects (`{ path: "/dashboard", element: <Dashboard /> }`) ONLY in frontend router files,
  // never Express/Fastify `app.get`/`router.get`.
  const looksLikeFrontendRouter =
    /\b(?:createBrowserRouter|createRoutesFromElements|RouteObject|vue-router|@tanstack\/react-router)\b/.test(content) ||
    (tags.length > 0 && /\bpath\s*:\s*["']\/[^"']*["']/.test(content));
  if (looksLikeFrontendRouter) {
    const objRouteRe = /\{\s*[^{}]{0,240}?\bpath\s*:\s*["'](\/[^"']*)["'][^{}]{0,240}?\}/g;
    let om: RegExpExecArray | null;
    while ((om = objRouteRe.exec(content))) {
      const routePath = (om[1] ?? "").trim();
      if (!routePath || routePath === "*" || routePath.includes("${")) continue;
      const snippet = om[0] ?? "";
      const authRequired = AUTH_GUARD_RE.test(snippet);
      const componentRels = new Set<string>();
      const compMatch = /\b(?:component|element)\s*:\s*<?([A-Z][A-Za-z0-9_$]*)/.exec(snippet);
      if (compMatch?.[1]) {
        const resolved = importMap.get(compMatch[1]);
        if (resolved) componentRels.add(resolved);
      }
      entries.push({
        path: routePath,
        rel,
        line: lineAt(content, om.index),
        authRequired,
        componentRels: Array.from(componentRels),
      });
    }
  }

  // Next.js App Router (`app/.../page.tsx`) & SvelteKit (`src/routes/.../+page.svelte`)
  const nextAppMatch = /(?:^|\/)app\/(.*?)\/?page\.(?:tsx|jsx|ts|js)$/i.exec(rel);
  if (nextAppMatch) {
    const rawSeg = (nextAppMatch[1] ?? "")
      .split("/")
      .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"))
      .join("/");
    const routePath = `/${rawSeg}`;
    entries.push({ path: routePath, rel, line: 1, authRequired: false, componentRels: [rel] });
  }
  const svelteMatch = /(?:^|\/)src\/routes\/(.*?)\/?\+page\.svelte$/i.exec(rel);
  if (svelteMatch) {
    const rawSeg = (svelteMatch[1] ?? "")
      .split("/")
      .filter((s) => s && !/^\(.*\)$/.test(s))
      .join("/");
    entries.push({ path: `/${rawSeg}`, rel, line: 1, authRequired: false, componentRels: [rel] });
  }

  const fileRoute = routeForSourceFile(rel, canonicalRoutes);
  if (fileRoute && !entries.some((e) => normalizeRouteKey(e.path) === normalizeRouteKey(fileRoute.path))) {
    entries.push({
      path: fileRoute.path,
      rel,
      line: 1,
      authRequired: fileRoute.authRequired,
      componentRels: [rel],
      fileScoped: true,
    });
  }

  return entries;
}

function nearbySiblingLabel(content: string, openStart: number, closeEnd: number): string {
  const before = content.slice(Math.max(0, openStart - 240), openStart);
  const after = content.slice(closeEnd, Math.min(content.length, closeEnd + 240));
  const parts: string[] = [];
  const textTagRe = /<(?:span|label|Label|p)\b[^>]*>([\s\S]{1,80}?)<\/(?:span|label|Label|p)>/g;
  let m: RegExpExecArray | null;
  const beforeMatches: string[] = [];
  while ((m = textTagRe.exec(before))) {
    const t = cleanLabel(m[1] ?? "");
    if (t) beforeMatches.push(t);
  }
  if (beforeMatches.length > 0) parts.push(beforeMatches[beforeMatches.length - 1]!);
  textTagRe.lastIndex = 0;
  const afterMatch = textTagRe.exec(after);
  if (afterMatch?.[1]) {
    const t = cleanLabel(afterMatch[1]);
    if (t && !parts.includes(t)) parts.push(t);
  }
  return parts.join(" / ").slice(0, 80);
}

function scanUiControlsInFile(
  content: string,
  rel: string,
  tags: ScannedTag[],
  fileRoutes: string[],
  sharedLayout: boolean,
): SourceFeature[] {
  if (NON_APP_UI_PATH_RE.test(rel) || BACKEND_DIR_RE.test(rel)) return [];
  const features: SourceFeature[] = [];
  const concreteRoutes = fileRoutes.filter((r) => !/[:*${]/.test(r));
  const primaryRoute = sharedLayout ? "" : (concreteRoutes[0] ?? fileRoutes[0] ?? "");

  // Collect `<label htmlFor="x">...</label>` / `<Label htmlFor="x">...</Label>` bindings
  const labelByFor = new Map<string, string>();
  for (const tag of tags) {
    if (tag.name === "label" || tag.name === "Label") {
      const htmlFor = attr(tag.attrs, "htmlFor") || attr(tag.attrs, "for");
      const text = cleanLabel(tag.innerRaw);
      if (htmlFor && text) labelByFor.set(htmlFor, text);
    }
  }

  const pushFeature = (
    kind: FeatureKind,
    rawLabel: string,
    selector: string,
    routeOverride: string,
    index: number,
    extra: {
      optionHint?: string;
      inputType?: string;
      placeholder?: string;
      required?: boolean;
    } = {},
  ): void => {
    const label = cleanLabel(rawLabel);
    if (!label && !selector) return;
    const effectiveRoute = routeOverride || primaryRoute;
    const line = lineAt(content, index);
    features.push({
      id: stableId(kind, label, effectiveRoute, rel, line),
      kind,
      label,
      selector_hint: selector,
      route_hint: effectiveRoute,
      ...(concreteRoutes.length > 0 && !sharedLayout ? { routes: concreteRoutes } : {}),
      ...(extra.optionHint ? { option_hint: extra.optionHint } : {}),
      ...(extra.inputType ? { input_type: extra.inputType } : {}),
      ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
      ...(extra.required ? { required: true } : {}),
      ...(sharedLayout ? { shared_layout: true } : {}),
      source: { path: rel, line },
    });
  };

  for (const tag of tags) {
    const lower = tag.name.toLowerCase();
    const testId = attr(tag.attrs, "data-testid") || attr(tag.attrs, "data-test");
    const id = attr(tag.attrs, "id");
    const name = attr(tag.attrs, "name");
    const role = attr(tag.attrs, "role").toLowerCase();
    const ariaLabel = attr(tag.attrs, "aria-label");
    const safeIdSel = id && !id.includes("${") ? `#${id}` : "";
    const testIdSel = testId ? `[data-testid="${testId}"]` : "";

    // 1. Toggles: <Switch>, <Checkbox>, role="switch|checkbox", <input type="checkbox|radio">
    if (
      tag.name === "Switch" ||
      tag.name === "Checkbox" ||
      role === "switch" ||
      role === "checkbox" ||
      (lower === "input" && /^(?:checkbox|radio)$/i.test(attr(tag.attrs, "type")))
    ) {
      const label =
        (id ? labelByFor.get(id) : undefined) ||
        ariaLabel ||
        cleanLabel(tag.innerRaw) ||
        testId ||
        name ||
        id ||
        nearbySiblingLabel(content, tag.openStart, tag.closeEnd) ||
        (tag.name === "Switch" ? "Switch toggle" : "Checkbox toggle");
      const selector =
        testIdSel ||
        safeIdSel ||
        (name ? `[name="${name}"]` : "") ||
        (tag.name === "Switch" || role === "switch" ? 'button[role="switch"], [role="switch"]' : '[role="checkbox"], input[type="checkbox"]');
      pushFeature("toggle", label, selector, "", tag.openStart);
      continue;
    }

    // 2. Sliders: <Slider>, role="slider", <input type="range">
    if (tag.name === "Slider" || role === "slider" || (lower === "input" && attr(tag.attrs, "type").toLowerCase() === "range")) {
      const label =
        (id ? labelByFor.get(id) : undefined) ||
        ariaLabel ||
        testId ||
        name ||
        nearbySiblingLabel(content, tag.openStart, tag.closeEnd) ||
        "Range slider";
      const selector = testIdSel || safeIdSel || '[role="slider"], input[type="range"]';
      pushFeature("slider", label, selector, "", tag.openStart);
      continue;
    }

    // 3. Tabs: <TabsTrigger>, role="tab"
    if (tag.name === "TabsTrigger" || role === "tab") {
      const valAttr = attr(tag.attrs, "value");
      const label = cleanLabel(tag.innerRaw) || ariaLabel || valAttr || testId || "Tab";
      const selector = testIdSel || safeIdSel || '[role="tab"]';
      pushFeature("tab", label, selector, "", tag.openStart);
      continue;
    }

    // 4. Accordions / Disclosures: <AccordionTrigger>, <CollapsibleTrigger>, <summary>
    if (tag.name === "AccordionTrigger" || tag.name === "CollapsibleTrigger" || lower === "summary") {
      const label = cleanLabel(tag.innerRaw) || ariaLabel || testId || "Accordion section";
      const selector =
        testIdSel ||
        safeIdSel ||
        (lower === "summary" ? "details > summary" : "button[aria-expanded], [data-radix-collection-item][aria-expanded]");
      pushFeature("accordion", label, selector, "", tag.openStart);
      continue;
    }

    // 5. Buttons and interactive triggers: <button>, <Button>, <DialogTrigger>, <SheetTrigger>, <DropdownMenuTrigger>, role="button"
    if (
      lower === "button" ||
      tag.name === "DialogTrigger" ||
      tag.name === "SheetTrigger" ||
      tag.name === "DropdownMenuTrigger" ||
      role === "button"
    ) {
      if (hasBoolAttr(tag.attrs, "asChild") && tag.innerRaw.includes("<")) {
        // Inner button/link will be captured directly with its own attributes/text.
        continue;
      }
      const label = cleanLabel(tag.innerRaw) || ariaLabel || testId || attr(tag.attrs, "title");
      const selector = testIdSel || safeIdSel;
      pushFeature("button", label, selector, "", tag.openStart);
      continue;
    }

    // 6. Inputs & Textareas: <input>, <Input>, <textarea>, <Textarea>
    if (lower === "input" || lower === "textarea") {
      const rawType = lower === "textarea" ? "textarea" : (attr(tag.attrs, "type") || "text").toLowerCase();
      if (["hidden", "file", "submit", "button", "image", "checkbox", "radio", "range"].includes(rawType)) continue;
      const placeholder = attr(tag.attrs, "placeholder");
      const required = hasBoolAttr(tag.attrs, "required");
      const label = (id ? labelByFor.get(id) : undefined) || ariaLabel || placeholder || name || id || rawType;
      const selector =
        testIdSel ||
        safeIdSel ||
        (name ? `[name="${name}"]` : "") ||
        (placeholder ? `${lower === "textarea" ? "textarea" : "input"}[placeholder="${placeholder.replace(/"/g, '\\"')}"]` : "");
      pushFeature("input", label, selector, "", tag.openStart, {
        inputType: rawType,
        ...(placeholder ? { placeholder } : {}),
        ...(required ? { required: true } : {}),
      });
      continue;
    }

    // 7. Selects / Comboboxes: <select>, <SelectTrigger>
    if (lower === "select" || tag.name === "SelectTrigger" || role === "combobox") {
      const label = (id ? labelByFor.get(id) : undefined) || ariaLabel || name || id || "select";
      const selector =
        testIdSel ||
        safeIdSel ||
        (name ? `[name="${name}"]` : "") ||
        (tag.name === "SelectTrigger" || role === "combobox" ? 'button[role="combobox"], [role="combobox"]' : "");
      const lookahead = content.slice(tag.openEnd, Math.min(content.length, tag.openEnd + 1200));
      const optionMatches = Array.from(
        lookahead.matchAll(/<(?:option|SelectItem)\b([^>]*)>\s*([^<{]{1,60})/gi),
      )
        .map((m) => ({ attrs: m[1] ?? "", text: cleanLabel(m[2] ?? "") }))
        .filter((o) => o.text.length > 0);
      const nonPlaceholder = optionMatches.find(
        (o, idx) =>
          !hasBoolAttr(o.attrs, "disabled") &&
          attr(o.attrs, "value") !== "" &&
          !(idx === 0 && /^(?:select|choose|pick|--)\b/i.test(o.text)),
      );
      const chosenOption = nonPlaceholder?.text ?? optionMatches[1]?.text ?? optionMatches[0]?.text ?? "";
      pushFeature("select", label, selector, "", tag.openStart, {
        optionHint: chosenOption,
      });
      continue;
    }

    // 8. Forms: <form>
    if (lower === "form") {
      const label = ariaLabel || id || name || "form";
      const selector = testIdSel || safeIdSel;
      pushFeature("form", label, selector, "", tag.openStart);
      continue;
    }

    // 9. Links: <a>, <Link>
    if (lower === "a" || tag.name === "Link") {
      const href = attr(tag.attrs, "href") || attr(tag.attrs, "to");
      const label = cleanLabel(tag.innerRaw) || ariaLabel || href;
      const selector = testIdSel || safeIdSel;
      pushFeature("link", label, selector, href, tag.openStart);
    }
  }

  return features;
}

/** Scan a repository tree for testable UI features with route-to-component mapping. */
export function discoverFeatures(root: string, options: DiscoverFeaturesOptions = {}): FeatureInventory {
  const absRoot = path.resolve(root);
  const files = collectFiles(absRoot, options);
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const fileContents = new Map<string, string>();
  const fileTags = new Map<string, ScannedTag[]>();
  const srcRootsSet = new Set<string>(["", "src"]);

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
    fileContents.set(rel, content);
    const srcIdx = rel.indexOf("/src/");
    if (srcIdx > 0) srcRootsSet.add(`${rel.slice(0, srcIdx)}/src`);
    else if (rel.startsWith("src/")) srcRootsSet.add("src");
  }

  const fileSet = new Set(fileContents.keys());
  const srcRoots = Array.from(srcRootsSet);
  const canonicalRoutes = collectCanonicalRoutes(fileContents);
  const fileImports = new Map<string, Map<string, string>>();
  const childFilesByParent = new Map<string, Set<string>>();

  for (const [rel, content] of fileContents) {
    if (NON_APP_UI_PATH_RE.test(rel) || BACKEND_DIR_RE.test(rel)) continue;
    const tags = scanTags(content);
    fileTags.set(rel, tags);
    const imports = parseLocalImports(content, rel, fileSet, srcRoots);
    fileImports.set(rel, imports);

    const children = new Set<string>();
    for (const tag of tags) {
      if (/^[A-Z]/.test(tag.name) && !ROUTER_WRAPPER_NAMES.has(tag.name)) {
        const resolved = imports.get(tag.name);
        if (resolved && resolved !== rel) children.add(resolved);
      }
    }
    childFilesByParent.set(rel, children);
  }

  // Extract frontend routes and seed file -> routes mapping. Canonical catalog
  // routes are emitted first so full-site crawls prioritize public examples.
  const routeFeatures: SourceFeature[] = [];
  for (const route of canonicalRoutes.values()) {
    routeFeatures.push({
      id: stableId("route", route.path, route.path, route.sourceRel, 1),
      kind: "route",
      label: route.path,
      selector_hint: "",
      route_hint: route.path,
      ...(route.authRequired ? { auth_required: true } : {}),
      source: { path: route.sourceRel, line: 1 },
    });
  }
  const routesByFile = new Map<string, Set<string>>();
  const addRouteForFile = (targetRel: string, routePath: string): void => {
    let set = routesByFile.get(targetRel);
    if (!set) {
      set = new Set<string>();
      routesByFile.set(targetRel, set);
    }
    set.add(routePath);
  };

  for (const [rel, content] of fileContents) {
    const tags = fileTags.get(rel);
    const imports = fileImports.get(rel);
    if (!tags || !imports) continue;
    const discovered = extractRoutesFromFile(content, rel, tags, imports, canonicalRoutes);
    for (const r of discovered) {
      routeFeatures.push({
        id: stableId("route", r.path, r.path, r.rel, r.line),
        kind: "route",
        label: r.path,
        selector_hint: "",
        route_hint: r.path,
        ...(r.authRequired ? { auth_required: true } : {}),
        source: { path: r.rel, line: r.line },
      });
      if (r.fileScoped) addRouteForFile(r.rel, r.path);
      for (const compRel of r.componentRels) {
        addRouteForFile(compRel, r.path);
      }
    }
  }

  // Propagate routes up to 3 component-import hops (e.g., Route -> Home -> EarlyAccessForm).
  for (let hop = 0; hop < 3; hop++) {
    const updates: Array<[string, string]> = [];
    for (const [parentRel, routes] of routesByFile) {
      if (routes.size >= 4) continue; // Don't propagate shared layout shell routes into everything.
      const children = childFilesByParent.get(parentRel);
      if (!children) continue;
      for (const childRel of children) {
        for (const r of routes) {
          if (!routesByFile.get(childRel)?.has(r)) updates.push([childRel, r]);
        }
      }
    }
    if (updates.length === 0) break;
    for (const [childRel, r] of updates) addRouteForFile(childRel, r);
  }

  const all: SourceFeature[] = [...routeFeatures];
  for (const [rel, content] of fileContents) {
    const tags = fileTags.get(rel);
    if (!tags) continue;
    const routeSet = routesByFile.get(rel);
    const fileRoutes = routeSet ? Array.from(routeSet).sort((a, b) => a.localeCompare(b)) : [];
    const sharedLayout = fileRoutes.length >= 4 || /(?:^|\/)(?:Header|Footer|Navbar|NavBar|Layout|AppShell)\.[a-z]+$/i.test(rel);
    all.push(...scanUiControlsInFile(content, rel, tags, fileRoutes, sharedLayout));
  }

  const seen = new Set<string>();
  const features = all
    .filter((f) => {
      const key = `${f.kind}|${f.label.toLowerCase()}|${f.route_hint}|${f.selector_hint.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.route_hint.localeCompare(b.route_hint) ||
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
