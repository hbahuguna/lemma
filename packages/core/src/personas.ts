/**
 * Persona contract parsing.
 *
 * Ports the YAML-subset frontmatter parser and section splitter from assay's
 * `harness/personas.py` without a runtime YAML dependency. Schema validation,
 * ownership derivation, and linting build on top of this module; parsing itself
 * is text-only and deterministic (no clock, entropy, filesystem, or network
 * access beyond the explicit `readPersonaDocument` file read).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { PersonaError } from "./errors.js";

export const PERSONA_FRONTMATTER_DELIMITER = "---" as const;

export const PERSONA_FRONTMATTER_KEYS = [
  "id",
  "name",
  "version",
  "domains",
  "tools",
  "checks",
] as const;

export type PersonaFrontmatterKey = (typeof PERSONA_FRONTMATTER_KEYS)[number];

export type PersonaScalarValue = string | number | boolean | PersonaScalarValue[];

export type PersonaFrontmatter = Record<string, PersonaScalarValue>;

export interface PersonaFrontmatterSplit {
  /** Inner frontmatter text between the opening and closing delimiters. */
  frontmatter: string;
  /** Raw body text following the closing delimiter line. */
  body: string;
  /** Parsed frontmatter key→value map. */
  metadata: PersonaFrontmatter;
}

export interface PersonaDocument extends PersonaFrontmatterSplit {
  /** Map of lowercased `## Heading` titles to trimmed section bodies. */
  sections: Record<string, string>;
}

interface FrontmatterBounds {
  lines: string[];
  endIndex: number;
  bodyStart: number;
}

/**
 * Parse a single frontmatter value using assay's `_parse_scalar` semantics.
 */
export function parseFrontmatterScalar(value: string): PersonaScalarValue {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseFrontmatterScalar(part));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") return lower === "true";
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return trimmed;
}

function frontmatterBounds(text: string): FrontmatterBounds {
  const lines = text.split("\n");
  if (lines.length === 0 || (lines[0] ?? "").trim() !== PERSONA_FRONTMATTER_DELIMITER) {
    throw new PersonaError("Persona must start with a YAML frontmatter block delimited by ---");
  }
  // Character offset of the start of the current line (line 0 begins at 0).
  let offset = (lines[0] ?? "").length + 1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === PERSONA_FRONTMATTER_DELIMITER) {
      return { lines, endIndex: index, bodyStart: offset + PERSONA_FRONTMATTER_DELIMITER.length };
    }
    offset += line.length + 1;
  }
  throw new PersonaError("Persona frontmatter is missing a closing ---");
}

/**
 * Parse the `---`-delimited YAML subset at the start of a persona document.
 */
export function parseFrontmatter(text: string): PersonaFrontmatter {
  const { lines, endIndex } = frontmatterBounds(text);
  const data: PersonaFrontmatter = {};
  let currentKey: string | null = null;

  for (let index = 1; index < endIndex; index += 1) {
    const raw = lines[index] ?? "";
    if (!raw.trim()) continue;
    const lstripped = raw.replace(/^\s+/, "");
    if (lstripped.startsWith("- ")) {
      if (currentKey === null) {
        throw new PersonaError(`Frontmatter list item without a key: ${raw.trim()}`);
      }
      const item = parseFrontmatterScalar(lstripped.slice(2));
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      (data[currentKey] as PersonaScalarValue[]).push(item);
      continue;
    }
    const colon = raw.indexOf(":");
    if (colon === -1) {
      throw new PersonaError(`Invalid frontmatter line: ${raw.trim()}`);
    }
    const key = raw.slice(0, colon).trim();
    currentKey = key;
    const parsed = parseFrontmatterScalar(raw.slice(colon + 1));
    data[key] = parsed === "" ? [] : parsed;
  }

  return data;
}

/**
 * Split the frontmatter from the document body.
 */
