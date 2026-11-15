/**
 * Persona contract parsing.
 *
 * Ports the YAML-subset frontmatter parser and section splitter from assay's
 * `harness/personas.py` without a runtime YAML dependency. Schema validation,
 * ownership derivation, and linting build on top of this module; parsing itself
 * is text-only and deterministic (no clock, entropy, filesystem, or network
 * access beyond the explicit `readPersonaDocument` file read).
 */

import { readFile } from "node:fs/promises";

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
