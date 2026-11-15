/**
 * @lemma/cli — Machine-first lemma CLI.
 *
 * See docs/architecture.md for the package graph and dependency direction.
 */
import { EXIT_CODES, type ExitCode } from "@lemma/core";

import { emitError, writeJsonStdout, type CliIO } from "./errors.js";
import { coreCommandSpecs } from "./commands.js";
import { CliUsageError, type CliCommandSpec } from "./index-types.js";

export const PACKAGE_NAME = "@lemma/cli" as const;
export const CLI_NAME = "lemma" as const;
export const CLI_VERSION = "0.0.0" as const;

export * from "./errors.js";
export { CliUsageError, type CliCommandResult, type CliCommandHandler, type CliCommandSpec } from "./index-types.js";
export { coreCommandSpecs } from "./commands.js";

export function createCommandRegistry(specs: CliCommandSpec[] = []): Map<string, CliCommandSpec> {
  const registry = new Map<string, CliCommandSpec>();
  for (const spec of specs) registry.set(spec.name, spec);
  return registry;
}

export function usagePayload(registry: Map<string, CliCommandSpec>): Record<string, unknown> {
  const commands = [...registry.values()]
    .filter((c) => !c.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, description: c.description }));
  return {
    ok: true,
    cli: CLI_NAME,
    version: CLI_VERSION,
    usage: `${CLI_NAME} <command> [options]`,
    commands,
  };
}

export function versionPayload(): Record<string, unknown> {
  return { ok: true, cli: CLI_NAME, version: CLI_VERSION };
}

export function parseTopLevel(argv: string[]): { help: boolean; version: boolean; command?: string; rest: string[] } {
  const args = [...argv];
  let help = false;
  let version = false;
  let command: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!command && (a === "--help" || a === "-h" || a === "help")) {
      help = true;
      continue;
    }
    if (!command && (a === "--version" || a === "-v" || a === "version")) {
      version = true;
      continue;
    }
    if (!command && !a.startsWith("-")) {
      command = a;
      continue;
    }
    rest.push(a);
  }
  return { help, version, ...(command ? { command } : {}), rest };
}

export async function dispatch(argv: string[], registry: Map<string, CliCommandSpec>, io: CliIO): Promise<ExitCode> {
  const parsed = parseTopLevel(argv);
  if (parsed.version) {
    writeJsonStdout(io.stdout, versionPayload());
    return EXIT_CODES.pass;
  }
  if (parsed.help || !parsed.command) {
    writeJsonStdout(io.stdout, usagePayload(registry));
    return EXIT_CODES.pass;
  }
  const spec = registry.get(parsed.command);
  if (!spec) {
    throw new CliUsageError(`Unknown command: ${parsed.command}`, {
      command: parsed.command,
      available: [...registry.keys()].sort(),
    });
  }
  const result = await spec.handler(parsed.rest, io);
  for (const line of result.stderrLines ?? []) io.stderr(`${line}\n`);
  if (result.stdoutJson !== undefined) writeJsonStdout(io.stdout, result.stdoutJson);
  return result.exitCode ?? EXIT_CODES.pass;
}

export function defaultRegistry(): Map<string, CliCommandSpec> {
  return createCommandRegistry(coreCommandSpecs());
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIO = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) },
  registry: Map<string, CliCommandSpec> = defaultRegistry(),
): Promise<ExitCode> {
  try {
    return await dispatch(argv, registry, io);
  } catch (error) {
    const { exitCode } = emitError(io, error);
    return exitCode;
  }
}
