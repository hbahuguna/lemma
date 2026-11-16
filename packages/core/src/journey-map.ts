import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sanitizeUrl } from "./redaction.js";

export const JOURNEY_MAP_SCHEMA_VERSION = "lemma.journey_map/v1" as const;

export interface JourneyMapNode {
  id: string;
  route: string;
  label: string;
  checks: string[];
  evidence: string[];
  screenshot_ref: string | null;
  evidence_unavailable: boolean;
}

export interface JourneyMapEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  source: string;
  evidence: string[];
  screenshot_ref: string | null;
  evidence_unavailable: boolean;
}

export interface JourneyMapCheck {
  id: string;
  title: string;
  status: string;
  route: string;
  node_id: string | null;
  evidence: string[];
}

export interface JourneyMapTextRow {
  route: string;
  checks: Array<{ id: string; status: string; title: string }>;
}

export interface JourneyMap {
  schema_version: typeof JOURNEY_MAP_SCHEMA_VERSION;
  run_id: string | null;
  nodes: JourneyMapNode[];
  edges: JourneyMapEdge[];
  checks: JourneyMapCheck[];
  summary: Record<string, unknown>;
  text_table: JourneyMapTextRow[];
}

export interface BuildJourneyMapOptions {
  scenarioPlan?: unknown;
  browserEvidence?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function normalizeRoute(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "(unknown)";
  try {
    return sanitizeUrl(s);
  } catch {
    return s;
  }
}

function routeNodeId(route: string): string {
  const norm = normalizeRoute(route).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `route:${norm || "unknown"}`;
}

function pickScreenshotRef(refs: string[]): string | null {
  for (const r of refs) {
    if (/screenshot|\.png$|\.jpg$|\.jpeg$|\.webp$/i.test(r)) return r;
  }
  return null;
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))].sort((a, b) => a.localeCompare(b));
}

