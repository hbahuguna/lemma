import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const QUEUE_SCHEMA_VERSION = "quality-harness.queue/v1" as const;
export const DEFAULT_QUEUE_PATH = path.join(".lemma", "cloud", "queue.json");
export const DEFAULT_TENANT_ROOT = path.join(".lemma", "tenants");
export const DEFAULT_QUEUE_LOCK = path.join(".lemma", "cloud", "queue.lock");

export const STATUS_QUEUED = "queued" as const;
export const STATUS_RUNNING = "running" as const;
export const STATUS_COMPLETED = "completed" as const;
export const STATUS_FAILED = "failed" as const;
export const STATUS_CANCELLED = "cancelled" as const;

export type QueueStatus =
  | typeof STATUS_QUEUED
  | typeof STATUS_RUNNING
  | typeof STATUS_COMPLETED
  | typeof STATUS_FAILED
  | typeof STATUS_CANCELLED;

export const TERMINAL_STATUSES = new Set<QueueStatus>([
  STATUS_COMPLETED,
  STATUS_FAILED,
  STATUS_CANCELLED,
]);

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface QueueJob {
  schema_version: typeof QUEUE_SCHEMA_VERSION;
  job_id: string;
  workspace_id: string;
  root: string;
  target: string;
  status: QueueStatus;
  attempt: number;
  max_attempts: number;
  options: Record<string, unknown>;
  run_id: string | null;
  created_at: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  cancel_requested: boolean;
  cancel_reason: string;
  error: string;
  report_path: string | null;
  evidence_dir: string | null;
  findings: number;
  confidence: number | null;
  status_detail: string;
}

export interface PublicQueueJob {
  schema_version: typeof QUEUE_SCHEMA_VERSION;
  job_id: string;
  workspace_id: string;
  status: QueueStatus;
  attempt: number;
  run_id: string | null;
  target: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  cancel_requested: boolean;
  error: string;
  report_path: string | null;
  evidence_dir: string | null;
  findings: number;
  confidence: number | null;
  status_detail: string;
}

export interface JobQueueOptions {
  queuePath?: string;
  queue_path?: string;
  tenantRoot?: string;
  tenant_root?: string;
  lockPath?: string;
  lock_path?: string;
  maxAttempts?: number;
  max_attempts?: number;
  staleAfterSeconds?: number;
  stale_after_seconds?: number;
  personasDir?: string;
  personas_dir?: string;
  /** Injectable executor for deterministic tests/integration. */
  executor?: (job: QueueJob, queue: JobQueue) => Partial<QueueJob> | Promise<Partial<QueueJob>>;
}

function utcNow(): string {
  return new Date().toISOString();
}

function safeText(value: unknown, limit = 500): string {
  return String(value ?? "").trim().slice(0, limit);
}

function safeWorkspace(value: unknown): string {
  const text = safeText(value, 128);
  if (!WORKSPACE_RE.test(text)) {
    throw new Error(`Invalid workspace id: ${String(value)}`);
  }
  return text;
}

function chmodSafe(p: string, mode: number): void {
  try {
    fs.chmodSync(p, mode);
  } catch {
    /* ignore */
  }
}

