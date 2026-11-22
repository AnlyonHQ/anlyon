import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ActionDeclarationsInput, ActionVerifyMatch, Client, ImpactBound } from '@anlyonhq/sdk';
import { parseDuration, type OptionValue } from '../args';
import { connect, type Connection } from '../context';
import { CliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { describeImpact, describeVerify } from '../governed';
import { sanitizeRemoteText } from '../redact';
import type { Runtime } from '../runtime';
import { printSignOff, withSignOff } from '../sign-off';
import { requireArgs, type CommandContext, type CommandSpec } from './types';

type Invocation = NonNullable<Awaited<ReturnType<Client['actions']['invocation']>>['data']>;

const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'denied', 'expired']);
const POLL_MS = 2_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,255}$/;

/**
 * Every write is confirmed. Interactively the user answers a prompt that names
 * the workspace and environment the credential is bound to; anywhere else
 * (scripts, CI, an agent's shell) --yes is required, so a write can never happen
 * because stdin happened to be empty.
 */
export async function confirm(ctx: CommandContext, question: string): Promise<void> {
  if (ctx.options.yes === true) return;
  const interactive = Boolean((ctx.rt.stdin as { isTTY?: boolean }).isTTY) && !ctx.globals.noInput;
  if (!interactive) {
    throw usageError('This command changes something. Pass --yes to confirm when not running interactively.');
  }
  const rl = createInterface({ input: ctx.rt.stdin, output: ctx.rt.streams.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('ABORTED', 'Not confirmed. Nothing was sent.', EXIT.ERROR);
}

export function describeTarget(connection: Connection): string {
  const env = connection.environment;
  return `workspace ${connection.identity.workspaceId}, environment ${env.slug}${env.isProtected ? ' (protected)' : ''}`;
}

/**
 * The key that makes this write safe to repeat. Supplied, or generated and
 * printed, so a user whose command was interrupted can re-run it with the same
 * key and get the recorded result instead of a second execution. The SDK's own
 * automatic retries of a timed-out POST reuse it too.
 */
function idempotencyKey(ctx: CommandContext): string {
  const supplied = ctx.options['idempotency-key'];
  if (typeof supplied === 'string') {
    if (!IDEMPOTENCY_KEY.test(supplied)) {
      throw usageError('--idempotency-key must be 8-255 characters of letters, digits, ".", "_", ":" or "-".');
    }
    return supplied;
  }
  return `cli_${randomUUID()}`;
}

function exitFor(status: string | undefined): number {
  if (status === 'succeeded') return EXIT.OK;
  if (status === 'unknown') return EXIT.ACTION_UNKNOWN;
  if (status === 'pending_approval' || status === 'running') return EXIT.ACTION_PENDING;
  return EXIT.ACTION_NOT_SUCCEEDED;
}

const NEXT_STEP: Record<string, string> = {
  pending_approval: 'Waiting for a human decision. Check with `anlyon invocations get <id>`, or re-run with --wait.',
  running: 'Still running. Check with `anlyon invocations get <id>`.',
  unknown:
    'The outcome could not be confirmed: the destination may or may not have acted. Do not retry with a new key. ' +
    'Reconcile with the destination first. Re-running with the same --idempotency-key is safe.',
  failed: 'The action did not succeed.',
  denied: 'A reviewer or policy denied it. It did not run.',
  expired: 'The approval expired before a decision. It did not run.',
};

/**
 * Send a write, and if the CLI's own abort (--timeout or Ctrl-C) cut it off before a reply, say
 * what is true: the request may have reached Anlyon, so the outcome is unknown. Exit 13, with the
 * key that reads the recorded result back. Exiting 9 or 130 here would read as "nothing happened".
 */
async function sendWrite<T>(rt: Runtime, key: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!rt.signal.aborted) throw error;
    throw new CliError(
      'ACTION_UNKNOWN',
      'The request was cut off before a reply arrived. It may have reached Anlyon. Do not retry with a new key.',
      EXIT.ACTION_UNKNOWN,
      { hint: `Re-run with --idempotency-key ${key} to see the recorded result.` },
    );
  }
}

