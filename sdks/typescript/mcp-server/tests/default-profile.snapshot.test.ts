import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnlyonError, EndUserNotConnectedError, EndUserReconnectRequiredError, type Action } from '@anlyonhq/sdk';

const SNAPSHOTS = './__snapshots__/default-profile';
const LEGACY_SNAPSHOTS = './__snapshots__/legacy-profile';

const action = (overrides: Partial<Action>): Action => ({
  id: 'act_fixture',
  name: 'update-ticket-priority',
  description: 'Change a support ticket priority.',
  method: 'PATCH',
  urlTemplate: 'https://support.example.com/tickets/{{input.ticketId}}',
  headers: { Authorization: 'Bearer {{secret:SUPPORT_KEY}}' },
  bodyTemplate: { priority: '{{input.priority}}' },
  inputSchema: {
    type: 'object',
    properties: { ticketId: { type: 'string' }, priority: { type: 'string', enum: ['low', 'high'] } },
    required: ['ticketId', 'priority'],
  },
  requiresApproval: true,
  enabled: true,
  secrets: ['SUPPORT_KEY'],
  currentVersionId: 'acv_fixture',
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
  ...overrides,
});

const ACTIONS = [
  action({}),
  action({ id: 'act_read', name: 'get-ticket', description: 'Read a ticket.', method: 'GET', requiresApproval: false, secrets: [] }),
  action({
    id: 'act_declared',
    name: 'send-welcome-email',
    description: 'Send the welcome email.',
    method: 'POST',
    urlTemplate: 'https://mail.example.com/emails',
    headers: { Authorization: 'Bearer {{secret:MAIL_KEY}}' },
    bodyTemplate: { to: '{{input.to}}' },
    inputSchema: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } } }, required: ['to'] },
    requiresApproval: false,
    secrets: ['MAIL_KEY'],
    adapter: null,
    governed: true,
    impact: { dimension: 'emails', unit: 'emails', amount: 'count(input.to)', bound: 'exact' },
    verify: null,
  }),
];

const APPROVAL = {
  id: 'apr_fixture',
  kind: 'action',
  status: 'approved',
  title: 'Run action "update-ticket-priority"',
  description: 'Change a support ticket priority.',
  payload: { invocationId: 'inv_fixture', actionName: 'update-ticket-priority', method: 'PATCH' },
  decisionNote: 'Checked the ticket.',
  decidedBy: { type: 'user', id: 'usr_fixture', displayName: null },
  votes: [{ decision: 'approve', decidedBy: { type: 'user', id: 'usr_fixture', displayName: null }, note: null, decidedAt: '2026-09-30T00:01:00.000Z' }],
  requiredApprovals: 1,
  approvedCount: 1,
  matchedPolicyId: 'pol_fixture',
  matchedPolicyVersion: 2,
  policyExplanation: 'Every call needs one approver.',
  decisionOrigin: 'human',
  expiresAt: '2026-10-01T00:00:00.000Z',
  decidedAt: '2026-09-30T00:01:00.000Z',
  createdAt: '2026-09-30T00:00:00.000Z',
};

const INVOCATION = {
  id: 'inv_fixture',
  actionName: 'update-ticket-priority',
  status: 'succeeded',
  responseStatus: 200,
  body: '{"ok":true}',
  error: null,
  durationMs: 41,
  approvalId: null,
  decision: null,
  retryOf: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  completedAt: '2026-09-30T00:00:01.000Z',
};

const CONNECT = { integration: 'gmail', endUserId: 'user_42', connectUrl: 'https://api.anlyon.com/connect/eul_fixture', expiresAt: '2026-10-01T00:10:00.000Z' };

