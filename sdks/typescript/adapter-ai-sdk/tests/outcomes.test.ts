import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionOptions } from 'ai';
import { Client } from '@anlyonhq/sdk';
import { anlyonCheckRequestTool, anlyonTools, capBody, refusalOf } from '../src/actions.ts';
import { anlyonInvokeActionTool } from '../src/tools.ts';

const toolOpts: ToolExecutionOptions<never> = { toolCallId: 't1', messages: [], context: undefined as never };

const ACTIONS = [
  { name: 'e2e-reminder', description: 'Set a reminder.', enabled: true, requiresApproval: true, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

type Reply = { status?: number; body: unknown };
type Route = (path: string, endUser: string | null) => Reply | undefined;

function makeClient(route: Route) {
  const paths: Array<[string, string | null]> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const endUser = new Headers(init.headers).get('Anlyon-End-User');
    paths.push([path, endUser]);
    const reply = path === '/api/v2/actions' ? { body: { success: true, data: ACTIONS } } : route(path, endUser);
    if (!reply) return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
  return { client, paths };
}

const invocation = (fields: Record<string, unknown>) => ({
  id: 'inv_1', actionName: 'e2e-reminder', status: 'succeeded', responseStatus: 200, body: '{"ok":true}', error: null,
  durationMs: 10, approvalId: null, decision: null, retryOf: null, effectId: 'eff_1', grade: 'acknowledged', endUserId: 'user_42',
  createdAt: '2026-10-26T10:00:00.000Z', completedAt: '2026-10-26T10:00:01.000Z', ...fields,
});

describe('action tool results', () => {
  it('carry the invocation, receipt, end user and request ids beside the sentence', async () => {
    const { client } = makeClient(() => ({ body: { success: true, requestId: 'req_fake_1', data: { ...invocation({}), pendingApproval: false } } }));
    const tools = await anlyonTools({ client: client.forUser('user_42') });
    const result = await tools['e2e-reminder']!.execute!({ text: 'Hi' }, toolOpts);
    expect(result).toMatchObject({
      status: 'succeeded', invocationId: 'inv_1', effectId: 'eff_1', endUserId: 'user_42', requestId: 'req_fake_1',
      grade: 'acknowledged', code: null, limits: [], bodyTruncated: false,
    });
  });

  it('name the check tool while waiting for approval', async () => {
    const { client } = makeClient(() => ({ status: 202, body: { success: true, data: { ...invocation({ status: 'pending_approval', approvalId: 'apr_1', responseStatus: null, body: null }), pendingApproval: true } } }));
    const tools = await anlyonTools({ client });
    const result = (await tools['e2e-reminder']!.execute!({}, toolOpts)) as { status: string; approvalId: string; message: string };
    expect(result).toMatchObject({ status: 'pending_approval', invocationId: 'inv_1', approvalId: 'apr_1' });
    expect(result.message).toContain('call anlyon_check_request with invocationId "inv_1"');

    const plain = await anlyonTools({ client, checkTool: false });
    const quiet = (await plain['e2e-reminder']!.execute!({}, toolOpts)) as { message: string };
    expect(quiet.message).not.toContain('anlyon_check_request');
  });

  it('report a limit refusal with a code and the limit, not only prose', async () => {
    const error = 'Dispatch refused (impact_limit_exceeded): Not enough allowance: Reminders per day needs 1, has 0.';
    const { client } = makeClient(() => ({ body: { success: true, data: { ...invocation({ status: 'failed', responseStatus: null, body: null, error, grade: null }), pendingApproval: false } } }));
    const tools = await anlyonTools({ client });
    const result = (await tools['e2e-reminder']!.execute!({}, toolOpts)) as { code: string; limits: unknown[]; message: string; status: string };
    expect(result).toMatchObject({ status: 'failed', code: 'impact_limit_exceeded', limits: [{ name: 'Reminders per day', requested: 1, available: 0 }] });
    expect(result.message).toMatch(/refused because a limit was reached \(Reminders per day: needs 1, 0 left\)\. Nothing was sent/);
  });

  it('cap a long body with a marker', async () => {
    const long = 'x'.repeat(9000);
    const { client } = makeClient(() => ({ body: { success: true, data: { ...invocation({ body: long }), pendingApproval: false } } }));
    const tools = await anlyonTools({ client, maxBodyChars: 100 });
    const result = (await tools['e2e-reminder']!.execute!({}, toolOpts)) as { body: string; bodyTruncated: boolean; message: string };
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toBe(`${'x'.repeat(100)}…[truncated: 8900 more characters]`);
    expect(result.message.length).toBeLessThan(300);
  });

  it('invokeAction from createAnlyonTools caps the body at 8,000 characters', async () => {
    const { client } = makeClient(() => ({ body: { success: true, data: { ...invocation({ body: 'y'.repeat(20000) }), pendingApproval: false } } }));
    const text = (await anlyonInvokeActionTool(client).execute!({ name: 'e2e-reminder', input: {} }, toolOpts)) as string;
    expect(text).toContain('…[truncated: 12000 more characters]');
    expect(text.length).toBeLessThan(8200);
  });
});

describe('refusalOf', () => {
  it('reads policy, decline, expiry and dispatch refusals, and nothing else', () => {
    expect(refusalOf({ status: 'denied', error: null, decision: { code: 'POLICY_DENIED' } as never })).toEqual({ code: 'policy_denied', limits: [] });
    expect(refusalOf({ status: 'denied', error: null, decision: { code: 'HUMAN_DENIED' } as never })).toEqual({ code: 'approval_denied', limits: [] });
    expect(refusalOf({ status: 'expired', error: null })).toEqual({ code: 'approval_expired', limits: [] });
    expect(refusalOf({ status: 'failed', error: 'Dispatch refused (credential_unavailable): No key.' })).toEqual({ code: 'credential_unavailable', limits: [] });
    expect(refusalOf({ status: 'failed', error: 'HTTP 500' })).toBeNull();
    expect(refusalOf({ status: 'succeeded', error: null })).toBeNull();
    expect(refusalOf({ status: 'failed', error: 'Dispatch refused (impact_limit_exceeded): Not enough allowance: Refunds needs 1250, has 0; Emails needs 3, has 1.' })).toEqual({
      code: 'impact_limit_exceeded',
      limits: [{ name: 'Refunds', requested: 1250, available: 0 }, { name: 'Emails', requested: 3, available: 1 }],
    });
  });
});

describe('capBody', () => {
  it('leaves a short body and null alone', () => {
    expect(capBody('abc', 3)).toEqual({ body: 'abc', truncated: false });
    expect(capBody(null)).toEqual({ body: null, truncated: false });
  });
});

describe('anlyon_check_request', () => {
  it('reads the outcome on the same forUser client after approval, with the approval', async () => {
    const { client, paths } = makeClient((path) => {
      if (path === '/api/v2/actions/invocations/inv_1') return { body: { success: true, data: invocation({ approvalId: 'apr_1' }) } };
      if (path === '/api/v2/approvals/apr_1') return { body: { success: true, data: { id: 'apr_1', status: 'approved' } } };
      return undefined;
    });
    const tools = await anlyonTools({ client: client.forUser('user_42') });
    const result = await tools.anlyon_check_request!.execute!({ invocationId: 'inv_1' }, toolOpts);
    expect(result).toMatchObject({ status: 'succeeded', action: 'e2e-reminder', approvalStatus: 'approved', effectId: 'eff_1', endUserId: 'user_42' });
    expect((result as { message: string }).message).toMatch(/^It was approved and Action "e2e-reminder" succeeded/);
    expect(paths.every(([, endUser]) => endUser === 'user_42')).toBe(true);
  });

  it('answers at once while the person has not decided', async () => {
    let reads = 0;
    const { client } = makeClient((path) => {
      if (path === '/api/v2/actions/invocations/inv_1') {
        reads++;
        return { body: { success: true, data: invocation({ status: 'pending_approval', approvalId: 'apr_1', body: null }) } };
      }
      if (path === '/api/v2/approvals/apr_1') return { body: { success: true, data: { id: 'apr_1', status: 'pending' } } };
      return undefined;
    });
    const result = await anlyonCheckRequestTool(client).execute!({ invocationId: 'inv_1' }, toolOpts);
    expect(reads).toBe(1);
    expect(result).toMatchObject({ status: 'pending_approval', approvalStatus: 'pending' });
    expect((result as { message: string }).message).toMatch(/still waiting for the user's decision/);
  });

  it('waits briefly for a just-approved call to run', async () => {
    let reads = 0;
    const { client } = makeClient((path) => {
      if (path === '/api/v2/actions/invocations/inv_1') {
        reads++;
        return { body: { success: true, data: invocation(reads < 2 ? { status: 'pending_approval', approvalId: 'apr_1', body: null } : { approvalId: 'apr_1' }) } };
      }
      if (path === '/api/v2/approvals/apr_1') return { body: { success: true, data: { id: 'apr_1', status: 'approved' } } };
      return undefined;
    });
    const result = await anlyonCheckRequestTool(client, { settleMs: 3000 }).execute!({ invocationId: 'inv_1' }, toolOpts);
    expect(reads).toBe(2);
    expect(result).toMatchObject({ status: 'succeeded', approvalStatus: 'approved' });
  });

  it('reports a decline as declined, with its code', async () => {
    const { client } = makeClient((path) => {
      if (path === '/api/v2/actions/invocations/inv_1') {
        return { body: { success: true, data: invocation({ status: 'denied', approvalId: 'apr_1', body: null, responseStatus: null, decision: { code: 'HUMAN_DENIED' } }) } };
      }
      if (path === '/api/v2/approvals/apr_1') return { body: { success: true, data: { id: 'apr_1', status: 'denied' } } };
      return undefined;
    });
    const result = await anlyonCheckRequestTool(client).execute!({ invocationId: 'inv_1' }, toolOpts);
    expect(result).toMatchObject({ status: 'denied', code: 'approval_denied', approvalStatus: 'denied', message: 'Action "e2e-reminder" was declined, so it did not run.' });
  });

  it('tells the model not to retry an unknown outcome', async () => {
    const { client } = makeClient((path) =>
      path === '/api/v2/actions/invocations/inv_1' ? { body: { success: true, data: invocation({ status: 'unknown', body: null }) } } : undefined);
    const result = await anlyonCheckRequestTool(client).execute!({ invocationId: 'inv_1' }, toolOpts);
    expect((result as { message: string }).message).toMatch(/Do not invoke it again/);
  });

  it('says so for an id this client cannot read', async () => {
    const { client } = makeClient(() => undefined);
    const result = await anlyonCheckRequestTool(client).execute!({ invocationId: 'inv_other' }, toolOpts);
    expect(result).toMatchObject({ status: 'not_found', invocationId: 'inv_other' });
  });
});
