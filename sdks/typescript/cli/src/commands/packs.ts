import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { PackError, expandPackRefs, packActionKind, packShortName, validatePackManifest, type Invocation, type PackInstallOptions, type PackInstallResult, type PackManifest, type PackSecret, type PackCredentialMode } from '@anlyonhq/sdk';
import { connect } from '../context';
import { CliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { registerSecret } from '../redact';
import { confirm, describeTarget } from './actions-write';
import { requireArgs, type CommandContext, type CommandSpec } from './types';
import { catalogueManifest, resolveCataloguePack } from '../setup/catalogue';

/** The directory holding a pack's pack.json, for resolving the packs it references. */
async function packDir(path: string): Promise<string> {
  try {
    return (await stat(path)).isDirectory() ? resolve(path) : dirname(resolve(path));
  } catch {
    return dirname(resolve(path));
  }
}

/**
 * A pack that reuses another pack's actions (`ref: "anlyon/hubspot#add-note"`) finds it beside
 * itself: `<packs>/hubspot/pack.json`, the layout of this repository's packs/ directory.
 */
function siblingResolver(dir: string) {
  return async (pack: string) => {
    const file = join(dirname(dir), pack.slice(pack.indexOf('/') + 1), 'pack.json');
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  };
}

/** `./packs/outbound-sales`, `./packs/outbound-sales/pack.json`, or a catalogue pack by name (`github`). */
export async function readManifest(path: string): Promise<PackManifest> {
  let file = path;
  try {
    if ((await stat(path)).isDirectory()) file = join(path, 'pack.json');
  } catch {
    const bundled = catalogueManifest(path);
    if (bundled === undefined) {
      throw usageError(`No pack at ${path}, and no catalogue pack named "${path}".`, 'Pass a pack directory (containing pack.json), a manifest file, or a catalogue pack such as github.');
    }
    try {
      return validatePackManifest(await expandPackRefs(bundled, resolveCataloguePack));
    } catch (error) {
      throw packCliError(error);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw usageError(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validatePackManifest(await expandPackRefs(parsed, siblingResolver(await packDir(path))));
  } catch (error) {
    throw packCliError(error);
  }
}

/** `NAME=value` pairs from a repeatable flag. */
function pairs(raw: unknown, flag: string, pattern: RegExp): Record<string, string> {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    const key = at > 0 ? item.slice(0, at) : '';
    if (!pattern.test(key)) throw usageError(`--${flag} must be NAME=value. Got "${at > 0 ? key : item}".`);
    out[key] = item.slice(at + 1);
  }
  return out;
}

export function packCliError(error: unknown): unknown {
  if (!(error instanceof PackError)) return error;
  return new CliError(error.code, error.message, EXIT.REJECTED, error.command ? { hint: `Run: ${error.command}` } : {});
}

function options(ctx: CommandContext): PackInstallOptions {
  const secrets = pairs(ctx.options.secret, 'secret', /^[A-Z0-9_]+$/);
  for (const value of Object.values(secrets)) registerSecret(value);
  const secretNames = pairs(ctx.options['secret-name'], 'secret-name', /^[A-Z0-9_]+$/);
  const actions = Array.isArray(ctx.options.action) ? ctx.options.action : typeof ctx.options.action === 'string' ? [ctx.options.action] : [];
  const credential = ctx.options.credential;
  if (credential !== undefined && credential !== 'connection' && credential !== 'secret') {
    throw usageError(`--credential must be "connection" or "secret". Got "${String(credential)}".`);
  }
  return {
    ...(credential !== undefined ? { credential: credential as PackCredentialMode } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(Object.keys(secretNames).length > 0 ? { secretNames } : {}),
    withLimits: ctx.options['with-limits'] === true,
    update: ctx.options.update === true,
    noPrefix: ctx.options['no-prefix'] === true,
    secrets,
    params: pairs(ctx.options.param, 'param', /^[a-z][a-z0-9_]*$/),
  };
}

/** Interactively, ask for a static secret's value; otherwise refuse and say which flag supplies it. */
function promptSecret(ctx: CommandContext): ((secret: PackSecret) => Promise<string | undefined>) | undefined {
  const interactive = Boolean((ctx.rt.stdin as { isTTY?: boolean }).isTTY) && !ctx.globals.noInput;
  if (!interactive) return undefined;
  return async (secret) => {
    const rl = createInterface({ input: ctx.rt.stdin, output: ctx.rt.streams.stderr });
    const value = await new Promise<string>((resolve) => rl.question(`Value for ${secret.name} (${secret.description ?? 'stored value'}): `, resolve));
    rl.close();
    const trimmed = value.trim();
    if (trimmed) registerSecret(trimmed);
    return trimmed || undefined;
  };
}

function report(ctx: CommandContext, result: PackInstallResult): void {
  if (ctx.out.json) return void ctx.out.result({ data: result });
  ctx.out.line(`${result.pack}@${result.version}${result.applied ? '' : ' (plan: nothing sent)'}`);
  ctx.out.table(result.steps, [
    { header: 'kind', value: (s) => s.kind },
    { header: 'name', value: (s) => s.name },
    { header: 'outcome', value: (s) => s.outcome },
    { header: 'detail', value: (s) => s.detail },
  ]);
  if (result.disabledPolicies.length > 0) {
    ctx.out.info(`Policies installed disabled: ${result.disabledPolicies.join('; ')}. Review them, then enable them (\`anlyon policies list\`, or the console).`);
  }
  if (result.suggestedLimits.length > 0) {
    ctx.out.info('Suggested limits, not created (re-run with --with-limits; needs impact-limits:write):');
    for (const limit of result.suggestedLimits) {
      ctx.out.info(`  ${limit.name}: ${limit.amount} ${limit.currency ?? limit.dimension} per ${limit.period}${limit.actionName ? ` on ${limit.actionName}` : ''}`);
    }
  }
}

const commonOptions: CommandSpec['options'] = {
  'with-limits': { type: 'boolean', description: 'Create the suggested impact limits (needs impact-limits:write).' },
  update: { type: 'boolean', description: 'Install a changed action definition as a new version instead of refusing.' },
  'no-prefix': { type: 'boolean', description: "Keep the manifest's action names instead of prefixing the pack's short name." },
  secret: { type: 'string', multiple: true, description: 'A stored secret value as NAME=value. Repeatable.' },
  param: { type: 'string', multiple: true, description: 'A pack parameter as name=value. Repeatable.' },
  action: { type: 'string', multiple: true, description: "Install only this action (the manifest's name), with its policies and limits. Repeatable." },
  'secret-name': { type: 'string', multiple: true, description: 'Use another secret for one the pack names, as PACK_NAME=WORKSPACE_NAME (an account connected under another name). Repeatable.' },
  credential: {
    type: 'string',
    description: "connection (default): each call uses its end user's account, or this environment's connected account. secret: use the connected account the pack names, which must exist.",
  },
};

const plan: CommandSpec = {
  path: ['packs', 'plan'],
  summary: 'What installing a pack would create, skip or refuse. Nothing is sent.',
  args: [{ name: 'pack', description: 'A catalogue pack by name (github), a pack directory (with pack.json) or a manifest file.' }],
  options: commonOptions,
  async run(ctx) {
    const [path] = requireArgs(ctx, plan);
    const manifest = await readManifest(path!);
    const { client } = await connect(ctx.globals, ctx.rt);
    try {
      report(ctx, await client.packs.plan(manifest, options(ctx)));
    } catch (error) {
      throw packCliError(error);
    }
  },
};

const install: CommandSpec = {
  path: ['packs', 'install'],
  summary: 'Install a pack: secrets, declared actions, policies (disabled) and, with --with-limits, limits.',
  args: [{ name: 'pack', description: 'A catalogue pack by name (github), a pack directory (with pack.json) or a manifest file.' }],
  options: { ...commonOptions, yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' } },
  async run(ctx) {
    const [path] = requireArgs(ctx, install);
    const manifest = await readManifest(path!);
    const opts = options(ctx);
    const connection = await connect(ctx.globals, ctx.rt);
    await confirm(ctx, `Install ${manifest.pack}@${manifest.version} in ${describeTarget(connection)}?`);
    try {
      report(ctx, await connection.client.packs.install(manifest, { ...opts, resolveSecret: promptSecret(ctx) }));
    } catch (error) {
      throw packCliError(error);
    }
  },
};

/** packs/<name>/exercise.json: a run through every action of a pack, against a real account. */
interface Exercise {
  needs?: Record<string, string>;
  steps: Array<{ action: string; input?: Record<string, unknown>; save?: Record<string, string> }>;
}

interface ExerciseRow {
  step: number;
  action: string;
  kind: 'read' | 'write';
  outcome: string;
  grade: string;
  effect: string;
  detail: string;
}

async function readExercise(path: string): Promise<Exercise> {
  const file = join(await packDir(path), 'exercise.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw usageError(`No readable exercise at ${file}.`, 'A pack that can be exercised has an exercise.json beside its pack.json.');
  }
  const steps = (parsed as Exercise | null)?.steps;
  if (!Array.isArray(steps) || steps.some((s) => typeof s?.action !== 'string')) throw usageError(`${file}: steps must be a list of { action, input?, save? }.`);
  return parsed as Exercise;
}

const REF = /\{\{\s*(needs|saved)\.([A-Za-z0-9_]+)\s*\}\}|\{\{\s*run\s*\}\}/g;

/** Fill {{needs.x}}, {{saved.x}} and {{run}}. A string that is exactly one reference takes the value whole. */
export function fillExerciseInput(value: unknown, scope: { needs: Record<string, string>; saved: Record<string, unknown>; run: string }): unknown {
  if (typeof value === 'string') {
    const lookup = (kind: string | undefined, name: string | undefined) => (kind === undefined ? scope.run : kind === 'needs' ? scope.needs[name!] : scope.saved[name!]);
    const whole = new RegExp(`^(?:${REF.source})$`).exec(value);
    if (whole) return lookup(whole[1], whole[2]);
    return value.replace(REF, (_m, kind?: string, name?: string) => String(lookup(kind, name) ?? ''));
  }
  if (Array.isArray(value)) return value.map((item) => fillExerciseInput(item, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillExerciseInput(v, scope)]));
  return value;
}

/**
 * A saved value takes the type the next action's input asks for: GitHub returns an issue number as
 * a number that the next call takes as a string, and a `--need` is always text.
 */
export function matchInputTypes(input: Record<string, unknown>, schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = (schema?.properties ?? {}) as Record<string, { type?: string }>;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    const type = properties[key]?.type;
    if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return [key, String(value)];
    if ((type === 'integer' || type === 'number') && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return [key, Number(value)];
    if (type === 'boolean' && (value === 'true' || value === 'false')) return [key, value === 'true'];
    return [key, value];
  }));
}

function pick(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), value);
}

