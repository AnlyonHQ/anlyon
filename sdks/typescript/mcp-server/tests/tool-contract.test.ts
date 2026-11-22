import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@anlyonhq/sdk';

const list = vi.fn();
const approvals = { list: vi.fn(), approve: vi.fn(), deny: vi.fn() };

vi.mock('../src/client-factory.ts', () => ({
  getClient: () => ({ actions: { list }, approvals }),
}));

const { listTools, callTool, ALL_TOOLS, DEFAULT_TOOLS, hiddenOutsideGrant, scopesOfTool } = await import('../src/server.ts');
const { actionAnnotations, clearActionToolCache } = await import('../src/tools/dynamic-actions.ts');

const action = (overrides: Partial<Action> = {}): Action => ({
  id: 'act_1',
  name: 'update-ticket-priority',
  description: 'Change a ticket priority.',
  method: 'PATCH',
  urlTemplate: 'https://support.example.com/tickets/{{input.id}}',
  headers: {},
  bodyTemplate: null,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  requiresApproval: true,
  enabled: true,
  secrets: [],
  currentVersionId: 'acv_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  clearActionToolCache();
  list.mockReset();
  for (const fn of Object.values(approvals)) fn.mockReset();
  process.env.ANLYON_API_KEY = 'anlyon_live_test';
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
});

afterEach(() => {
  delete process.env.ANLYON_API_KEY;
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
});

describe('annotations and securitySchemes', () => {
  it('are on every tool, generated action tools included', async () => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
    list.mockResolvedValue({ data: [action()] });
    const { tools } = await listTools();

    expect(tools).toHaveLength(ALL_TOOLS.length + 1);
    expect(DEFAULT_TOOLS.length).toBeLessThan(ALL_TOOLS.length);
    for (const tool of tools) {
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.idempotentHint, tool.name).toBe('boolean');
      if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      expect(tool.securitySchemes, tool.name).toEqual([{ type: 'oauth2', scopes: [...scopesOfTool(tool.name)] }]);
    }
  });

  it('mark what deletes, sends or runs something as destructive', () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

    for (const name of ['delete_topic', 'delete_subscription', 'invoke_action', 'decide_approval']) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(true);
    }
    for (const name of ['list_topics', 'list_events', 'list_actions', 'check_approval', 'wait_for_approval', 'list_pending_approvals']) {
      expect(byName.get(name)?.annotations.readOnlyHint, name).toBe(true);
    }
  });

  it('treat only a plain GET action as read-only', () => {
    expect(actionAnnotations({ method: 'GET', adapter: null })).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(actionAnnotations({ method, adapter: null }), method).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    const adapter = { type: 'github.file_update', config: {}, credentialSecret: 'GITHUB' };
    expect(actionAnnotations({ method: 'GET', adapter })).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(actionAnnotations({ method: 'PUT', adapter: null }).idempotentHint).toBe(true);
    expect(actionAnnotations({ method: 'POST', adapter: null }).idempotentHint).toBe(false);
  });
});

describe('hiddenOutsideGrant', () => {
  it('leaves only events tools, and those needing no group, for a messaging-only grant', async () => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
    list.mockResolvedValue({ data: [action()] });
    const { tools } = await listTools({ hiddenTools: hiddenOutsideGrant(['openid', 'anlyon:messaging']) });
    const names = tools.map((t) => t.name);

    expect(names).toEqual(expect.arrayContaining(['publish_event', 'list_events', 'list_topics', 'create_subscription']));
    for (const tool of tools) {
      expect(tool.securitySchemes[0].scopes.every((scope) => scope === 'anlyon:messaging'), tool.name).toBe(true);
    }
    expect(names).not.toContain('invoke_action');
    expect(names).not.toContain('action_update-ticket-priority');
    expect(names).not.toContain('decide_approval');
  });

  it('shows a messaging-only grant nothing but ungrouped tools while the events tools are off', async () => {
    list.mockResolvedValue({ data: [action()] });
    const { tools } = await listTools({ hiddenTools: hiddenOutsideGrant(['openid', 'anlyon:messaging']) });

    expect(tools.map((t) => t.name)).toEqual(['check_sign_off', 'wait_for_sign_off', 'list_workspaces']);
  });

  it('shows the reviewer tools only with the decide group', () => {
    const withoutDecide = hiddenOutsideGrant(['anlyon:actions']);
    const withDecide = hiddenOutsideGrant(['anlyon:actions', 'anlyon:approvals.decide']);
    expect(withoutDecide('decide_approval')).toBe(true);
    expect(withoutDecide('list_pending_approvals')).toBe(true);
    expect(withoutDecide('request_approval')).toBe(false);
    expect(withDecide('decide_approval')).toBe(false);
    expect(withDecide('list_pending_approvals')).toBe(false);
  });

  it('hides nothing from a caller granted every group', () => {
    const everything = hiddenOutsideGrant(ALL_TOOLS.flatMap((t) => [...t.scopes]));
    expect(ALL_TOOLS.filter((t) => everything(t.name))).toEqual([]);
    expect(everything('action_anything')).toBe(false);
  });

  it('answers a hidden tool as unknown rather than calling it', async () => {
    const result = await callTool(
      'decide_approval',
      { approvalId: 'apr_1', decision: 'approve', reason: 'x' },
      { hiddenTools: hiddenOutsideGrant(['anlyon:actions']) },
    );
    expect(result.isError).toBe(true);
    expect(approvals.approve).not.toHaveBeenCalled();
  });
});

describe('reviewer tools', () => {
  it('list only what is still pending', async () => {
    approvals.list.mockResolvedValue({ data: [{ id: 'apr_1', status: 'pending' }] });
    await callTool('list_pending_approvals', { limit: 5 });
    expect(approvals.list).toHaveBeenCalledWith({ status: 'pending', limit: 5 });
  });

  it('approve and deny through their own endpoints with the reason as the note', async () => {
    approvals.approve.mockResolvedValue({ data: { approval: { id: 'apr_1', status: 'approved' } } });
    approvals.deny.mockResolvedValue({ data: { approval: { id: 'apr_2', status: 'denied' } } });

    await callTool('decide_approval', { approvalId: 'apr_1', decision: 'approve', reason: 'checked' });
    await callTool('decide_approval', { approvalId: 'apr_2', decision: 'deny', reason: 'wrong ticket' });

    expect(approvals.approve).toHaveBeenCalledWith('apr_1', { note: 'checked' });
    expect(approvals.deny).toHaveBeenCalledWith('apr_2', { note: 'wrong ticket' });
  });

  it('refuse a decision without a reason before calling the API', async () => {
    const result = await callTool('decide_approval', { approvalId: 'apr_1', decision: 'approve' });
    expect(result.isError).toBe(true);
    expect(approvals.approve).not.toHaveBeenCalled();
  });
});
