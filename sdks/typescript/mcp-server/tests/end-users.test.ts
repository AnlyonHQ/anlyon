import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endUserFlag, requestContext, resolveEndUserId, setProcessEndUser } from '../src/auth.ts';
import { callTool, connectRequiredResult, listTools } from '../src/server.ts';
import { clearActionToolCache } from '../src/tools/dynamic-actions.ts';

interface Sent {
  method: string;
  path: string;
  endUser: string | null;
}

const ACTIONS = [
  {
    id: 'act_send',
    name: 'gmail-send',
    description: 'Send an email from the user’s Gmail.',
    method: 'POST',
    urlTemplate: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    headers: { Authorization: 'Bearer {{connection:gmail}}' },
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to'] },
    requiresApproval: false,
    enabled: true,
    secrets: [],
  },
  {
    id: 'act_issue',
    name: 'github-create-issue',
    description: 'Open an issue.',
    method: 'POST',
    urlTemplate: 'https://api.github.com/repos/{{input.repo}}/issues',
    headers: { Authorization: 'Bearer {{secret:GITHUB}}' },
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, title: { type: 'string' } } },
    requiresApproval: false,
    enabled: true,
    secrets: ['GITHUB'],
  },
];

const CONNECT = {
  integration: 'gmail',
  connectUrl: 'https://api.anlyon.com/connect/eul_abc',
  expiresAt: '2026-10-24T10:10:00.000Z',
};

let sent: Sent[];
let notConnected: Map<string, 'END_USER_NOT_CONNECTED' | 'END_USER_RECONNECT_REQUIRED'>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sent = [];
  notConnected = new Map();
  clearActionToolCache();
  setProcessEndUser(undefined);
  delete process.env.ANLYON_END_USER;
  process.env.ANLYON_API_KEY = 'anlyon_live_endusers';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const endUser = headers.get('Anlyon-End-User');
      const path = new URL(url.toString()).pathname;
      const method = init.method ?? 'GET';
      sent.push({ method, path, endUser });
      if (method === 'GET' && path === '/api/v2/actions') return json(200, { success: true, data: ACTIONS });
      const invoked = path.match(/^\/api\/v2\/actions\/([^/]+)\/invoke$/)?.[1];
      if (invoked) {
        const code = endUser ? notConnected.get(endUser) : undefined;
        if (code) {
          return json(409, {
            success: false,
            error: { code, message: 'The end user has no Gmail account connected.', endUserId: endUser, ...CONNECT },
          });
        }
        return json(200, {
          success: true,
          data: { id: `inv_${endUser ?? 'workspace'}`, actionName: invoked, status: 'succeeded', responseStatus: 200, body: '{}', pendingApproval: false },
        });
      }
      return json(404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    }),
  );
});

afterEach(() => {
  setProcessEndUser(undefined);
  delete process.env.ANLYON_API_KEY;
  delete process.env.ANLYON_END_USER;
  vi.unstubAllGlobals();
});

const asUser = <T>(endUserId: string | undefined, fn: () => Promise<T>) =>
  requestContext.run({ apiKey: 'anlyon_live_endusers', cacheScope: 'key_1', ...(endUserId ? { endUserId } : {}) }, fn);

describe('isolation between end users', () => {
  it('sends only the bound end user on every request a call makes, with calls for two users interleaved', async () => {
    const [a, b] = await Promise.all([
      asUser('user_a', () => callTool('action_gmail-send', { to: 'x@example.com' })),
      asUser('user_b', () => callTool('action_gmail-send', { to: 'y@example.com' })),
    ]);

    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(JSON.parse((a.content[0] as { text: string }).text).id).toBe('inv_user_a');
    expect(JSON.parse((b.content[0] as { text: string }).text).id).toBe('inv_user_b');

    const invokes = sent.filter((s) => s.path.endsWith('/invoke'));
    expect(invokes.map((s) => s.endUser).sort()).toEqual(['user_a', 'user_b']);
    expect(sent.every((s) => s.endUser === 'user_a' || s.endUser === 'user_b')).toBe(true);
  });

  it('lists tools for one end user without a request for another', async () => {
    await asUser('user_a', () => listTools());
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.endUser === 'user_a')).toBe(true);
  });

  it('never reuses one end user’s client for another, or for the workspace', async () => {
    await asUser('user_a', () => callTool('invoke_action', { name: 'gmail-send', input: { to: 'x@example.com' } }));
    await asUser(undefined, () => callTool('invoke_action', { name: 'gmail-send', input: { to: 'x@example.com' } }));
    await asUser('user_b', () => callTool('invoke_action', { name: 'gmail-send', input: { to: 'x@example.com' } }));

    expect(sent.filter((s) => s.path.endsWith('/invoke')).map((s) => s.endUser)).toEqual(['user_a', null, 'user_b']);
  });

  it('has no tool whose input schema can name an end user', async () => {
    const { tools } = await asUser('user_a', () => listTools());
    expect(tools.some((t) => t.name === 'action_gmail-send')).toBe(true);
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/end.?user|anlyon-end-user|for_?user/i);
    }
  });

  it('ignores an end-user field a model puts in the arguments', async () => {
    await asUser('user_a', () =>
      callTool('invoke_action', { name: 'gmail-send', input: { to: 'x@example.com' }, endUserId: 'user_b', endUser: 'user_b' }),
    );
    const invoke = sent.find((s) => s.path.endsWith('/invoke'));
    expect(invoke?.endUser).toBe('user_a');
  });
});