const SETTLED = new Set(['succeeded', 'failed', 'unknown', 'denied', 'expired']);

const exercise: CommandSpec = {
  path: ['packs', 'exercise'],
  summary: "Run every action of an installed pack once against the connected account, in the order its exercise.json gives, and report each outcome and receipt.",
  args: [{ name: 'pack', description: 'A pack directory with pack.json and exercise.json.' }],
  options: {
    need: { type: 'string', multiple: true, description: 'A value the exercise needs, as name=value (see the pack README). Repeatable.' },
    'no-prefix': { type: 'boolean', description: "The pack was installed with --no-prefix: call the manifest's action names." },
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  async run(ctx) {
    const [path] = requireArgs(ctx, exercise);
    const manifest = await readManifest(path!);
    const plan = await readExercise(path!);
    const needs = pairs(ctx.options.need, 'need', /^[A-Za-z][A-Za-z0-9_]*$/);
    const missing = Object.entries(plan.needs ?? {}).filter(([name]) => !needs[name]);
    if (missing.length > 0) {
      throw usageError(`The exercise needs: ${missing.map(([name]) => name).join(', ')}.`, missing.map(([name, what]) => `--need ${name}=...  ${what}`).join('\n'));
    }
    const kinds = new Map(manifest.actions.map((a) => [a.name, packActionKind(a)]));
    const unknownAction = plan.steps.find((s) => !kinds.has(s.action));
    if (unknownAction) throw usageError(`The exercise calls ${unknownAction.action}, which ${manifest.pack} does not define.`);

    const connection = await connect(ctx.globals, ctx.rt);
    const writes = plan.steps.filter((s) => kinds.get(s.action) === 'write').length;
    await confirm(ctx, `Run ${plan.steps.length} calls of ${manifest.pack} (${writes} change something at the provider) in ${describeTarget(connection)}?`);

    const prefix = ctx.options['no-prefix'] === true ? '' : `${packShortName(manifest.pack)}-`;
    const run = randomBytes(3).toString('hex');
    const saved: Record<string, unknown> = {};
    const rows: ExerciseRow[] = [];
    let stopped = false;
    for (const [i, step] of plan.steps.entries()) {
      const row: ExerciseRow = { step: i + 1, action: `${prefix}${step.action}`, kind: kinds.get(step.action)!, outcome: 'not run', grade: '', effect: '', detail: '' };
      rows.push(row);
      if (stopped) continue;
      const action = manifest.actions.find((a) => a.name === step.action)!;
      const input = matchInputTypes(fillExerciseInput(step.input ?? {}, { needs, saved, run }) as Record<string, unknown>, 'inputSchema' in action ? action.inputSchema : undefined);
      let invocation: Invocation;
      try {
        const { data } = await connection.client.actions.invoke(row.action, input, { idempotencyKey: `exercise-${run}-${i + 1}` });
        invocation = data!;
        if (data!.pendingApproval) {
          row.outcome = 'pending_approval';
          row.detail = `An approval policy matched (${data!.approvalId}). Approve it or turn the policy off, then run again.`;
          stopped = true;
          continue;
        }
        for (let wait = 0; !SETTLED.has(invocation.status) && wait < 30; wait++) {
          await new Promise((r) => setTimeout(r, 1000));
          invocation = (await connection.client.actions.invocation(invocation.id)).data!;
        }
      } catch (error) {
        row.outcome = 'error';
        row.detail = error instanceof Error ? error.message : String(error);
        stopped = true;
        continue;
      }
      row.outcome = invocation.status;
      row.grade = invocation.grade ?? '';
      row.effect = invocation.effectId ?? '';
      const passed = invocation.status === 'succeeded' && (row.kind === 'read' || ['confirmed', 'acknowledged', ''].includes(row.grade));
      if (!passed) {
        row.detail = invocation.error ?? (invocation.body ? invocation.body.slice(0, 300) : `HTTP ${invocation.responseStatus ?? '-'}`);
        stopped = true;
        continue;
      }
      if (step.save) {
        let json: unknown;
        try { json = invocation.body ? JSON.parse(invocation.body) : undefined; } catch { json = undefined; }
        for (const [name, at] of Object.entries(step.save)) {
          const value = pick(json, at);
          if (value === undefined || value === null) {
            row.outcome = 'failed';
            row.detail = `The response has no ${at} to save as ${name}.`;
            stopped = true;
          } else saved[name] = value;
        }
      }
      if (row.kind === 'write' && row.grade === 'acknowledged') row.detail = 'Sent; this write has no read-back.';
    }

    const failed = rows.filter((r) => r.outcome !== 'succeeded');
    if (ctx.out.json) ctx.out.result({ data: { pack: manifest.pack, version: manifest.version, run, steps: rows } });
    else {
      ctx.out.line(`${manifest.pack}@${manifest.version}, run ${run}`);
      ctx.out.table(rows, [
        { header: 'step', value: (r) => String(r.step) },
        { header: 'action', value: (r) => r.action },
        { header: 'kind', value: (r) => r.kind },
        { header: 'outcome', value: (r) => r.outcome },
        { header: 'grade', value: (r) => r.grade },
        { header: 'effect', value: (r) => r.effect },
        { header: 'detail', value: (r) => r.detail },
      ]);
      if (failed.length === 0) ctx.out.info(`All ${rows.length} calls succeeded. Send the effect ids and grades to record the run.`);
    }
    if (failed.length > 0) {
      throw new CliError('EXERCISE_FAILED', `${failed.length} of ${rows.length} steps did not succeed; the run stopped at step ${failed[0]!.step} (${failed[0]!.action}).`, EXIT.ERROR);
    }
  },
};

export const packCommands: CommandSpec[] = [plan, install, exercise];