export function splitFrontmatter(text: string): PersonaFrontmatterSplit {
  const { lines, endIndex, bodyStart } = frontmatterBounds(text);
  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: text.slice(bodyStart),
    metadata: parseFrontmatter(text),
  };
}

/**
 * Split a document body into lowercased `## Heading` → section text pairs.
 */
export function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const pattern = /^##\s+(.+?)\s*$/gm;
  const matches = [...body.matchAll(pattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match === undefined) continue;
    const title = (match[1] ?? "").trim().toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1];
    const end = next?.index ?? body.length;
    sections[title] = body.slice(start, end).trim();
  }
  return sections;
}

/**
 * Parse a complete persona document into frontmatter, body, and sections.
 */
export function parsePersonaDocument(text: string): PersonaDocument {
  const split = splitFrontmatter(text);
  return { ...split, sections: splitSections(split.body) };
}

/**
 * Read and parse a UTF-8 persona document from disk.
 */
export async function readPersonaDocument(filePath: string): Promise<PersonaDocument> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PersonaError(`Could not read persona ${filePath}: ${reason}`);
  }
  return parsePersonaDocument(text);
}

// --------------------------------------------------------- schema validation

/** JSON value accepted by the persona output/blocker contracts. */
export type PersonaJsonValue =
  | null
  | boolean
  | number
  | string
  | PersonaJsonValue[]
  | { [key: string]: PersonaJsonValue };

/** The useful JSON-Schema subset allowed in a persona contract. */
export interface PersonaJsonSchema {
  type?: string;
  enum?: PersonaJsonValue[];
  required?: string[];
  properties?: Record<string, PersonaJsonSchema>;
  items?: PersonaJsonSchema;
  [key: string]: unknown;
}

/** Fields every persona output (finding) contract must require. */
export const CORE_FINDING_FIELDS = [
  "title",
  "severity",
  "domain",
  "strength",
  "consequence",
  "location",
  "reproduction",
  "remediation",
  "verification",
] as const;

/** Fields every persona blocker contract must require. */
export const CORE_BLOCKER_FIELDS = [
  "persona",
  "check_id",
  "attempted_action",
  "boundary",
  "unblock_evidence",
  "covered_elsewhere",
] as const;

/** Primitive/composite JSON-Schema types the harness understands. */
export const SUPPORTED_SCHEMA_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;

export type SupportedSchemaType = (typeof SUPPORTED_SCHEMA_TYPES)[number];

export type CoreFindingField = (typeof CORE_FINDING_FIELDS)[number];
export type CoreBlockerField = (typeof CORE_BLOCKER_FIELDS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (isPlainObject(value)) return "object";
  return typeof value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]),
    );
  }
  return false;
}

/**
 * Whether a value satisfies a declared schema type.
 *
 * Unknown declared types are permissive, matching assay `_type_matches`.
 */
export function matchesSchemaType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Extract and validate the JSON contract in a persona section.
 *
 * Requires a fenced ```json block containing an object schema with
 * `type: "object"`, a non-empty `required` array, and a non-empty `properties`
 * object, matching assay `_extract_json_schema`.
 */
export function extractJsonSchema(
  section: string,
  label: string,
  source = "persona",
): PersonaJsonSchema {
  const match = /```json\s*\n([\s\S]*?)```/i.exec(section);
  if (!match) {
    throw new PersonaError(`${source}: ${label} section needs a \`\`\`json fenced block`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PersonaError(`${source}: ${label} JSON is invalid: ${reason}`);
  }
  if (!isPlainObject(parsed)) {
    throw new PersonaError(`${source}: ${label} must be a JSON object`);
  }
  const schema = parsed as PersonaJsonSchema;
  if (schema.type !== "object") {
    throw new PersonaError(`${source}: ${label} type must be 'object'`);
  }
  if (!Array.isArray(schema.required) || schema.required.length === 0) {
    throw new PersonaError(`${source}: ${label} needs a non-empty required array`);
  }
  if (!isPlainObject(schema.properties) || Object.keys(schema.properties).length === 0) {
    throw new PersonaError(`${source}: ${label} needs a properties object`);
  }
  return schema;
}

