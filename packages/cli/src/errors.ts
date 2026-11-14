import { EXIT_CODES, exitCodeForError, toErrorPayload, type ErrorPayload, type ExitCode } from "@lemma/core";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function writeJsonStdout(stdout: (text: string) => void, payload: unknown): void {
  stdout(`${JSON.stringify(payload)}\n`);
}

export function writeDiagnosticStderr(stderr: (text: string) => void, message: string): void {
  stderr(`${message}\n`);
}

export function emitError(io: CliIO, error: unknown): { exitCode: ExitCode; payload: ErrorPayload } {
  const payload = toErrorPayload(error);
  const exitCode = exitCodeForError(error);
  writeJsonStdout(io.stdout, payload);
  return { exitCode, payload };
}

export async function runCli(
  fn: () => Promise<{ exitCode?: ExitCode; stdoutJson?: unknown; stderrLines?: string[] }> | { exitCode?: ExitCode; stdoutJson?: unknown; stderrLines?: string[] },
  io: CliIO = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) },
): Promise<ExitCode> {
  try {
    const result = await fn();
    for (const line of result.stderrLines ?? []) writeDiagnosticStderr(io.stderr, line);
    if (result.stdoutJson !== undefined) writeJsonStdout(io.stdout, result.stdoutJson);
    return result.exitCode ?? EXIT_CODES.pass;
  } catch (error) {
    const { exitCode } = emitError(io, error);
    return exitCode;
  }
}
