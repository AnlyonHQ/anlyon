import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';
import {
  AnlyonError,
  EndUserConnectionRequiredError,
  EndUserNotConnectedError,
  EndUserReconnectRequiredError,
  EndUserRequiredError,
  EndUserMismatchError,
  RedirectUrlRequiredError,
  createErrorFromResponse,
} from '../core/errors';
import { END_USER_HEADER, isValidEndUserId, parseConnectRedirect } from '../core/end-user';

interface MockResponse { status?: number; body: unknown }
interface Call { url: string; method: string; body: unknown; endUser: string | null }

function makeClient(responses: MockResponse[] = [{ body: { success: true, data: {} } }], config: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
      endUser: headers.get(END_USER_HEADER),
    });
    const next = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new Client({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    fetch: fetchFn as unknown as typeof fetch,
    retry: { maxAttempts: 3, initialDelay: 1 },
    ...config,
  });
  return { client, calls, fetchFn };
}

const ok = (data: unknown) => ({ body: { success: true, data } });
const route = (call: Call) => `${call.method} ${new URL(call.url).pathname}`;

const connectDetails = {
  integration: 'gmail',
  endUserId: 'user_42',
  connectUrl: 'https://connect.anlyon.com/l/cl_abc',
  expiresAt: '2026-10-24T12:10:00.000Z',
};

