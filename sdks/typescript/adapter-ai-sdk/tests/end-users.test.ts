import { describe, expect, it, vi } from 'vitest';
import { asSchema, generateText, type ToolExecutionOptions, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Client } from '@anlyonhq/sdk';
import { anlyonTools, connectRequiredResult } from '../src/actions.ts';
import { createAnlyonTools, anlyonInvokeActionTool } from '../src/tools.ts';

const toolOpts: ToolExecutionOptions<never> = { toolCallId: 't1', messages: [], context: undefined as never };

const SEND_SCHEMA = {
  type: 'object',
  properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' } },
  required: ['to'],
};

const ACTIONS = [
  { name: 'gmail-send-email', description: 'Send an email from the user\'s Gmail.', enabled: true, requiresApproval: false, inputSchema: SEND_SCHEMA },
  { name: 'gmail-list-labels', description: null, enabled: true, requiresApproval: false, inputSchema: {} },
  { name: 'retired', description: 'Off.', enabled: false, requiresApproval: false, inputSchema: {} },
];

const CONNECT = {
  integration: 'gmail',
  endUserId: 'user_42',
  connectUrl: 'https://connect.anlyon.com/l/cl_abc',
  expiresAt: '2026-10-24T12:10:00.000Z',
};

type Reply = { status?: number; body: unknown };

function makeClient(invoke: Reply[]) {
  const calls: Array<{ path: string; endUser: string | null; body: unknown }> = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, endUser: new Headers(init.headers).get('Anlyon-End-User'), body: init.body ? JSON.parse(init.body as string) : undefined });
    const reply: Reply = path === '/api/v2/actions' ? { body: { success: true, data: ACTIONS } } : invoke[Math.min(i++, invoke.length - 1)];
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new Client({ apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
  return { client, calls };
}

const notConnected: Reply = { status: 409, body: { success: false, error: { code: 'END_USER_NOT_CONNECTED', message: 'Connect Gmail first.', details: CONNECT } } };
const reconnect: Reply = { status: 409, body: { success: false, error: { code: 'END_USER_RECONNECT_REQUIRED', message: 'Reconnect Gmail.', details: CONNECT } } };
const succeeded: Reply = { body: { success: true, data: { id: 'inv_1', status: 'succeeded', pendingApproval: false, approvalId: null, responseStatus: 200, body: '{"id":"m_1"}', grade: 'confirmed' } } };

function propertyNames(schema: unknown, into: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, into);
  } else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object') into.push(...Object.keys(value));
      propertyNames(value, into);
    }
  }
  return into;
}

async function schemaOf(tools: ToolSet, name: string): Promise<unknown> {
  return await asSchema(tools[name]!.inputSchema).jsonSchema;
}

