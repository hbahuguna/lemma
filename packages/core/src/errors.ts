export const EXIT_CODES = {
  pass: 0,
  policyThresholdFailed: 1,
  harnessError: 2,
  killSwitchHalt: 3,
  interrupt: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorCode =
  | "harness_error"
  | "workflow_error"
  | "workflow_malformed"
  | "state_error"
  | "state_corrupt"
  | "persona_error"
  | "plugin_error"
  | "policy_error"
  | "policy_threshold_failed"
  | "auth_error"
  | "quota_error"
  | "billing_error"
  | "queue_error"
  | "ssrf_error"
  | "redaction_error"
  | "kill_switch_halt"
  | "operator_interrupt"
  | "run_error";

export interface ErrorPayload {
  ok: false;
  error: {
    type: string;
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class HarnessError extends Error {
  readonly exitCode: ExitCode = EXIT_CODES.harnessError;
  readonly errorCode: ErrorCode = "harness_error";
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options?: { code?: ErrorCode; details?: Record<string, unknown>; exitCode?: ExitCode },
  ) {
    super(message);
    this.name = "HarnessError";
    if (options?.code) (this as { errorCode: ErrorCode }).errorCode = options.code;
    if (options?.details) this.details = options.details;
    if (options?.exitCode !== undefined) (this as { exitCode: ExitCode }).exitCode = options.exitCode;
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = {
      ok: false,
      error: {
        type: this.name,
        code: this.errorCode,
        message: this.message,
      },
    };
    if (this.details && Object.keys(this.details).length > 0) {
      payload.error.details = this.details;
    }
    return payload;
  }
}

type HarnessOpts = { code?: ErrorCode; details?: Record<string, unknown>; exitCode?: ExitCode };
const opts = (base: HarnessOpts): HarnessOpts => {
  const o: HarnessOpts = {};
  if (base.code !== undefined) o.code = base.code;
  if (base.details !== undefined) o.details = base.details;
  if (base.exitCode !== undefined) o.exitCode = base.exitCode;
  return o;
};

export class WorkflowError extends HarnessError {
  constructor(message: string, options?: { code?: ErrorCode; details?: Record<string, unknown> }) {
    super(message, opts({ code: options?.code ?? "workflow_error", ...(options?.details ? { details: options.details } : {}) }));
    this.name = "WorkflowError";
  }
}

export class MalformedWorkflowError extends WorkflowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "workflow_malformed", ...(details ? { details } : {}) });
    this.name = "MalformedWorkflowError";
  }
}

export class StateError extends HarnessError {
  constructor(message: string, options?: { code?: ErrorCode; details?: Record<string, unknown> }) {
    super(message, opts({ code: options?.code ?? "state_error", ...(options?.details ? { details: options.details } : {}) }));
    this.name = "StateError";
  }
}

export class CorruptStateError extends StateError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "state_corrupt", ...(details ? { details } : {}) });
    this.name = "CorruptStateError";
  }
}

export class PersonaError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "persona_error", ...(details ? { details } : {}) }));
    this.name = "PersonaError";
  }
}

export class PluginError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "plugin_error", ...(details ? { details } : {}) }));
    this.name = "PluginError";
  }
}

export class PolicyError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "policy_error", ...(details ? { details } : {}) }));
    this.name = "PolicyError";
  }
}

export class PolicyThresholdError extends PolicyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "PolicyThresholdError";
    (this as { errorCode: ErrorCode }).errorCode = "policy_threshold_failed";
    (this as { exitCode: ExitCode }).exitCode = EXIT_CODES.policyThresholdFailed;
  }
}

export class AuthError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "auth_error", ...(details ? { details } : {}) }));
    this.name = "AuthError";
  }
}

export class QuotaError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "quota_error", ...(details ? { details } : {}) }));
    this.name = "QuotaError";
  }
}

export class BillingError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "billing_error", ...(details ? { details } : {}) }));
    this.name = "BillingError";
  }
}

export class QueueError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "queue_error", ...(details ? { details } : {}) }));
    this.name = "QueueError";
  }
}

export class SsrfError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "ssrf_error", ...(details ? { details } : {}) }));
    this.name = "SsrfError";
  }
}

export class RedactionError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "redaction_error", ...(details ? { details } : {}) }));
    this.name = "RedactionError";
  }
}

export class KillSwitchHaltError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, opts({ code: "kill_switch_halt", exitCode: EXIT_CODES.killSwitchHalt, ...(details ? { details } : {}) }));
    this.name = "KillSwitchHaltError";
  }
}

export class OperatorInterruptError extends HarnessError {
  constructor(message = "Operation interrupted", details?: Record<string, unknown>) {
    super(message, opts({ code: "operator_interrupt", exitCode: EXIT_CODES.interrupt, ...(details ? { details } : {}) }));
    this.name = "OperatorInterruptError";
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError;
}

export function exitCodeForError(error: unknown): ExitCode {
  if (isHarnessError(error)) return error.exitCode;
  if (error && typeof error === "object" && "exitCode" in error) {
    const code = (error as { exitCode?: unknown }).exitCode;
    if (code === 0 || code === 1 || code === 2 || code === 3 || code === 130) return code;
  }
  return EXIT_CODES.harnessError;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isHarnessError(error)) return error.toPayload();
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      type: error instanceof Error && error.name ? error.name : "Error",
      code: "harness_error",
      message,
    },
  };
}
