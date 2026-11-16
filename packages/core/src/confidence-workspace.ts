import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { StateError } from "./errors.js";
import { atomicWriteFile, atomicWriteJson, ensureDir, readJsonFile } from "./state.js";
import { redactText, redactUnknown } from "./redaction.js";

export const CONFIDENCE_WORKSPACE_DIR = ".confidence" as const;
export const CONFIDENCE_SUBDIRS = ["risks", "claims", "evals", "traces", "decisions", "reviews"] as const;
export type ConfidenceSubdir = (typeof CONFIDENCE_SUBDIRS)[number];
export const CONFIDENCE_WORKSPACE_MANIFEST = "workspace.manifest.json" as const;

export interface ConfidenceWorkspaceArtifact {
  id: string;
  path: string; // relative to workspace root (.confidence/...)
  subdir: ConfidenceSubdir;
  fingerprint: string;
  size: number;
}

export interface ConfidenceWorkspaceManifest {
  schema_version: "lemma.confidence.workspace/v1";
  workspace: ".confidence";
  generated_at: string;
  artifacts: ConfidenceWorkspaceArtifact[];
}

export interface InitConfidenceWorkspaceParams {
  root?: string;
  force?: boolean;
  generatedAt?: string;
}

export interface InitConfidenceWorkspaceResult {
  root: string;
  workspace_path: string;
  created: boolean;
  overwritten: boolean;
  manifest_path: string;
  manifest: ConfidenceWorkspaceManifest;
}

function workspaceAbs(root: string): string {
  return path.join(root, CONFIDENCE_WORKSPACE_DIR);
}

