import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Action } from '@anlyonhq/sdk';

const list = vi.fn();
const invoke = vi.fn();
const listTopics = vi.fn();

vi.mock('../src/client-factory.ts', () => ({
  getClient: () => ({ actions: { list, invoke }, events: { listTopics } }),
}));

const { listTools, callTool, ALL_TOOLS, DEFAULT_TOOLS, LEGACY_TOOL_NAMES, isLegacyTool } = await import('../src/server.ts');
const { clearActionToolCache } = await import('../src/tools/dynamic-actions.ts');

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'act_1',
    name: 'refund-customer',
    description: 'Refund a Stripe charge.',
    method: 'POST',
    urlTemplate: 'https://api.stripe.com/v1/refunds',
    headers: {},
    bodyTemplate: null,
    inputSchema: {
      type: 'object',
      properties: { charge: { type: 'string' } },
      required: ['charge'],
    },
    requiresApproval: false,
    enabled: true,
    secrets: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  clearActionToolCache();
  list.mockReset();
  invoke.mockReset();
  listTopics.mockReset();
  process.env.ANLYON_API_KEY = 'anlyon_live_test';
  delete process.env.ANLYON_MCP_DYNAMIC_ACTIONS;
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
});

afterEach(() => {
  delete process.env.ANLYON_API_KEY;
  delete process.env.ANLYON_MCP_DYNAMIC_ACTIONS;
  delete process.env.ANLYON_MCP_LEGACY_TOOLS;
});

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text as string;

describe('hidden events tools', () => {
  const LEGACY = [...LEGACY_TOOL_NAMES];
  const GOVERNED = [
    'list_actions',
    'invoke_action',
    'request_approval',
    'check_approval',
    'wait_for_approval',
    'get_invocation',
    'list_pending_approvals',
    'decide_approval',
    'check_sign_off',
    'wait_for_sign_off',
    'list_workspaces',
    'select_workspace',
  ];

  it('names every events tool, and nothing governed', () => {
    expect(LEGACY.sort()).toEqual([
      'create_subscription', 'create_topic', 'delete_subscription', 'delete_topic', 'get_event',
      'list_events', 'list_subscriptions', 'list_topics', 'publish_event',
    ]);
    for (const name of GOVERNED) expect(isLegacyTool(name), name).toBe(false);
    expect(isLegacyTool('action_refund-customer')).toBe(false);
    expect(DEFAULT_TOOLS.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name).filter((name) => !isLegacyTool(name)));
  });

  it('serves only the governed tools by default', async () => {
    list.mockResolvedValue({ data: [action()] });

    const names = (await listTools()).tools.map((t) => t.name);

    expect(names).toEqual([...GOVERNED, 'action_refund-customer']);
    for (const name of LEGACY) expect(names, name).not.toContain(name);
  });

  it('answers a hidden events tool as unknown rather than calling it', async () => {
    listTopics.mockResolvedValue({ data: [] });

    const result = await callTool('list_topics', {});

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Unknown tool: list_topics');
    expect(listTopics).not.toHaveBeenCalled();
  });

  it('restores every events tool with ANLYON_MCP_LEGACY_TOOLS=1', async () => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
    list.mockResolvedValue({ data: [action()] });
    listTopics.mockResolvedValue({ data: [{ id: 'top_1', name: 'orders' }] });

    const names = (await listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...ALL_TOOLS.map((t) => t.name), 'action_refund-customer']);

    const result = await callTool('list_topics', {});
    expect(result.isError).toBeUndefined();
    expect(listTopics).toHaveBeenCalled();
  });

  it('serves none of the tools version 3 removed, even with ANLYON_MCP_LEGACY_TOOLS=1', async () => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
    const removed = ['memory_recall', 'queue_publish', 'list_files', 'cache_lookup', 'get_context', 'create_session', 'append_to_session', 'get_session_context'];

    const names = (await listTools()).tools.map((t) => t.name);
    for (const name of removed) {
      expect(names, name).not.toContain(name);
      const result = await callTool(name, {});
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toContain(`Unknown tool: ${name}`);
    }
  });

  it('ignores any value of the variable other than 1', async () => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = 'true';

    const names = (await listTools()).tools.map((t) => t.name);

    expect(names).not.toContain('list_topics');
  });

  it('composes with a caller predicate in both directions', async () => {
    process.env.ANLYON_MCP_LEGACY_TOOLS = '1';
    const hiddenTools = (name: string) => name.endsWith('_topic') || name === 'list_topics';
    const withLegacy = (await listTools({ hiddenTools })).tools.map((t) => t.name);
    expect(withLegacy).toContain('publish_event');
    expect(withLegacy.some(hiddenTools)).toBe(false);
    expect((await callTool('list_topics', {}, { hiddenTools })).isError).toBe(true);

    delete process.env.ANLYON_MCP_LEGACY_TOOLS;
    const withoutLegacy = (await listTools({ hiddenTools: () => false })).tools.map((t) => t.name);
    expect(withoutLegacy).not.toContain('publish_event');
    expect(withoutLegacy).toContain('invoke_action');
  });
});

