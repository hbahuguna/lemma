import { spawn } from "node:child_process";

import {
  CheckOutcome,
  CheckStatus,
  dispatchWithBrowserAdapter,
  type BrowserAdapter,
  type BrowserAdapterCapabilities,
  type BrowserDispatchRequest,
  type BrowserDispatchResult,
  type Check,
} from "@lemma/core";

import { degradeBrowserChecks } from "./runtime.js";

export interface VibiumCliResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface VibiumCliRunner {
  run(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<VibiumCliResult>;
  version?(options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string | null>;
  isAvailable?(options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ available: boolean; reason?: string }>;
}

export interface VibiumCheckResultPayload {
  status?: string; // passed|failed|blocked|skipped|error
  actual?: string;
  findings?: any[];
  evidence?: string[] | Record<string, string>;
  evidence_handles?: Record<string, string>;
  artifacts?: {
    screenshots?: string[] | Record<string, string>;
    console?: string[] | string;
    network?: string[] | string;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
}

export interface VibiumRunPayload {
  checks?: Record<string, VibiumCheckResultPayload>;
  outcomes?: Record<string, VibiumCheckResultPayload>;
  evidence_handles?: Record<string, string>;
  version?: string;
  native_version?: string;
  [key: string]: unknown;
}

export const VIBIUM_DEFAULT_CAPABILITIES: BrowserAdapterCapabilities = {
  navigation: true,
  screenshots: true,
  console: true,
  network: true,
  storage: false,
  viewport: false,
  crawl: false,
};

function defaultCliRunner(command = "vibium"): VibiumCliRunner {
  const run = (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<VibiumCliResult> =>
    new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let finished = false;
      const timeout = options?.timeoutMs ? setTimeout(() => {
        if (finished) return;
        try { child.kill("SIGTERM"); } catch {}
      }, options.timeoutMs) : null;
      child.stdout.on("data", (d) => { stdout += String(d); });
      child.stderr.on("data", (d) => { stderr += String(d); });
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        const msg = err && (err as any).code === "ENOENT" ? `Vibium CLI not found: ${command}` : String(err?.message || err);
        resolve({ ok: false, exitCode: null, stdout, stderr, error: msg });
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        resolve({ ok: code === 0, exitCode: code, stdout, stderr });
      });
    });

  return {
    run,
    async version(options) {
      const res = await run(["--version"], options);
      if (res.ok) {
        const v = (res.stdout || res.stderr).trim().split(/\s+/).pop() || (res.stdout || res.stderr).trim();
        return v || null;
      }
      return null;
    },
    async isAvailable(options) {
      const res = await run(["--version"], options);
      if (res.error && /not found|ENOENT/i.test(res.error)) return { available: false, reason: res.error };
      if (!res.ok && /not found|ENOENT/i.test(res.stderr + res.stdout)) return { available: false, reason: `Vibium CLI not found: ${command}` };
      // if version command fails for other reasons but binary exists, still consider available; blocked behavior handled at dispatch
      if (res.error) return { available: false, reason: res.error };
      return { available: true };
    },
  };
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v) return [v];
  return [];
}

function normalizeStatus(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "pass" || s === "passed") return CheckStatus.PASSED;
  if (s === "fail" || s === "failed") return CheckStatus.FAILED;
  if (s === "blocked") return CheckStatus.BLOCKED;
  if (s === "skipped" || s === "skip") return CheckStatus.SKIPPED;
  if (s === "error" || s === "errored") return CheckStatus.ERROR;
  return CheckStatus.FAILED;
}

function toEvidenceRefs(payload: VibiumCheckResultPayload): string[] {
  const refs: string[] = [];
  for (const r of asArray(payload.evidence)) refs.push(r);
  if (payload.evidence && !Array.isArray(payload.evidence) && typeof payload.evidence === "object") {
    for (const v of Object.values(payload.evidence as Record<string, unknown>)) if (typeof v === "string") refs.push(v);
  }
  if (payload.evidence_handles) for (const v of Object.values(payload.evidence_handles)) if (typeof v === "string") refs.push(v);
  if (payload.artifacts) {
    for (const [k, v] of Object.entries(payload.artifacts)) {
      if (typeof v === "string") refs.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") refs.push(x);
      else if (v && typeof v === "object") for (const x of Object.values(v as any)) if (typeof x === "string") refs.push(x);
      void k;
    }
  }
  return Array.from(new Set(refs));
}

function toOutcome(check: Check, payload: VibiumCheckResultPayload | undefined, baseMeta: Record<string, unknown>): CheckOutcome {
  if (!payload) {
    return new CheckOutcome({
      status: CheckStatus.SKIPPED,
      actual: `No Vibium result provided for '${check.id}' (recorded as explicit coverage gap, not a pass).`,
      evidence: [],
      findings: [],
      blocker: null,
      metadata: { ...baseMeta, coverage_note: `Missing Vibium result for ${check.id}`, not_a_pass: true },
    });
  }
  const status = normalizeStatus(payload.status);
  const evidence = toEvidenceRefs(payload);
  return new CheckOutcome({
    status,
    actual: typeof payload.actual === "string" ? payload.actual : (status === CheckStatus.PASSED ? "Vibium check passed." : "Vibium check completed."),
    evidence,
    findings: Array.isArray(payload.findings) ? payload.findings : [],
    blocker: status === CheckStatus.BLOCKED ? { attempted_action: check.id, boundary: typeof payload.actual === "string" ? payload.actual : "Vibium reported blocked", unblock_evidence: [] } as any : null,
    metadata: { ...baseMeta, ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}) },
  });
}

export interface VibiumBrowserAdapterOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: VibiumCliRunner;
  declaredCapabilities?: Partial<BrowserAdapterCapabilities>;
  /** Optional base checks to run when request does not specify; args are still passed verbatim to CLI. */
  defaultChecks?: Check[];
}


function runnerOptions(options: VibiumBrowserAdapterOptions): { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } {
  const o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {};
  if (options.cwd !== undefined) o.cwd = options.cwd;
  if (options.env !== undefined) o.env = options.env;
  if (options.timeoutMs !== undefined) o.timeoutMs = options.timeoutMs;
  return o;
}

export class VibiumBrowserAdapter implements BrowserAdapter {
  readonly id = "vibium";
  readonly version = "1.0.0";
  readonly nativeVersion?: string | null;
  private readonly options: VibiumBrowserAdapterOptions;
  private readonly runner: VibiumCliRunner;
  private cachedNativeVersion: string | null | undefined;

  constructor(options: VibiumBrowserAdapterOptions = {}) {
    this.options = options;
    this.runner = options.runner ?? defaultCliRunner(options.command ?? "vibium");
  }

  capabilities(): BrowserAdapterCapabilities {
    return { ...VIBIUM_DEFAULT_CAPABILITIES, ...(this.options.declaredCapabilities ?? {}) };
  }

  async getNativeVersion(): Promise<string | null> {
    if (this.cachedNativeVersion !== undefined) return this.cachedNativeVersion;
    try {
      const v = this.runner.version ? await this.runner.version(runnerOptions(this.options)) : null;
      this.cachedNativeVersion = v;
      return v;
    } catch {
      this.cachedNativeVersion = null;
      return null;
    }
  }

  async probe(options?: Record<string, unknown>): Promise<{ available: boolean; reason?: string }> {
    const disabled = options?.disabled === true || options?.noBrowser === true;
    if (disabled) return { available: false, reason: "Browser execution is disabled (--no-browser)." };
    if (this.runner.isAvailable) {
      return await this.runner.isAvailable(runnerOptions(this.options));
    }
    const v = await this.getNativeVersion();
    return v != null ? { available: true } : { available: false, reason: "Vibium CLI is unavailable." };
  }

  async dispatch(request: BrowserDispatchRequest): Promise<BrowserDispatchResult> {
    const outcomes = new Map<string, CheckOutcome>();
    const checks = [...request.checks] as Check[];
    const probe = await this.probe(request.options as any);
    if (!probe.available) {
      const reason = probe.reason ?? "Vibium runtime is unavailable.";
      await degradeBrowserChecks(checks, reason, async (check, outcome) => { outcomes.set(check.id, outcome); });
      return { outcomes, blocked_runtime: true, blocked_reason: reason };
    }

    const nativeVersion = await this.getNativeVersion();
    const args = [...(this.options.args ?? [])]; // preserved verbatim as provided
    const runRes = await this.runner.run(args, runnerOptions(this.options));

    const baseMeta: Record<string, unknown> = {
      adapter_id: this.id,
      adapter_version: this.version,
      vibium_adapter_version: this.version,
      vibium_cli_version: nativeVersion,
      vibium_args: args,
    };

    if (!runRes.ok && runRes.error && /not found|ENOENT/i.test(runRes.error)) {
      const reason = runRes.error;
      await degradeBrowserChecks(checks, reason, async (check, outcome) => {
        outcome.metadata = { ...(outcome.metadata ?? {}), ...baseMeta };
        outcomes.set(check.id, outcome);
      });
      return { outcomes, blocked_runtime: true, blocked_reason: reason };
    }

    let payload: VibiumRunPayload | null = null;
    try {
      payload = runRes.stdout && runRes.stdout.trim() ? JSON.parse(runRes.stdout) as VibiumRunPayload : null;
    } catch {
      payload = null;
    }

    const checkMap: Record<string, VibiumCheckResultPayload> = (payload?.checks ?? payload?.outcomes ?? {}) as any;
    for (const check of checks) {
      const p = checkMap && typeof checkMap === "object" ? (checkMap[check.id] ?? (checkMap as any)[check.title]) : undefined;
      let out: CheckOutcome;
      if (!runRes.ok && !payload) {
        out = new CheckOutcome({
          status: CheckStatus.ERROR,
          actual: `Vibium CLI failed (exit ${String(runRes.exitCode)}): ${(runRes.stderr || runRes.stdout || runRes.error || "unknown error").slice(0, 500)}`,
          evidence: [],
          findings: [],
          blocker: null,
          metadata: { ...baseMeta },
        });
      } else {
        out = toOutcome(check, p, baseMeta);
        // ensure version metadata recorded in evidence metadata
        out.metadata = { ...(out.metadata ?? {}), ...baseMeta, ...(payload?.native_version ? { vibium_cli_version: payload.native_version } : {}) };
      }
      outcomes.set(check.id, out);
    }

    return { outcomes, blocked_runtime: false };
  }
}

export function createVibiumBrowserAdapter(options: VibiumBrowserAdapterOptions = {}): VibiumBrowserAdapter {
  return new VibiumBrowserAdapter(options);
}

export { dispatchWithBrowserAdapter };