function isSubdir(name: string): name is ConfidenceSubdir {
  return (CONFIDENCE_SUBDIRS as readonly string[]).includes(name);
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

export function confidenceWorkspacePaths(root = process.cwd()): { root: string; workspace: string; manifest: string } {
  const absRoot = path.resolve(root);
  const ws = workspaceAbs(absRoot);
  return { root: absRoot, workspace: ws, manifest: path.join(ws, CONFIDENCE_WORKSPACE_MANIFEST) };
}

function toPosixRel(wsAbs: string, absPath: string): string {
  const rel = path.relative(wsAbs, absPath);
  return rel.split(path.sep).join("/");
}

function artifactId(relPath: string): string {
  // stable id derived from relative path
  return "cw-" + sha256(relPath).slice(0, 16);
}

function normalizeGeneratedAt(generatedAt?: string): string {
  return typeof generatedAt === "string" && generatedAt ? generatedAt : new Date(0).toISOString();
}

export async function regenerateConfidenceManifest(params: { root?: string; generatedAt?: string } = {}): Promise<ConfidenceWorkspaceManifest> {
  const { workspace, manifest } = confidenceWorkspacePaths(params.root);
  if (!(await isDir(workspace))) {
    throw new StateError(`Confidence workspace not found: ${workspace}`);
  }
  const artifacts: ConfidenceWorkspaceArtifact[] = [];
  for (const subdir of CONFIDENCE_SUBDIRS) {
    const dir = path.join(workspace, subdir);
    await ensureDir(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (ent.name === ".DS_Store") continue;
      const abs = path.join(dir, ent.name);
      const rel = toPosixRel(workspace, abs); // e.g. risks/foo.json
      const content = await fs.readFile(abs);
      artifacts.push({
        id: artifactId(rel),
        path: path.posix.join(CONFIDENCE_WORKSPACE_DIR, rel),
        subdir,
        fingerprint: "sha256:" + sha256(content),
        size: content.byteLength,
      });
    }
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const manifestObj: ConfidenceWorkspaceManifest = {
    schema_version: "lemma.confidence.workspace/v1",
    workspace: ".confidence",
    generated_at: normalizeGeneratedAt(params.generatedAt),
    artifacts,
  };
  // regenerate atomically; never partially written
  await atomicWriteJson(manifest, manifestObj);
  return manifestObj;
}

export async function initConfidenceWorkspace(params: InitConfidenceWorkspaceParams = {}): Promise<InitConfidenceWorkspaceResult> {
  const root = path.resolve(params.root ?? process.cwd());
  const ws = workspaceAbs(root);
  const existed = await exists(ws);

  if (existed && !params.force) {
    throw new StateError(`Confidence workspace already exists at ${ws}; refusing to overwrite without --force`);
  }

  let overwritten = false;
  if (existed && params.force) {
    // overwrite existing workspace contents safely (recreate structure)
    overwritten = true;
    await fs.rm(ws, { recursive: true, force: true });
  }

  await ensureDir(ws);
  for (const subdir of CONFIDENCE_SUBDIRS) {
    await ensureDir(path.join(ws, subdir));
  }

  // create/readme marker (documented)
  const readmePath = path.join(ws, "README.md");
  const readme = `# .confidence workspace\n\nVersioned, atomic, redacted, resumable workspace for AI-system confidence artifacts.\n\nSubdirectories:\n- risks/\n- claims/\n- evals/\n- traces/\n- decisions/\n- reviews/\n`;
  await atomicWriteFile(readmePath, readme, { encoding: "utf8" });

  const manifest = await regenerateConfidenceManifest({ root, generatedAt: params.generatedAt ?? new Date(0).toISOString() });
  return {
    root,
    workspace_path: ws,
    created: !existed,
    overwritten,
    manifest_path: path.join(ws, CONFIDENCE_WORKSPACE_MANIFEST),
    manifest,
  };
}

export async function readConfidenceJson<T = unknown>(params: { root?: string; subdir: ConfidenceSubdir; name: string }): Promise<T> {
  const { workspace } = confidenceWorkspacePaths(params.root);
  if (!isSubdir(params.subdir)) throw new StateError(`Invalid confidence workspace subdir: ${String(params.subdir)}`);
  const filePath = path.join(workspace, params.subdir, params.name);
  // all reads go through core/state JSON read primitive; corrupt -> CorruptStateError (StateError subclass)
  return await readJsonFile<T>(filePath);
}

export async function writeConfidenceJson(params: { root?: string; subdir: ConfidenceSubdir; name: string; value: unknown; generatedAt?: string }): Promise<{ path: string; manifest: ConfidenceWorkspaceManifest }> {
  const root = path.resolve(params.root ?? process.cwd());
  const ws = workspaceAbs(root);
  if (!(await isDir(ws))) throw new StateError(`Confidence workspace not found: ${ws}`);
  if (!isSubdir(params.subdir)) throw new StateError(`Invalid confidence workspace subdir: ${String(params.subdir)}`);
  const filePath = path.join(ws, params.subdir, params.name);
  // redaction applied before persistence across every subdirectory
  const redacted = redactConfidenceValue(params.value);
  await atomicWriteJson(filePath, redacted);
  const manifest = await regenerateConfidenceManifest({ root, generatedAt: params.generatedAt ?? new Date(0).toISOString() });
  return { path: filePath, manifest };
}

export async function writeConfidenceText(params: { root?: string; subdir: ConfidenceSubdir; name: string; text: string; generatedAt?: string }): Promise<{ path: string; manifest: ConfidenceWorkspaceManifest }> {
  const root = path.resolve(params.root ?? process.cwd());
  const ws = workspaceAbs(root);
  if (!(await isDir(ws))) throw new StateError(`Confidence workspace not found: ${ws}`);
  if (!isSubdir(params.subdir)) throw new StateError(`Invalid confidence workspace subdir: ${String(params.subdir)}`);
  const filePath = path.join(ws, params.subdir, params.name);
  const redacted = redactText(String(params.text ?? ""));
  await atomicWriteFile(filePath, redacted, { encoding: "utf8" });
  const manifest = await regenerateConfidenceManifest({ root, generatedAt: params.generatedAt ?? new Date(0).toISOString() });
  return { path: filePath, manifest };
}

function redactConfidenceValue(value: unknown): unknown {
  // deep redaction via core redaction; also ensure common secret-shaped strings stripped
  const redacted = redactUnknown(value);
  const json = JSON.stringify(redacted);
  const stripped = redactText(json);
  try { return JSON.parse(stripped); } catch { return stripped; }
}
