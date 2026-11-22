import { parseArgs } from 'node:util';
import { usageError } from './errors';

export interface OptionSpec {
  type: 'string' | 'boolean';
  description: string;
  /** Allowed values for a string option; checked before anything is sent. */
  choices?: readonly string[];
  short?: string;
  /** A string option that may be given more than once. Its value is then a list. */
  multiple?: boolean;
}

/** What a command reads for one of its options. A list only for a `multiple` option. */
export type OptionValue = string | boolean | string[] | undefined;

/** Flags every command accepts. Part of the terminal contract; see README. */
export const GLOBAL_OPTIONS = {
  json: { type: 'boolean', description: 'Machine-readable output: one JSON document on stdout.' },
  profile: { type: 'string', description: 'Profile to use (default: ANLYON_PROFILE, then the configured default).' },
  environment: {
    type: 'string',
    description:
      "Assert the environment (id or slug) the credential is bound to. Never switches it: a mismatch fails with exit 10.",
  },
  input: { type: 'string', description: 'Read options as a JSON object from a file, or from stdin with `-`.' },
  limit: { type: 'string', description: 'Page size for list commands (1-100).' },
  cursor: { type: 'string', description: 'Continue a list from the `nextCursor` of a previous page.' },
  timeout: { type: 'string', description: 'Give up after this long, e.g. 30s, 2m, 500ms (default 60s).' },
  'no-input': { type: 'boolean', description: 'Never prompt or open a browser. Fail instead.' },
  help: { type: 'boolean', short: 'h', description: 'Show help.' },
} as const satisfies Record<string, OptionSpec>;

export type GlobalOptionName = keyof typeof GLOBAL_OPTIONS;

export interface GlobalFlags {
  json: boolean;
  profile?: string;
  environment?: string;
  input?: string;
  limit?: string;
  cursor?: string;
  timeout?: string;
  noInput: boolean;
  help: boolean;
}

export interface ParsedCommandLine {
  path: string[];
  args: string[];
  options: Record<string, OptionValue>;
  globals: GlobalFlags;
}

/**
 * Split argv into the command path (the leading positionals that name a known
 * command) and everything else. Flags may appear anywhere.
 *
 * `commandPaths` is every registered path, e.g. [["auth","login"], ["runs","list"]].
 * `commandOptions` looks up the command's own options once the path is known.
 */
export function parseCommandLine(
  argv: string[],
  commandPaths: string[][],
  commandOptions: (path: string[]) => Record<string, OptionSpec> | undefined,
  allStringOptions: Set<string>,
): ParsedCommandLine {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      if (!name.includes('=') && allStringOptions.has(name)) i++;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) continue;
    positionals.push(token);
  }

  let path: string[] = [];
  for (const candidate of commandPaths) {
    if (candidate.length > path.length && candidate.every((part, index) => positionals[index] === part)) path = candidate;
  }

  const own = (path.length ? commandOptions(path) : undefined) ?? {};
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
  for (const [name, spec] of Object.entries({ ...GLOBAL_OPTIONS, ...own }) as [string, OptionSpec][]) {
    options[name] = { type: spec.type, ...(spec.short ? { short: spec.short } : {}), ...(spec.multiple ? { multiple: true } : {}) };
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message.replace(/^TypeError[^:]*: /, '') : String(error), 'See `anlyon --help`.');
  }

  const values = parsed.values as Record<string, OptionValue>;
  for (const [name, spec] of Object.entries(own)) {
    const value = values[name];
    if (spec.choices && typeof value === 'string' && !spec.choices.includes(value)) {
      throw usageError(`--${name} must be one of: ${spec.choices.join(', ')}.`);
    }
  }

  const str = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : undefined);
  return {
    path,
    args: parsed.positionals.slice(path.length),
    options: Object.fromEntries(Object.keys(own).map((name) => [name, values[name]])),
    globals: {
      json: values.json === true,
      profile: str('profile'),
      environment: str('environment'),
      input: str('input'),
      limit: str('limit'),
      cursor: str('cursor'),
      timeout: str('timeout'),
      noInput: values['no-input'] === true,
      help: values.help === true,
    },
  };
}

/** "30", "30s", "2m", "500ms", "1h" → milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw usageError(`Invalid duration "${text}". Use e.g. 30s, 2m, 500ms.`);
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const ms = unit === 'ms' ? value : unit === 's' ? value * 1000 : unit === 'm' ? value * 60_000 : value * 3_600_000;
  if (!(ms > 0) || ms > 24 * 3_600_000) throw usageError('--timeout must be between 1ms and 24h.');
  return Math.round(ms);
}

export function parseLimit(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw usageError('--limit must be a whole number between 1 and 100.');
  const n = Number(text);
  if (n < 1 || n > 100) throw usageError('--limit must be between 1 and 100.');
  return n;
}
