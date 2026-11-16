import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  EvidenceStore,
  atomicWriteJson,
  ensureDir,
  now,
  readJsonFile,
  redactUnknown,
  sha256Bytes,
} from "@lemma/core";

import { requireProLicense, type ProLicenseContext } from "./entitlement.js";

export type ProofStatus = "PROVED" | "COUNTEREXAMPLE" | "UNPROVED" | "STALE";

export interface ProofScope {
  target: string;
  files?: string[];
  symbols?: string[];
  constraints?: string[];
  target_hash?: string;
  [key: string]: unknown;
}

export interface ProofAssumptions {
  items: string[];
  [key: string]: unknown;
}

export interface ProofBackendResult {
  status: Exclude<ProofStatus, "STALE">;
  artifact: string;
  transcript: string;
  notes?: string[];
}

export interface ProofBackend {
  id: string;
  name: string;
  description: string;
  run(input: {
    property: string;
    target: string;
    scope: ProofScope;
    assumptions: ProofAssumptions;
  }): Promise<ProofBackendResult> | ProofBackendResult;
}

export interface ProofEvidencePaths {
  directory: string;
  artifact: string;
  scope_assumptions: string;
  transcript: string;
  result: string;
}

export interface PropertyProofResult {
  schema_version: "lemma.pro.proof/v1";
  proof_id: string;
  run_id: string;
  status: ProofStatus;
  property: string;
  target: string;
  scope: ProofScope;
  assumptions: ProofAssumptions;
  backend: { id: string; name: string; configured: boolean } | null;
  notes: string[];
  created_at: string;
  checked_at: string;
  evidence: ProofEvidencePaths;
  evidence_refs: string[];
  /** Report fragment linked to proof evidence. COUNTEREXAMPLE is surfaced as blocker (not finding). */
  report: {
    proof: {
      proof_id: string;
      status: ProofStatus;
      evidence_refs: string[];
    };
    blockers: Array<{
      id: string;
      kind: "proof_counterexample";
      title: string;
      check_id: string;
      persona: string;
      evidence: string[];
      details: Record<string, unknown>;
    }>;
    findings: Array<Record<string, unknown>>;
  };
  stale_reason?: string;
  counterexample?: { artifact_path: string; summary: string };
}

export interface RunPropertyProofOptions {
  property: string;
  target: string;
  scope?: Partial<ProofScope> | null;
  assumptions?: Partial<ProofAssumptions> | string[] | null;
  backend?: ProofBackend | string | null;
  license?: ProLicenseContext | null;
  cwd?: string;
  root?: string;
  runId?: string;
  proofId?: string;
  now?: () => string;
  /** If provided and mismatches recorded target hash, result becomes STALE. */
  recomputeStaleness?: boolean;
}

function asRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deterministicId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function resolveNow(opt?: () => string): string {
  try { return opt ? opt() : now(); } catch { return new Date().toISOString(); }
}

async function hashTarget(target: string, cwd: string): Promise<string> {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  try {
    const st = await fs.stat(abs);
    if (st.isFile()) {
      const buf = await fs.readFile(abs);
      return sha256Bytes(buf);
    }
    if (st.isDirectory()) {
      // deterministic directory snapshot hash over sorted relative file list + file hashes (bounded scan)
      const entries: string[] = [];
      const walk = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 4 || entries.length >= 200) return;
        const items = await fs.readdir(dir, { withFileTypes: true });
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const it of items) {
          if (entries.length >= 200) break;
          if (it.name === ".git" || it.name === ".lemma" || it.name === "node_modules" || it.name === "dist") continue;
          const full = path.join(dir, it.name);
          const rel = path.relative(abs, full).replace(/\\/g, "/");
          if (it.isDirectory()) await walk(full, depth + 1);
          else if (it.isFile()) {
            try {
              const buf = await fs.readFile(full);
              entries.push(`${rel}:${sha256Bytes(buf)}`);
            } catch {
              entries.push(`${rel}:unreadable`);
            }
          }
        }
      };
      await walk(abs);
      return sha256Bytes(entries.join("\n"));
    }
  } catch {
    // fall through
  }
  return sha256Bytes(String(target));
}

export class LeanProofBackend implements ProofBackend {
  readonly id = "lean";
  readonly name = "Lean (reference backend)";
  readonly description = "Pluggable Lean backend interface. Without a configured Lean toolchain/runtime, callers should treat backend as unavailable.";

  async run(input: { property: string; target: string; scope: ProofScope; assumptions: ProofAssumptions }): Promise<ProofBackendResult> {
    // Reference backend adapter: in this environment no Lean execution is assumed.
    // If an external integration provides a configured Lean runner, it should be passed as a custom backend instance.
    return {
      status: "UNPROVED",
      artifact: JSON.stringify({ backend: this.id, property: input.property, target: input.target, result: "unproved" }, null, 2),
      transcript: "Lean backend is documented but not configured/executed in this runtime; no formal proof was produced.",
      notes: ["backend unavailable"],
    };
  }
}