function atomicWrite(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chmodSafe(dir, 0o700);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeSync(fd, text, undefined, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    chmodSafe(tmp, 0o600);
    fs.renameSync(tmp, filePath);
    chmodSafe(filePath, 0o600);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JobQueue {
  readonly root: string;
  readonly queuePath: string;
  readonly tenantRoot: string;
  readonly lockPath: string;
  readonly maxAttempts: number;
  readonly staleAfterSeconds: number;
  readonly personasDir?: string;
  readonly executor?: (job: QueueJob, queue: JobQueue) => Partial<QueueJob> | Promise<Partial<QueueJob>>;

  constructor(root: string, opts: JobQueueOptions = {}) {
    this.root = path.resolve(root);
    this.queuePath = this.resolvePath(opts.queuePath ?? opts.queue_path ?? DEFAULT_QUEUE_PATH);
    this.tenantRoot = this.resolvePath(opts.tenantRoot ?? opts.tenant_root ?? DEFAULT_TENANT_ROOT);
    this.lockPath = this.resolvePath(opts.lockPath ?? opts.lock_path ?? DEFAULT_QUEUE_LOCK);
    this.maxAttempts = Math.max(1, Number(opts.maxAttempts ?? opts.max_attempts ?? 3));
    this.staleAfterSeconds = Math.max(1, Number(opts.staleAfterSeconds ?? opts.stale_after_seconds ?? 300));
    const personas = opts.personasDir ?? opts.personas_dir;
    if (personas) this.personasDir = path.resolve(personas);
    if (opts.executor) this.executor = opts.executor;
  }

  private resolvePath(value: string): string {
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.root, value);
  }

  private empty(): { schema_version: typeof QUEUE_SCHEMA_VERSION; jobs: Record<string, QueueJob> } {
    return { schema_version: QUEUE_SCHEMA_VERSION, jobs: {} };
  }

  private load(): { schema_version: typeof QUEUE_SCHEMA_VERSION; jobs: Record<string, QueueJob> } {
    if (!fs.existsSync(this.queuePath)) return this.empty();
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.queuePath, "utf8"));
    } catch (err) {
      throw new Error(`Run queue is unreadable: ${String(err)}`);
    }
    if (!isRecord(data)) throw new Error("Run queue must contain a JSON object.");
    if (data.schema_version !== QUEUE_SCHEMA_VERSION) {
      throw new Error("Unsupported run queue schema version.");
    }
    const jobsRaw = data.jobs;
    const jobs: Record<string, QueueJob> = {};
    if (isRecord(jobsRaw)) {
      for (const [id, job] of Object.entries(jobsRaw)) {
        if (isRecord(job)) jobs[id] = job as unknown as QueueJob;
      }
    }
    return { schema_version: QUEUE_SCHEMA_VERSION, jobs };
  }

  private save(data: { schema_version: typeof QUEUE_SCHEMA_VERSION; jobs: Record<string, QueueJob> }): void {
    atomicWrite(this.queuePath, JSON.stringify(data, null, 2) + "\n");
  }

  tenantRootFor(workspaceId: string): string {
    return path.join(this.tenantRoot, safeWorkspace(workspaceId));
  }

  private publicJob(job: QueueJob): PublicQueueJob {
    return {
      schema_version: QUEUE_SCHEMA_VERSION,
      job_id: job.job_id,
      workspace_id: job.workspace_id,
      status: job.status,
      attempt: job.attempt,
      run_id: job.run_id ?? null,
      target: job.target,
      created_at: job.created_at,
      started_at: job.started_at ?? null,
      completed_at: job.completed_at ?? null,
      duration_seconds: job.duration_seconds ?? null,
      cancel_requested: Boolean(job.cancel_requested),
      error: job.error ?? "",
      report_path: job.report_path ?? null,
      evidence_dir: job.evidence_dir ?? null,
      findings: Number(job.findings ?? 0),
      confidence: job.confidence ?? null,
      status_detail: job.status_detail ?? "",
    };
  }

  submit(
    workspaceId: string,
    target: string,
    opts: {
      options?: Record<string, unknown>;
      source?: string;
      intent?: string;
      workspace?: string;
      metering_sink?: string;
      meteringSink?: string;
    } = {},
  ): PublicQueueJob {
    const workspaceKey = safeWorkspace(workspaceId);
    const targetText = safeText(target, 4000);
    if (!targetText) throw new Error("A run target is required.");
    const optionData: Record<string, unknown> = { ...(opts.options ?? {}) };
    optionData.target = optionData.target ?? targetText;
    if (opts.source !== undefined) optionData.source = opts.source;
    if (opts.intent !== undefined) optionData.intent = opts.intent;
    optionData.workspace = optionData.workspace ?? opts.workspace ?? workspaceKey;
    if (this.personasDir) optionData.personas_dir = optionData.personas_dir ?? this.personasDir;
    optionData.no_browser = optionData.no_browser ?? true;
    optionData.metering_sink =
      optionData.metering_sink ?? opts.metering_sink ?? opts.meteringSink ?? ".lemma/metering/events.jsonl";

    const jobId = `job-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const ts = utcNow();
    const job: QueueJob = {
      schema_version: QUEUE_SCHEMA_VERSION,
      job_id: jobId,
      workspace_id: workspaceKey,
      root: this.tenantRootFor(workspaceKey),
      target: targetText,
      status: STATUS_QUEUED,
      attempt: 0,
      max_attempts: this.maxAttempts,
      options: optionData,
      run_id: null,
      created_at: ts,
      queued_at: ts,
      started_at: null,
      completed_at: null,
      duration_seconds: null,
      cancel_requested: false,
      cancel_reason: "",
      error: "",
      report_path: null,
      evidence_dir: null,
      findings: 0,
      confidence: null,
      status_detail: "queued",
    };
    const data = this.load();
    data.jobs[jobId] = job;
    this.save(data);
    return this.publicJob(job);
  }

  private getOwnedJob(data: { jobs: Record<string, QueueJob> }, workspaceId: string, jobId: string): QueueJob | null {
    const workspaceKey = safeWorkspace(workspaceId);
    const job = data.jobs[String(jobId)];
    if (!job) return null;
    if (job.workspace_id !== workspaceKey) return null;
    return job;
  }

  getJob(workspaceId: string, jobId: string): PublicQueueJob | null {
    const data = this.load();
    const job = this.getOwnedJob(data, workspaceId, jobId);
    return job ? this.publicJob(job) : null;
  }

  listJobs(workspaceId: string): PublicQueueJob[] {
    const workspaceKey = safeWorkspace(workspaceId);
    const data = this.load();
    const jobs = Object.values(data.jobs)
      .filter((job) => job.workspace_id === workspaceKey)
      .map((job) => this.publicJob(job));
    jobs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return jobs;
  }

  cancel(workspaceId: string, jobId: string, reason = "operator cancelled"): PublicQueueJob {
    const workspaceKey = safeWorkspace(workspaceId);
    const data = this.load();
    const job = this.getOwnedJob(data, workspaceKey, jobId);
    if (!job) throw new Error("Job not found.");
    if (TERMINAL_STATUSES.has(job.status)) {
      return this.publicJob(job);
    }
    job.cancel_requested = true;
    job.cancel_reason = safeText(reason, 500);
    if (job.status === STATUS_QUEUED) {
      job.status = STATUS_CANCELLED;
      job.completed_at = utcNow();
      job.status_detail = "cancelled before execution";
    } else {
      job.status_detail = "cancellation requested";
      const killPath = path.join(job.root, ".lemma", "KILL");
      fs.mkdirSync(path.dirname(killPath), { recursive: true });
      chmodSafe(path.dirname(killPath), 0o700);
      const payload = JSON.stringify({ reason: job.cancel_reason, requested_at: utcNow() }) + "\n";
      fs.writeFileSync(killPath, payload, { encoding: "utf8", mode: 0o600 });
      chmodSafe(killPath, 0o600);
    }
    this.save(data);
    return this.publicJob(job);
  }

  recover(): PublicQueueJob[] {
    const data = this.load();
    const recovered: PublicQueueJob[] = [];
    for (const job of Object.values(data.jobs)) {
      if (job.status === STATUS_RUNNING) {
        job.status = STATUS_QUEUED;
        job.status_detail = "recovered after worker crash";
        job.started_at = null;
        job.queued_at = utcNow();
        job.cancel_requested = false;
        job.cancel_reason = "";
        recovered.push(this.publicJob(job));
      }
    }
    if (recovered.length) this.save(data);
    return recovered;
  }

  recoverStale(_now?: unknown): PublicQueueJob[] {
    // Simple local worker semantics: any running job is considered stale/recoverable.
    return this.recover();
  }

  claimNext(): QueueJob | null {
    const data = this.load();
    const queued = Object.values(data.jobs).filter((j) => j.status === STATUS_QUEUED);
    if (!queued.length) return null;
    queued.sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
    const job = queued[0]!;
    job.status = STATUS_RUNNING;
    job.attempt = Number(job.attempt ?? 0) + 1;
    job.started_at = utcNow();
    job.status_detail = "running";
    this.save(data);
    return { ...job, options: { ...(job.options ?? {}) } };
  }

  private finish(jobId: string, status: QueueStatus, updates: Partial<QueueJob> = {}): PublicQueueJob {
    const data = this.load();
    const job = data.jobs[jobId];
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.status = status;
    job.completed_at = utcNow();
    const keys: Array<keyof QueueJob> = [
      "run_id",
      "findings",
      "confidence",
      "report_path",
      "evidence_dir",
      "error",
      "duration_seconds",
      "status_detail",
      "cancel_requested",
      "cancel_reason",
    ];
    for (const key of keys) {
      if (updates[key] !== undefined) {
        (job as any)[key] = updates[key] as any;
      }
    }
    if (TERMINAL_STATUSES.has(status) && !job.status_detail) {
      job.status_detail = status;
    }
    this.save(data);
    return this.publicJob(job);
  }

  completeJob(jobId: string, updates: Partial<QueueJob> = {}): PublicQueueJob {
    return this.finish(jobId, STATUS_COMPLETED, { error: "", status_detail: "completed", ...updates });
  }

  failJob(jobId: string, error: string, updates: Partial<QueueJob> = {}): PublicQueueJob {
    const data = this.load();
    const job = data.jobs[jobId];
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const attempt = Number(job.attempt ?? 0);
    const maxAttempts = Number(job.max_attempts ?? this.maxAttempts);
    if (attempt < maxAttempts) {
      job.status = STATUS_QUEUED;
      job.started_at = null;
      job.completed_at = null;
      job.queued_at = utcNow();
      job.error = safeText(error, 500);
      job.status_detail = "requeued after failure";
      this.save(data);
      return this.publicJob(job);
    }
    return this.finish(jobId, STATUS_FAILED, { error: safeText(error, 500), status_detail: "failed", ...updates });
  }

  cancelJobResult(jobId: string, updates: Partial<QueueJob> = {}): PublicQueueJob {
    return this.finish(jobId, STATUS_CANCELLED, { status_detail: "cancelled", cancel_requested: true, ...updates });
  }

  async processNext(): Promise<PublicQueueJob | null> {
    const job = this.claimNext();
    if (!job) return null;
    const started = Date.now();
    try {
      if (this.executor) {
        const result = await this.executor(job, this);
        const duration = (result.duration_seconds as number | undefined) ?? Number(((Date.now() - started) / 1000).toFixed(6));
        if (result.status === STATUS_CANCELLED || job.cancel_requested) {
          return this.cancelJobResult(job.job_id, { ...result, duration_seconds: duration });
        }
        if (result.status === STATUS_FAILED) {
          return this.failJob(job.job_id, String(result.error ?? "run failed"), { ...result, duration_seconds: duration });
        }
        return this.completeJob(job.job_id, { ...result, duration_seconds: duration });
      }
      // Default: mark completed as a placeholder processed job (execution integration is host/cloud-specific).
      return this.completeJob(job.job_id, {
        duration_seconds: Number(((Date.now() - started) / 1000).toFixed(6)),
        status_detail: "completed",
      });
    } catch (err) {
      const duration = Number(((Date.now() - started) / 1000).toFixed(6));
      return this.failJob(job.job_id, err instanceof Error ? err.message : String(err), { duration_seconds: duration });
    }
  }

  async processPending(limit?: number): Promise<PublicQueueJob[]> {
    const results: PublicQueueJob[] = [];
    let processed = 0;
    while (limit === undefined || processed < limit) {
      const job = await this.processNext();
      if (!job) break;
      results.push(job);
      processed += 1;
    }
    return results;
  }

  deleteWorkspaceJobs(workspaceId: string): number {
    const workspaceKey = safeWorkspace(workspaceId);
    const data = this.load();
    let removed = 0;
    for (const [jobId, job] of Object.entries(data.jobs)) {
      if (job.workspace_id === workspaceKey) {
        delete data.jobs[jobId];
        removed += 1;
      }
    }
    if (removed) this.save(data);
    return removed;
  }

  metrics(): Record<string, unknown> {
    const data = this.load();
    const jobs = Object.values(data.jobs);
    const byStatus: Record<string, number> = {};
    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    }
    const durations = jobs
      .map((j) => j.duration_seconds)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const avg = durations.length ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(6)) : 0;
    return {
      schema_version: QUEUE_SCHEMA_VERSION,
      queue_depth: byStatus[STATUS_QUEUED] ?? 0,
      running: byStatus[STATUS_RUNNING] ?? 0,
      completed: byStatus[STATUS_COMPLETED] ?? 0,
      failed: byStatus[STATUS_FAILED] ?? 0,
      cancelled: byStatus[STATUS_CANCELLED] ?? 0,
      total: jobs.length,
      by_status: byStatus,
      average_run_duration_seconds: avg,
      run_durations: Object.fromEntries(
        jobs.filter((j) => j.duration_seconds !== null).map((j) => [j.job_id, j.duration_seconds]),
      ),
    };
  }
}

export const RunQueue = JobQueue;
export const JobStore = JobQueue;
export const TaskQueue = JobQueue;