async function waitForTerminal(client: Client, rt: Runtime, invocation: Invocation, deadline: number): Promise<Invocation> {
  let current = invocation;
  while (!TERMINAL.has(current.status) && Date.now() + POLL_MS < deadline) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_MS);
      rt.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
      }, { once: true });
    });
    current = (await client.actions.invocation(current.id)).data!;
  }
  return current;
}

function report(ctx: CommandContext, invocation: Invocation & { pendingApproval?: boolean }, key: string, verb: string): number {
  const status = invocation.status;
  const next = NEXT_STEP[status];
  if (ctx.out.json) {
    ctx.out.result({ data: invocation, idempotencyKey: key, ...(next ? { nextStep: next } : {}) });
  } else {
    ctx.out.fields([
      ['invocation', invocation.id],
      ['action', invocation.actionName],
      ['status', status],
      ['approval', invocation.approvalId],
      ['http status', invocation.responseStatus],
      ['idempotency key', key],
    ]);
    if (invocation.error) ctx.out.info(`error: ${sanitizeRemoteText(String(invocation.error))}`);
    if (next) ctx.out.info(next.replace('<id>', invocation.id));
    else if (status === 'succeeded') ctx.out.info(`${verb} succeeded.`);
  }
  return exitFor(status);
}

function waitOption(ctx: CommandContext): number | undefined {
  const wait = ctx.options.wait;
  return typeof wait === 'string' ? parseDuration(wait) : undefined;
}

/** Leave a minute after the wait for the invoke/decide call itself. */
const timeoutWithWait = (options: Record<string, OptionValue>) =>
  typeof options.wait === 'string' ? parseDuration(options.wait) + 60_000 : undefined;

const invoke: CommandSpec = {
  path: ['actions', 'invoke'],
  summary: 'Invoke an action. Policy and approvals apply exactly as for any other caller.',
  args: [{ name: 'ref', description: 'Action name or act_ id.' }],
  bodyInput: true,
  timeoutFor: timeoutWithWait,
  options: {
    data: { type: 'string', description: 'The action input as a JSON object (or use --input <file|->).' },
    'idempotency-key': {
      type: 'string',
      description: 'Makes the call safe to repeat: the same key returns the recorded result. Generated and printed if omitted.',
    },
    wait: { type: 'string', description: 'If approval is needed, wait up to this long for the outcome (e.g. 10m).' },
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  async run(ctx) {
    const [ref] = requireArgs(ctx, invoke);
    if (typeof ctx.options.data === 'string' && ctx.body !== undefined) throw usageError('Use either --data or --input, not both.');
    let input: unknown = ctx.body ?? {};
    if (typeof ctx.options.data === 'string') {
      try {
        input = JSON.parse(ctx.options.data);
      } catch {
        throw usageError('--data must be a JSON object.');
      }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw usageError('The action input must be a JSON object.');
    const waitMs = waitOption(ctx);
    const key = idempotencyKey(ctx);

    const connection = await connect(ctx.globals, ctx.rt);
    await confirm(ctx, `Invoke "${ref}" in ${describeTarget(connection)}?`);
    ctx.out.info(`Invoking ${ref} (idempotency key ${key})…`);
    const response = await sendWrite(ctx.rt, key, () =>
      connection.client.actions.invoke(ref!, input as Record<string, unknown>, { idempotencyKey: key }),
    );
    let invocation: Invocation = response.data!;
    if (waitMs !== undefined && !TERMINAL.has(invocation.status)) {
      ctx.out.info(invocation.status === 'pending_approval' ? `Waiting for approval ${invocation.approvalId}…` : 'Waiting for the outcome…');
      invocation = await waitForTerminal(connection.client, ctx.rt, invocation, Date.now() + waitMs);
    }
    return report(ctx, invocation, key, 'Invocation');
  },
};

function decide(verb: 'approve' | 'deny'): CommandSpec {
  const spec: CommandSpec = {
    path: ['approvals', verb],
    summary:
      verb === 'approve'
        ? 'Approve a pending request. For a gated action, Anlyon runs the reviewed request once enough approvers agree.'
        : 'Deny a pending request. A denied action never runs.',
    args: [{ name: 'id', description: 'The apr_ approval id.' }],
    options: {
      note: { type: 'string', description: 'Why, recorded with the decision.' },
      'idempotency-key': { type: 'string', description: 'Makes the call safe to repeat. Generated if omitted.' },
      yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
    },
    async run(ctx) {
      const [id] = requireArgs(ctx, spec);
      const key = idempotencyKey(ctx);
      const connection = await connect(ctx.globals, ctx.rt);
      const approval = (await connection.client.approvals.get(id!)).data!;
      if (approval.status !== 'pending') {
        throw new CliError('APPROVAL_NOT_PENDING', `Approval ${approval.id} is already ${approval.status}.`, EXIT.REJECTED);
      }
      await confirm(ctx, `${verb === 'approve' ? 'Approve' : 'Deny'} "${sanitizeRemoteText(approval.title, 120)}" in ${describeTarget(connection)}?`);
      const note = typeof ctx.options.note === 'string' ? ctx.options.note : undefined;
      const request = note ? { note } : {};
      const result = await sendWrite(ctx.rt, key, async () =>
        verb === 'approve'
          ? (await connection.client.approvals.approve(id!, request, { idempotencyKey: key })).data!
          : (await connection.client.approvals.deny(id!, request, { idempotencyKey: key })).data!,
      );

      if (ctx.out.json) {
        ctx.out.result({ data: result, idempotencyKey: key });
      } else {
        ctx.out.fields([
          ['approval', result.approval.id],
          ['status', result.approval.status],
          ['invocation', result.invocation?.id],
          ['invocation status', result.invocation?.status],
        ]);
        if (result.invocation?.status && NEXT_STEP[result.invocation.status]) {
          ctx.out.info(NEXT_STEP[result.invocation.status]!.replace('<id>', result.invocation.id));
        }
      }
      return result.invocation?.status === 'unknown' ? EXIT.ACTION_UNKNOWN : EXIT.OK;
    },
  };
  return spec;
}

const IMPACT_FLAGS = ['dimension', 'unit', 'amount', 'bound'];
const VERIFY_FLAGS = ['verify-url', 'verify-status', 'verify-match'];

/** `data.status=sent` → { path, equals }. A value that reads as a JSON number, boolean, null or quoted string is sent as that. */
function parseMatch(text: string): ActionVerifyMatch {
  const at = text.indexOf('=');
  if (at < 1) throw usageError(`--verify-match must be path=value, for example data.status=sent. Got "${text}".`);
  const raw = text.slice(at + 1);
  let equals: ActionVerifyMatch['equals'] = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed)) equals = parsed as ActionVerifyMatch['equals'];
  } catch {
  }
  return { path: text.slice(0, at), equals };
}

