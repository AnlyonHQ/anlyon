import type { GlobalFlags, OptionSpec, OptionValue } from '../args';
import { usageError } from '../errors';
import type { Output } from '../output';
import type { Runtime } from '../runtime';

export interface ArgSpec {
  name: string;
  description: string;
}

export interface CommandContext {
  rt: Runtime;
  out: Output;
  globals: GlobalFlags;
  args: string[];
  options: Record<string, OptionValue>;
  /** For `bodyInput` commands: the parsed `--input` document, passed through as the request body. */
  body?: unknown;
}

export interface CommandSpec {
  path: string[];
  summary: string;
  args?: ArgSpec[];
  options?: Record<string, OptionSpec>;
  /** Accepts --limit/--cursor. */
  paginated?: boolean;
  /** Overrides the 60s default when --timeout is not given (e.g. browser login). */
  defaultTimeoutMs?: number;
  /** Derive the default timeout from the command's own options (e.g. `--wait 10m`). */
  timeoutFor?(options: Record<string, OptionValue>): number | undefined;
  /**
   * `--input` is the request body (any JSON value the command validates), not a
   * JSON object of option values. Used by commands that send data, such as invoke.
   */
  bodyInput?: boolean;
  /** Returns the exit code; undefined means 0. */
  run(ctx: CommandContext): Promise<number | void>;
}

export function requireArgs(ctx: CommandContext, spec: CommandSpec): string[] {
  const wanted = spec.args ?? [];
  if (ctx.args.length !== wanted.length) {
    const usage = [spec.path.join(' '), ...wanted.map((arg) => `<${arg.name}>`)].join(' ');
    throw usageError(`Expected ${wanted.length} argument(s).`, `Usage: anlyon ${usage}`);
  }
  return ctx.args;
}