describe('forUser', () => {
  it('sends Anlyon-End-User on every request of the bound client, and never on the parent', async () => {
    const { client, calls } = makeClient([ok({ status: 'succeeded', pendingApproval: false }), ok([]), ok([])]);
    const forUser = client.forUser('user_42');

    await forUser.actions.invoke('gmail.send', { to: ['a@example.com'] });
    await forUser.approvals.list();
    await client.approvals.list();

    expect(calls.map((c) => c.endUser)).toEqual(['user_42', 'user_42', null]);
    expect(forUser.endUserId).toBe('user_42');
    expect(client.endUserId).toBeUndefined();
  });

  it('checks the id before anything is sent', () => {
    const { client, fetchFn } = makeClient();
    for (const bad of ['', 'a b', 'user/42', 'ü', 'x'.repeat(129), 'a\r\nX-Injected: 1', undefined, 42]) {
      expect(() => client.forUser(bad as string)).toThrow(AnlyonError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    for (const good of ['u', 'user_42', 'auth0:abc', 'jane@example.com', 'A.b-c_d:e@f', 'x'.repeat(128)]) {
      expect(isValidEndUserId(good)).toBe(true);
      expect(client.forUser(good).endUserId).toBe(good);
    }
  });

  it('is fixed once bound: it cannot be switched, and the same id returns the same client', () => {
    const { client } = makeClient();
    const forUser = client.forUser('user_a');
    expect(forUser.forUser('user_a')).toBe(forUser);
    expect(() => forUser.forUser('user_b')).toThrow(/cannot be switched/);
    expect(forUser).not.toBe(client);
    expect(() => {
      (forUser as unknown as { endUserId: string }).endUserId = 'user_b';
    }).toThrow(TypeError);
    expect(forUser.endUserId).toBe('user_a');
  });

  it('keeps two end users apart', async () => {
    const { client, calls } = makeClient([ok({ status: 'succeeded', pendingApproval: false })]);
    const a = client.forUser('user_a');
    const b = client.forUser('user_b');
    await a.actions.invoke('gmail.send', {});
    await b.actions.invoke('gmail.send', {});
    await a.actions.invoke('gmail.send', {});
    expect(calls.map((c) => c.endUser)).toEqual(['user_a', 'user_b', 'user_a']);
  });

  it('refuses the header in defaultHeaders, under any capitalisation', () => {
    for (const name of ['Anlyon-End-User', 'anlyon-end-user', 'ANLYON-END-USER']) {
      expect(() => makeClient(undefined, { defaultHeaders: { [name]: 'user_42' } })).toThrow(/forUser/);
    }
  });

  it('a bound client refuses another end user on the end-user routes, before sending', async () => {
    const { client, fetchFn } = makeClient();
    const forUser = client.forUser('user_a');
    await expect(forUser.endUsers.listConnections('user_b')).rejects.toThrow(/different end user/);
    await expect(forUser.endUsers.approvals.list('user_b')).rejects.toThrow(/different end user/);
    await expect(forUser.endUsers.approvals.decide('user_b', 'apr_1', { decision: 'approve' })).rejects.toThrow(/different end user/);
    await expect(forUser.endUsers.list()).rejects.toThrow(/cannot list the others/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('endUsers', () => {
  it('creates a connect link, with and without a redirect URL', async () => {
    const link = { url: 'https://connect.anlyon.com/l/cl_abc', expiresAt: '2026-10-24T12:10:00.000Z' };
    const { client, calls } = makeClient([ok(link)]);
    const { data } = await client.endUsers.createConnectLink({ endUserId: 'user_42', integration: 'gmail', redirectUrl: 'https://app.example.com/done' });
    await client.endUsers.createConnectLink({ endUserId: 'jane@example.com', integration: 'slack' });
    expect(data).toEqual(link);
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/end-users/user_42/connect-links', method: 'POST', body: { integration: 'gmail', redirectUrl: 'https://app.example.com/done' }, endUser: 'user_42' },
      { url: 'https://api.test/api/v2/end-users/jane%40example.com/connect-links', method: 'POST', body: { integration: 'slack' }, endUser: 'jane@example.com' },
    ]);
  });

  it('stores, lists and deletes connections, and erases an end user', async () => {
    const connection = { integration: 'notion', status: 'active', scopes: [], connectedAt: 'x', updatedAt: 'x' };
    const erasure = { connectionsDeleted: 1, approvalsCancelled: 2, countersCleared: 3, erasedAs: 'eu_erased_0000' };
    const { client, calls } = makeClient([ok(connection), ok([connection]), ok({ deleted: true }), ok(erasure)]);
    expect((await client.endUsers.setConnection('user_42', 'notion', { token: 'fixture-not-a-key' })).data).toEqual(connection);
    expect((await client.endUsers.listConnections('user_42')).data).toEqual([connection]);
    expect((await client.endUsers.deleteConnection('user_42', 'notion')).data).toEqual({ deleted: true });
    const erased = (await client.endUsers.erase('user_42')).data!;
    expect(erased).toEqual(erasure);
    expect(erased.connectionsDeleted + erased.approvalsCancelled + erased.countersCleared).toBe(6);
    expect(calls.map(route)).toEqual([
      'PUT /api/v2/end-users/user_42/connections/notion',
      'GET /api/v2/end-users/user_42/connections',
      'DELETE /api/v2/end-users/user_42/connections/notion',
      'DELETE /api/v2/end-users/user_42',
    ]);
    expect(calls[0].body).toEqual({ token: 'fixture-not-a-key' });
    expect(calls.every((c) => c.endUser === 'user_42')).toBe(true);
  });

  it('lists end users by cursor, without naming one', async () => {
    const page = { success: true, data: [{ endUserId: 'user_42', connections: 2, invocations: 5, pendingApprovals: 1 }], pagination: { nextCursor: 'c_2' } };
    const { client, calls } = makeClient([{ body: page }]);
    const result = await client.endUsers.list({ cursor: 'c_1' });
    expect(result.pagination.nextCursor).toBe('c_2');
    expect(calls[0].url).toBe('https://api.test/api/v2/end-users?cursor=c_1');
    expect(calls[0].endUser).toBeNull();
  });

  it('lists and decides the end user\'s approvals with the matching end user', async () => {
    const { client, calls } = makeClient([ok([{ id: 'apr_1', status: 'pending' }]), ok({ approval: { id: 'apr_1', status: 'approved' } }), ok({ approval: { id: 'apr_2', status: 'denied' } })]);
    await client.endUsers.approvals.list('user_42', { status: 'pending' });
    await client.endUsers.approvals.decide('user_42', 'apr_1', { decision: 'approve' });
    await client.endUsers.approvals.decide('user_42', 'apr_2', { decision: 'deny', reason: 'Not this one' });
    expect(calls.map((c) => [route(c), c.body, c.endUser])).toEqual([
      ['GET /api/v2/end-users/user_42/approvals', undefined, 'user_42'],
      ['POST /api/v2/end-users/user_42/approvals/apr_1/decide', { decision: 'approve' }, 'user_42'],
      ['POST /api/v2/end-users/user_42/approvals/apr_2/decide', { decision: 'deny', reason: 'Not this one' }, 'user_42'],
    ]);
    expect(calls[0].url).toContain('status=pending');
  });

  it('creates a session token for one end user, with an optional lifetime', async () => {
    const session = { token: 'eus_v1.e30.sig', expiresAt: '2026-10-26T12:15:00.000Z', endUserId: 'user_42', capabilities: ['connections', 'approvals'] };
    const { client, calls } = makeClient([ok(session)]);
    const { data } = await client.endUsers.createSession('user_42');
    await client.endUsers.createSession('jane@example.com', { ttlSeconds: 300 });
    expect(data).toEqual(session);
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/end-users/user_42/sessions', method: 'POST', body: {}, endUser: 'user_42' },
      { url: 'https://api.test/api/v2/end-users/jane%40example.com/sessions', method: 'POST', body: { ttlSeconds: 300 }, endUser: 'jane@example.com' },
    ]);
  });

  it('refuses a session lifetime outside 60 to 3600 seconds before sending', async () => {
    const { client, fetchFn } = makeClient();
    for (const ttlSeconds of [59, 3601, 90.5]) {
      await expect(client.endUsers.createSession('user_42', { ttlSeconds })).rejects.toThrow(/ttlSeconds/);
    }
    await expect(client.endUsers.createSession('../admin')).rejects.toThrow(AnlyonError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses malformed input before sending', async () => {
    const { client, fetchFn } = makeClient();
    await expect(client.endUsers.listConnections('../admin')).rejects.toThrow(AnlyonError);
    await expect(client.endUsers.createConnectLink({ endUserId: 'user_42', integration: '' })).rejects.toThrow(/integration/);
    await expect(client.endUsers.setConnection('user_42', 'notion', { token: '' })).rejects.toThrow(/token/);
    await expect(client.endUsers.approvals.decide('user_42', 'apr_1', { decision: 'maybe' as 'approve' })).rejects.toThrow(/approve/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('end-user errors', () => {
  it('maps 409 END_USER_NOT_CONNECTED to EndUserNotConnectedError with the connect link, without retrying', async () => {
    const { client, calls } = makeClient([{ status: 409, body: { success: false, error: { code: 'END_USER_NOT_CONNECTED', message: 'Connect Gmail first.', details: connectDetails } } }]);
    const error = await client.forUser('user_42').actions.invoke('gmail.send', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EndUserNotConnectedError);
    expect(error).toBeInstanceOf(EndUserConnectionRequiredError);
    expect(error).toMatchObject({ code: 'END_USER_NOT_CONNECTED', status: 409, ...connectDetails });
    expect(calls).toHaveLength(1);
  });

  it('maps 409 END_USER_RECONNECT_REQUIRED to EndUserReconnectRequiredError', async () => {
    const { client } = makeClient([{ status: 409, body: { success: false, error: { code: 'END_USER_RECONNECT_REQUIRED', message: 'Reconnect Gmail.', details: connectDetails } } }]);
    const error = await client.forUser('user_42').actions.invoke('gmail.send', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EndUserReconnectRequiredError);
    expect(error).not.toBeInstanceOf(EndUserNotConnectedError);
    expect((error as EndUserReconnectRequiredError).connectUrl).toBe(connectDetails.connectUrl);
  });

  it('maps 400 END_USER_REQUIRED to EndUserRequiredError', async () => {
    const { client } = makeClient([{ status: 400, body: { success: false, error: { code: 'END_USER_REQUIRED', message: 'This key requires an end user.' } } }]);
    const error = await client.actions.invoke('gmail.send', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EndUserRequiredError);
    expect(error).toMatchObject({ code: 'END_USER_REQUIRED', status: 400 });
  });

  it('has a null connectUrl when the environment has no default redirect URL', async () => {
    const { client } = makeClient([{ status: 409, body: { success: false, error: { code: 'END_USER_NOT_CONNECTED', message: 'Connect first.', details: { integration: 'gmail', endUserId: 'user_42' } } } }]);
    const error = (await client.actions.invoke('x', {}).catch((e: unknown) => e)) as EndUserNotConnectedError;
    expect(error.connectUrl).toBeNull();
    expect(error.expiresAt).toBeNull();
    expect(error.integration).toBe('gmail');
    expect(error.displayName).toBeNull();
  });

  it("carries an MCP server's name from the error's own fields", async () => {
    const integration = 'mcp-3f2a0c1e-0000-4000-8000-000000000001';
    const { client } = makeClient([{ status: 409, body: { success: false, error: { code: 'END_USER_NOT_CONNECTED', message: 'Connect Tracker first.', integration, displayName: 'Tracker', endUserId: 'user_42', connectUrl: 'https://api.test/connect?token=t' } } }]);
    const error = (await client.forUser('user_42').actions.invoke('tracker-create_issue', {}).catch((e: unknown) => e)) as EndUserNotConnectedError;
    expect(error).toMatchObject({ integration, displayName: 'Tracker', connectUrl: 'https://api.test/connect?token=t' });
  });

  it('maps 403 END_USER_MISMATCH and 400 REDIRECT_URL_REQUIRED', async () => {
    const { client } = makeClient([
      { status: 403, body: { success: false, error: { code: 'END_USER_MISMATCH', message: 'This flow belongs to another end user.' } } },
      { status: 400, body: { success: false, error: { code: 'REDIRECT_URL_REQUIRED', message: 'Pass a redirectUrl.' } } },
    ]);
    await expect(client.endUsers.confirmConnection('user_42', 'flow_1')).rejects.toBeInstanceOf(EndUserMismatchError);
    await expect(client.endUsers.createConnectLink({ endUserId: 'user_42', integration: 'gmail' })).rejects.toBeInstanceOf(RedirectUrlRequiredError);
  });
});

describe('confirming a connect flow', () => {
  it('confirms with the end user from the path and the header', async () => {
    const { client, calls } = makeClient([ok({ integration: 'gmail', status: 'active' })]);
    const { data } = await client.endUsers.confirmConnection('user_42', 'flow_1');
    expect(data).toEqual({ integration: 'gmail', status: 'active' });
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/end-users/user_42/connections/confirm', method: 'POST', body: { flowId: 'flow_1' }, endUser: 'user_42' },
    ]);
  });

  it('connections.confirm() confirms for the bound end user, and a workspace client refuses', async () => {
    const { client, calls, fetchFn } = makeClient([ok({ integration: 'gmail', status: 'active' })]);
    await expect(client.connections.confirm('flow_1')).rejects.toThrow(/forUser/);
    expect(fetchFn).not.toHaveBeenCalled();
    await client.forUser('user_42').connections.confirm('flow_1');
    expect(calls.map((c) => [route(c), c.endUser])).toEqual([['POST /api/v2/end-users/user_42/connections/confirm', 'user_42']]);
  });

  it('a bound client will not confirm for another end user', async () => {
    const { client, fetchFn } = makeClient();
    await expect(client.forUser('user_a').endUsers.confirmConnection('user_b', 'flow_1')).rejects.toThrow(/different end user/);
    await expect(client.endUsers.confirmConnection('user_42', '')).rejects.toThrow(/flowId/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('parseConnectRedirect', () => {
  it('reads the status, flow and integration, and never the end user', () => {
    const parsed = parseConnectRedirect('https://app.example.com/cb?anlyon_status=pending_confirmation&anlyon_flow=flow_1&integration=gmail&end_user=someone_else');
    expect(parsed).toEqual({ status: 'pending_confirmation', flowId: 'flow_1', integration: 'gmail' });
    expect(parseConnectRedirect(new URLSearchParams('anlyon_status=declined&integration=gmail'))).toEqual({ status: 'declined', flowId: null, integration: 'gmail' });
    expect(parseConnectRedirect(new URL('https://app.example.com/cb?anlyon_status=error'))).toEqual({ status: 'error', flowId: null, integration: null });
    expect(parseConnectRedirect('/cb?anlyon_status=connected')).toMatchObject({ status: 'connected' });
  });

  it('returns null without a recognisable status', () => {
    expect(parseConnectRedirect('https://app.example.com/cb')).toBeNull();
    expect(parseConnectRedirect('https://app.example.com/cb?anlyon_status=hacked')).toBeNull();
    expect(parseConnectRedirect('http://[bad')).toBeNull();
  });
});

describe('connect-required errors from the API', () => {
  it('reads the fields the API puts on the error itself (production drops details)', () => {
    const error = createErrorFromResponse(409, {
      error: {
        code: 'END_USER_NOT_CONNECTED',
        message: 'Connect Gmail first',
        integration: 'gmail',
        endUserId: 'user_42',
        connectUrl: 'https://api.anlyon.com/connect/link?t=abc',
        expiresAt: '2026-10-24T12:00:00.000Z',
      } as { code: string; message: string },
    });
    expect(error).toBeInstanceOf(EndUserNotConnectedError);
    const required = error as EndUserNotConnectedError;
    expect(required.integration).toBe('gmail');
    expect(required.endUserId).toBe('user_42');
    expect(required.connectUrl).toBe('https://api.anlyon.com/connect/link?t=abc');
  });
});

describe('list filters', () => {
  it('passes actingFor, endUserId and decider through to the list routes', async () => {
    const page = { body: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false } } };
    const { client, calls } = makeClient([page]);
    await client.actions.invocations({ actingFor: 'end_users', endUserId: 'user_42' });
    await client.actions.invocationsFor('gmail-send', { actingFor: 'workspace', status: 'unknown' });
    await client.actions.effects({ actingFor: 'end_users', endUserId: 'user_42' });
    await client.approvals.list({ actingFor: 'workspace', decider: 'end_user' });
    const queries = calls.map((call) => Object.fromEntries(new URL(call.url).searchParams));
    expect(queries).toEqual([
      { actingFor: 'end_users', endUserId: 'user_42' },
      { actingFor: 'workspace', status: 'unknown' },
      { actingFor: 'end_users', endUserId: 'user_42' },
      { actingFor: 'workspace', decider: 'end_user' },
    ]);
  });
});

describe('requestId', () => {
  it('reads X-Request-Id onto a successful response without changing its JSON or equality', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { id: 'inv_1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_fixture_1' },
    }));
    const client = new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch });
    const res = await client.actions.invocation('inv_1');
    expect(res.requestId).toBe('req_fixture_1');
    expect(res).toEqual({ success: true, data: { id: 'inv_1' } });
    expect(JSON.parse(JSON.stringify(res))).toEqual({ success: true, data: { id: 'inv_1' } });
  });

  it('is absent when the server sends none', async () => {
    const { client } = makeClient([ok({ id: 'inv_1' })]);
    expect((await client.actions.invocation('inv_1')).requestId).toBeUndefined();
  });
});
