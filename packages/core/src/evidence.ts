import { createHash } from "node:crypto";
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
  [key: string]: unknown;
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

export class EvidenceStore {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly manifestPath: string;
  private entries: EvidenceEntry[] = [];
  private finalized = false;

  constructor(root: string, runId: string, options?: { stateDirName?: string }) {
    this.root = path.resolve(root);
    this.runId = runId;
    const dirName = options?.stateDirName ?? ".lemma";
    this.runDir = path.join(this.root, dirName, "evidence", runId);
    this.manifestPath = path.join(this.runDir, "manifest.json");
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

  async checkpoint(): Promise<void> {
    if (this.finalized) return;
    await ensureDir(this.runDir);
    const manifest: EvidenceManifest = {
      schema_version: "1.0",
      run_id: this.runId,
      generated_at: now(),
      checkpoint: true,
      evidence: [...this.entries],
      summary: this.summary(),
    };
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
      const manifest: EvidenceManifest = {
        schema_version: "1.0",
        run_id: this.runId,
        generated_at: now(),
        run: runMetadata ?? {},
        evidence: [...this.entries],
        summary: this.summary(),
      };
      await atomicWriteJson(this.manifestPath, manifest);
      this.finalized = true;
    }
    const raw = await fs.readFile(this.manifestPath, "utf8");
    const manifest = JSON.parse(raw) as EvidenceManifest;
    manifest.manifest_path = this.relative(this.manifestPath);
    manifest.manifest_sha256 = sha256Bytes(raw);
    return manifest;
  }
}
