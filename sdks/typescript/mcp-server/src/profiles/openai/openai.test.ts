import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnlyonError } from '@anlyonhq/sdk';

const client = {
  actions: {
    list: vi.fn(async () => ({
      data: [{
        id: 'act_1', name: 'update-ticket-priority', description: 'Change a ticket priority.', method: 'PATCH',
        urlTemplate: 'https://support.example.com/tickets/{{input.id}}', headers: { Authorization: 'Bearer {{secret:SUPPORT_KEY}}' },
        bodyTemplate: null, inputSchema: { type: 'object', properties: {} }, requiresApproval: true, enabled: true,
        secrets: ['SUPPORT_KEY'], currentVersionId: 'acv_1', createdAt: 'x', updatedAt: 'x',
      }],
    })),
  },
  approvals: {
    get: vi.fn(async () => ({
      data: {
        id: 'apr_1', kind: 'custom', status: 'approved', title: 't', description: null, payload: {}, decisionNote: 'ok',
        decidedBy: { type: 'user', id: 'usr_1', displayName: null }, votes: [{ decision: 'approve' }], requiredApprovals: 1,
        approvedCount: 1, matchedPolicyId: 'pol_1', matchedPolicyVersion: 3, policyExplanation: 'one approver',
        decisionOrigin: 'human', expiresAt: 'x', decidedAt: 'x', createdAt: 'x',
      },
    })),
    approve: vi.fn(async () => {
      throw new AnlyonError({ code: 'AUTHORIZATION_ERROR', message: 'Missing scope "approvals:decide"', status: 403 });
    }),
  },
  events: {
    listTopics: vi.fn(async () => {
      throw new AnlyonError({ code: 'UNKNOWN_ERROR', message: 'boom', status: 500 });
    }),
    createTopic: vi.fn(async () => {
      throw new AnlyonError({ code: 'AUTHENTICATION_FAILED', message: 'Token expired', status: 401 });
    }),
  },
};

vi.mock('../../client-factory.ts', () => ({ getClient: () => client }));

const { listTools, callTool } = await import('../../server.ts');
const { clearActionToolCache } = await import('../../tools/dynamic-actions.ts');
const { openAiPresentation, RESTRICTED_DATA_WARNING, DESCRIPTION_OVERLAYS } = await import('./index.ts');

const METADATA = 'https://api.anlyon.com/.well-known/oauth-protected-resource/mcp';
const presentation = openAiPresentation({ resourceMetadataUrl: METADATA });

beforeEach(() => {
  clearActionToolCache();
  process.env.ANLYON_API_KEY = 'anlyon_live_test';
  process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
});

afterEach(() => {
  delete process.env.ANLYON_API_KEY;
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
});

describe('tools', () => {
  it('hides the events tools by default, the same as every other client', async () => {
    delete process.env.ANLYON_MCP_LEGACY_TOOLS;
    const names = (await listTools({ presentation })).tools.map((t) => t.name);
    expect(names).toEqual(['list_actions', 'invoke_action', 'request_approval', 'check_approval', 'wait_for_approval', 'get_invocation', 'list_pending_approvals', 'decide_approval', 'check_sign_off', 'wait_for_sign_off', 'list_workspaces', 'select_workspace', 'action_update-ticket-priority']);
    expect((await callTool('list_topics', {}, { presentation })).isError).toBe(true);
  });

  it('lists the same tools with the same schemas and annotations, in the same order', async () => {
    const plain = (await listTools()).tools;
    const presented = (await listTools({ presentation })).tools;

    expect(presented.map((t) => t.name)).toEqual(plain.map((t) => t.name));
    for (const [index, tool] of presented.entries()) {
      expect(tool.inputSchema, tool.name).toEqual(plain[index].inputSchema);
      expect(tool.annotations, tool.name).toEqual(plain[index].annotations);
      expect(tool.securitySchemes, tool.name).toEqual(plain[index].securitySchemes);
    }
  });

  it('rewrites the descriptions ChatGPT reads and leaves the rest', async () => {
    const plain = new Map((await listTools()).tools.map((t) => [t.name, t.description]));
    const presented = new Map((await listTools({ presentation })).tools.map((t) => [t.name, t.description]));

    for (const name of Object.keys(DESCRIPTION_OVERLAYS)) expect(presented.get(name), name).toBe(DESCRIPTION_OVERLAYS[name]);
    expect(presented.get('list_topics')).toBe(plain.get('list_topics'));
    expect(presented.get('action_update-ticket-priority')).toBe(plain.get('action_update-ticket-priority'));
  });

  it('keeps the restricted-data warning that hosts adding a storing tool put on it', async () => {
    expect(RESTRICTED_DATA_WARNING).toMatch(/credentials/);
    expect(RESTRICTED_DATA_WARNING).toMatch(/payment/);
    expect(RESTRICTED_DATA_WARNING).toMatch(/health/);
    expect(RESTRICTED_DATA_WARNING).toMatch(/government ID/);
  });

  it('mirrors each tool\'s security schemes under _meta', async () => {
    for (const tool of (await listTools({ presentation })).tools) {
      expect(tool._meta?.securitySchemes, tool.name).toEqual(tool.securitySchemes);
    }
  });
});

