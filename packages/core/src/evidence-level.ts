export const EVIDENCE_LEVELS = ["E0", "E1", "E2", "E3"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const EVIDENCE_LEVEL_RANK: Record<EvidenceLevel, number> = {
  E0: 0,
  E1: 1,
  E2: 2,
  E3: 3,
};

export function evidenceLevelRank(level: unknown): number {
  if (typeof level === "string" && (level === "E0" || level === "E1" || level === "E2" || level === "E3")) {
    return EVIDENCE_LEVEL_RANK[level];
  }
  return 0;
}

export function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return value === "E0" || value === "E1" || value === "E2" || value === "E3";
}

export interface EvidenceLike {
  path?: string;
  id?: string;
  type?: string;
  kind?: string;
  source?: string;
  description?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  content_type?: string;
  mime_type?: string;
  observed?: boolean;
  executed?: boolean;
  captured_result?: boolean;
  corroborated?: boolean;
  inspected_only?: boolean;
  [key: string]: unknown;
}

export interface FindingLike {
  id?: string;
  title?: string;
  evidence?: unknown;
  evidence_level?: unknown;
  evidenceLevel?: unknown;
  declared_evidence_level?: unknown;
  metadata?: Record<string, unknown>;
  strength?: string;
  [key: string]: unknown;
}

export interface EvidenceClassification {
  level: EvidenceLevel;
  supported_level: EvidenceLevel;
  declared_level?: EvidenceLevel | null;
  downgraded: boolean;
  note?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function norm(s: string): string {
  return s.toLowerCase();
}

function evidenceToRecords(evidence: unknown): EvidenceLike[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((e) => {
    if (typeof e === "string") return { path: e, id: e };
    if (isRecord(e)) return e as EvidenceLike;
    return {};
  });
}

function textOfEvidence(e: EvidenceLike): string {
  const parts = [
    asString(e.path),
    asString(e.id),
    asString(e.type),
    asString(e.kind),
    asString(e.source),
    asString(e.description),
    asString(e.summary),
    asString(e.content_type),
    asString(e.mime_type),
  ];
  if (isRecord(e.metadata)) {
    for (const [k, v] of Object.entries(e.metadata)) {
      parts.push(k);
      if (typeof v === "string") parts.push(v);
      else if (typeof v === "boolean" || typeof v === "number") parts.push(String(v));
    }
  }
  return norm(parts.join(" | "));
}

function isCapturedResult(e: EvidenceLike): boolean {
  if (e.captured_result === true) return true;
  const t = textOfEvidence(e);
  if (/(screenshot|snapshot|png|jpg|jpeg|webp|image|http response|response body|response\b|status code|har\b|trace\b|log\b|stdout|stderr|captured|recording|video)/.test(t)) return true;
  // common evidence path hints
  if (/\.(png|jpe?g|webp|gif|har|json|log|txt|html)$/i.test(asString(e.path))) return true;
  return false;
}

function isExecutedBehavior(e: EvidenceLike): boolean {
  if (e.executed === true || e.observed === true) return true;
  const t = textOfEvidence(e);
  if (/(executed|ran|run\b|runtime|live behavior|observed live|browser|http request|http response|response\b|screenshot|trace|interaction|clicked|navigated|loaded)/.test(t)) return true;
  return false;
}

function isSourceOnlyEvidence(e: EvidenceLike): boolean {
  if (e.inspected_only === true) return true;
  const t = textOfEvidence(e);
  if (/(source|static analysis|inspected|inspection|code review|readme|file content|ast\b)/.test(t)) return true;
  return false;
}

function sourceKey(e: EvidenceLike): string {
  // independent source heuristic: prefer explicit source/id/type+path bucket, else path prefix/type
  const src = asString(e.source);
  if (src) return `source:${norm(src)}`;
  const kind = asString(e.kind) || asString(e.type);
  const pathStr = asString(e.path);
  if (kind && pathStr) return `${norm(kind)}:${norm(pathStr.split("/").slice(0, 2).join("/"))}`;
  if (pathStr) return `path:${norm(pathStr.split("/").slice(0, 2).join("/"))}`;
  if (kind) return `kind:${norm(kind)}`;
  return "";
}

/**
 * Strict classifier:
 * - E3: executed behavior AND captured result
 * - E2: corroborating evidence across >= 2 independent sources
 * - E1: source-only (inspected source only)
 * - E0: unknown
 */
export function classifySupportedEvidenceLevel(evidence: unknown): EvidenceLevel {
  const records = evidenceToRecords(evidence);
  if (records.length === 0) return "E0";

  let hasExecuted = false;
  let hasCaptured = false;
  let hasSourceOnly = false;
  const independentSources = new Set<string>();

  for (const e of records) {
    if (isExecutedBehavior(e)) hasExecuted = true;
    if (isCapturedResult(e)) hasCaptured = true;
    if (isSourceOnlyEvidence(e)) hasSourceOnly = true;
    const k = sourceKey(e);
    if (k) independentSources.add(k);
  }

  if (hasExecuted && hasCaptured) return "E3";

  // corroborated across >= 2 independent sources
  let distinct = independentSources.size;
  if (distinct === 0 && records.length >= 2) {
    // fallback: treat each evidence record as an independent source when no keys could be derived
    distinct = records.length;
  }
  if (distinct >= 2) return "E2";

  // source-only if we have evidence but it is only inspected/source-derived and not executed+captured/corroborated
  if (hasSourceOnly || records.length > 0) return "E1";

  return "E0";
}

export function classifyFinding(finding: FindingLike, evidence?: unknown): EvidenceClassification {
  const evidenceInput = evidence !== undefined ? evidence : finding?.evidence;
  const supported = classifySupportedEvidenceLevel(evidenceInput);

  const declaredRaw = finding?.declared_evidence_level ?? finding?.evidence_level ?? finding?.evidenceLevel ?? (isRecord(finding?.metadata) ? (finding!.metadata as any).evidence_level : undefined);
  const declared = isEvidenceLevel(declaredRaw) ? declaredRaw : null;

  let level = supported;
  let downgraded = false;
  let note: string | undefined;

  if (declared && evidenceLevelRank(declared) > evidenceLevelRank(supported)) {
    level = supported;
    downgraded = true;
    note = `Declared evidence level ${declared} downgraded to supported level ${supported} (insufficient supporting evidence).`;
  } else if (declared && evidenceLevelRank(declared) <= evidenceLevelRank(supported)) {
    // do not claim higher than supported; keep supported as highest supported level (deterministic)
    level = supported;
  } else {
    level = supported;
  }

  return {
    level,
    supported_level: supported,
    declared_level: declared,
    downgraded,
    ...(note ? { note } : {}),
  };
}

export function applyEvidenceLevelToFinding<T extends FindingLike>(finding: T, evidence?: unknown): T & { evidence_level: EvidenceLevel; evidence_level_note?: string } {
  const c = classifyFinding(finding, evidence);
  const next: any = { ...finding, evidence_level: c.level };
  if (c.note) next.evidence_level_note = c.note;
  else if (typeof (finding as any).evidence_level_note === "string" && c.downgraded) next.evidence_level_note = (finding as any).evidence_level_note;
  if (c.downgraded) {
    // keep typed note accessible
    next.evidence_level_downgraded = true;
    next.evidence_level_supported = c.supported_level;
    next.evidence_level_declared = c.declared_level;
  }
  return next;
}

export function applyEvidenceLevelsToFindings<T extends FindingLike>(findings: T[]): Array<T & { evidence_level: EvidenceLevel; evidence_level_note?: string }> {
  return findings.map((f) => applyEvidenceLevelToFinding(f));
}
