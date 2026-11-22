import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { parseDocument } from 'yaml';
import { followSignOff, type SignOff } from '../api';
import { parseDuration } from '../args';
import { connect, type Connection } from '../context';
import { CliError, toCliError, withHint } from '../errors';
import { EXIT } from '../exit-codes';
import { lineEnding } from '../setup/project';
import { apply, plan, pull, type Applied, type Direction, type Plan } from '../config-file/engine';
import { CONFIG_FILE, CONFIG_VERSION, parseConfig, type ConfigFile } from '../config-file/model';
import { confirm, describeTarget } from './actions-write';
import type { CommandContext, CommandSpec } from './types';

/**
 * `anlyon plan`, `anlyon apply` and `anlyon pull`: an environment's actions, packs, policies,
 * limits and budgets kept in anlyon.yaml and changed by review. See src/config-file/model.ts.
 */

const GUARDRAILS_HINT = 'Plan, apply and pull read policies. Log in with `anlyon auth login --scope anlyon:guardrails`, or use a key with policies:read (and policies:write, impact-limits:write, actions:write, budgets:write to apply).';
const MARK: Record<Direction, string> = { tightening: 'tightening', loosening: 'loosening', neutral: 'neutral', 'needs-person': 'needs you' };
const OP: Record<string, string> = { create: '+', update: '~', delete: '-', replace: '±', missing: '!' };

