import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@anlyonhq/sdk';
import type { ToolExecutionOptions } from 'ai';
import {
  anlyonPublishEventTool,
  anlyonListEventsTool,
  anlyonInvokeActionTool,
  anlyonRequestApprovalTool,
  anlyonCheckApprovalTool,
  createAnlyonTools,
  GOVERNED_TOOL_NAMES,
  LEGACY_TOOL_NAMES,
} from '../src/tools.ts';

const toolOpts: ToolExecutionOptions<never> = {
  toolCallId: 't1',
  messages: [],
  context: undefined as never,
};

describe('anlyonInvokeActionTool', () => {
  it('tells the agent to wait when the action is gated', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { pendingApproval: true, approvalId: 'apr_1', status: 'pending_approval' },
    });
    const client = { actions: { invoke } } as unknown as Client;

    const result = await anlyonInvokeActionTool(client).execute!(
      { name: 'refund', input: { charge: 'ch_1' } },
      toolOpts,
    );

    expect(invoke).toHaveBeenCalledWith('refund', { charge: 'ch_1' });
    expect(result).toContain('needs human approval');
    expect(result).toContain('apr_1');
  });

  it('returns the response body on success', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { pendingApproval: false, status: 'succeeded', responseStatus: 200, body: '{"ok":true}' },
    });
    const client = { actions: { invoke } } as unknown as Client;

    const result = await anlyonInvokeActionTool(client).execute!({ name: 'ping', input: undefined }, toolOpts);

    expect(result).toContain('succeeded (HTTP 200)');
    expect(result).toContain('{"ok":true}');
    expect(result).not.toContain('Receipt grade');
  });

  it('reports an unknown outcome as unknown, never as failed', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { pendingApproval: false, status: 'unknown', responseStatus: null, body: null, error: 'timeout', grade: 'unknown' },
    });
    const client = { actions: { invoke } } as unknown as Client;

    const result = await anlyonInvokeActionTool(client).execute!({ name: 'refund', input: undefined }, toolOpts);

    expect(result).toContain('unknown outcome');
    expect(result).toContain('Do not invoke it again');
    expect(result).not.toContain('failed');
    expect(result).toContain('Receipt grade: unknown.');
  });

  it('carries the receipt grade of a governed action', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { pendingApproval: false, status: 'succeeded', responseStatus: 200, body: '{}', grade: 'confirmed' },
    });
    const client = { actions: { invoke } } as unknown as Client;

    const result = await anlyonInvokeActionTool(client).execute!({ name: 'send-email', input: undefined }, toolOpts);

    expect(result).toContain('Receipt grade: confirmed.');
  });

  it('reports a failed invocation as failed', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { pendingApproval: false, status: 'failed', responseStatus: 402, body: null, error: null },
    });
    const client = { actions: { invoke } } as unknown as Client;

    const result = await anlyonInvokeActionTool(client).execute!({ name: 'refund', input: undefined }, toolOpts);

    expect(result).toBe('Action "refund" failed: HTTP 402');
  });
});

describe('approval tools', () => {
  it('requests and checks an approval', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ data: { id: 'apr_1', expiresAt: '2026-07-12T00:00:00.000Z' } });
    const get = vi
      .fn()
      .mockResolvedValue({ data: { id: 'apr_1', status: 'approved', decisionNote: 'go ahead' } });
    const client = { approvals: { request, get } } as unknown as Client;

    const requested = await anlyonRequestApprovalTool(client).execute!(
      { title: 'Send contract?', description: undefined, payload: undefined, expiresInSeconds: undefined },
      toolOpts,
    );
    expect(requested).toContain('apr_1');

    const checked = await anlyonCheckApprovalTool(client).execute!({ approvalId: 'apr_1' }, toolOpts);
    expect(checked).toContain('approved');
    expect(checked).toContain('go ahead');
  });
});

describe('anlyonPublishEventTool', () => {
  it('publishes an event and reports id/status', async () => {
    const publish = vi.fn().mockResolvedValue({
      data: { id: 'evt_1', status: 'received' },
    });
    const client = { events: { publish } } as unknown as Client;

    const result = await anlyonPublishEventTool(client).execute!(
      {
        topic: 'orders',
        type: 'order.created',
        data: { orderId: '123' },
        idempotencyKey: 'k1',
      },
      toolOpts,
    );

    expect(publish).toHaveBeenCalledWith({
      topic: 'orders',
      type: 'order.created',
      data: { orderId: '123' },
      idempotencyKey: 'k1',
    });
    expect(result).toBe('Published event: evt_1 [received]');
  });

  it('notes deduplicated publishes', async () => {
    const publish = vi.fn().mockResolvedValue({
      data: { id: 'evt_1', status: 'received', deduplicated: true },
    });
    const client = { events: { publish } } as unknown as Client;

    const result = await anlyonPublishEventTool(client).execute!(
      {
        topic: 'orders',
        type: 'order.created',
        data: undefined,
        idempotencyKey: 'k1',
      },
      toolOpts,
    );

    expect(result).toBe('Published event: evt_1 [received] (deduplicated)');
  });
});

describe('anlyonListEventsTool', () => {
  it('formats events as lines', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'evt_1',
          topic: 'orders',
          type: 'order.created',
          status: 'received',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const client = { events: { list } } as unknown as Client;

    const result = await anlyonListEventsTool(client).execute!(
      { topic: 'orders', type: undefined, limit: 10, offset: undefined },
      toolOpts,
    );

    expect(list).toHaveBeenCalledWith({
      topic: 'orders',
      type: undefined,
      limit: 10,
      offset: undefined,
    });
    expect(result).toContain('[evt_1] order.created topic=orders status=received');
  });

  it('handles empty list', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const client = { events: { list } } as unknown as Client;

    const result = await anlyonListEventsTool(client).execute!(
      { topic: undefined, type: undefined, limit: undefined, offset: undefined },
      toolOpts,
    );

    expect(result).toBe('No events found.');
  });
});

describe('createAnlyonTools', () => {
  const client = {
    events: {},
    actions: {},
    approvals: {},
  } as unknown as Client;

  const GOVERNED = ['listActions', 'invokeAction', 'requestApproval', 'checkApproval', 'waitForApproval'];
  const LEGACY = ['publishEvent', 'listEvents'];

  it('returns the governed tools only by default', () => {
    expect(Object.keys(createAnlyonTools(client))).toEqual(GOVERNED);
    expect(Object.keys(createAnlyonTools(client, {}))).toEqual(GOVERNED);
    expect(Object.keys(createAnlyonTools(client, { legacy: false }))).toEqual(GOVERNED);
  });

  it('adds the events tools only with an explicit opt-in', () => {
    const tools = createAnlyonTools(client, { legacy: true });
    expect(Object.keys(tools)).toEqual([...GOVERNED, ...LEGACY]);
    expect(tools.publishEvent.execute).toBeTypeOf('function');
  });

  it('does not treat a truthy non-boolean as the opt-in', () => {
    const tools = createAnlyonTools(client, { legacy: 'yes' as unknown as boolean });
    expect(Object.keys(tools)).toEqual(GOVERNED);
  });

  it('names both sets', () => {
    expect([...GOVERNED_TOOL_NAMES]).toEqual(GOVERNED);
    expect([...LEGACY_TOOL_NAMES]).toEqual(LEGACY);
  });
});
