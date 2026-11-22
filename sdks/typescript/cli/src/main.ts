import { GLOBAL_OPTIONS, parseCommandLine, parseDuration, type OptionSpec } from './args';
import { COMMANDS, GROUP_SUMMARIES } from './commands';
import type { CommandSpec } from './commands/types';
import { CliError, toCliError, usageError } from './errors';
import { EXIT } from './exit-codes';
import { loadBody, loadInput } from './input';
import { Output, type Streams } from './output';
import type { Runtime } from './runtime';
import { CLI_VERSION, SDK_VERSION, runtimeDescription } from './version';

const PATHS = COMMANDS.map((command) => command.path);
const STRING_OPTIONS = new Set<string>(
  [GLOBAL_OPTIONS, ...COMMANDS.map((command) => command.options ?? {})].flatMap((options) =>
    Object.entries(options as Record<string, OptionSpec>)
      .filter(([, spec]) => spec.type === 'string')
      .map(([name]) => name),
  ),
);

function findCommand(path: string[]): CommandSpec | undefined {
  return COMMANDS.find((command) => command.path.join(' ') === path.join(' '));
}

function optionLines(options: Record<string, OptionSpec>): string[] {
  return Object.entries(options).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : ''}--${name}${spec.type === 'string' ? ' <value>' : ''}`;
    const choices = spec.choices ? ` (${spec.choices.join('|')})` : '';
    return `  ${flag.padEnd(28)} ${spec.description}${choices}${spec.multiple ? ' Repeatable.' : ''}`;
  });
}

function globalHelp(): string {
  const groups = new Map<string, CommandSpec[]>();
  for (const command of COMMANDS) {
    const key = command.path.length > 1 ? command.path[0]! : '';
    groups.set(key, [...(groups.get(key) ?? []), command]);
  }
  const lines = ['anlyon: operate Anlyon from a terminal', '', 'Usage: anlyon <command> [options]', ''];
  for (const [group, commands] of groups) {
    lines.push(group ? `${group}: ${GROUP_SUMMARIES[group] ?? ''}` : 'Account:');
    for (const command of commands) lines.push(`  anlyon ${command.path.join(' ').padEnd(24)} ${command.summary}`);
    lines.push('');
  }
  lines.push('Global options:', ...optionLines(GLOBAL_OPTIONS), '');
  lines.push(
    'Environment: ANLYON_PROFILE, ANLYON_API_KEY (automation, bypasses profiles), ANLYON_API_URL,',
    '             ANLYON_CONFIG_DIR, ANLYON_CREDENTIAL_STORE (auto|keychain|file), ANLYON_NO_BROWSER=1',
    '',
    'Exit codes: 0 ok, 1 error, 2 usage, 3 not logged in, 4 permission denied, 5 not found,',
    '            6 rejected, 7 rate limited, 8 unavailable, 9 timeout, 10 target mismatch,',
    '            11 not available on this server, 12 action pending, 13 action outcome unknown,',
    "            14 action did not succeed, 15 waiting for a human's sign-off, 130 cancelled",
  );
  return lines.join('\n');
}

function groupHelp(group: string): string {
  const commands = COMMANDS.filter((command) => command.path[0] === group && command.path.length > 1);
  return [`anlyon ${group}: ${GROUP_SUMMARIES[group] ?? ''}`, '', ...commands.map((c) => `  anlyon ${c.path.join(' ').padEnd(24)} ${c.summary}`)].join('\n');
}

function commandHelp(command: CommandSpec): string {
  const usage = ['anlyon', ...command.path, ...(command.args ?? []).map((arg) => `<${arg.name}>`), '[options]'].join(' ');
  const lines = [command.summary, '', `Usage: ${usage}`];
  if (command.args?.length) lines.push('', 'Arguments:', ...command.args.map((arg) => `  ${arg.name.padEnd(28)} ${arg.description}`));
  if (command.options && Object.keys(command.options).length) lines.push('', 'Options:', ...optionLines(command.options));
  lines.push('', 'Global options: --json --profile --environment --input --timeout --no-input' + (command.paginated ? ' --limit --cursor' : ''));
  if (command.bodyInput) lines.push('--input <file|-> supplies the request body as JSON.');
  return lines.join('\n');
}

export interface MainOptions {
  streams: Streams;
  /** Build the runtime around the abort signal main owns. */
  runtime: (signal: AbortSignal, abortState: Runtime['abortState']) => Runtime;
  /** Install a SIGINT handler (the real executable does; in-process tests do not). */
  handleSignals?: boolean;
}

export async function main(argv: string[], options: MainOptions): Promise<number> {
  const controller = new AbortController();
  const abortState = { cancelled: false, timedOut: false };
  const rt = options.runtime(controller.signal, abortState);
  const wantsJson = argv.includes('--json');
  let out = new Output(options.streams, wantsJson);

  if (argv[0] === '--version' || argv[0] === '-V' || (argv[0] === 'version' && argv.length <= 2)) {
    if (wantsJson) out.result({ cli: CLI_VERSION, sdk: SDK_VERSION, runtime: runtimeDescription(), platform: `${rt.platform}/${process.arch}` });
    else out.line(`anlyon ${CLI_VERSION} (@anlyonhq/sdk ${SDK_VERSION}, ${runtimeDescription()})`);
    return EXIT.OK;
  }

  let onSigint: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const parsed = parseCommandLine(argv, PATHS, (path) => findCommand(path)?.options, STRING_OPTIONS);
    out = new Output(options.streams, parsed.globals.json);
    const command = parsed.path.length ? findCommand(parsed.path) : undefined;

    if (!command) {
      const [first] = parsed.args;
      if (first && GROUP_SUMMARIES[first] && parsed.args.length === 1) {
        (parsed.globals.help ? out.line.bind(out) : out.info.bind(out))(groupHelp(first));
        return parsed.globals.help ? EXIT.OK : EXIT.USAGE;
      }
      if (first) throw usageError(`Unknown command "${parsed.args.join(' ')}".`, 'See `anlyon --help`.');
      if (parsed.globals.help) {
        out.line(globalHelp());
        return EXIT.OK;
      }
      out.info(globalHelp());
      return EXIT.USAGE;
    }
    if (parsed.globals.help) {
      out.line(commandHelp(command));
      return EXIT.OK;
    }
    if (!command.paginated && (parsed.globals.limit !== undefined || parsed.globals.cursor !== undefined)) {
      throw usageError(`\`anlyon ${command.path.join(' ')}\` is not a list; --limit and --cursor do not apply.`);
    }

    let body: unknown;
    if (parsed.globals.input !== undefined && command.bodyInput) {
      body = await loadBody(parsed.globals.input, rt.stdin);
    } else if (parsed.globals.input !== undefined) {
      const fromInput = await loadInput(parsed.globals.input, command.options ?? {}, rt.stdin);
      for (const [key, value] of Object.entries(fromInput)) {
        if (key === 'limit' || key === 'cursor') {
          if (!command.paginated) throw usageError(`--input key "${key}" applies only to list commands.`);
          parsed.globals[key] ??= String(value);
        } else if (parsed.options[key] === undefined) {
          parsed.options[key] = value;
        }
      }
      for (const [name, spec] of Object.entries(command.options ?? {})) {
        const value = parsed.options[name];
        if (spec.choices && typeof value === 'string' && !spec.choices.includes(value)) {
          throw usageError(`${name} must be one of: ${spec.choices.join(', ')}.`);
        }
      }
    }

    rt.timeoutMs = parsed.globals.timeout
      ? parseDuration(parsed.globals.timeout)
      : (command.timeoutFor?.(parsed.options) ?? command.defaultTimeoutMs ?? rt.timeoutMs);
    timer = setTimeout(() => {
      abortState.timedOut = true;
      controller.abort();
    }, rt.timeoutMs);
    if (options.handleSignals) {
      onSigint = () => {
        if (abortState.cancelled) process.exit(EXIT.CANCELLED);
        abortState.cancelled = true;
        controller.abort();
      };
      process.on('SIGINT', onSigint);
    }

    const code = await command.run({ rt, out, globals: parsed.globals, args: parsed.args, options: parsed.options, body });
    if (abortState.cancelled) throw new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED);
    return code ?? EXIT.OK;
  } catch (error) {
    const failure = toCliError(error, abortState);
    out.error(failure);
    if (failure.code === 'UNEXPECTED' && rt.env.ANLYON_DEBUG) out.info(String((error as Error).stack));
    return failure.exitCode;
  } finally {
    if (timer) clearTimeout(timer);
    if (onSigint) process.off('SIGINT', onSigint);
  }
}