/**
 * Validate a payload against the persona JSON-Schema subset.
 *
 * Returns a deterministic list of `$`-rooted error strings; an empty list means
 * the payload is valid. Ports assay `validate_payload`.
 */
export function validatePayload(
  payload: unknown,
  schema: PersonaJsonSchema,
  path = "$",
): string[] {
  const errors: string[] = [];
  const expectedType = schema.type;
  if (expectedType && !matchesSchemaType(payload, expectedType)) {
    errors.push(`${path}: expected type ${expectedType}, got ${jsonTypeName(payload)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => jsonEqual(payload, option))) {
    errors.push(
      `${path}: value ${JSON.stringify(payload)} is not one of ${JSON.stringify(schema.enum)}`,
    );
  }
  if (isPlainObject(payload)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) {
        errors.push(`${path}: missing required property '${key}'`);
      }
    }
    const properties = schema.properties;
    if (isPlainObject(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
        if (isPlainObject(child)) {
          errors.push(...validatePayload(payload[key], child, `${path}.${key}`));
        }
      }
    }
  }
  const items = schema.items;
  if (Array.isArray(payload) && isPlainObject(items)) {
    for (let index = 0; index < payload.length; index += 1) {
      errors.push(...validatePayload(payload[index], items, `${path}[${index}]`));
    }
  }
  return errors;
}

/**
 * Validate a structured blocker payload against a persona blocker schema.
 */
export function validateBlocker(payload: unknown, blockerSchema: PersonaJsonSchema): string[] {
  return validatePayload(payload, blockerSchema);
}

// -------------------------------------------------------------- persona load

/** Persona sections every contract must declare, in assay order. */
export const PERSONA_REQUIRED_SECTIONS = [
  "role",
  "available tools",
  "output schema",
  "blocker schema",
  "refusal handling",
] as const;

/** Frontmatter keys every persona contract must declare non-empty. */
export const PERSONA_REQUIRED_FRONTMATTER_KEYS = [
  "id",
  "name",
  "domains",
  "tools",
  "checks",
] as const;

export interface Persona {
  id: string;
  name: string;
  version: string;
  domains: string[];
  tools: string[];
  checks: string[];
  path: string;
  role: string;
  tools_section: string;
  output_schema: PersonaJsonSchema;
  blocker_schema: PersonaJsonSchema;
  refusal: string;
  body: string;
  metadata: PersonaFrontmatter;
}

export interface PersonaPublic {
  id: string;
  name: string;
  version: string;
  domains: string[];
  tools: string[];
  checks: string[];
  path: string;
  schema_title: string;
  blocker_schema_title: string;
}

export interface LoadPersonasOptions {
  selected?: Iterable<string>;
  requireMinimum?: number;
}

function titleCaseSection(name: string): string {
  return name.replace(/\b\w/g, (character) => character.toUpperCase());
}

function frontmatterList(
  metadata: PersonaFrontmatter,
  key: string,
  source: string,
): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    throw new PersonaError(`${source}: ${key} must be a list`);
  }
  return value.map((item) => String(item));
}

/**
 * Build a validated `Persona` from an already-parsed persona document.
 *
 * Mirrors assay `load_persona` after frontmatter/body parsing.
 */
export function personaFromDocument(document: PersonaDocument, source = "persona"): Persona {
  const metadata = document.metadata;
  for (const key of PERSONA_REQUIRED_FRONTMATTER_KEYS) {
    const value = metadata[key];
    const empty =
      value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) {
      throw new PersonaError(`${source}: missing frontmatter key '${key}'`);
    }
  }

  const domains = frontmatterList(metadata, "domains", source);
  const tools = frontmatterList(metadata, "tools", source);
  const checks = frontmatterList(metadata, "checks", source);

  const sections = document.sections;
  const missing = PERSONA_REQUIRED_SECTIONS.filter((name) => sections[name] === undefined);
  if (missing.length > 0) {
    const label = missing.map((name) => `## ${titleCaseSection(name)}`).join(", ");
    throw new PersonaError(`${source}: missing required section(s): ${label}`);
  }

  const outputSchema = extractJsonSchema(sections["output schema"] ?? "", "output schema", source);
  const blockerSchema = extractJsonSchema(
    sections["blocker schema"] ?? "",
    "blocker schema",
    source,
  );
  const role = sections["role"] ?? "";
  const toolsSection = sections["available tools"] ?? "";
  const refusal = sections["refusal handling"] ?? "";
  if (!role) {
    throw new PersonaError(`${source}: role section is empty`);
  }
  if (!refusal) {
    throw new PersonaError(`${source}: refusal handling section is empty`);
  }

  return {
    id: String(metadata.id),
    name: String(metadata.name),
    version: String(metadata.version ?? "1.0"),
    domains,
    tools,
    checks,
    path: source,
    role,
    tools_section: toolsSection,
    output_schema: outputSchema,
    blocker_schema: blockerSchema,
    refusal,
    body: document.body,
    metadata,
  };
}

/**
 * Read, parse, and validate one persona contract.
 */
export async function loadPersona(filePath: string): Promise<Persona> {
  const document = await readPersonaDocument(filePath);
  return personaFromDocument(document, filePath);
}

/**
 * Load every non-README persona contract in a directory.
 *
 * Mirrors assay `load_personas`: sorted files, duplicate-id rejection,
 * optional selection, and a minimum persona count.
 */
export async function loadPersonas(
  directory: string,
  options: LoadPersonasOptions = {},
): Promise<Persona[]> {
  const requireMinimum = options.requireMinimum ?? 3;
  const info = await stat(directory).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new PersonaError(`Personas directory not found: ${directory}`);
  }

  const files = (await readdir(directory))
    .filter(
      (name) =>
        name.toLowerCase().endsWith(".md") && !name.toLowerCase().startsWith("readme"),
    )
    .sort();

  const personas: Persona[] = [];
  const seen = new Set<string>();
  for (const name of files) {
    const persona = await loadPersona(path.join(directory, name));
    if (seen.has(persona.id)) {
      throw new PersonaError(`Duplicate persona id '${persona.id}' in ${directory}`);
    }
    seen.add(persona.id);
    personas.push(persona);
  }
  if (personas.length === 0) {
    throw new PersonaError(`No persona files found in ${directory}`);
  }

  const selected = options.selected
    ? [...options.selected].map((item) => item.trim()).filter((item) => item.length > 0)
    : [];
  if (selected.length > 0) {
    const missing = selected.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      throw new PersonaError(
        `Unknown persona id(s): ${missing.join(", ")}. Available: ${[...seen].sort().join(", ")}`,
      );
    }
    const wanted = new Set(selected);
    return personas.filter((persona) => wanted.has(persona.id));
  }

  if (requireMinimum && personas.length < requireMinimum) {
    throw new PersonaError(
      `Expected at least ${requireMinimum} personas, found ${personas.length}. Add specialist files to personas/.`,
    );
  }
  return personas;
}