export function buildJourneyMap(report: unknown, options: BuildJourneyMapOptions = {}): JourneyMap {
  const r = isRecord(report) ? report : {};
  const runId = typeof r.run_id === "string" ? r.run_id : null;
  const checks = Array.isArray(r.checks) ? r.checks.filter(isRecord) : [];
  const target = isRecord(r.target) ? r.target : {};
  const defaultRoute = normalizeRoute(asString(target.resolved) || asString(target.raw) || "(target)");

  const nodeById = new Map<string, JourneyMapNode>();
  const checksOut: JourneyMapCheck[] = [];

  const ensureNode = (routeRaw: string): JourneyMapNode => {
    const route = normalizeRoute(routeRaw || defaultRoute);
    const id = routeNodeId(route);
    let node = nodeById.get(id);
    if (!node) {
      node = {
        id,
        route,
        label: route,
        checks: [],
        evidence: [],
        screenshot_ref: null,
        evidence_unavailable: false,
      };
      nodeById.set(id, node);
    }
    return node;
  };

  // derive nodes/check associations from report checks (browser metadata.routes, route/page, evidence refs)
  const sortedChecks = [...checks].sort((a, b) => asString(a.id).localeCompare(asString(b.id)));
  for (const check of sortedChecks) {
    const cid = asString(check.id);
    if (!cid) continue;
    const title = asString(check.title);
    const status = asString(check.status);
    const evidenceRefs = Array.isArray(check.evidence) ? check.evidence.filter((x): x is string => typeof x === "string") : [];
    const meta = isRecord(check.metadata) ? check.metadata : {};

    const routeEntries: Array<{ route: string; status?: string }> = [];
    const routesMeta = Array.isArray(meta.routes) ? meta.routes : [];
    for (const entry of routesMeta) {
      if (!isRecord(entry)) continue;
      const route = asString(entry.route) || asString(entry.page) || asString(entry.url);
      if (route) routeEntries.push({ route, status: asString(entry.status) });
    }
    if (routeEntries.length === 0) {
      const route = asString(meta.route) || asString(meta.page) || asString(meta.url) || "";
      if (route) routeEntries.push({ route, status });
    }
    if (routeEntries.length === 0 && (isRecord(r.target) || cid.startsWith("browser."))) {
      routeEntries.push({ route: defaultRoute, status });
    }

    const uniqueNodeIds = new Set<string>();
    for (const re of routeEntries) {
      const node = ensureNode(re.route);
      uniqueNodeIds.add(node.id);
      if (!node.checks.includes(cid)) node.checks.push(cid);
      for (const ev of evidenceRefs) if (!node.evidence.includes(ev)) node.evidence.push(ev);
      const shot = pickScreenshotRef(evidenceRefs);
      if (shot && !node.screenshot_ref) node.screenshot_ref = shot;
    }
    for (const nodeId of uniqueNodeIds) {
      const route = nodeById.get(nodeId)?.route ?? defaultRoute;
      checksOut.push({ id: cid, title, status, route, node_id: nodeId, evidence: [...evidenceRefs] });
    }
    if (uniqueNodeIds.size === 0) {
      checksOut.push({ id: cid, title, status, route: "(unmapped)", node_id: null, evidence: [...evidenceRefs] });
    }
  }

  // scenario-derived transitions (artifact: scenario plan/steps) - deterministic, no invented transitions
  const edges: JourneyMapEdge[] = [];
  const addEdge = (fromRoute: string, toRoute: string, label: string, source: string, evidence: string[] = []) => {
    const fromNode = ensureNode(fromRoute);
    const toNode = ensureNode(toRoute);
    if (fromNode.id === toNode.id) return;
    const id = `edge:${edges.length + 1}:${fromNode.id}->${toNode.id}`;
    const shot = pickScreenshotRef(evidence);
    edges.push({
      id,
      from: fromNode.id,
      to: toNode.id,
      label,
      source,
      evidence: uniqSorted(evidence),
      screenshot_ref: shot,
      evidence_unavailable: evidence.length > 0 && !shot && false ? true : false,
    });
  };

  const scenario = options.scenarioPlan;
  const steps = Array.isArray(scenario)
    ? scenario
    : isRecord(scenario) && Array.isArray(scenario.steps)
      ? scenario.steps
      : [];
  let prevGoto: string | null = null;
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const action = asString(step.action).toLowerCase();
    const targetUrl = asString(step.target) || asString(step.url) || asString(step.route);
    if ((action === "goto" || action === "navigate" || action === "open") && targetUrl) {
      const norm = normalizeRoute(targetUrl);
      ensureNode(norm);
      if (prevGoto && prevGoto !== norm) {
        addEdge(prevGoto, norm, asString(step.name) || "navigate", "scenario_plan");
      }
      prevGoto = norm;
    }
  }

  // optional browser evidence hints (artifact-derived)
  const browserEvidence = isRecord(options.browserEvidence) ? options.browserEvidence : null;
  if (browserEvidence && Array.isArray(browserEvidence.transitions)) {
    for (const t of browserEvidence.transitions) {
      if (!isRecord(t)) continue;
      const from = asString(t.from);
      const to = asString(t.to);
      if (from && to) addEdge(from, to, asString(t.label) || "transition", "browser_evidence");
    }
  }

  // finalize nodes deterministically
  const nodes = [...nodeById.values()]
    .map((n) => {
      const checksSorted = uniqSorted(n.checks);
      const evidenceSorted = uniqSorted(n.evidence);
      const screenshot_ref = n.screenshot_ref ?? pickScreenshotRef(evidenceSorted);
      return {
        ...n,
        checks: checksSorted,
        evidence: evidenceSorted,
        screenshot_ref,
        evidence_unavailable: screenshot_ref ? false : false,
      };
    })
    .sort((a, b) => (a.route.localeCompare(b.route) || a.id.localeCompare(b.id)));

  const edgeOut = edges.map((e) => ({ ...e }));

  const text_table: JourneyMapTextRow[] = nodes.map((n) => {
    const rows = checksOut
      .filter((c) => c.node_id === n.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({ id: c.id, status: c.status, title: c.title }));
    return { route: n.route, checks: rows };
  });

  return {
    schema_version: JOURNEY_MAP_SCHEMA_VERSION,
    run_id: runId,
    nodes,
    edges: edgeOut,
    checks: checksOut.sort((a, b) => (a.route.localeCompare(b.route) || a.id.localeCompare(b.id) || (a.node_id || "").localeCompare(b.node_id || ""))),
    summary: {
      node_count: nodes.length,
      edge_count: edgeOut.length,
      check_count: checksOut.length,
      routes: nodes.map((n) => n.route),
    },
    text_table,
  };
}

export function journeyMapSchemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../schemas/journey_map/journey_map.v1.schema.json"),
    path.resolve(here, "../../schemas/journey_map/journey_map.v1.schema.json"),
    path.resolve(process.cwd(), "schemas/journey_map/journey_map.v1.schema.json"),
  ];
  for (const c of candidates) {
    try { readFileSync(c, "utf8"); return c; } catch { /* continue */ }
  }
  return candidates[0]!;
}
