import type { Client, SignOffRequest } from '@anlyonhq/sdk';
import { CliError, signOffFrom, signOffRequiredError } from './errors';
import { EXIT } from './exit-codes';
import type { Output } from './output';
import { sanitizeRemoteText } from './redact';
import type { Runtime } from './runtime';

/**
 * Loosening a guardrail with a CLI login or an API key is never applied directly: the API answers
 * 202 with a pending sign-off request, and the SDK throws SignOffRequiredError. This file turns
 * that into what the terminal prints and the exit code (15), and follows a request for --wait.
 */

export const SIGN_OFF_STATUSES = ['pending', 'applied', 'rejected', 'expired', 'cancelled', 'failed'] as const;

const NO_SELF_APPROVAL = 'This command cannot approve it, and neither can any API key or CLI login.';

/** Why a request ended without being applied, in one line. */
const ENDED: Record<string, string> = {
  rejected: 'A workspace admin rejected the change. Nothing changed.',
  expired: 'Nobody decided in time and the request expired. Nothing changed.',
  cancelled: 'The request was withdrawn. Nothing changed.',
  failed: 'An admin approved the change, but it could not be applied. Nothing changed. Ask again.',
};

/** The sign-off block on stderr: the link on its own line, the id, the diff, and who can approve. */
export function printSignOffNotice(out: Output, signOff: SignOffRequest): void {
  out.info("Needs a human's sign-off. A workspace admin must approve this change before it applies:");
  out.info(signOff.signOffUrl);
  out.info('');
  out.info(`id:      ${signOff.id}`);
  if (signOff.summary) out.info(`change:  ${sanitizeRemoteText(signOff.summary, 300)}`);
  if (signOff.expiresAt) out.info(`expires: ${signOff.expiresAt}`);
  if (signOff.diff) {
    out.info('');
    for (const line of sanitizeRemoteText(signOff.diff, 4000).split('\n')) out.info(`  ${line}`);
  }
  out.info('');
  out.info(NO_SELF_APPROVAL);
}

/** What `sign-offs get` and a followed write print for a request in any status. */
export function printSignOff(out: Output, signOff: SignOffRequest): void {
  out.fields([
    ['id', signOff.id],
    ['status', signOff.status],
    ['operation', signOff.operation],
    ['change', signOff.summary ? sanitizeRemoteText(signOff.summary, 300) : undefined],
    ['link', signOff.signOffUrl],
    ['requested', signOff.createdAt],
    ['expires', signOff.expiresAt],
    ['decided', signOff.decidedAt],
    ['note', signOff.decisionNote ? sanitizeRemoteText(signOff.decisionNote, 300) : undefined],
    ['error', signOff.error ? sanitizeRemoteText(`${signOff.error.code}: ${signOff.error.message}`, 300) : undefined],
  ]);
  if (signOff.diff) {
    out.line('');
    for (const line of sanitizeRemoteText(signOff.diff, 4000).split('\n')) out.line(`  ${line}`);
  }
}

/** Exit code for a request's status once followed: 0 applied, 15 still pending, 14 ended otherwise. */
export function exitForSignOff(status: string): number {
  if (status === 'applied') return EXIT.OK;
  if (status === 'pending') return EXIT.SIGN_OFF_REQUIRED;
  return EXIT.ACTION_NOT_SUCCEEDED;
}

/** One line on why a request ended, for stderr. */
export function endedReason(signOff: SignOffRequest): string {
  const base = ENDED[signOff.status] ?? `The request is ${signOff.status}.`;
  const note = signOff.decisionNote ? ` Note: ${sanitizeRemoteText(signOff.decisionNote, 300)}` : '';
  const error = signOff.error ? ` ${sanitizeRemoteText(signOff.error.message, 300)}` : '';
  return `${base}${error}${note}`;
}

function sleep(rt: Runtime, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    rt.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
      },
      { once: true },
    );
  });
}

/**
 * Poll a request until it leaves `pending` or the wait ends. Returns the request as last read;
 * still `pending` means the wait ran out.
 */
export async function followSignOff(client: Client, rt: Runtime, signOff: SignOffRequest, waitMs: number): Promise<SignOffRequest> {
  const deadline = Date.now() + waitMs;
  let current = signOff;
  while (current.status === 'pending') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const seconds = typeof current.pollAfterSeconds === 'number' && current.pollAfterSeconds > 0 ? current.pollAfterSeconds : 5;
    const interval = Math.max(50, seconds * 1000);
    await sleep(rt, Math.min(interval, remaining));
    current = (await client.signOffs.get(current.id)).data!;
  }
  return current;
}

/**
 * Run a governance write. A change that needs a human's sign-off throws as usual (exit 15), unless
 * the command was given --wait: then the CLI prints the link, follows the request, and returns what
 * the original call would have returned once it is applied. Rejected, expired, cancelled or failed
 * exits 14; a wait that runs out exits 9.
 */
export async function withSignOff<T>(
  ctx: { out: Output; rt: Runtime },
  client: Client,
  waitMs: number | undefined,
  send: () => Promise<{ data?: T }>,
): Promise<{ data?: T; signOff?: SignOffRequest }> {
  try {
    return await send();
  } catch (error) {
    const signOff = signOffFrom(error);
    if (!signOff) throw error;
    if (waitMs === undefined) throw signOffRequiredError(signOff, error);

    printSignOffNotice(ctx.out, signOff);
    ctx.out.info('');
    ctx.out.info(`Waiting for a decision on ${signOff.id}…`);
    const decided = await followSignOff(client, ctx.rt, signOff, waitMs);
    if (decided.status === 'applied') {
      ctx.out.info(`Approved and applied (${decided.id}).`);
      return { data: (decided.result ?? undefined) as T | undefined, signOff: decided };
    }
    if (decided.status === 'pending') {
      throw new CliError('TIMEOUT', `No decision on ${decided.id} before the wait ended. It is still pending.`, EXIT.TIMEOUT, {
        hint: `Check again with \`anlyon sign-offs get ${decided.id} --wait 10m\`.`,
        details: decided,
      });
    }
    throw new CliError(`SIGN_OFF_${decided.status.toUpperCase()}`, endedReason(decided), EXIT.ACTION_NOT_SUCCEEDED, { details: decided });
  }
}