/**
 * Return the requested persona subset, preserving contract order.
 */
export function selectPersonas(
  personas: Iterable<Persona>,
  selected?: Iterable<string>,
): Persona[] {
  const list = [...personas];
  if (!selected) return list;
  const wanted = [...selected].map((item) => item.trim()).filter((item) => item.length > 0);
  if (wanted.length === 0) return list;
  const available = new Set(list.map((persona) => persona.id));
  const missing = wanted.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new PersonaError(
      `Unknown persona id(s): ${missing.join(", ")}. Available: ${[...available].sort().join(", ")}`,
    );
  }
  const wantedSet = new Set(wanted);
  return list.filter((persona) => wantedSet.has(persona.id));
}

/**
 * Assay-compatible public projection of a persona contract.
 */
export function personaPublic(persona: Persona): PersonaPublic {
  const schemaTitle = persona.output_schema.title;
  const blockerTitle = persona.blocker_schema.title;
  return {
    id: persona.id,
    name: persona.name,
    version: persona.version,
    domains: [...persona.domains],
    tools: [...persona.tools],
    checks: [...persona.checks],
    path: persona.path,
    schema_title: typeof schemaTitle === "string" ? schemaTitle : "",
    blocker_schema_title: typeof blockerTitle === "string" ? blockerTitle : "",
  };
}

