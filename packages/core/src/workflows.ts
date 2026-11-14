import * as fs from "node:fs";
import * as path from "node:path";

import { MalformedWorkflowError, WorkflowError } from "./errors.js";

export const PHASE_ORDER = [
  "risk_analysis",
  "test_planning",
  "execution",
  "evidence_collection",
  "confidence_scoring",
] as const;

export type PhaseName = (typeof PHASE_ORDER)[number];

export const DEFAULT_PHASE_TITLES: Record<PhaseName, string> = {
  risk_analysis: "Risk Analysis",
  test_planning: "Test Planning",
  execution: "Execution",
  evidence_collection: "Evidence Collection",
  confidence_scoring: "Confidence Scoring",
};

export const DEFAULT_PHASE_DESCRIPTIONS: Record<PhaseName, string> = {
  risk_analysis:
    "Inspect available artifacts, map intent to consequences, and rank risks.",
  test_planning:
    "Select intent-linked checks owned by specialist personas within budget.",
  execution:
    "Run static Inspect checks and browser Operate checks; halt on a kill-switch finding.",
  evidence_collection:
    "Finalize the evidence manifest, hashes, and coverage roll-up.",
  confidence_scoring:
    "Compute a weighted, gap-aware release confidence score and gate result.",
};

export interface PhaseDefinition {
  name: PhaseName;
  title: string;
  description: string;
}

export interface Workflow {
  id: string;
  name: string;
  version: string;
  phases: PhaseDefinition[];
  description: string;
  schema_version?: string;
}

export function builtInReleaseConfidenceWorkflow(): Workflow {
  return {
    id: "release-confidence",
    name: "Release Confidence",
    version: "1.0",
    description: "Default five-phase release-confidence workflow.",
    phases: PHASE_ORDER.map((name) => ({
      name,
      title: DEFAULT_PHASE_TITLES[name],
      description: DEFAULT_PHASE_DESCRIPTIONS[name],
    })),
  };
}

export const RELEASE_CONFIDENCE: Workflow = builtInReleaseConfidenceWorkflow();
export const WORKFLOWS: Record<string, Workflow> = {
  [RELEASE_CONFIDENCE.id]: RELEASE_CONFIDENCE,
};

// --------------------------------------------------------------------------- yaml subset
const KEY_RE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\d*\.\d+)$/;

type Token = [indent: number, content: string, lineNumber: number];

function stripComment(line: string): string {
  let quote: "" | "'" | '"' = "";
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\" && quote === '"') {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function tokenize(text: string, filePath: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNumber = i + 1;
    if (raw.trim().length === 0) continue;
    if (raw.startsWith("\t")) {
      throw new MalformedWorkflowError(`${filePath}:${lineNumber}: tabs are not allowed for indentation`, {
        path: filePath,
        line: lineNumber,
      });
    }
    const indent = raw.length - raw.replace(/^ +/, "").length;
    const rest = raw.slice(indent);
    const content = stripComment(rest).trim();
    if (!content || content === "---" || content === "...") continue;
    if (rest.startsWith("\t")) {
      throw new MalformedWorkflowError(`${filePath}:${lineNumber}: tabs are not allowed for indentation`, {
        path: filePath,
        line: lineNumber,
      });
    }
    tokens.push([indent, content, lineNumber]);
  }
  return tokens;
}