export function getDefaultProofBackends(): Record<string, ProofBackend> {
  const lean = new LeanProofBackend();
  return { lean };
}

function resolveBackend(backend: RunPropertyProofOptions["backend"]): { backend: ProofBackend | null; id: string; name: string; configured: boolean; note?: string } {
  if (backend === null || backend === undefined || backend === "") {
    return { backend: null, id: "none", name: "No backend configured", configured: false, note: "no backend configured" };
  }
  if (typeof backend === "string") {
    const known = getDefaultProofBackends();
    const b = known[backend];
    if (b) return { backend: b, id: b.id, name: b.name, configured: true };
    return { backend: null, id: backend, name: backend, configured: false, note: "backend unavailable" };
  }
  if (backend && typeof backend.run === "function") {
    return { backend, id: backend.id || "custom", name: backend.name || "custom", configured: true };
  }
  return { backend: null, id: "invalid", name: "Invalid backend", configured: false, note: "backend unavailable" };
}

function blockerForCounterexample(result: PropertyProofResult): PropertyProofResult["report"]["blockers"][number] {
  return {
    id: `proof-counterexample-${result.proof_id}`,
    kind: "proof_counterexample",
    title: `Property does not hold: ${result.property}`,
    check_id: "pro.proof",
    persona: "pro.proof",
    evidence: [...result.evidence_refs],
    details: {
      status: result.status,
      proof_id: result.proof_id,
      run_id: result.run_id,
      property: result.property,
      target: result.target,
      counterexample_artifact: result.evidence.artifact,
      note: "COUNTEREXAMPLE surfaced as blocker (property does not hold), not a quality-threshold finding.",
    },
  };
}

export async function detectProofStaleness(record: Pick<PropertyProofResult, "target" | "scope">, cwd = process.cwd()): Promise<{ stale: boolean; reason?: string; current_hash: string; recorded_hash?: string }> {
  const recorded = typeof record.scope?.target_hash === "string" ? record.scope.target_hash : undefined;
  const current = await hashTarget(record.target, cwd);
  if (recorded && recorded !== current) {
    return { stale: true, reason: "target or scope changed since proof was recorded (target content hash mismatch)", current_hash: current, recorded_hash: recorded };
  }
  return { stale: false, current_hash: current, ...(recorded ? { recorded_hash: recorded } : {}) };
}

/**
 * Run a property proof workflow (LEM-158).
 * Unlicensed invocation refuses with ProUnavailableError before any work.
 * Licensed invocation without configured backend returns UNPROVED with "no backend configured".
 */