// ------------------------------------------------------------------ ownership, lint, scaffold

/** Minimal persona shape needed to derive check ownership. */
export interface PersonaOwnershipSource {
  readonly id: string;
  readonly checks: readonly string[];
}

export type CheckOwnership = Record<string, string[]>;

/**
 * Map every declared check id to the sorted persona ids that claim it.
 *
 * Ownership is derived from persona frontmatter only (D16); check definitions
 * never contribute an owner.
 */
export function checkOwnership(personas: Iterable<PersonaOwnershipSource>): CheckOwnership {
  const owners: Record<string, string[]> = {};
  for (const persona of personas) {
    for (const checkId of persona.checks) {
      const list = owners[checkId];
      if (list) {
        list.push(persona.id);
      } else {
        owners[checkId] = [persona.id];
      }
    }
  }
  const result: CheckOwnership = {};
  for (const [checkId, personaIds] of Object.entries(owners)) {
    result[checkId] = [...personaIds].sort();
  }
  return result;
}

/**
 * Deterministic ownership configuration error, matching assay.
 */
export function ownershipErrorMessage(checkId: string, owners: Iterable<string>): string {
  const ownerList = [...owners].sort();
  if (ownerList.length === 0) {
    return `Check '${checkId}' has no declared persona owner; it must be listed by exactly one persona contract.`;
  }
  return `Check '${checkId}' is claimed by multiple personas (${ownerList.join(", ")}); it must be listed by exactly one persona contract.`;
}

/**
 * Return (persona id, unknown check id) pairs in contract order.
 */
export function unknownPersonaCheckIds(
  personas: Iterable<PersonaOwnershipSource>,
  knownCheckIds: Iterable<string>,
): Array<[string, string]> {
  const known = new Set(knownCheckIds);
  const missing: Array<[string, string]> = [];
  for (const persona of personas) {
    for (const checkId of persona.checks) {
      if (!known.has(checkId)) missing.push([persona.id, checkId]);
    }
  }
  return missing;
}

/**
 * Reject persona contracts that reference unknown check ids.
 */
export function validatePersonaChecks(
  personas: Iterable<PersonaOwnershipSource>,
  knownCheckIds: Iterable<string>,
): void {
  const missing = unknownPersonaCheckIds(personas, knownCheckIds);
  if (missing.length === 0) return;
  const first = missing[0];
  const personaId = first ? first[0] : "";
  const checkIds = [...new Set(missing.map(([, checkId]) => checkId))].sort();
  throw new PersonaError(
    `Persona '${personaId}' references unknown check id(s): ${checkIds.join(", ")}`,
  );
}

/**
 * Derive and validate ownership over a known check id set.
 *
 * Every declared id must be known, and every known id must have exactly one
 * owner. Returns the validated ownership map.
 */
export function validateOwnership(
  personas: Iterable<PersonaOwnershipSource>,
  knownCheckIds: Iterable<string>,
): CheckOwnership {
  const list = [...personas];
  const known = [...new Set(knownCheckIds)];
  validatePersonaChecks(list, known);
  const ownership = checkOwnership(list);
  for (const checkId of [...known].sort()) {
    const owners = ownership[checkId] ?? [];
    if (owners.length !== 1) {
      throw new PersonaError(ownershipErrorMessage(checkId, owners));
    }
  }
  return ownership;
}

