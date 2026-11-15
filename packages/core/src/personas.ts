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