const client = {
  actions: {
    list: vi.fn(async () => ({ data: ACTIONS })),
    invoke: vi.fn(async (name: string) => {
      if (name === 'gmail-send') throw new EndUserNotConnectedError('The end user has not connected gmail.', CONNECT);
      if (name === 'gmail-send-revoked') throw new EndUserReconnectRequiredError('The end user must reconnect gmail.', CONNECT);
      return name === 'update-ticket-priority'
        ? { data: { ...INVOCATION, status: 'pending_approval', responseStatus: null, body: null, completedAt: null, approvalId: 'apr_fixture', pendingApproval: true } }
        : name === 'send-welcome-email'
          ? { data: { ...INVOCATION, actionName: name, effectId: 'eff_fixture', grade: 'acknowledged', pendingApproval: false } }
          : { data: { ...INVOCATION, actionName: name, pendingApproval: false } };
    }),
    invocation: vi.fn(async () => ({ data: INVOCATION })),
  },
  approvals: {
    request: vi.fn(async () => ({ data: { ...APPROVAL, kind: 'custom', status: 'pending', payload: {}, decidedBy: null, votes: [], approvedCount: 0, decisionNote: null, decisionOrigin: null, decidedAt: null } })),
    get: vi.fn(async () => ({ data: APPROVAL })),
    waitForDecision: vi.fn(async () => APPROVAL),
    list: vi.fn(async () => {
      throw new AnlyonError({ code: 'AUTHORIZATION_ERROR', message: 'Missing scope approvals:decide', status: 403 });
    }),
    approve: vi.fn(async () => ({ data: { approval: APPROVAL, invocation: INVOCATION } })),
    deny: vi.fn(async () => ({ data: { approval: { ...APPROVAL, status: 'denied' } } })),
  },
  events: {
    listTopics: vi.fn(async () => {
      throw new AnlyonError({ code: 'AUTHORIZATION_ERROR', message: 'Missing scope events:read', status: 403 });
    }),
  },
};

vi.mock('../src/client-factory.ts', () => ({ getClient: () => client }));

const { listTools, callTool } = await import('../src/server.ts');
const { clearActionToolCache } = await import('../src/tools/dynamic-actions.ts');

beforeEach(() => {
  clearActionToolCache();
  process.env.ANLYON_API_KEY = 'anlyon_live_fixture';
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: true, data: { workspaces: [{ id: 'ws_fixture', name: 'Fixture', slug: 'fixture', role: 'admin', environments: [{ id: 'env_fixture', name: 'Production', slug: 'production', isDefault: true }] }] } }), { status: 200 })),
  );
});

afterEach(() => {
  delete process.env.ANLYON_API_KEY;
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
  vi.unstubAllGlobals();
});

const bytes = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('default profile (API-key caller)', () => {
  it('tools/list', async () => {
    await expect(bytes(await listTools())).toMatchFileSnapshot(`${SNAPSHOTS}/tools-list.json`);
  });

  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['list_actions', 'list_actions', {}],
    ['invoke_action-pending', 'invoke_action', { name: 'update-ticket-priority', input: { ticketId: 'T-1', priority: 'high' } }],
    ['action_gated-pending', 'action_update-ticket-priority', { ticketId: 'T-1', priority: 'high' }],
    ['action_read-succeeded', 'action_get-ticket', {}],
    ['invoke_action-graded', 'invoke_action', { name: 'send-welcome-email', input: { to: ['a@example.com'] } }],
    ['action_declared-graded', 'action_send-welcome-email', { to: ['a@example.com'] }],
    ['request_approval', 'request_approval', { title: 'Send the contract?' }],
    ['check_approval', 'check_approval', { approvalId: 'apr_fixture' }],
    ['wait_for_approval', 'wait_for_approval', { approvalId: 'apr_fixture', timeoutSeconds: 1 }],
    ['list_workspaces', 'list_workspaces', {}],
    ['error-403', 'list_pending_approvals', {}],
    ['unknown-tool', 'no_such_tool', {}],
    ['legacy-tool', 'list_topics', {}],
    ['invalid-arguments', 'check_approval', {}],
    ['invoke_action-connect-required', 'invoke_action', { name: 'gmail-send', input: { to: 'a@example.com' } }],
    ['invoke_action-reconnect-required', 'invoke_action', { name: 'gmail-send-revoked', input: { to: 'a@example.com' } }],
  ];

  for (const [label, name, args] of calls) {
    it(`tools/call ${label}`, async () => {
      await expect(bytes(await callTool(name, args))).toMatchFileSnapshot(`${SNAPSHOTS}/call-${label}.json`);
    });
  }
});

describe('legacy profile (ANLYON_MCP_LEGACY_TOOLS=1)', () => {
  beforeEach(() => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
  });

  it('tools/list', async () => {
    await expect(bytes(await listTools())).toMatchFileSnapshot(`${LEGACY_SNAPSHOTS}/tools-list.json`);
  });

  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['error-403', 'list_topics', {}],
  ];

  for (const [label, name, args] of calls) {
    it(`tools/call ${label}`, async () => {
      await expect(bytes(await callTool(name, args))).toMatchFileSnapshot(`${LEGACY_SNAPSHOTS}/call-${label}.json`);
    });
  }
});