// ----------------------------------------------------------------------- lint

export type PersonaLintStatus = "valid" | "invalid";

export interface PersonaLintSummary {
  files: number;
  valid_personas: number;
  errors: number;
  warnings: number;
}

export interface PersonaLintLoadedPersona {
  id: string;
  file: string;
  domains: string[];
  checks: string[];
}

export interface PersonaLintIssue {
  code: string;
  message: string;
  file?: string;
  persona?: string;
  check_id?: string;
  field?: string;
  schema?: string;
  owners?: string[];
}

export interface PersonaLintReport {
  schema_version: "quality-harness.personas.lint/v1";
  directory: string;
  status: PersonaLintStatus;
  known_check_count: number;
  personas: PersonaLintLoadedPersona[];
  errors: PersonaLintIssue[];
  warnings: PersonaLintIssue[];
  summary: PersonaLintSummary;
}

function relativePersonaFile(filePath: string, directory: string): string {
  const relative = path.relative(directory, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

function lintErrorCode(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("missing required section")) return "missing_section";
  if (text.includes("frontmatter")) return "frontmatter";
  if (text.includes("output schema") || text.includes("blocker schema")) return "schema";
  if (text.includes("section is empty")) return "empty_section";
  return "invalid_persona";
}

function schemaIssues(persona: Persona): PersonaLintIssue[] {
  const issues: PersonaLintIssue[] = [];
  const contracts: Array<[string, PersonaJsonSchema, readonly string[]]> = [
    ["output", persona.output_schema, CORE_FINDING_FIELDS],
    ["blocker", persona.blocker_schema, CORE_BLOCKER_FIELDS],
  ];
  for (const [label, schema, coreFields] of contracts) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const title = label.charAt(0).toUpperCase() + label.slice(1);
    for (const fieldName of coreFields) {
      if (!required.includes(fieldName)) {
        issues.push({
          code: "schema_required_field_missing",
          schema: label,
          field: fieldName,
          persona: persona.id,
          message: `${title} schema must require field '${fieldName}'.`,
        });
      }
    }
    for (const fieldName of required) {
      if (!Object.prototype.hasOwnProperty.call(properties, fieldName)) {
        issues.push({
          code: "schema_property_not_defined",
          schema: label,
          field: fieldName,
          persona: persona.id,
          message: `${title} schema requires '${fieldName}' but does not define it.`,
        });
      }
    }
    for (const [fieldName, child] of Object.entries(properties)) {
      if (!isPlainObject(child)) {
        issues.push({
          code: "schema_property_invalid",
          schema: label,
          field: fieldName,
          persona: persona.id,
          message: `${title} schema property '${fieldName}' must be an object.`,
        });
        continue;
      }
      const expectedType = child.type;
      if (typeof expectedType === "string" && !(SUPPORTED_SCHEMA_TYPES as readonly string[]).includes(expectedType)) {
        issues.push({
          code: "schema_type_unsupported",
          schema: label,
          field: fieldName,
          persona: persona.id,
          message: `${title} schema property '${fieldName}' uses unsupported type '${expectedType}'.`,
        });
      }
      if ("enum" in child && !Array.isArray(child.enum)) {
        issues.push({
          code: "schema_enum_invalid",
          schema: label,
          field: fieldName,
          persona: persona.id,
          message: `${title} schema property '${fieldName}' enum must be an array.`,
        });
      }
      if ("items" in child && !isPlainObject(child.items)) {
        issues.push({
          code: "schema_items_invalid",
          schema: label,
          field: fieldName,
          persona: persona.id,
          message: `${title} schema property '${fieldName}' items must be an object.`,
        });
      }
    }
  }
  return issues;
}

