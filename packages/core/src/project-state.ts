import path from "node:path";
import { promises as fs } from "node:fs";

import { CorruptStateError, StateError } from "./errors.js";
import { atomicWriteJson, ensureDir, readJsonFile } from "./state.js";

/**
 * Documented durable `.lemma/` layout (LEM-195).
 * Directories are created/read/pruned via shared state primitives.
 */
export const PROJECT_STATE_DIRECTORIES = [
  "state",
  "evidence",
  "framework",
  "learning",
  "recordings",
  "tests",
  "auto",
  "continuous",
  "regressions",
  "humans",
  "confidence",
  "incidents",
] as const;

export const PROJECT_STATE_FILES = ["events.jsonl", "history.json"] as const;

export type ProjectStateDirectory = (typeof PROJECT_STATE_DIRECTORIES)[number];
export type ProjectStateFile = (typeof PROJECT_STATE_FILES)[number];

export interface ProjectStateOptions {
  root?: string;
  stateDirName?: string;
}

export interface ProjectStateValidationIssue {
  path: string;
  kind: "missing_directory" | "missing_file" | "corrupt_directory" | "corrupt_file" | "invalid_type";
  message: string;
}

export interface ProjectStateValidationResult {
  ok: boolean;
  root: string;
  state_dir: string;
  issues: ProjectStateValidationIssue[];
}

export interface ProjectStatePruneOptions {
  /** Retention for JSON entries in selected directories; invalid/corrupt entries are preserved and reported, never deleted. */
  retention?: number;
  /** Directories to prune (must be layout directories). Defaults to ["continuous", "regressions"] when present. */
  directories?: ProjectStateDirectory[];
}

export interface ProjectStatePruneResult {
  pruned: string[];
  preserved_corrupt: string[];
  details: Record<string, { kept: number; pruned: number; preserved_corrupt: number }>;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function statSafe(p: string): Promise<import("node:fs").Stats | null> {
  try { return await fs.stat(p); } catch { return null; }
}

async function isReadableDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isDirectory()) return false;
    await fs.readdir(p);
    return true;
  } catch {
    return false;
  }
}

function toCorruptIssue(targetPath: string, kind: "directory" | "file", cause: unknown): ProjectStateValidationIssue {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (kind === "directory") {
    return { path: targetPath, kind: "corrupt_directory", message: `Corrupt/unreadable directory: ${message}` };
  }
  return { path: targetPath, kind: "corrupt_file", message: `Corrupt/unreadable file: ${message}` };
}

/**
 * ProjectState manages the durable `.lemma/` layout using shared state primitives
 * (`ensureDir`, `atomicWriteJson`, `readJsonFile`, etc.). No package-local FS
 * write primitives are reimplemented here.
 */
export class ProjectState {
  readonly root: string;
  readonly stateDirName: string;
  readonly stateDir: string;