/** Turn the flags into the PATCH body, refusing combinations that contradict each other before anything is sent. */
function declarationsFrom(options: Record<string, OptionValue>): ActionDeclarationsInput {
  const text = (name: string) => (typeof options[name] === 'string' ? (options[name] as string) : undefined);
  const given = (names: string[]) => names.filter((name) => options[name] !== undefined);
  const impactFlags = given(IMPACT_FLAGS);
  const verifyFlags = given(VERIFY_FLAGS);

  if (options.ungoverned === true) {
    const others = [...impactFlags, ...verifyFlags, ...given(['governed', 'no-impact', 'no-verify'])];
    if (others.length) throw usageError(`--ungoverned removes every declaration. It cannot be combined with --${others[0]}.`);
    return { governed: false };
  }

  const declarations: ActionDeclarationsInput = {};
  if (options['no-impact'] === true) {
    if (impactFlags.length) throw usageError(`--no-impact cannot be combined with --${impactFlags[0]}.`);
    declarations.impact = null;
  } else if (impactFlags.length) {
    const [dimension, unit, amount, bound] = IMPACT_FLAGS.map(text);
    if (!dimension || !amount || !bound) throw usageError('An impact needs --dimension, --amount and --bound together.');
    if (dimension === 'money' && !unit) throw usageError('--dimension money needs --unit with the currency, for example --unit usd.');
    declarations.impact = { dimension, amount, bound: bound as ImpactBound, ...(unit ? { unit } : {}) };
  }

  if (options['no-verify'] === true) {
    if (verifyFlags.length) throw usageError(`--no-verify cannot be combined with --${verifyFlags[0]}.`);
    declarations.verify = null;
  } else if (verifyFlags.length) {
    const url = text('verify-url');
    const status = text('verify-status');
    if (!url || !status) throw usageError('A read-back needs --verify-url and --verify-status together.');
    if (!/^[1-5]\d\d$/.test(status)) throw usageError('--verify-status must be an HTTP status, for example 200.');
    const matches = options['verify-match'];
    const match = (Array.isArray(matches) ? matches : typeof matches === 'string' ? [matches] : []).map(parseMatch);
    declarations.verify = { url, status: Number(status), ...(match.length ? { match } : {}) };
  }

  if (options.governed === true) declarations.governed = true;
  if (Object.keys(declarations).length === 0) {
    throw usageError('Nothing to declare.', 'Set an impact, a read-back or --governed. See `anlyon actions declare --help`.');
  }
  return declarations;
}