export async function runPropertyProof(options: RunPropertyProofOptions): Promise<PropertyProofResult> {
  const { property, target } = options;
  if (!property || !String(property).trim()) {
    throw new Error("property is required");
  }
  if (!target || !String(target).trim()) {
    throw new Error("target is required");
  }

  // License gate first (no partial execution)
  requireProLicense(options.license ?? null, "property proof (/proof)");

  const cwd = path.resolve(options.root ?? options.cwd ?? process.cwd());
  const checkedAt = resolveNow(options.now);
  const runId = options.runId ?? deterministicId("run", `${property}\n${target}\n${checkedAt}`);
  const proofId = options.proofId ?? deterministicId("proof", `${property}\n${target}\n${JSON.stringify(options.scope ?? {})}\n${JSON.stringify(options.assumptions ?? [])}`);

  const targetHash = await hashTarget(target, cwd);
  const assumptionsItems = Array.isArray(options.assumptions)
    ? options.assumptions.map(String)
    : Array.isArray((options.assumptions as any)?.items)
      ? ((options.assumptions as any).items as unknown[]).map(String)
      : [];
  const scope: ProofScope = {
    target,
    ...(asRecord(options.scope) ? (options.scope as Record<string, unknown>) : {}),
    target_hash: (asRecord(options.scope) && typeof (options.scope as any).target_hash === "string")
      ? String((options.scope as any).target_hash)
      : targetHash,
  };
  const assumptions: ProofAssumptions = {
    ...(asRecord(options.assumptions) && !Array.isArray(options.assumptions) ? (options.assumptions as Record<string, unknown>) : {}),
    items: assumptionsItems,
  };

  const backendResolved = resolveBackend(options.backend);
  let status: ProofStatus;
  let artifactText = "";
  let transcriptText = "";
  const notes: string[] = [];

  if (!backendResolved.configured || !backendResolved.backend) {
    status = "UNPROVED";
    const note = backendResolved.note === "no backend configured" || !options.backend
      ? "no backend configured"
      : "backend unavailable";
    notes.push(note);
    artifactText = JSON.stringify({ status, note, property, target, backend: backendResolved.id }, null, 2);
    transcriptText = note === "no backend configured"
      ? "No proof backend configured. Proof not executed."
      : "Requested proof backend is unavailable. Proof not executed.";
  } else {
    const out = await backendResolved.backend.run({ property, target, scope, assumptions });
    status = out.status;
    artifactText = typeof out.artifact === "string" ? out.artifact : JSON.stringify(out.artifact ?? "", null, 2);
    transcriptText = typeof out.transcript === "string" ? out.transcript : String(out.transcript ?? "");
    if (Array.isArray(out.notes)) notes.push(...out.notes.map(String));
  }

  // Staleness detection: if recomputing and recorded hash differs from current, mark STALE
  let staleReason: string | undefined;
  if (options.recomputeStaleness) {
    const stale = await detectProofStaleness({ target, scope }, cwd);
    if (stale.stale) {
      status = "STALE";
      staleReason = stale.reason;
      notes.push(staleReason || "STALE");
    }
  }

  const evidenceDir = path.join(cwd, ".lemma", "evidence", runId, "proof", proofId);
  await ensureDir(evidenceDir);
  const paths: ProofEvidencePaths = {
    directory: path.relative(cwd, evidenceDir).replace(/\\/g, "/"),
    artifact: path.relative(cwd, path.join(evidenceDir, "artifact.txt")).replace(/\\/g, "/"),
    scope_assumptions: path.relative(cwd, path.join(evidenceDir, "scope-assumptions.json")).replace(/\\/g, "/"),
    transcript: path.relative(cwd, path.join(evidenceDir, "transcript.txt")).replace(/\\/g, "/"),
    result: path.relative(cwd, path.join(evidenceDir, "result.json")).replace(/\\/g, "/"),
  };

  // Redact transcript before persistence (and avoid leaking secrets)
  const redactedTranscript = String((redactUnknown(transcriptText) as any) ?? transcriptText);
  const scopeRecord = {
    schema_version: "lemma.pro.proof_scope/v1",
    proof_id: proofId,
    run_id: runId,
    property,
    target,
    scope,
    assumptions,
    staleness: {
      mechanism: "target content hash recorded at proof time; recomputed at read/check time and marked STALE on mismatch",
      recorded_target_hash: scope.target_hash,
    },
    checked_at: checkedAt,
  };

  const baseResult: PropertyProofResult = {
    schema_version: "lemma.pro.proof/v1",
    proof_id: proofId,
    run_id: runId,
    status,
    property,
    target,
    scope,
    assumptions,
    backend: { id: backendResolved.id, name: backendResolved.name, configured: backendResolved.configured },
    notes,
    created_at: checkedAt,
    checked_at: checkedAt,
    evidence: paths,
    evidence_refs: [paths.artifact, paths.scope_assumptions, paths.transcript, paths.result],
    report: {
      proof: { proof_id: proofId, status, evidence_refs: [paths.artifact, paths.scope_assumptions, paths.transcript, paths.result] },
      blockers: [],
      findings: [],
    },
    ...(staleReason ? { stale_reason: staleReason } : {}),
    ...(status === "COUNTEREXAMPLE" ? { counterexample: { artifact_path: paths.artifact, summary: "Counterexample artifact recorded; property does not hold." } } : {}),
  };

  if (status === "COUNTEREXAMPLE") {
    baseResult.report.blockers.push(blockerForCounterexample(baseResult));
  }

  await fs.writeFile(path.join(cwd, paths.artifact), String(artifactText ?? ""), "utf8");
  await atomicWriteJson(path.join(cwd, paths.scope_assumptions), scopeRecord);
  await fs.writeFile(path.join(cwd, paths.transcript), redactedTranscript, "utf8");
  await atomicWriteJson(path.join(cwd, paths.result), baseResult);

  // Link evidence into manifest via EvidenceStore (best-effort) for hashed evidence linkage
  try {
    const store = new EvidenceStore(cwd, runId);
    await store.init();
    const recordText = async (rel: string, kind: string, desc: string) => {
      const abs = path.join(cwd, rel);
      try { await (store as any).recordText?.(abs, await fs.readFile(abs, "utf8"), kind, desc, "pro.proof"); } catch { /* optional API */ }
    };
    await recordText(paths.artifact, "proof_artifact", "Proof artifact");
    await recordText(paths.scope_assumptions, "proof_scope", "Proof scope and assumptions");
    await recordText(paths.transcript, "proof_transcript", "Proof backend transcript (redacted)");
    await recordText(paths.result, "proof_result", "Proof result record");
    try { await (store as any).finalize?.({ run_id: runId }); } catch { /* best effort */ }
  } catch {
    // evidence files are still written and referenced by paths
  }

  return baseResult;
}

export async function readPropertyProofResult(root: string, runId: string, proofId: string): Promise<PropertyProofResult> {
  const resultPath = path.join(path.resolve(root), ".lemma", "evidence", runId, "proof", proofId, "result.json");
  return (await readJsonFile<PropertyProofResult>(resultPath)) as PropertyProofResult;
}
