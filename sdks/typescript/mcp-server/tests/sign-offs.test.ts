import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignOffRequiredError, type Action, type SignOffRequest } from '@anlyonhq/sdk';

const signOff = (overrides: Partial<SignOffRequest> = {}): SignOffRequest => ({
  object: 'sign_off_request',
  id: 'sor_fixture',
  status: 'pending',
  operation: 'impact_limit.update',
  environmentId: 'env_fixture',
  resource: { type: 'impact_limit', id: 'lim_1', name: 'Daily refunds' },
  summary: 'Raise impact limit "Daily refunds" from 50000 to 200000',
  changes: [{ field: 'amount', from: 50000, to: 200000, direction: 'loosening', reason: 'Raises a limit.' }],
  diff: '- amount: 50000\n+ amount: 200000',
  signOffUrl: 'https://console.anlyon.com/sign-offs/sor_fixture',
  pollUrl: '/api/v2/sign-offs/sor_fixture',
  pollAfterSeconds: 5,
  requestedBy: { type: 'oauth_client', id: 'client_1', onBehalfOf: 'user_1' },
  createdAt: '2026-10-28T00:00:00.000Z',
  expiresAt: '2026-10-29T00:00:00.000Z',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  result: null,
  error: null,
  ...overrides,
});

const ACTION: Action = {
  id: 'act_1',
  name: 'raise-limit',
  description: 'Raise a limit.',
  method: 'POST',
  urlTemplate: 'https://api.example.com/limits',
  headers: {},
  bodyTemplate: null,
  inputSchema: { type: 'object', properties: {} },
  requiresApproval: false,
  enabled: true,
  secrets: [],
  currentVersionId: 'acv_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const client = {
  actions: {
    list: vi.fn(async () => ({ data: [ACTION] })),
    invoke: vi.fn(async () => {
      throw new SignOffRequiredError(signOff());
    }),
  },
  signOffs: {
    get: vi.fn(async () => ({ data: signOff() })),
    wait: vi.fn(async () => signOff({ status: 'applied', result: { id: 'lim_1', amount: 200000 }, decidedAt: '2026-10-28T00:05:00.000Z' })),
  },
};

vi.mock('../src/client-factory.ts', () => ({ getClient: () => client }));

const { callTool, listTools, signOffRequiredResult } = await import('../src/server.ts');
const { clearActionToolCache } = await import('../src/tools/dynamic-actions.ts');

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]!.text!;

beforeEach(() => {
  clearActionToolCache();
  process.env.ANLYON_API_KEY = 'anlyon_live_fixture';
  client.signOffs.get.mockClear();
  client.signOffs.wait.mockClear();
});

afterEach(() => {
  delete process.env.ANLYON_API_KEY;
});

describe('a tool whose call needs a human’s sign-off', () => {
  it('returns a normal result that leads with the link, then the change, the id and what to do', async () => {
    const result = await callTool('invoke_action', { name: 'raise-limit', input: {} });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text.split('\n')[0]).toBe(
      'A human must approve this change before it applies. Give them this link: https://console.anlyon.com/sign-offs/sor_fixture'
    );
    expect(text).toContain('Raise impact limit "Daily refunds" from 50000 to 200000');
    expect(text).toContain('- amount: 50000\n+ amount: 200000');
    expect(text).toContain('Sign-off id: sor_fixture');
    expect(text.trimEnd().endsWith('You cannot approve it yourself. Call wait_for_sign_off with this id, or check_sign_off later.')).toBe(true);
    expect(result.structuredContent).toEqual({
      status: 'sign_off_required',
      signOffId: 'sor_fixture',
      signOffUrl: 'https://console.anlyon.com/sign-offs/sor_fixture',
      summary: 'Raise impact limit "Daily refunds" from 50000 to 200000',
      diff: '- amount: 50000\n+ amount: 200000',
      expiresAt: '2026-10-29T00:00:00.000Z',
    });
  });

  it('does the same for a generated action tool', async () => {
    const result = await callTool('action_raise-limit', {});
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/^A human must approve this change before it applies\. Give them this link: /);
  });

  it('recognises the error by its code, whichever copy of the SDK threw it', () => {
    const copy = { code: 'SIGN_OFF_REQUIRED', signOff: signOff() };
    expect(signOffRequiredResult(copy)?.signOffId).toBe('sor_fixture');
    expect(signOffRequiredResult({ code: 'SIGN_OFF_REQUIRED' })).toBeNull();
    expect(signOffRequiredResult(new Error('x'))).toBeNull();
  });
});

describe('check_sign_off and wait_for_sign_off', () => {
  it('are listed, read-only, and need no consent group', async () => {
    const { tools } = await listTools();
    for (const name of ['check_sign_off', 'wait_for_sign_off']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
    }
  });

  it('check_sign_off returns the status, the diff and the link', async () => {
    const result = await callTool('check_sign_off', { id: 'sor_fixture' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result));
    expect(client.signOffs.get).toHaveBeenCalledWith('sor_fixture');
    expect(body).toMatchObject({
      id: 'sor_fixture',
      status: 'pending',
      diff: '- amount: 50000\n+ amount: 200000',
      signOffUrl: 'https://console.anlyon.com/sign-offs/sor_fixture',
    });
    expect(body.next).toContain('You cannot approve it yourself.');
  });

  it('wait_for_sign_off caps the wait at 300 seconds and returns the decided request', async () => {
    const result = await callTool('wait_for_sign_off', { id: 'sor_fixture', timeoutSeconds: 300 });
    const body = JSON.parse(textOf(result));
    expect(client.signOffs.wait).toHaveBeenCalledWith('sor_fixture', { timeoutMs: 300_000 });
    expect(body).toMatchObject({ status: 'applied', result: { id: 'lim_1', amount: 200000 } });

    const tooLong = await callTool('wait_for_sign_off', { id: 'sor_fixture', timeoutSeconds: 301 });
    expect(tooLong.isError).toBe(true);
  });

  it('needs an id', async () => {
    expect((await callTool('check_sign_off', {})).isError).toBe(true);
  });
});
