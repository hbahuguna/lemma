import { HarnessError, type ExitCode } from "@lemma/core";
import type { CliIO } from "./errors.js";

export interface CliCommandResult {
  exitCode?: ExitCode;
  stdoutJson?: unknown;
  stderrLines?: string[];
}

export type CliCommandHandler = (args: string[], io: CliIO) => Promise<CliCommandResult> | CliCommandResult;

export interface CliCommandSpec {
  name: string;
  description: string;
  handler: CliCommandHandler;
  hidden?: boolean;
}

export type { CliIO } from "./errors.js";

export class CliUsageError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "harness_error", ...(details ? { details } : {}) });
    this.name = "CliUsageError";
  }
}
