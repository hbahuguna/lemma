import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import {
  StateError,
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  lintPersonas,
  parsePersonaDocument,
  readJsonFile,
  type PersonaLintReport,
} from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const PRO_PERSONAS_DIR = path.join(".lemma", "pro", "personas");
export const PRO_PERSONAS_MANIFEST = path.join(PRO_PERSONAS_DIR, "manifest.json");
export const DEFAULT_PANEL_MAX_SIZE = 12;
export const DOCUMENTED_PANEL_MAX_SIZE = 12;

export interface ProPersonaManifestEntry {
  id: string;
  file: string;
  opt_in: boolean;
  opt_in_runs: string[];
  source: "custom" | "generated";
  created_at: string;
  updated_at: string;
  checks: string[];
  domains: string[];
}

export interface ProPersonaManifest {
  schema_version: "lemma.pro.personas/v1";
  personas: Record<string, ProPersonaManifestEntry>;
  updated_at: string;
}

export interface AddPersonaParams {
  contract: string | { id: string; name?: string; domains?: string[]; checks: string[]; tools?: string[]; markdown?: string };
  root?: string;
  license?: ProLicenseContext | null;
  optIn?: boolean;
  optInRuns?: string[];
  force?: boolean;
  /** Known check ids for lint validation context (plugin/built-in checks). */
  knownCheckIds?: string[];
}

export interface GeneratePanelParams {
  size: number;
  diversity?: number | string | string[];
  root?: string;
  license?: ProLicenseContext | null;
  maxSize?: number;
  prefix?: string;
  seed?: number | string;
  optIn?: boolean;
  optInRuns?: string[];
  knownCheckIds?: string[];
}

function assertLicensed(license: ProLicenseContext | null | undefined, capability: string): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError(capability);
}

function nowIso() { return new Date().toISOString(); }

async function pathExists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

export function proPersonasDir(root: string): string {
  return path.join(path.resolve(root), PRO_PERSONAS_DIR);
}

export function proPersonasManifestPath(root: string): string {
  return path.join(path.resolve(root), PRO_PERSONAS_MANIFEST);
}

async function loadManifest(root: string): Promise<ProPersonaManifest> {
  const p = proPersonasManifestPath(root);
  if (!(await pathExists(p))) {
    return { schema_version: "lemma.pro.personas/v1", personas: {}, updated_at: nowIso() };
  }
  try {
    const data = await readJsonFile<any>(p);
    if (data && typeof data === "object" && data.schema_version === "lemma.pro.personas/v1" && data.personas && typeof data.personas === "object") {
      return data as ProPersonaManifest;
    }
  } catch { /* fall through */ }
  throw new StateError("Corrupt Pro personas manifest", { code: "state_corrupt", details: { path: p } });
}

async function saveManifest(root: string, manifest: ProPersonaManifest): Promise<void> {
  await ensureDir(path.dirname(proPersonasManifestPath(root)));
  manifest.updated_at = nowIso();
  await atomicWriteJson(proPersonasManifestPath(root), manifest);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "persona";
}

function buildPersonaMarkdown(spec: { id: string; name: string; domains: string[]; checks: string[]; tools?: string[]; role?: string }): string {
  const tools = spec.tools && spec.tools.length ? spec.tools : ["source_inventory"];
  const schemaTitleBase = spec.name.replace(/[^A-Za-z0-9]+/g, "") || "Custom";
  const outputSchema = {
    type: "object",
    title: `${schemaTitleBase}Finding`,
    required: ["title", "severity", "domain", "strength", "consequence", "location", "reproduction", "remediation", "verification"],
    properties: {
      title: { type: "string" },
      severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
      domain: { type: "string", enum: spec.domains },
      strength: { type: "string", enum: ["observed", "source_proven", "suspected"] },
      consequence: { type: "string" },
      location: { type: "string" },
      reproduction: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      remediation: { type: "string" },
      verification: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  const blockerSchema = {
    type: "object",
    title: `${schemaTitleBase}Blocker`,
    required: ["persona", "check_id", "attempted_action", "boundary", "unblock_evidence", "covered_elsewhere"],
    properties: {
      persona: { type: "string" },
      check_id: { type: "string" },
      attempted_action: { type: "string" },
      boundary: { type: "string" },
      unblock_evidence: { type: "array", items: { type: "string" } },
      covered_elsewhere: { type: "boolean" },
      covered_by: { type: "array", items: { type: "string" } },
    },
  };
  const frontmatter = [
    "---",
    `id: ${spec.id}`,
    `name: ${spec.name}`,
    "version: 1.0",
    "domains:",
    ...spec.domains.map((d) => `  - ${d}`),
    "tools:",
    ...tools.map((t) => `  - ${t}`),
    "checks:",
    ...spec.checks.map((c) => `  - ${c}`),
    "---",
  ];
  return `${frontmatter.join("\n")}

## Role

${spec.role || `Represents the ${spec.name} perspective for release-risk checks in ${spec.domains.join(", ")}.`}

## Available tools

| Tool | Use | Boundary |
| --- | --- | --- |
${tools.map((t) => `| \`${t}\` | Gather evidence within declared scope. | Read-only unless explicitly authorized. |`).join("\n")}

## Output schema

\`\`\`json
${JSON.stringify(outputSchema, null, 2)}
\`\`\`

## Blocker schema

\`\`\`json
${JSON.stringify(blockerSchema, null, 2)}
\`\`\`

## Refusal handling

Refuse with a structured blocker when required evidence is unavailable or outside scope. Never convert a refusal into a pass.
`;
}