function isScaffoldPlaceholder(persona: Persona, checkId: string): boolean {
  return checkId.startsWith(`plugin.${persona.id}.`);
}

/**
 * Lint every persona contract without stopping at the first failure.
 */
export async function lintPersonas(
  directory: string,
  knownCheckIds?: Iterable<string>,
): Promise<PersonaLintReport> {
  const known = new Set(knownCheckIds ?? []);
  const errors: PersonaLintIssue[] = [];
  const warnings: PersonaLintIssue[] = [];
  const personas: Persona[] = [];
  const personaFiles: Record<string, string> = {};
  let filesScanned = 0;

  const info = await stat(directory).catch(() => null);
  if (!info || !info.isDirectory()) {
    errors.push({
      code: "directory_missing",
      message: `Personas directory not found: ${directory}`,
    });
  } else {
    const files = (await readdir(directory))
      .filter(
        (name) =>
          name.toLowerCase().endsWith(".md") && !name.toLowerCase().startsWith("readme"),
      )
      .sort()
      .map((name) => path.join(directory, name));

    if (files.length === 0) {
      errors.push({
        code: "no_persona_files",
        message: `No persona files found in ${directory}`,
      });
    }

    for (const filePath of files) {
      const fileName = relativePersonaFile(filePath, directory);
      filesScanned += 1;
      let persona: Persona;
      try {
        persona = await loadPersona(filePath);
      } catch (error) {
        if (error instanceof PersonaError) {
          errors.push({
            code: lintErrorCode(error.message),
            file: fileName,
            message: error.message,
          });
          continue;
        }
        throw error;
      }

      if (Object.prototype.hasOwnProperty.call(personaFiles, persona.id)) {
        errors.push({
          code: "duplicate_persona_id",
          file: fileName,
          persona: persona.id,
          message: `Duplicate persona id '${persona.id}' (also declared in ${personaFiles[persona.id]}).`,
        });
        continue;
      }

      personaFiles[persona.id] = fileName;
      personas.push(persona);
      for (const issue of schemaIssues(persona)) {
        issuesWithFile(issue, fileName);
        errors.push(issue);
      }
    }

    const ownership = checkOwnership(personas);
    const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
    for (const [checkId, owners] of Object.entries(ownership).sort(([a], [b]) => a.localeCompare(b))) {
      if (owners.length > 1) {
        errors.push({
          code: "duplicate_ownership",
          check_id: checkId,
          owners: [...owners],
          message: ownershipErrorMessage(checkId, owners),
        });
        continue;
      }
      if (known.has(checkId)) continue;
      const ownerId = owners[0];
      const persona = ownerId ? personaMap.get(ownerId) : undefined;
      if (persona && isScaffoldPlaceholder(persona, checkId)) {
        warnings.push({
          code: "plugin_check_placeholder",
          file: personaFiles[persona.id] ?? "",
          persona: persona.id,
          check_id: checkId,
          message: `Scaffold check '${checkId}' has no installed plugin yet; install a signed plugin or replace the check id before running.`,
        });
      } else {
        errors.push({
          code: "unknown_check",
          check_id: checkId,
          owners: [...owners],
          message: `Check '${checkId}' is not in the check registry; it must be a built-in check or an installed plugin check.`,
        });
      }
    }
  }

  const loaded: PersonaLintLoadedPersona[] = personas.map((persona) => ({
    id: persona.id,
    file: personaFiles[persona.id] ?? "",
    domains: [...persona.domains],
    checks: [...persona.checks],
  }));

  return {
    schema_version: "quality-harness.personas.lint/v1",
    directory,
    status: errors.length > 0 ? "invalid" : "valid",
    known_check_count: known.size,
    personas: loaded,
    errors,
    warnings,
    summary: {
      files: filesScanned,
      valid_personas: personas.length,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}

function issuesWithFile(issue: PersonaLintIssue, fileName: string): void {
  issue.file = fileName;
}