describe('anlyonTools', () => {
  it('builds one tool per chosen action with the action\'s own schema, and acts for the bound end user', async () => {
    const { client, calls } = makeClient([succeeded]);
    const tools = await anlyonTools({ client: client.forUser('user_42'), actions: ['gmail-send-email'] });

    expect(Object.keys(tools)).toEqual(['gmail-send-email', 'anlyon_check_request']);
    expect(await schemaOf(tools, 'gmail-send-email')).toEqual(SEND_SCHEMA);

    const result = await tools['gmail-send-email']!.execute!({ to: ['a@example.com'], subject: 'Hi' }, toolOpts);
    expect(result).toMatchObject({ status: 'succeeded', invocationId: 'inv_1', grade: 'confirmed' });
    expect(calls.map((c) => [c.path, c.endUser])).toEqual([
      ['/api/v2/actions', 'user_42'],
      ['/api/v2/actions/gmail-send-email/invoke', 'user_42'],
    ]);
    expect(calls[1].body).toEqual({ input: { to: ['a@example.com'], subject: 'Hi' } });
  });

  it('returns every enabled action without a filter, and refuses an unknown or disabled name', async () => {
    const { client } = makeClient([succeeded]);
    expect(Object.keys(await anlyonTools({ client }))).toEqual(['gmail-send-email', 'gmail-list-labels', 'anlyon_check_request']);
    expect(Object.keys(await anlyonTools({ client, checkTool: false }))).toEqual(['gmail-send-email', 'gmail-list-labels']);
    expect(Object.keys(await anlyonTools({ client, checkTool: 'check_call' }))).toEqual(['gmail-send-email', 'gmail-list-labels', 'check_call']);
    await expect(anlyonTools({ client, actions: ['nope', 'retired'] })).rejects.toThrow(/nope, retired/);
  });

  it('returns connect_required as a result, not an error, with a message the model can relay', async () => {
    const { client } = makeClient([notConnected]);
    const tools = await anlyonTools({ client: client.forUser('user_42'), actions: ['gmail-send-email'] });
    const result = await tools['gmail-send-email']!.execute!({ to: ['a@example.com'] }, toolOpts);
    expect(result).toEqual({
      status: 'connect_required',
      integration: 'gmail',
      displayName: 'Gmail',
      connectUrl: CONNECT.connectUrl,
      endUserId: 'user_42',
      requestId: null,
      message: 'The user has not connected Gmail yet, so nothing was done. Ask them to connect it, then try again.',
    });
  });

  it("names a tool adopted from an MCP server by the server's name the API gave", async () => {
    const integration = 'mcp-3f2a0c1e-0000-4000-8000-000000000001';
    const { client } = makeClient([{ status: 409, body: { success: false, error: { code: 'END_USER_NOT_CONNECTED', message: 'Connect Tracker first.', integration, displayName: 'Tracker', endUserId: 'user_42', connectUrl: CONNECT.connectUrl } } }]);
    const tools = await anlyonTools({ client: client.forUser('user_42'), actions: ['gmail-send-email'] });
    const result = await tools['gmail-send-email']!.execute!({ to: ['a@example.com'] }, toolOpts);
    expect(result).toMatchObject({
      status: 'connect_required',
      integration,
      displayName: 'Tracker',
      connectUrl: CONNECT.connectUrl,
      message: 'The user has not connected Tracker yet, so nothing was done. Ask them to connect it, then try again.',
    });
  });

  it('returns reconnect_required for a revoked connection', async () => {
    const { client } = makeClient([reconnect]);
    const tools = await anlyonTools({ client: client.forUser('user_42'), actions: ['gmail-send-email'] });
    const result = await tools['gmail-send-email']!.execute!({ to: ['a@example.com'] }, toolOpts);
    expect(result).toMatchObject({ status: 'reconnect_required', integration: 'gmail', connectUrl: CONNECT.connectUrl });
  });

  it('still throws every other error', async () => {
    const { client } = makeClient([{ status: 400, body: { success: false, error: { code: 'END_USER_REQUIRED', message: 'This key requires an end user.' } } }]);
    const tools = await anlyonTools({ client, actions: ['gmail-send-email'] });
    await expect(tools['gmail-send-email']!.execute!({ to: [] }, toolOpts)).rejects.toMatchObject({ code: 'END_USER_REQUIRED' });
  });

  it('reaches the model as a tool result through generateText', async () => {
    const { client } = makeClient([notConnected]);
    const tools = await anlyonTools({ client: client.forUser('user_42'), actions: ['gmail-send-email'] });
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'gmail-send-email', input: JSON.stringify({ to: ['a@example.com'] }) }],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      },
    });
    const result = await generateText({ model, tools, prompt: 'Email a@example.com' });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.output).toMatchObject({ status: 'connect_required', connectUrl: CONNECT.connectUrl });
  });
});

describe('invokeAction with a forUser client', () => {
  it('returns connect_required instead of throwing', async () => {
    const { client } = makeClient([notConnected]);
    const result = await anlyonInvokeActionTool(client.forUser('user_42')).execute!({ name: 'gmail-send-email', input: { to: [] } }, toolOpts);
    expect(result).toMatchObject({ status: 'connect_required', integration: 'gmail', connectUrl: CONNECT.connectUrl });
  });
});

describe('connectRequiredResult', () => {
  it('reads the fields from the error, or from its details, and ignores other errors', () => {
    expect(connectRequiredResult({ code: 'END_USER_NOT_CONNECTED', details: CONNECT })).toMatchObject({ status: 'connect_required', integration: 'gmail' });
    expect(connectRequiredResult({ code: 'END_USER_REQUIRED' })).toBeNull();
    expect(connectRequiredResult(new Error('boom'))).toBeNull();
    expect(connectRequiredResult(undefined)).toBeNull();
  });

  it('has a null connectUrl when the API sent none', () => {
    expect(connectRequiredResult({ code: 'END_USER_NOT_CONNECTED', details: { integration: 'gmail', endUserId: 'user_42' } })).toMatchObject({
      status: 'connect_required',
      integration: 'gmail',
      connectUrl: null,
    });
  });
});

describe('isolation: no tool schema has an end-user field', () => {
  const endUserField = /end[\W_]*user|anlyon[\W_]*end/i;

  it('holds for every tool either factory returns, bound or not', async () => {
    const { client } = makeClient([succeeded]);
    for (const c of [client, client.forUser('user_42')]) {
      const sets: ToolSet[] = [createAnlyonTools(c, { legacy: true }), await anlyonTools({ client: c })];
      for (const tools of sets) {
        for (const name of Object.keys(tools)) {
          const names = propertyNames(await schemaOf(tools, name));
          expect(names.filter((n) => endUserField.test(n)), `${name}: ${names.join(', ')}`).toEqual([]);
        }
      }
    }
  });

  it('a bound client produces exactly the schemas an unbound one does', async () => {
    const { client } = makeClient([succeeded]);
    const plain = await anlyonTools({ client });
    const bound = await anlyonTools({ client: client.forUser('user_42') });
    for (const name of Object.keys(plain)) {
      expect(await schemaOf(bound, name)).toEqual(await schemaOf(plain, name));
    }
  });
});