  constructor(options: ProjectStateOptions = {}) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.stateDirName = options.stateDirName ?? ".lemma";
    this.stateDir = path.join(this.root, this.stateDirName);
  }

  resolve(...segments: string[]): string {
    return path.join(this.stateDir, ...segments);
  }

  directoryPath(name: ProjectStateDirectory): string {
    return this.resolve(name);
  }

  filePath(name: ProjectStateFile): string {
    return this.resolve(name);
  }

  /** Creates documented layout directories/files (idempotent) using shared primitives. */
  async ensureLayout(): Promise<{ created: string[]; existing: string[] }> {
    await ensureDir(this.stateDir);
    const created: string[] = [];
    const existing: string[] = [];

    for (const name of PROJECT_STATE_DIRECTORIES) {
      const p = this.directoryPath(name);
      const st = await statSafe(p);
      if (!st) {
        await ensureDir(p);
        created.push(p);
      } else if (!st.isDirectory()) {
        throw new StateError(`Project state path exists but is not a directory: ${p}`, { code: "state_error", details: { path: p, expected: "directory" } });
      } else {
        existing.push(p);
      }
    }

    for (const name of PROJECT_STATE_FILES) {
      const p = this.filePath(name);
      const st = await statSafe(p);
      if (!st) {
        if (name === "history.json") {
          await atomicWriteJson(p, { schema_version: "lemma.history/v1", runs: [] });
        } else if (name.endsWith(".json")) {
          await atomicWriteJson(p, {});
        } else {
          await fs.writeFile(p, "", "utf8"); // events.jsonl initialized empty; append-only managed elsewhere
        }
        created.push(p);
      } else if (!st.isFile()) {
        throw new StateError(`Project state path exists but is not a file: ${p}`, { code: "state_error", details: { path: p, expected: "file" } });
      } else {
        existing.push(p);
      }
    }

    return { created, existing };
  }

  async list(): Promise<{ directories: Array<{ name: ProjectStateDirectory; path: string; exists: boolean }>; files: Array<{ name: ProjectStateFile; path: string; exists: boolean }> }> {
    const directories = await Promise.all(PROJECT_STATE_DIRECTORIES.map(async (name) => {
      const p = this.directoryPath(name);
      return { name, path: p, exists: await pathExists(p) };
    }));
    const files = await Promise.all(PROJECT_STATE_FILES.map(async (name) => {
      const p = this.filePath(name);
      return { name, path: p, exists: await pathExists(p) };
    }));
    return { directories, files };
  }

  async readJson<T = unknown>(relativePath: string): Promise<T> {
    return readJsonFile<T>(this.resolve(relativePath));
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await atomicWriteJson(this.resolve(relativePath), value);
  }

  /**
   * Validates documented layout. Reports missing/corrupt directories/files as typed
   * issues. Corrupted state is preserved for inspection and never modified/deleted.
   */
  async validateLayout(): Promise<ProjectStateValidationResult> {
    const issues: ProjectStateValidationIssue[] = [];

    const stateSt = await statSafe(this.stateDir);
    if (!stateSt) {
      issues.push({ path: this.stateDir, kind: "missing_directory", message: "State directory is missing" });
    } else if (!stateSt.isDirectory()) {
      issues.push({ path: this.stateDir, kind: "invalid_type", message: "State path exists but is not a directory" });
    }

    for (const name of PROJECT_STATE_DIRECTORIES) {
      const p = this.directoryPath(name);
      const st = await statSafe(p);
      if (!st) {
        issues.push({ path: p, kind: "missing_directory", message: `Missing directory: ${name}/` });
        continue;
      }
      if (!st.isDirectory()) {
        issues.push({ path: p, kind: "invalid_type", message: `Expected directory but found non-directory: ${name}/` });
        continue;
      }
      if (!(await isReadableDir(p))) {
        try { await fs.readdir(p); } catch (e) { issues.push(toCorruptIssue(p, "directory", e)); }
      }
    }

    for (const name of PROJECT_STATE_FILES) {
      const p = this.filePath(name);
      const st = await statSafe(p);
      if (!st) {
        issues.push({ path: p, kind: "missing_file", message: `Missing file: ${name}` });
        continue;
      }
      if (!st.isFile()) {
        issues.push({ path: p, kind: "invalid_type", message: `Expected file but found non-file: ${name}` });
        continue;
      }
      try {
        if (name.endsWith(".json")) {
          await readJsonFile(p);
        } else {
          await fs.readFile(p, "utf8");
        }
      } catch (e) {
        if (e instanceof CorruptStateError || e instanceof StateError) issues.push(toCorruptIssue(p, "file", e));
        else issues.push(toCorruptIssue(p, "file", e));
      }
    }

    return { ok: issues.length === 0, root: this.root, state_dir: this.stateDir, issues };
  }

  /**
   * Prunes layout-managed history entries using retention where applicable.
   * Corrupt/unreadable entries are preserved for inspection and never deleted.
   */
  async prune(options: ProjectStatePruneOptions = {}): Promise<ProjectStatePruneResult> {
    const retention = Math.max(1, Math.floor(Number(options.retention ?? 50) || 50));
    const dirs = options.directories ?? (PROJECT_STATE_DIRECTORIES.filter((d) => d === "continuous" || d === "regressions") as ProjectStateDirectory[]);
    const pruned: string[] = [];
    const preserved_corrupt: string[] = [];
    const details: ProjectStatePruneResult["details"] = {};

    for (const dirName of dirs) {
      const dirPath = this.directoryPath(dirName);
      let kept = 0, removed = 0, preserved = 0;
      if (!(await isReadableDir(dirPath))) {
        if (await pathExists(dirPath)) preserved_corrupt.push(dirPath);
        details[dirName] = { kept: 0, pruned: 0, preserved_corrupt: (await pathExists(dirPath)) ? 1 : 0 };
        continue;
      }
      // Conservative prune: only prune .json history-like files directly inside known history subdirs for continuous; for others keep simple.
      if (dirName === "continuous") {
        const triggers = ["pr", "nightly", "scheduled"];
        for (const t of triggers) {
          const hdir = path.join(dirPath, t, "history");
          if (!(await isReadableDir(hdir))) continue;
          const entries = await fs.readdir(hdir);
          const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
          // validate/read to detect corrupt; corrupt preserved
          const valid: string[] = [];
          for (const f of jsonFiles) {
            const fp = path.join(hdir, f);
            try { await readJsonFile(fp); valid.push(f); } catch { preserved++; preserved_corrupt.push(fp); }
          }
          if (valid.length > retention) {
            const toDelete = valid.slice(0, valid.length - retention);
            for (const f of toDelete) { await fs.unlink(path.join(hdir, f)); removed++; pruned.push(path.join(hdir, f)); }
            kept += valid.length - toDelete.length;
          } else {
            kept += valid.length;
          }
        }
      } else {
        // generic: do not guess retention targets outside documented continuous history; preserve everything
        kept = 0;
      }
      details[dirName] = { kept, pruned: removed, preserved_corrupt: preserved };
    }

    return { pruned, preserved_corrupt, details };
  }

  /**
   * Doctor-equivalent validation: throws typed StateError on any missing/corrupt layout issue.
   * Corrupted state remains on disk for inspection.
   */
  async assertHealthy(): Promise<ProjectStateValidationResult> {
    const result = await this.validateLayout();
    if (!result.ok) {
      const corrupt = result.issues.filter((i) => i.kind.startsWith("corrupt"));
      const code = corrupt.length ? "state_corrupt" : "state_error";
      throw new StateError(`Project state layout invalid (${result.issues.length} issue(s))`, { code, details: { issues: result.issues, root: result.root, state_dir: result.state_dir } });
    }
    return result;
  }
}

export function createProjectState(options: ProjectStateOptions = {}): ProjectState {
  return new ProjectState(options);
}