describe('results', () => {
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text as string;

  it('drops request templates and secret names from list_actions', async () => {
    const body = text(await callTool('list_actions', {}, { presentation }));
    expect(JSON.parse(body)).toEqual([
      { name: 'update-ticket-priority', description: 'Change a ticket priority.', method: 'PATCH', requiresApproval: true, enabled: true, inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(body).not.toContain('SUPPORT_KEY');
  });

  it('drops vote history and policy ids from approvals and keeps who decided', async () => {
    const approval = JSON.parse(text(await callTool('check_approval', { approvalId: 'apr_1' }, { presentation })));
    expect(approval).not.toHaveProperty('votes');
    expect(approval).not.toHaveProperty('matchedPolicyId');
    expect(approval.decidedBy).toEqual({ type: 'user', id: 'usr_1', displayName: null });
  });

  it('keeps a gated action\'s outcome on a trimmed approval, and trims it too', async () => {
    const { trimmed } = await import('./outputs.ts');
    const invocation = { id: 'inv_1', status: 'succeeded', grade: 'acknowledged', durationMs: 4 };
    expect(trimmed('wait_for_approval', { id: 'apr_1', status: 'approved', policyId: 'pol_1', invocation })).toEqual({
      id: 'apr_1', status: 'approved', invocation: { id: 'inv_1', status: 'succeeded', grade: 'acknowledged' },
    });
    expect(trimmed('check_approval', { id: 'apr_1', status: 'approved', next: 'Read it.' })).toEqual({ id: 'apr_1', status: 'approved', next: 'Read it.' });
    expect(trimmed('get_invocation', invocation)).toEqual({ id: 'inv_1', status: 'succeeded', grade: 'acknowledged' });
  });

  it('keeps the receipt grade on a trimmed invocation', async () => {
    const { trimmed } = await import('./outputs.ts');
    expect(trimmed('invoke_action', { id: 'inv_1', status: 'succeeded', grade: 'confirmed', durationMs: 4 })).toEqual({
      id: 'inv_1', status: 'succeeded', grade: 'confirmed',
    });
  });

  it('changes nothing for a client without the presentation', async () => {
    const approval = JSON.parse(text(await callTool('check_approval', { approvalId: 'apr_1' })));
    expect(approval).toHaveProperty('votes');
    expect(approval).toHaveProperty('matchedPolicyId');
  });
});

describe('failures', () => {
  it('asks ChatGPT for the missing permission on a 403', async () => {
    const result = await callTool('decide_approval', { approvalId: 'apr_1', decision: 'approve', reason: 'ok' }, { presentation });
    expect(result.isError).toBe(true);
    expect(result._meta?.['mcp/www_authenticate']).toEqual([
      `Bearer resource_metadata="${METADATA}", error="insufficient_scope", error_description="Missing scope \\"approvals:decide\\"", scope="anlyon:approvals.decide"`,
    ]);
  });

  it('sends the person back through OAuth on a 401', async () => {
    const result = await callTool('create_topic', { name: 'orders' }, { presentation });
    expect((result._meta?.['mcp/www_authenticate'] as string[])[0]).toContain('error="invalid_token"');
  });

  it('adds nothing for a failure the credential did not cause, or for another client', async () => {
    expect((await callTool('list_topics', {}, { presentation }))._meta).toBeUndefined();
    expect((await callTool('decide_approval', { approvalId: 'apr_1', decision: 'approve', reason: 'ok' }))._meta).toBeUndefined();
  });
});