async function lintProPersonas(root: string, knownCheckIds?: string[]): Promise<PersonaLintReport> {
  const dir = proPersonasDir(root);
  const known = new Set<string>(knownCheckIds ?? []);
  // include checks owned by pro personas themselves as known for cross-validation context
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md") && !f.toLowerCase().startsWith("readme"));
    for (const f of files) {
      try {
        const doc = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = parsePersonaDocument(doc);
        const checks = Array.isArray(parsed.metadata.checks) ? parsed.metadata.checks.map(String) : [];
        for (const c of checks) known.add(c);
      } catch { /* lint will report */ }
    }
  } catch { /* dir may not exist yet */ }
  return lintPersonas(dir, known);
}

function assertOwnershipAndDisjoint(report: PersonaLintReport): void {
  if (report.status !== "valid") {
    const msg = report.errors.map((e) => e.message).join("; ") || "Persona lint failed";
    throw new StateError(msg, { code: "persona_error", details: { errors: report.errors, warnings: report.warnings } });
  }
  // each persona must own at least one check
  for (const p of report.personas) {
    if (!p.checks || p.checks.length === 0) {
      throw new StateError(`Custom persona '${p.id}' must own at least one check`, { code: "persona_error" });
    }
  }
  // disjoint ownership enforced by lint duplicate_ownership errors (already checked above), but be explicit
  const owners: Record<string, string[]> = {};
  for (const p of report.personas) for (const c of p.checks) (owners[c] ||= []).push(p.id);
  for (const [c, ids] of Object.entries(owners)) {
    if (ids.length > 1) throw new StateError(`Check ownership must be disjoint: '${c}' claimed by ${ids.join(", ")}`, { code: "persona_error" });
  }
}

export async function addPersona(params: AddPersonaParams): Promise<{ persona: ProPersonaManifestEntry; lint: PersonaLintReport; path: string }> {
  assertLicensed(params.license, "custom persona panel (addPersona)");
  const root = path.resolve(params.root ?? process.cwd());
  const dir = proPersonasDir(root);
  await ensureDir(dir);

  let id: string;
  let markdown: string;
  let checks: string[] = [];
  let domains: string[] = [];

  if (typeof params.contract === "string") {
    markdown = params.contract;
    const parsed = parsePersonaDocument(markdown);
    id = String(parsed.metadata.id || "").trim();
    checks = Array.isArray(parsed.metadata.checks) ? parsed.metadata.checks.map(String) : [];
    domains = Array.isArray(parsed.metadata.domains) ? parsed.metadata.domains.map(String) : [];
  } else {
    const c = params.contract;
    id = String(c.id || "").trim();
    checks = Array.isArray(c.checks) ? c.checks.map(String) : [];
    domains = Array.isArray(c.domains) && c.domains.length ? c.domains.map(String) : [id || "custom"];
    const name = String(c.name || id || "Custom Persona");
    if (c.markdown) {
      markdown = c.markdown;
    } else {
      if (!id) throw new StateError("Persona contract requires id");
      markdown = buildPersonaMarkdown({ id, name, domains, checks, ...(c.tools ? { tools: c.tools } : {}) });
    }
  }
  if (!id) throw new StateError("Persona contract requires id");
  if (!checks.length) throw new StateError(`Custom persona '${id}' must own at least one check`, { code: "persona_error" });

  const filePath = path.join(dir, `${id}.md`);
  if ((await pathExists(filePath)) && !params.force) {
    throw new StateError(`Persona '${id}' already exists; pass force to overwrite`, { details: { path: filePath } });
  }
  await atomicWriteFile(filePath, markdown, { mode: 0o644 });

  const lint = await lintProPersonas(root, params.knownCheckIds);
  try {
    assertOwnershipAndDisjoint(lint);
  } catch (e) {
    // keep file for inspection? AC says "corrupted state preserved..." not directly this case, but better not delete; throw
    throw e;
  }

  const manifest = await loadManifest(root);
  const entry: ProPersonaManifestEntry = {
    id,
    file: filePath,
    opt_in: params.optIn === true,
    opt_in_runs: Array.isArray(params.optInRuns) ? params.optInRuns.map(String) : [],
    source: "custom",
    created_at: manifest.personas[id]?.created_at ?? nowIso(),
    updated_at: nowIso(),
    checks,
    domains,
  };
  manifest.personas[id] = entry;
  await saveManifest(root, manifest);

  return { persona: entry, lint, path: filePath };
}