function parseScalar(value: string, filePath: string, lineNumber: number): unknown {
  const text = value.trim();
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^[|>&*!{[]/.test(text)) {
    throw new MalformedWorkflowError(
      `${filePath}:${lineNumber}: unsupported YAML feature in value ${JSON.stringify(text)}; use simple mappings, lists, and scalars`,
      { path: filePath, line: lineNumber },
    );
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new MalformedWorkflowError(`${filePath}:${lineNumber}: unterminated double-quoted string`, {
        path: filePath,
        line: lineNumber,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MalformedWorkflowError(`${filePath}:${lineNumber}: invalid double-quoted string`, {
        path: filePath,
        line: lineNumber,
      });
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new MalformedWorkflowError(`${filePath}:${lineNumber}: unterminated single-quoted string`, {
        path: filePath,
        line: lineNumber,
      });
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (INT_RE.test(text)) return Number.parseInt(text, 10);
  if (FLOAT_RE.test(text)) return Number.parseFloat(text);
  return text;
}

function parseNode(tokens: Token[], index: number, indent: number, filePath: string): [unknown, number] {
  const token = tokens[index];
  if (!token) throw new MalformedWorkflowError(`${filePath}: unexpected end of workflow`, { path: filePath });
  const [, content] = token;
  if (content.startsWith("- ")) return parseList(tokens, index, indent, filePath);
  return parseMap(tokens, index, indent, filePath);
}

function parseMap(tokens: Token[], index: number, indent: number, filePath: string): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  while (index < tokens.length) {
    const tok = tokens[index];
    if (!tok) break;
    const [currentIndent, content, lineNumber] = tok;
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      throw new MalformedWorkflowError(
        `${filePath}:${lineNumber}: unexpected indentation; expected ${indent} spaces`,
        { path: filePath, line: lineNumber },
      );
    }
    if (content.startsWith("- ")) {
      throw new MalformedWorkflowError(
        `${filePath}:${lineNumber}: a list item cannot appear inside a mapping without a key`,
        { path: filePath, line: lineNumber },
      );
    }
    const match = KEY_RE.exec(content);
    if (!match) {
      throw new MalformedWorkflowError(
        `${filePath}:${lineNumber}: expected 'key: value', found ${JSON.stringify(content)}`,
        { path: filePath, line: lineNumber },
      );
    }
    const key = match[1] ?? "";
    const remainder = (match[2] ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new MalformedWorkflowError(`${filePath}:${lineNumber}: duplicate key '${key}'`, {
        path: filePath,
        line: lineNumber,
        key,
      });
    }
    index += 1;
    if (remainder) {
      result[key] = parseScalar(remainder, filePath, lineNumber);
    } else {
      const next = tokens[index];
      if (next && next[0] > indent) {
        const [childValue, nextIndex] = parseNode(tokens, index, next[0], filePath);
        result[key] = childValue;
        index = nextIndex;
      } else {
        result[key] = null;
      }
    }
  }
  return [result, index];
}

function parseList(tokens: Token[], index: number, indent: number, filePath: string): [unknown[], number] {
  const items: unknown[] = [];
  while (index < tokens.length) {
    const tok = tokens[index];
    if (!tok) break;
    const [currentIndent, content, lineNumber] = tok;
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      throw new MalformedWorkflowError(
        `${filePath}:${lineNumber}: unexpected indentation; expected ${indent} spaces`,
        { path: filePath, line: lineNumber },
      );
    }
    if (!content.startsWith("- ")) break;
    const remainder = content.slice(2).trim();
    index += 1;

    if (!remainder) {
      const next = tokens[index];
      if (next && next[0] > indent) {
        const [child, nextIndex] = parseNode(tokens, index, next[0], filePath);
        items.push(child);
        index = nextIndex;
      } else {
        items.push(null);
      }
      continue;
    }

    const match = remainder.startsWith("'") || remainder.startsWith('"') ? null : KEY_RE.exec(remainder);
    if (!match) {
      items.push(parseScalar(remainder, filePath, lineNumber));
      const next = tokens[index];
      if (next && next[0] > indent) {
        throw new MalformedWorkflowError(
          `${filePath}:${lineNumber}: a scalar list item cannot contain a nested block`,
          { path: filePath, line: lineNumber },
        );
      }
      continue;
    }

    const key = match[1] ?? "";
    const valueText = (match[2] ?? "").trim();
    const item: Record<string, unknown> = {};
    if (valueText) {
      item[key] = parseScalar(valueText, filePath, lineNumber);
    } else {
      const next = tokens[index];
      if (next && next[0] > indent) {
        const [child, nextIndex] = parseNode(tokens, index, next[0], filePath);
        item[key] = child;
        index = nextIndex;
      } else {
        item[key] = null;
      }
    }

    const nextAfter = tokens[index];
    if (nextAfter && nextAfter[0] > indent) {
      const [block, nextIndex] = parseMap(tokens, index, nextAfter[0], filePath);
      for (const [bk, bv] of Object.entries(block)) {
        if (Object.prototype.hasOwnProperty.call(item, bk)) {
          throw new MalformedWorkflowError(`${filePath}:${lineNumber}: duplicate key '${bk}'`, {
            path: filePath,
            line: lineNumber,
            key: bk,
          });
        }
        item[bk] = bv;
      }
      index = nextIndex;
    }
    items.push(item);
  }
  return [items, index];
}

function parseYaml(text: string, filePath: string): Record<string, unknown> {
  const tokens = tokenize(text, filePath);
  if (tokens.length === 0) {
    throw new MalformedWorkflowError(`${filePath}: workflow file is empty`, { path: filePath });
  }
  const rootIndent = tokens[0]?.[0] ?? 0;
  const [data, index] = parseNode(tokens, 0, rootIndent, filePath);
  if (index !== tokens.length) {
    const lineNumber = tokens[index]?.[2] ?? 0;
    throw new MalformedWorkflowError(`${filePath}:${lineNumber}: could not parse the rest of the file`, {
      path: filePath,
      line: lineNumber,
    });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new MalformedWorkflowError(`${filePath}: the workflow document must be a mapping`, { path: filePath });
  }
  return data as Record<string, unknown>;
}

// ----------------------------------------------------------------------- validation
const TOP_LEVEL_KEYS = new Set(["schema_version", "id", "name", "version", "description", "phases"]);
const PHASE_KEYS = new Set(["name", "title", "description"]);
const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function wfError(message: string, details?: Record<string, unknown>): WorkflowError {
  return details ? new WorkflowError(message, { details }) : new WorkflowError(message);
}

function requireText(data: Record<string, unknown>, key: string, filePath: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw wfError(`${filePath}: '${key}' must be a non-empty string`, { path: filePath, key });
  }
  return value.trim();
}