describe('connect-required results', () => {
  it('returns connect_required as a result, not an error, with a message the model can relay', async () => {
    notConnected.set('user_a', 'END_USER_NOT_CONNECTED');
    const result = await asUser('user_a', () => callTool('action_gmail-send', { to: 'x@example.com' }));

    expect(result.isError).toBeUndefined();
    const expected = {
      status: 'connect_required',
      integration: 'gmail',
      connectUrl: CONNECT.connectUrl,
      message: 'The user has not connected gmail yet, so nothing was done. Ask them to connect it, then try again.',
    };
    expect(result.structuredContent).toEqual(expected);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(expected);
  });

  it('returns reconnect_required for a revoked connection, from the generic invoke tool too', async () => {
    notConnected.set('user_a', 'END_USER_RECONNECT_REQUIRED');
    const result = await asUser('user_a', () => callTool('invoke_action', { name: 'gmail-send', input: { to: 'x@example.com' } }));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ status: 'reconnect_required', integration: 'gmail', connectUrl: CONNECT.connectUrl });
  });

  it('affects only the end user who is not connected', async () => {
    notConnected.set('user_b', 'END_USER_NOT_CONNECTED');
    const a = await asUser('user_a', () => callTool('action_gmail-send', { to: 'x@example.com' }));
    expect(a.structuredContent).toBeUndefined();
    expect(JSON.parse((a.content[0] as { text: string }).text).status).toBe('succeeded');
  });

  it('matches the AI SDK adapter: null for any other error, connectUrl null when the API sent none', () => {
    expect(connectRequiredResult(new Error('boom'))).toBeNull();
    expect(connectRequiredResult({ code: 'END_USER_REQUIRED' })).toBeNull();
    expect(connectRequiredResult({ code: 'END_USER_NOT_CONNECTED', details: { integration: 'gmail' } })).toEqual({
      status: 'connect_required',
      integration: 'gmail',
      connectUrl: null,
      message: 'The user has not connected gmail yet, so nothing was done. Ask them to connect it, then try again.',
    });
  });

  it("names an MCP server by the API's displayName", () => {
    const integration = 'mcp-3f2a0c1e-0000-4000-8000-000000000001';
    expect(connectRequiredResult({ code: 'END_USER_NOT_CONNECTED', integration, displayName: 'Tracker', connectUrl: CONNECT.connectUrl })).toEqual({
      status: 'connect_required',
      integration,
      displayName: 'Tracker',
      connectUrl: CONNECT.connectUrl,
      message: 'The user has not connected Tracker yet, so nothing was done. Ask them to connect it, then try again.',
    });
  });
});

describe('stating the end user', () => {
  it('reads --end-user in both spellings', () => {
    expect(endUserFlag(['node', 'anlyon-mcp', '--end-user', 'user_1'])).toBe('user_1');
    expect(endUserFlag(['node', 'anlyon-mcp', '--end-user=org:5:user:9'])).toBe('org:5:user:9');
    expect(endUserFlag(['node', 'anlyon-mcp'])).toBeUndefined();
  });

  it('uses --end-user, then ANLYON_END_USER, for a stdio process', () => {
    expect(resolveEndUserId()).toBeNull();
    process.env.ANLYON_END_USER = 'user_env';
    expect(resolveEndUserId()).toBe('user_env');
    setProcessEndUser('user_flag');
    expect(resolveEndUserId()).toBe('user_flag');
  });

  it('never applies the process setting to a hosted request', async () => {
    process.env.ANLYON_END_USER = 'user_env';
    setProcessEndUser('user_flag');
    expect(requestContext.run({ apiKey: 'k' }, () => resolveEndUserId())).toBeNull();
    expect(requestContext.run({ apiKey: 'k', endUserId: 'user_a' }, () => resolveEndUserId())).toBe('user_a');
  });

  it('sends ANLYON_END_USER on every stdio call', async () => {
    process.env.ANLYON_END_USER = 'user_stdio';
    await callTool('action_gmail-send', { to: 'x@example.com' });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.endUser === 'user_stdio')).toBe(true);
  });
});

describe('serving a subset of actions', () => {
  const github = { actions: (name: string) => name.startsWith('github-') };

  it('lists and calls only the actions the host serves', async () => {
    const { tools } = await asUser('user_a', () => listTools(github));
    const actionTools = tools.map((t) => t.name).filter((n) => n.startsWith('action_'));
    expect(actionTools).toEqual(['action_github-create-issue']);

    const refused = await asUser('user_a', () => callTool('action_gmail-send', { to: 'x@example.com' }, github));
    expect(refused.isError).toBe(true);
    expect(sent.some((s) => s.path.endsWith('/invoke'))).toBe(false);
  });
});