const DIVERSITY_PROFILES = [
  { key: "accessibility", name: "Accessibility Advocate", domain: "accessibility", tool: "source_inventory" },
  { key: "performance", name: "Performance Skeptic", domain: "performance", tool: "source_inventory" },
  { key: "security", name: "Security Reviewer", domain: "security", tool: "source_inventory" },
  { key: "privacy", name: "Privacy Guardian", domain: "privacy", tool: "source_inventory" },
  { key: "new-user", name: "First-time User", domain: "usability", tool: "source_inventory" },
  { key: "power-user", name: "Power User", domain: "functionality", tool: "source_inventory" },
  { key: "mobile", name: "Mobile User", domain: "responsive", tool: "source_inventory" },
  { key: "api", name: "API Consumer", domain: "api", tool: "source_inventory" },
];

function hashSeed(seed: number | string | undefined, i: number): string {
  return createHash("sha256").update(`${String(seed ?? "panel")}:${i}`).digest("hex").slice(0, 8);
}

export async function generatePanel(params: GeneratePanelParams): Promise<{ personas: ProPersonaManifestEntry[]; lint: PersonaLintReport; maxSize: number; bounded: boolean; dir: string }> {
  assertLicensed(params.license, "custom persona panel (generatePanel)");
  const root = path.resolve(params.root ?? process.cwd());
  const dir = proPersonasDir(root);
  await ensureDir(dir);

  const maxSize = Math.max(1, Math.floor(Number(params.maxSize ?? DOCUMENTED_PANEL_MAX_SIZE) || DOCUMENTED_PANEL_MAX_SIZE));
  const requested = Math.max(0, Math.floor(Number(params.size) || 0));
  const size = Math.min(requested, maxSize);
  const bounded = requested > maxSize;
  const prefix = slug(params.prefix || "panel");

  const diversityCount = typeof params.diversity === "number" ? Math.max(1, Math.floor(params.diversity)) : (Array.isArray(params.diversity) ? params.diversity.length : DIVERSITY_PROFILES.length);
  const profiles = DIVERSITY_PROFILES;

  const manifest = await loadManifest(root);
  const created: ProPersonaManifestEntry[] = [];

  for (let i = 0; i < size; i++) {
    const profile = profiles[i % Math.min(profiles.length, Math.max(1, diversityCount))]!;
    const suf = hashSeed(params.seed, i);
    const id = `${prefix}-${profile.key}-${suf}`;
    const checkId = `pro.panel.${prefix}.${profile.key}.${suf}`;
    // ensure disjoint check ownership in pro set by unique check ids
    const name = `${profile.name} (${i + 1})`;
    const markdown = buildPersonaMarkdown({ id, name, domains: [profile.domain, "custom-panel"], checks: [checkId], tools: [profile.tool], role: `Represents ${profile.name.toLowerCase()} behavior and release-risk expectations. Reacts like a real ${profile.name.toLowerCase()} evaluating ${profile.domain}.` });
    const filePath = path.join(dir, `${id}.md`);
    await atomicWriteFile(filePath, markdown, { mode: 0o644 });
    const entry: ProPersonaManifestEntry = {
      id,
      file: filePath,
      opt_in: params.optIn === true,
      opt_in_runs: Array.isArray(params.optInRuns) ? params.optInRuns.map(String) : [],
      source: "generated",
      created_at: nowIso(),
      updated_at: nowIso(),
      checks: [checkId],
      domains: [profile.domain, "custom-panel"],
    };
    manifest.personas[id] = entry;
    created.push(entry);
  }

  await saveManifest(root, manifest);

  const lint = await lintProPersonas(root, params.knownCheckIds);
  assertOwnershipAndDisjoint(lint);

  return { personas: created, lint, maxSize, bounded, dir };
}

export async function setProPersonaOptIn(params: { root?: string; license?: ProLicenseContext | null; personaId: string; optIn: boolean; runId?: string }): Promise<ProPersonaManifestEntry> {
  assertLicensed(params.license, "custom persona panel (set opt-in)");
  const root = path.resolve(params.root ?? process.cwd());
  const manifest = await loadManifest(root);
  const entry = manifest.personas[params.personaId];
  if (!entry) throw new StateError(`Unknown pro persona '${params.personaId}'`);
  entry.opt_in = params.optIn === true;
  if (params.runId) {
    const runs = new Set(entry.opt_in_runs || []);
    if (params.optIn) runs.add(String(params.runId)); else runs.delete(String(params.runId));
    entry.opt_in_runs = Array.from(runs);
  }
  entry.updated_at = nowIso();
  manifest.personas[params.personaId] = entry;
  await saveManifest(root, manifest);
  return entry;
}

export async function listProPersonas(params?: { root?: string; license?: ProLicenseContext | null }): Promise<ProPersonaManifest> {
  assertLicensed(params?.license, "custom persona panel (list)");
  return loadManifest(path.resolve(params?.root ?? process.cwd()));
}

export function isProPersonaOptedIn(entry: ProPersonaManifestEntry, runId?: string): boolean {
  if (runId && Array.isArray(entry.opt_in_runs) && entry.opt_in_runs.includes(runId)) return true;
  return entry.opt_in === true;
}
