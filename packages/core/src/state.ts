import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CorruptStateError, HarnessError, StateError } from "./errors.js";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  fsync?: boolean;
  fsyncDir?: boolean;
  /** Test hook: override rename to simulate crash/failure points. */
  renameFn?: (oldPath: string, newPath: string) => Promise<void>;
}

async function fsyncDir(dirPath: string): Promise<void> {
  try {
    const fd = await fs.open(dirPath, constants.O_RDONLY);
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch {
    // Best effort: some platforms/filesystems do not support directory fsync.
  }
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const {
    encoding = "utf8",
    mode = 0o644,
    fsync = true,
    fsyncDir: doFsyncDir = true,
    renameFn,
  } = options;
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const base = path.basename(filePath);
  const tmpName = `.${base}.${process.pid}.${randomUUID()}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  let fd: fs.FileHandle | undefined;
  try {
    fd = await fs.open(tmpPath, "w", mode);
    if (typeof data === "string") {
      await fd.writeFile(data, { encoding });
    } else {
      await fd.writeFile(data);
    }
    if (fsync) {
      await fd.sync();
    }
    await fd.close();
    fd = undefined;

    const doRename = renameFn ?? ((oldPath: string, newPath: string) => fs.rename(oldPath, newPath));
    await doRename(tmpPath, filePath);
    if (doFsyncDir) {
      await fsyncDir(dir);
    }
  } catch (error) {
    try {
      if (fd) await fd.close();
    } catch {
      // ignore
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new StateError(`Atomic write failed for ${filePath}: ${msg}`, { details: { path: filePath } });
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  options?: AtomicWriteOptions & { spaces?: number },
): Promise<void> {
  const spaces = options?.spaces ?? 2;
  const payload = `${JSON.stringify(value, null, spaces)}\n`;
  await atomicWriteFile(filePath, payload, options);
}

export interface ReadJsonOptions<T> {
  /** Optional zod-like parser/guard: (data) => T */
  parse?: (data: unknown) => T;
  /** Error code override context */
  label?: string;
}

export async function readJsonFile<T = unknown>(
  filePath: string,
  options: ReadJsonOptions<T> = {},
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") {
      throw new StateError(`State file not found: ${filePath}`, { details: { path: filePath, reason: "ENOENT" } });
    }
    const msg = err instanceof Error ? err.message : String(error);
    throw new StateError(`Failed to read state file ${filePath}: ${msg}`, { details: { path: filePath } });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Preserve corrupt file on disk; callers keep last good state by not overwriting.
    throw new CorruptStateError(`Corrupt JSON in ${filePath}: ${msg}`, { path: filePath });
  }

  if (options.parse) {
    try {
      return options.parse(data);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new StateError(`Invalid state data in ${filePath}: ${msg}`, { details: { path: filePath } });
    }
  }
  return data as T;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  lockPath?: string;
}

interface LockRecord {
  pid: number;
  token: string;
  createdAt: number;
  hostname: string;
}

function defaultLockPath(targetPath: string): string {
  return `${targetPath}.lock`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means process exists but we may not signal it; treat as alive.
    if (code === "EPERM") return true;
    // On some platforms/errors, be conservative.
    return true;
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const data = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof data.pid === "number" && typeof data.token === "string" && typeof data.createdAt === "number") {
      return {
        pid: data.pid,
        token: data.token,
        createdAt: data.createdAt,
        hostname: typeof data.hostname === "string" ? data.hostname : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
  const rec = await readLockRecord(lockPath);
  if (!rec) {
    // unreadable/corrupt lock file: treat as stale if old enough
    try {
      const st = await fs.stat(lockPath);
      return Date.now() - st.mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
  const age = Date.now() - rec.createdAt;
  const sameHost = !rec.hostname || rec.hostname === os.hostname();
  if (sameHost && !isProcessAlive(rec.pid)) return true;
  if (age > staleMs) return true;
  return false;
}

export interface FileLockHandle {
  lockPath: string;
  token: string;
  release: () => Promise<void>;
}

export async function acquireFileLock(
  targetPath: string,
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  const lockPath = options.lockPath ?? defaultLockPath(targetPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  await ensureDir(path.dirname(lockPath));

  while (true) {
    const record: LockRecord = {
      pid: process.pid,
      token,
      createdAt: Date.now(),
      hostname: os.hostname(),
    };
    try {
      const fd = await fs.open(lockPath, "wx");
      try {
        await fd.writeFile(JSON.stringify(record), "utf8");
        await fd.sync();
      } finally {
        await fd.close();
      }
      // acquired
      const handle: FileLockHandle = {
        lockPath,
        token,
        release: async () => {
          try {
            const current = await readLockRecord(lockPath);
            if (current && current.token !== token) return; // lost ownership
            await fs.unlink(lockPath);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              // best effort
            }
          }
        },
      };
      return handle;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StateError(`Failed to acquire lock ${lockPath}: ${msg}`, { details: { path: lockPath } });
      }
      // lock exists: try stale recovery
      if (await isLockStale(lockPath, staleMs)) {
        try {
          // attempt to break stale lock; if another process wins, loop retries
          await fs.unlink(lockPath);
        } catch (unlinkErr) {
          const ucode = (unlinkErr as NodeJS.ErrnoException).code;
          if (ucode !== "ENOENT") {
            // cannot break; fall through to wait
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new StateError(`Timed out acquiring lock ${lockPath}`, {
          details: { path: lockPath, timeoutMs },
        });
      }
      await sleep(pollMs);
    }
  }
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T> | T,
  options?: FileLockOptions,
): Promise<T> {
  const lock = await acquireFileLock(targetPath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function killFilePath(rootDir: string): string {
  return path.join(rootDir, "KILL");
}

export async function writeKillFile(rootDir: string, reason = "killed"): Promise<string> {
  const p = killFilePath(rootDir);
  await ensureDir(path.dirname(p));
  // kill file is a simple signal file; atomic write avoids partial reads
  await atomicWriteFile(p, `${reason}\n`);
  return p;
}

export async function readKillFile(rootDir: string): Promise<string | null> {
  const p = killFilePath(rootDir);
  try {
    const raw = await fs.readFile(p, "utf8");
    return raw.trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new StateError(`Failed to read kill file ${p}: ${msg}`, { details: { path: p } });
  }
}

export async function clearKillFile(rootDir: string): Promise<void> {
  const p = killFilePath(rootDir);
  try {
    await fs.unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new StateError(`Failed to clear kill file ${p}: ${msg}`, { details: { path: p } });
    }
  }
}

// Synchronous helper for simple existence checks in polling loops (non-blocking IO semantics not required)
export function killFileExistsSync(rootDir: string): boolean {
  try {
    fsSync.accessSync(killFilePath(rootDir));
    return true;
  } catch {
    return false;
  }
}
