import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { StateError } from "./errors.js";
import { now } from "./determinism.js";
import { CheckStatus } from "./models.js";
import { atomicWriteJson, ensureDir } from "./state.js";

export interface EvidenceEntry {
  path: string;
  kind: string;
  description: string;
  check_id: string;
  bytes: number;
  sha256: string;
  content_type: string;
  created_at: string;
  [key: string]: unknown;
}

export interface EvidenceSummary {
  directory: string;
  count: number;
  by_kind: Record<string, number>;
  total_bytes: number;
  manifest: string;
}

export interface EvidenceManifest {
  schema_version: string;
  run_id: string;
  generated_at: string;
  checkpoint?: boolean;
  run?: Record<string, unknown>;
  evidence: EvidenceEntry[];
  summary: EvidenceSummary;
  manifest_path?: string;
  manifest_sha256?: string;
  signature?: string;
  signature_algorithm?: string;
  signed_at?: string;
  [key: string]: unknown;
}

export interface EvidenceVerification {
  schema_version: string;
  run_id: string;
  checked: number;
  missing: string[];
  mismatches: Array<Record<string, unknown>>;
  signature_valid: boolean;
  signature_error: string;
  tampered: boolean;
  affected: Array<Record<string, unknown>>;
  alert: { level: "error" | "ok"; message: string };
}

export interface ReconcileCheckLike {
  id: string;
  status: string;
  evidence?: readonly string[] | string[];
}

function slug(value: string, fallback = "artifact"): string {
  let v = value.trim().replace(/\\/g, "/");
  v = v.replace(/[^A-Za-z0-9._-]+/g, "-");
  v = v.replace(/^[._-]+|[._-]+$/g, "");
  return v || fallback;
}

export function sha256Bytes(data: Uint8Array | Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return sha256Bytes(data);
}

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".json":
      return "application/json";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".html":
      return "text/html";
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

function ensureSafeRelative(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new StateError(`Refusing to access path outside evidence root: ${target}`, {
      details: { path: target },
    });
  }
  return resolvedTarget;
}

function canonicalManifestPayload(manifest: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(manifest).sort()) {
    if (key === "signature" || key === "signature_algorithm" || key === "signed_at") continue;
    payload[key] = manifest[key];
  }
  return JSON.stringify(payload);
}

function normalizeSigningKey(runId: string, signingKey?: Uint8Array | Buffer | string): Buffer {
  if (signingKey === undefined) {
    return createHash("sha256").update(`quality-harness-evidence:${runId}`, "utf8").digest();
  }
  if (typeof signingKey === "string") {
    try {
      // if it's an existing file path, use its contents; otherwise treat as key material
      const stat = requireSafeSyncRead(signingKey);
      if (stat !== null) return stat;
    } catch {
      // fall through to treat as string key
    }
    return Buffer.from(signingKey, "utf8");
  }
  return Buffer.from(signingKey);
}

function requireSafeSyncRead(filePath: string): Buffer | null {
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return readFileSync(filePath);
    }
  } catch {
    return null;
  }
  return null;
}

export class EvidenceStore {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly manifestPath: string;
  private entries: EvidenceEntry[] = [];
  private finalized = false;
  private readonly signingKey: Buffer;

  constructor(
    root: string,
    runId: string,
    options?: { stateDirName?: string; signingKey?: Uint8Array | Buffer | string },
  ) {
    this.root = path.resolve(root);
    this.runId = runId;
    const dirName = options?.stateDirName ?? ".lemma";
    this.runDir = path.join(this.root, dirName, "evidence", runId);
    this.manifestPath = path.join(this.runDir, "manifest.json");
    this.signingKey = normalizeSigningKey(runId, options?.signingKey);
  }

  async init(): Promise<void> {
    await ensureDir(this.runDir);
    await this.loadExistingManifest();
  }

