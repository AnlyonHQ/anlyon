import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, SignOffRequiredError } from '../index';

const API = 'https://api.anlyon.com';
const UPSTREAMS = `${API}/api/v2/mcp-upstreams`;

const signOff = {
  object: 'sign_off_request', id: 'sor_1', status: 'pending', operation: 'mcp_upstream.adopt', environmentId: 'env-1',
  resource: { type: 'mcp_upstream', id: 'mcpu_1', name: 'tracker' }, summary: 'Adopt 1 tool', changes: [], diff: '',
  signOffUrl: 'https://console.anlyon.com/sign-offs/sor_1', pollUrl: '/api/v2/sign-offs/sor_1', pollAfterSeconds: 5,
  requestedBy: { type: 'api_key', id: 'key_1' }, createdAt: '2026-11-02T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z',
  decidedAt: null, decidedBy: null, decisionNote: null, result: null, error: null,
};

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('client.mcpUpstreams', () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let answer: () => Response = () => respond(200, { success: true, data: {} });

  beforeEach(() => {
    calls.length = 0;
    answer = () => respond(200, { success: true, data: {} });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const raw = init?.body ?? (request ? await request.clone().text() : undefined);
      calls.push({
        url: request ? request.url : String(input),
        method: init?.method ?? request?.method ?? 'GET',
        body: typeof raw === 'string' && raw ? JSON.parse(raw) : undefined,
      });
      return answer();
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const client = () => new Client({ apiKey: 'anlyon_test_key', baseUrl: API });

  it('reaches each route with the body the API takes', async () => {
    const c = client().mcpUpstreams;
    await c.list();
    await c.get('mcpu_1');
    await c.inspect('https://mcp.example.com/mcp');
    await c.register({ name: 'tracker', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secret:TRACKER}}' } });
    await c.refresh('mcpu_1');
    await c.adopt('mcpu_1', { list_issues: {} });
    await c.archive('mcpu_1');
    await c.createConnectLink('mcpu_1', { endUserId: 'user-1' });
    expect(calls.map((call) => `${call.method} ${call.url.replace(UPSTREAMS, '')}`)).toEqual([
      'GET ', 'GET /mcpu_1', 'POST /inspect', 'POST ', 'POST /mcpu_1/refresh', 'POST /mcpu_1/adopt', 'POST /mcpu_1/archive', 'POST /mcpu_1/connect-links',
    ]);
    expect(calls[2]!.body).toEqual({ url: 'https://mcp.example.com/mcp' });
    expect(calls[3]!.body).toEqual({ name: 'tracker', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secret:TRACKER}}' } });
    expect(calls[5]!.body).toEqual({ tools: { list_issues: {} } });
    expect(calls[7]!.body).toEqual({ endUserId: 'user-1' });
  });

  it('adopt throws SignOffRequiredError with the link a person approves at', async () => {
    answer = () => respond(202, { success: true, signOffRequired: true, data: signOff });
    const error = await client().mcpUpstreams.adopt('mcpu_1', { delete_issue: { requiresApproval: true } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignOffRequiredError);
    expect((error as SignOffRequiredError).signOffUrl).toBe(signOff.signOffUrl);
  });
});