const declare: CommandSpec = {
  path: ['actions', 'declare'],
  summary: 'Set or remove what an action declares: its impact, its read-back, or governed alone.',
  args: [{ name: 'ref', description: 'Action name or act_ id.' }],
  options: {
    dimension: { type: 'string', description: 'What one call changes: money, resource_mutations, or a unit you name such as emails.' },
    unit: { type: 'string', description: 'The currency when the dimension is money, for example usd. Leave it out otherwise.' },
    amount: { type: 'string', description: 'How much one call changes: an integer, input.<path> or count(input.<path>), with an optional "* <integer>".' },
    bound: { type: 'string', description: 'Whether the amount is exact or a ceiling.', choices: ['exact', 'upper_bound'] },
    'verify-url': { type: 'string', description: "A GET on the action's own host that reads the write back. May use {{input.field}} and {{response.field}}." },
    'verify-status': { type: 'string', description: 'The HTTP status the read-back must answer with, for example 200.' },
    'verify-match': { type: 'string', multiple: true, description: 'A check on the read-back body as path=value, for example data.status=sent. Up to 10.' },
    governed: { type: 'boolean', description: 'Govern an action that declares neither an impact nor a read-back.' },
    'no-impact': { type: 'boolean', description: 'Remove the declared impact.' },
    'no-verify': { type: 'boolean', description: 'Remove the declared read-back.' },
    ungoverned: { type: 'boolean', description: 'Remove every declaration. The action stops being governed.' },
    'idempotency-key': { type: 'string', description: 'Makes the call safe to repeat. Generated if omitted.' },
    wait: {
      type: 'string',
      description: "If the change needs a human's sign-off, wait up to this long for their decision (e.g. 10m).",
    },
    yes: { type: 'boolean', description: 'Confirm without prompting (required when not interactive).' },
  },
  timeoutFor: timeoutWithWait,
  async run(ctx) {
    const [ref] = requireArgs(ctx, declare);
    const declarations = declarationsFrom(ctx.options);
    const waitMs = waitOption(ctx);
    const key = idempotencyKey(ctx);
    const connection = await connect(ctx.globals, ctx.rt);
    await confirm(ctx, `Change what "${ref}" declares in ${describeTarget(connection)}?`);
    const response = await withSignOff(ctx, connection.client, waitMs, () =>
      sendWrite(ctx.rt, key, () => connection.client.actions.declare(ref!, declarations, { idempotencyKey: key })),
    );
    const action = response.data;

    if (!action) {
      if (ctx.out.json) ctx.out.result({ data: response.signOff ?? null, idempotencyKey: key });
      else if (response.signOff) printSignOff(ctx.out, response.signOff);
      return;
    }
    if (ctx.out.json) {
      ctx.out.result({ data: action, idempotencyKey: key, ...(response.signOff ? { signOffId: response.signOff.id } : {}) });
    } else {
      ctx.out.fields([
        ['name', action.name],
        ['id', action.id],
        ['governed', action.governed],
        ['impact', describeImpact(action.impact)],
        ['verify', describeVerify(action.verify)],
        ['idempotency key', key],
      ]);
      ctx.out.info(action.governed ? 'Declarations saved. The action is governed.' : 'Declarations saved. The action is not governed.');
    }
  },
};

export const writeCommands: CommandSpec[] = [declare, invoke, decide('approve'), decide('deny')];