  private async loadExistingManifest(): Promise<void> {
    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const entries = data.evidence;
      if (Array.isArray(entries)) {
        this.entries = entries.filter((e): e is EvidenceEntry => {
          if (!e || typeof e !== "object") return false;
          const r = e as Record<string, unknown>;
          return typeof r.path === "string" && r.path.length > 0;
        });
      }
    } catch {
      this.entries = [];
    }
  }

  private relative(absPath: string): string {
    const rel = path.relative(this.root, absPath);
    return rel.split(path.sep).join("/");
  }

  private async target(name: string, defaultSuffix = ""): Promise<string> {
    await ensureDir(this.runDir);
    let safe = slug(name);
    if (defaultSuffix && !safe.endsWith(defaultSuffix)) safe += defaultSuffix;
    const candidate = path.join(this.runDir, safe);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    const ext = path.extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    let index = 2;
    for (;;) {
      const alt = path.join(this.runDir, `${stem}-${index}${ext}`);
      try {
        await fs.access(alt);
      } catch {
        return alt;
      }
      index += 1;
    }
  }

  private async record(
    filePath: string,
    kind: string,
    description: string,
    checkId: string,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    const data = await fs.readFile(filePath);
    const relPath = this.relative(filePath);
    const entry: EvidenceEntry = {
      path: relPath,
      kind,
      description,
      check_id: checkId,
      bytes: data.byteLength,
      sha256: sha256Bytes(data),
      content_type: guessContentType(filePath),
      created_at: now(),
      ...(extra ?? {}),
    };
    this.entries = this.entries.filter((e) => e.path !== entry.path);
    this.entries.push(entry);
    return entry.path;
  }

  async saveText(
    name: string,
    text: string,
    kind = "text",
    description = "",
    checkId = "",
    suffix = ".txt",
  ): Promise<string> {
    const filePath = await this.target(name, suffix);
    await fs.writeFile(filePath, text, "utf8");
    return this.record(filePath, kind, description, checkId);
  }

  async saveJson(
    name: string,
    payload: unknown,
    kind = "json",
    description = "",
    checkId = "",
  ): Promise<string> {
    const text = JSON.stringify(payload, null, 2);
    return this.saveText(name, text, kind, description, checkId, ".json");
  }

  async saveBytes(
    name: string,
    data: Uint8Array | Buffer,
    kind = "binary",
    description = "",
    checkId = "",
    suffix = ".bin",
  ): Promise<string> {
    const filePath = await this.target(name, suffix);
    await fs.writeFile(filePath, data);
    return this.record(filePath, kind, description, checkId);
  }

  async saveScreenshot(
    name: string,
    data: Uint8Array | Buffer,
    description = "",
    checkId = "",
  ): Promise<string> {
    let suffix = ".png";
    const b = Buffer.from(data);
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      suffix = ".png";
    } else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      suffix = ".jpg";
    } else if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") {
      suffix = ".webp";
    }
    return this.saveBytes(name, data, "screenshot", description, checkId, suffix);
  }

  async saveConsoleLog(
    entries: unknown[],
    checkId = "",
    name = "console-log",
  ): Promise<string> {
    return this.saveJson(name, entries, "console_log", "Browser console messages and page errors", checkId);
  }

  async saveNetworkLog(
    entries: unknown[],
    checkId = "",
    name = "network-log",
  ): Promise<string> {
    return this.saveJson(name, entries, "network_log", "Browser network requests and responses", checkId);
  }

  summary(): EvidenceSummary {
    const byKind: Record<string, number> = {};
    let totalBytes = 0;
    for (const entry of this.entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      totalBytes += Number(entry.bytes ?? 0);
    }
    return {
      directory: this.relative(this.runDir),
      count: this.entries.length,
      by_kind: byKind,
      total_bytes: totalBytes,
      manifest: this.relative(this.manifestPath),
    };
  }

  getEntries(): EvidenceEntry[] {
    return [...this.entries];
  }

  private signManifest(manifest: EvidenceManifest): EvidenceManifest {
    const base = { ...manifest } as Record<string, unknown>;
    delete base.signature;
    delete base.signature_algorithm;
    delete base.signed_at;
    const signature = createHmac("sha256", this.signingKey).update(canonicalManifestPayload(base)).digest("hex");
    return {
      ...(base as EvidenceManifest),
      signature_algorithm: "HMAC-SHA256",
      signed_at: now(),
      signature,
    };
  }

  private verifySignature(manifest: Record<string, unknown>): boolean {
    const signature = manifest.signature;
    if (typeof signature !== "string" || signature.length === 0) return false;
    const expected = createHmac("sha256", this.signingKey).update(canonicalManifestPayload(manifest)).digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }

  async checkpoint(): Promise<void> {
    if (this.finalized) return;
    await ensureDir(this.runDir);
    const manifest = this.signManifest({
      schema_version: "1.0",
      run_id: this.runId,
      generated_at: now(),
      checkpoint: true,
      evidence: [...this.entries],
      summary: this.summary(),
    });
    await atomicWriteJson(this.manifestPath, manifest);
  }

  private async recoverEntry(relPath: string, checkId: string): Promise<EvidenceEntry | null> {
    try {
      const abs = ensureSafeRelative(this.root, relPath);
      const data = await fs.readFile(abs);
      return {
        path: this.relative(abs),
        kind: "recovered",
        description: "Recovered from the last completed-check checkpoint.",
        check_id: checkId,
        bytes: data.byteLength,
        sha256: sha256Bytes(data),
        content_type: guessContentType(abs),
        created_at: now(),
      };
    } catch {
      return null;
    }
  }

  async reconcile(checks: readonly ReconcileCheckLike[]): Promise<void> {
    await this.init();
    const rerunStatuses = new Set<string>([
      CheckStatus.PLANNED,
      CheckStatus.RUNNING,
      CheckStatus.ERROR,
    ]);
    const rerunIds = new Set(checks.filter((c) => rerunStatuses.has(c.status)).map((c) => c.id));
    this.entries = this.entries.filter((e) => !rerunIds.has(String(e.check_id ?? "")));
    const known = new Set(this.entries.map((e) => e.path));
    for (const check of checks) {
      if (rerunIds.has(check.id)) continue;
      const evidence = check.evidence ?? [];
      for (const p of evidence) {
        if (!p || known.has(p)) continue;
        const recovered = await this.recoverEntry(p, check.id);
        if (recovered) {
          this.entries.push(recovered);
          known.add(recovered.path);
        }
      }
    }
    await this.checkpoint();
  }

  async finalize(runMetadata?: Record<string, unknown>): Promise<EvidenceManifest> {
    if (!this.finalized) {
      await ensureDir(this.runDir);
      const manifest = this.signManifest({
        schema_version: "1.0",
        run_id: this.runId,
        generated_at: now(),
        run: runMetadata ?? {},
        evidence: [...this.entries],
        summary: this.summary(),
      });
      await atomicWriteJson(this.manifestPath, manifest);
      this.finalized = true;
    }
    const raw = await fs.readFile(this.manifestPath, "utf8");
    const manifest = JSON.parse(raw) as EvidenceManifest;
    manifest.manifest_path = this.relative(this.manifestPath);
    manifest.manifest_sha256 = sha256Bytes(raw);
    return manifest;
  }

  async verify(): Promise<EvidenceVerification> {
    let manifest: Record<string, unknown> = {};
    let signatureValid = false;
    let signatureError = "";
    if (await fs
      .access(this.manifestPath)
      .then(() => true)
      .catch(() => false)) {
      try {
        const raw = await fs.readFile(this.manifestPath, "utf8");
        manifest = JSON.parse(raw) as Record<string, unknown>;
        signatureValid = this.verifySignature(manifest);
        if (!signatureValid) {
          signatureError = "manifest signature is missing or invalid";
        }
      } catch (err) {
        signatureError = `manifest is unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      signatureError = "manifest is missing";
    }

    const entriesRaw = manifest.evidence;
    const entries: EvidenceEntry[] = Array.isArray(entriesRaw)
      ? entriesRaw.filter((e): e is EvidenceEntry => !!e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string")
      : [...this.entries];

    let checked = 0;
    const missing: string[] = [];
    const mismatches: Array<Record<string, unknown>> = [];
    const affected: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      if (!entry.path) continue;
      const relPath = entry.path;
      let absPath: string;
      try {
        absPath = ensureSafeRelative(this.root, relPath);
      } catch {
        missing.push(relPath);
        affected.push({ path: relPath, check_id: entry.check_id ?? "", reason: "missing" });
        continue;
      }
      const exists = await fs
        .access(absPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        missing.push(relPath);
        affected.push({ path: relPath, check_id: entry.check_id ?? "", reason: "missing" });
        continue;
      }
      checked += 1;
      const actual = await sha256File(absPath);
      if (actual !== entry.sha256) {
        mismatches.push({
          path: relPath,
          check_id: entry.check_id ?? "",
          expected: entry.sha256,
          actual,
        });
        affected.push({ path: relPath, check_id: entry.check_id ?? "", reason: "hash_mismatch" });
      }
    }

    if (signatureError) {
      affected.push({ path: this.relative(this.manifestPath), check_id: "", reason: "signature_invalid" });
    }

    const tampered = Boolean(signatureError || missing.length > 0 || mismatches.length > 0);
    return {
      schema_version: "1.0",
      run_id: this.runId,
      checked,
      missing,
      mismatches,
      signature_valid: signatureValid,
      signature_error: signatureError,
      tampered,
      affected,
      alert: {
        level: tampered ? "error" : "ok",
        message: tampered
          ? `Evidence tampering detected: ${affected.length} affected artifact(s).`
          : "Evidence verification passed.",
      },
    };
  }
}


export interface VerifyEvidenceResult extends EvidenceVerification {
  command: "verify-evidence";
  run_id: string;
  confidence_cap?: number;
  decision?: "hold";
  status?: "ok" | "error";
  error?: { type: string; message: string };
}

async function resolveVerifyRunId(root: string, runId?: string): Promise<string | null> {
  if (runId && runId.trim()) return runId.trim();

  // Prefer current progress/state run if present.
  try {
    const progressPath = path.join(root, ".lemma", "progress.json");
    const raw = await fs.readFile(progressPath, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === "object" && typeof (data as { run_id?: unknown }).run_id === "string") {
      const id = ((data as { run_id: string }).run_id || "").trim();
      if (id) return id;
    }
  } catch {
    // ignore and fall back
  }

  // Fall back to newest evidence directory.
  try {
    const evidenceRoot = path.join(root, ".lemma", "evidence");
    const entries = await fs.readdir(evidenceRoot, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return dirs.length > 0 ? (dirs[dirs.length - 1] ?? null) : null;
  } catch {
    return null;
  }
}

export async function verifyEvidence(
  root: string,
  runId?: string,
  options?: { signingKey?: string | Buffer },
): Promise<VerifyEvidenceResult> {
  const requestedRunId = typeof runId === "string" ? runId : "";
  const resolved = await resolveVerifyRunId(root, runId);
  if (!resolved) {
    const message = "No run id or evidence directory found.";
    return {
      schema_version: "1.0",
      command: "verify-evidence",
      run_id: requestedRunId,
      status: "error",
      checked: 0,
      missing: [] as string[],
      mismatches: [] as Array<Record<string, unknown>>,
      signature_valid: false,
      signature_error: message,
      tampered: false,
      affected: [] as Array<Record<string, unknown>>,
      alert: { level: "error", message },
      error: { type: "StateError", message },
    };
  }

  const store = new EvidenceStore(root, resolved, options);
  await store.init();
  const result = await store.verify();
  const out: VerifyEvidenceResult = {
    ...result,
    command: "verify-evidence",
    run_id: resolved,
  };
  if (out.tampered) {
    out.confidence_cap = 0.0;
    out.decision = "hold";
  } else {
    out.status = "ok";
  }
  return out;
}