describe('hiddenTools', () => {
  const reviewer = (name: string) => name === 'list_pending_approvals' || name === 'decide_approval';

  it('omits a hidden family from the catalogue', async () => {
    const all = (await listTools()).tools.map((t) => t.name);
    const filtered = (await listTools({ hiddenTools: reviewer })).tools.map((t) => t.name);

    expect(all.some(reviewer)).toBe(true);
    expect(filtered.some(reviewer)).toBe(false);
    expect(filtered).toEqual(all.filter((name) => !reviewer(name)));
  });

  it('answers a hidden tool as unknown rather than calling it', async () => {
    const result = await callTool('list_pending_approvals', {}, { hiddenTools: reviewer });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Unknown tool: list_pending_approvals');
  });
});

describe('listTools', () => {
  it('does not ship the flag-gated cross-agent messaging tools', async () => {
    const names = (await listTools()).tools.map((t) => t.name);

    expect(names.some((name) => name.startsWith('connect_'))).toBe(false);
  });

  it('appends the workspace actions to the static tools', async () => {
    list.mockResolvedValue({ data: [action(), action({ id: 'act_2', name: 'send-invoice' })] });

    const { tools } = await listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('list_actions');
    expect(names).toContain('wait_for_approval');
    expect(names).toContain('action_refund-customer');
    expect(names).toContain('action_send-invoice');
    expect(tools).toHaveLength(DEFAULT_TOOLS.length + 2);
  });

  it('returns only the static tools when there is no API key', async () => {
    delete process.env.ANLYON_API_KEY;

    const { tools } = await listTools();

    expect(tools).toHaveLength(DEFAULT_TOOLS.length);
    expect(list).not.toHaveBeenCalled();
  });

  it('returns only the static tools when the actions call fails', async () => {
    list.mockRejectedValue(new Error('insufficient scope'));

    const { tools } = await listTools();

    expect(tools).toHaveLength(DEFAULT_TOOLS.length);
  });

  it('honours the ANLYON_MCP_DYNAMIC_ACTIONS=0 opt-out', async () => {
    process.env.ANLYON_MCP_DYNAMIC_ACTIONS = '0';
    list.mockResolvedValue({ data: [action()] });

    const { tools } = await listTools();

    expect(tools).toHaveLength(DEFAULT_TOOLS.length);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('callTool  dynamic action tools', () => {
  it('routes action_<name> to actions.invoke with the raw args as input', async () => {
    list.mockResolvedValue({ data: [action()] });
    invoke.mockResolvedValue({ data: { id: 'inv_1', status: 'succeeded', pendingApproval: false } });

    const result = await callTool('action_refund-customer', { charge: 'ch_1' });

    expect(invoke).toHaveBeenCalledWith('refund-customer', { charge: 'ch_1' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('succeeded');
  });

  it('tells the model how to wait when the action is gated', async () => {
    list.mockResolvedValue({ data: [action({ requiresApproval: true })] });
    invoke.mockResolvedValue({
      data: { id: 'inv_1', status: 'pending_approval', pendingApproval: true, approvalId: 'apr_9' },
    });

    const result = await callTool('action_refund-customer', { charge: 'ch_1' });

    expect(result.content[0].text).toContain('wait_for_approval');
    expect(result.content[0].text).toContain('apr_9');
    expect(result.isError).toBeUndefined();
  });

  it("validates args against the action's own schema before calling the API", async () => {
    list.mockResolvedValue({ data: [action()] });

    const result = await callTool('action_refund-customer', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports an action tool that no longer exists', async () => {
    list.mockResolvedValue({ data: [] });

    const result = await callTool('action_gone', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_actions');
  });

  it('surfaces an invoke failure as a tool error', async () => {
    list.mockResolvedValue({ data: [action()] });
    invoke.mockRejectedValue(new Error('action is disabled'));

    const result = await callTool('action_refund-customer', { charge: 'ch_1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('action is disabled');
  });

  it('rejects an unknown non-action tool', async () => {
    const result = await callTool('not_a_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('needs an API key', async () => {
    delete process.env.ANLYON_API_KEY;

    const result = await callTool('action_refund-customer', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ANLYON_API_KEY');
  });
});