function filePath(ctx: CommandContext): string {
  const given = typeof ctx.options.file === 'string' ? ctx.options.file : CONFIG_FILE;
  return isAbsolute(given) ? given : join(ctx.rt.cwd, given);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function load(ctx: CommandContext): Promise<{ path: string; name: string; config: ConfigFile }> {
  const path = filePath(ctx);
  const name = typeof ctx.options.file === 'string' ? ctx.options.file : CONFIG_FILE;
  const source = await readText(path);
  if (source === undefined) {
    throw new CliError('CONFIG_NOT_FOUND', `No ${name} here.`, EXIT.USAGE, { hint: 'Run `anlyon pull` to write the live environment to it, then edit it.' });
  }
  return { path, name, config: parseConfig(source, name) };
}

async function connectFor(ctx: CommandContext): Promise<Connection> {
  return connect(ctx.globals, ctx.rt);
}

/** A 403 from these commands is almost always a login without the guardrails group: say so. */
function guarded<T>(promise: Promise<T>, rt: CommandContext['rt']): Promise<T> {
  return promise.catch((error: unknown) => {
    const failure = error instanceof CliError ? error : toCliError(error, rt.abortState);
    throw failure.exitCode === EXIT.PERMISSION_DENIED && !failure.hint ? withHint(failure, GUARDRAILS_HINT) : failure;
  });
}

function summaryLine(p: Plan): string {
  const s = p.summary;
  const parts = [`${s.tightening} tightening`, `${s.loosening} loosening${s.loosening ? " (waits for a person's sign-off)" : ''}`, `${s.neutral} neutral`];
  if (s['needs-person']) parts.push(`${s['needs-person']} need${s['needs-person'] === 1 ? 's' : ''} you`);
  parts.push(`${s.unchanged} unchanged`);
  return `${parts.join(', ')}.`;
}

export function renderPlan(p: Plan): string[] {
  const lines = [`Plan for ${p.file}: environment ${p.environment.slug} (${p.environment.id})`, ''];
  if (!p.changes.length) lines.push('  No changes. The environment matches the file.');
  const width = Math.min(48, Math.max(0, ...p.changes.map((c) => `${c.section}.${c.key}`.length)));
  for (const change of p.changes) {
    lines.push(`  ${OP[change.op] ?? '?'} ${`${change.section}.${change.key}`.padEnd(width)}  ${MARK[change.direction].padEnd(10)}  ${change.reason}`);
  }
  for (const error of p.errors) lines.push(`  error: ${error}`);
  lines.push('', summaryLine(p));
  return lines;
}

/** The plan as a pull-request comment. */
export function renderPlanMarkdown(p: Plan): string {
  const escape = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [`### anlyon plan: \`${p.environment.slug}\``, ''];
  if (!p.changes.length) lines.push('No changes. The environment matches the file.');
  else {
    lines.push('| | Change | Direction | What it does |', '|---|---|---|---|');
    for (const c of p.changes) lines.push(`| ${OP[c.op] ?? '?'} | \`${escape(`${c.section}.${c.key}`)}\` | ${c.direction === 'loosening' ? '**loosening**' : MARK[c.direction]} | ${escape(c.reason)} |`);
  }
  for (const error of p.errors) lines.push('', `> Error: ${escape(error)}`);
  lines.push('', summaryLine(p));
  if (p.summary.loosening) lines.push('', "Loosening changes are not applied by a key or a CLI login. On apply, each one gets a sign-off link for a workspace admin.");
  return lines.join('\n');
}

const planCommand: CommandSpec = {
  path: ['plan'],
  summary: 'Show what applying anlyon.yaml would change in this environment, each change marked tightening or loosening.',
  options: {
    file: { type: 'string', description: `The config file (default ${CONFIG_FILE}).` },
    markdown: { type: 'boolean', description: 'Print the plan as Markdown, for a pull-request comment.' },
  },
  async run(ctx) {
    const { name, config } = await load(ctx);
    const connection = await connectFor(ctx);
    const { plan: result } = await guarded(plan(connection, config, name), ctx.rt);
    if (ctx.out.json) ctx.out.result({ data: result });
    else if (ctx.options.markdown === true) ctx.out.line(renderPlanMarkdown(result));
    else for (const line of renderPlan(result)) ctx.out.line(line);
    return result.errors.length ? EXIT.REJECTED : EXIT.OK;
  },
};

function printSignOff(ctx: CommandContext, applied: Applied & { signOff: SignOff }): void {
  ctx.out.info(`  ${applied.section}.${applied.key}: needs a person's sign-off`);
  ctx.out.info(`    ${applied.signOff.signOffUrl}`);
  if (applied.signOff.summary) ctx.out.info(`    ${applied.signOff.summary}`);
}

const applyCommand: CommandSpec = {
  path: ['apply'],
  summary: 'Make this environment match anlyon.yaml. Tightening changes apply at once; each loosening one prints a sign-off link for a person.',
  timeoutFor: (options) => (typeof options.wait === 'string' ? parseDuration(options.wait) + 120_000 : undefined),
  options: {
    file: { type: 'string', description: `The config file (default ${CONFIG_FILE}).` },
    yes: { type: 'boolean', description: 'Apply without prompting (required when not interactive, e.g. in CI).' },
    wait: { type: 'string', description: 'Wait this long (e.g. 30m) for a person to decide the sign-offs, then report.' },
  },
  async run(ctx) {
    const waitMs = typeof ctx.options.wait === 'string' ? parseDuration(ctx.options.wait) : undefined;
    const { name, config } = await load(ctx);
    const connection = await connectFor(ctx);
    const { plan: result, work } = await guarded(plan(connection, config, name), ctx.rt);
    if (!ctx.out.json) for (const line of renderPlan(result)) ctx.out.info(line);
    if (result.errors.length) throw new CliError('PLAN_INVALID', `${name} cannot be applied: ${result.errors.join('; ')}`, EXIT.REJECTED);
    const actionable = result.changes.filter((change) => change.direction !== 'needs-person');
    if (!actionable.length) {
      if (ctx.out.json) ctx.out.result({ data: { plan: result, applied: [] } });
      else ctx.out.line(result.changes.length ? 'Nothing the file can change. See the lines marked "needs you".' : 'No changes.');
      return EXIT.OK;
    }
    await confirm(ctx, `Apply ${actionable.length} change(s) to ${describeTarget(connection)}?`);
    const applied = await guarded(apply(ctx.rt, connection, work), ctx.rt);

    const pending = applied.filter((a): a is Applied & { signOff: SignOff } => a.outcome === 'sign-off' && Boolean(a.signOff));
    if (pending.length && !ctx.out.json) {
      ctx.out.info('');
      ctx.out.info("These changes loosen a guardrail. A workspace admin approves each one at its link; nothing here can approve them:");
      for (const item of pending) printSignOff(ctx, item);
    }
    if (pending.length && waitMs !== undefined) {
      const deadline = Date.now() + waitMs;
      const interactive = Boolean((ctx.rt.stdin as { isTTY?: boolean }).isTTY) && !ctx.globals.noInput && ctx.rt.env.ANLYON_NO_BROWSER !== '1';
      ctx.out.info('');
      ctx.out.info(`Waiting up to ${ctx.options.wait} for a decision (Ctrl-C to stop waiting; the requests stay open)…`);
      for (const item of pending) {
        if (interactive) ctx.rt.openBrowser(item.signOff.signOffUrl);
        item.signOff = await followSignOff(ctx.rt, connection, item.signOff, Math.max(0, deadline - Date.now()));
        if (item.signOff.status === 'applied') item.outcome = 'applied';
      }
    }

    const failed = applied.filter((a) => a.outcome === 'failed' || (a.signOff && !['pending', 'applied'].includes(a.signOff.status)));
    const waiting = applied.filter((a) => a.outcome === 'sign-off' && a.signOff?.status === 'pending');
    if (ctx.out.json) ctx.out.result({ data: { plan: result, applied } });
    else {
      ctx.out.line('');
      for (const a of applied) {
        const status = a.outcome === 'sign-off' ? `sign-off ${a.signOff?.status ?? 'pending'}${a.signOff ? ` (${a.signOff.id})` : ''}` : a.outcome;
        ctx.out.line(`  ${a.section}.${a.key}  ${status}${a.error ? `: ${a.error}` : ''}`);
      }
      ctx.out.line('');
      ctx.out.line(waiting.length ? `${waiting.length} change(s) wait for a person's sign-off. Run anlyon plan after they decide.` : failed.length ? `${failed.length} change(s) did not apply.` : 'Applied.');
    }
    if (failed.length) return EXIT.ACTION_NOT_SUCCEEDED;
    if (waiting.length) return waitMs !== undefined ? EXIT.TIMEOUT : EXIT.SIGN_OFF_REQUIRED;
    return EXIT.OK;
  },
};

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const HEADER = [
  '# anlyon.yaml: this project\'s guardrails, per environment.',
  '# `anlyon plan` shows what would change, `anlyon apply` applies it, `anlyon pull` refreshes it.',
  '# Secret values never go here: list secret names, and store values with `anlyon connections add`.',
  '# Reference: https://docs.anlyon.com/cli/config-as-code',
];

const pullCommand: CommandSpec = {
  path: ['pull'],
  summary: "Write this environment's live actions, policies, limits and budgets to anlyon.yaml. Other environments and comments are kept.",
  options: {
    file: { type: 'string', description: `The config file (default ${CONFIG_FILE}).` },
    yes: { type: 'boolean', description: "Replace the environment's entry without prompting." },
  },
  async run(ctx) {
    const path = filePath(ctx);
    const name = typeof ctx.options.file === 'string' ? ctx.options.file : CONFIG_FILE;
    const before = await readText(path);
    const config = before !== undefined && before.trim() ? parseConfig(before, name) : undefined;
    const connection = await connectFor(ctx);
    const slug = connection.environment.slug;
    const entry = await guarded(pull(connection, config), ctx.rt);
    if (config?.environments?.[slug]) await confirm(ctx, `Replace environment ${slug} in ${name} with what is live?`);

    const eol = lineEnding(before ?? (process.platform === 'win32' ? '\r\n' : '\n'));
    const document = before !== undefined && before.trim() ? parseDocument(before) : parseDocument(`${HEADER.join('\n')}\nversion: ${CONFIG_VERSION}\nenvironments: {}\n`);
    const environments = document.get('environments');
    if (!environments || (environments as { items?: unknown[] }).items?.length === 0) document.set('environments', document.createNode({ [slug]: entry }));
    else document.setIn(['environments', slug], document.createNode(entry));
    const text = document.toString({ lineWidth: 0 }).replace(/\r?\n/g, eol);
    await writeAtomic(path, text);
    const counts = { actions: Object.keys(entry.actions ?? {}).length, policies: Object.keys(entry.policies ?? {}).length, limits: Object.keys(entry.limits ?? {}).length, budgets: Object.keys(entry.budgets ?? {}).length, mcp: Object.keys(entry.mcp ?? {}).length, secrets: entry.secrets?.length ?? 0 };
    if (ctx.out.json) ctx.out.result({ data: { file: name, environment: { id: connection.environment.id, slug }, ...counts } });
    else {
      ctx.out.line(`Wrote environment ${slug} to ${name}: ${counts.actions} actions, ${counts.policies} policies, ${counts.limits} limits, ${counts.budgets} budgets, ${counts.mcp} MCP servers, ${counts.secrets} secret names.`);
      ctx.out.line('Review it, commit it, and change guardrails with anlyon plan and anlyon apply from now on.');
    }
  },
};

export const configCommands: CommandSpec[] = [planCommand, applyCommand, pullCommand];