function optionalText(data: Record<string, unknown>, key: string, filePath: string): string {
  if (!(key in data) || data[key] === null || data[key] === undefined) return "";
  const value = data[key];
  if (typeof value !== "string") {
    throw wfError(`${filePath}: '${key}' must be a string`, { path: filePath, key });
  }
  return value;
}

function validateWorkflow(data: Record<string, unknown>, filePath: string): Workflow {
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw wfError(`${filePath}: unknown workflow key(s): ${key}`, { details: { path: filePath, key } });
    }
  }

  const id = requireText(data, "id", filePath);
  if (!WORKFLOW_ID_RE.test(id)) {
    throw wfError(`${filePath}: workflow id must match ${WORKFLOW_ID_RE.source} (got ${JSON.stringify(id)})`, {
      details: { path: filePath, id },
    });
  }
  const name = requireText(data, "name", filePath);

  const rawVersion = data.version;
  if (rawVersion === null || rawVersion === undefined || typeof rawVersion === "boolean") {
    throw wfError(`${filePath}: 'version' must be a non-empty string or number`, { details: { path: filePath } });
  }
  let version: string;
  if (typeof rawVersion === "number") {
    if (!Number.isFinite(rawVersion)) {
      throw wfError(`${filePath}: 'version' must be a non-empty string or number`, { details: { path: filePath } });
    }
    version = String(rawVersion).trim();
  } else if (typeof rawVersion === "string") {
    version = rawVersion.trim();
  } else {
    throw wfError(`${filePath}: 'version' must be a non-empty string or number`, { details: { path: filePath } });
  }
  if (!version) {
    throw wfError(`${filePath}: 'version' must be a non-empty string or number`, { details: { path: filePath } });
  }

  const rawPhasesValue = data.phases;
  if (!Array.isArray(rawPhasesValue)) {
    throw wfError(`${filePath}: 'phases' must be a list`, { details: { path: filePath } });
  }
  const rawPhases: unknown[] = rawPhasesValue;
  if (rawPhases.length !== PHASE_ORDER.length) {
    throw wfError(
      `${filePath}: workflow must define exactly ${PHASE_ORDER.length} phases, found ${rawPhases.length}`,
      { details: { path: filePath } },
    );
  }

  const phases: PhaseDefinition[] = [];
  for (let position = 0; position < PHASE_ORDER.length; position++) {
    const expectedName = PHASE_ORDER[position] as PhaseName;
    const item: unknown = rawPhases[position];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw wfError(`${filePath}: phase ${position + 1} must be a mapping`, {
        details: { path: filePath, position: position + 1 },
      });
    }
    const phaseObj = item as Record<string, unknown>;
    for (const key of Object.keys(phaseObj)) {
      if (!PHASE_KEYS.has(key)) {
        throw wfError(`${filePath}: phase ${position + 1} has unknown key(s): ${key}`, {
          details: { path: filePath, position: position + 1, key },
        });
      }
    }
    const phaseName = requireText(phaseObj, "name", filePath);
    if (!PHASE_ORDER.includes(phaseName as PhaseName)) {
      throw wfError(
        `${filePath}: unknown phase '${phaseName}'; allowed phases are: ${PHASE_ORDER.join(", ")}`,
        { details: { path: filePath, phase: phaseName } },
      );
    }
    if (phaseName !== expectedName) {
      throw wfError(
        `${filePath}: invalid phase order at position ${position + 1}: expected '${expectedName}', found '${phaseName}'`,
        { details: { path: filePath, position: position + 1, expected: expectedName, found: phaseName } },
      );
    }
    const title = requireText(phaseObj, "title", filePath);
    const description = optionalText(phaseObj, "description", filePath);
    phases.push({ name: expectedName, title, description });
  }

  const workflow: Workflow = {
    id,
    name,
    version,
    phases,
    description: optionalText(data, "description", filePath),
  };
  if (typeof data.schema_version === "string" && data.schema_version.trim()) {
    workflow.schema_version = data.schema_version.trim();
  }
  return workflow;
}

export function loadWorkflowFile(filePath: string): Workflow {
  const resolved = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`Could not read workflow file ${resolved}: ${msg}`, { details: { path: resolved } });
  }
  const parsed = parseYaml(text, resolved);
  return validateWorkflow(parsed, resolved);
}

export function loadWorkflows(directory?: string | null): Record<string, Workflow> {
  if (directory === undefined || directory === null) return {};
  const dir = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`Could not access workflow directory ${dir}: ${msg}`, { details: { path: dir } });
  }
  if (!stat.isDirectory()) {
    throw new WorkflowError(`Workflow path is not a directory: ${dir}`, { details: { path: dir } });
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const out: Record<string, Workflow> = {};
  for (const file of files) {
    const workflow = loadWorkflowFile(path.join(dir, file));
    if (Object.prototype.hasOwnProperty.call(out, workflow.id)) {
      throw new WorkflowError(`Duplicate workflow id '${workflow.id}' in directory ${dir}`, {
        details: { path: dir, workflow_id: workflow.id },
      });
    }
    out[workflow.id] = workflow;
  }
  return out;
}
