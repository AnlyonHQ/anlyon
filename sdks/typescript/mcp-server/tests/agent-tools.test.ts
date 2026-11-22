import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@anlyonhq/sdk';
import { agentTools } from '../src/tools/agent.ts';

function tool(name: string) {
  const found = agentTools.find((t) => t.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

describe('wait_for_approval', () => {
  it('long-polls through the SDK and returns the decided approval', async () => {
    const waitForDecision = vi
      .fn()
      .mockResolvedValue({ id: 'apr_1', status: 'approved', decisionNote: 'ok' });
    const client = { approvals: { waitForDecision } } as unknown as Client;

    const result = await tool('wait_for_approval').handler(client, { approvalId: 'apr_1' });

    expect(result).toEqual({ id: 'apr_1', status: 'approved', decisionNote: 'ok' });
    expect(waitForDecision).toHaveBeenCalledWith('apr_1', { timeoutMs: 45_000 });
  });

  const gated = { id: 'apr_1', status: 'approved', payload: { invocationId: 'inv_1' } };

  it('hands back what a gated action did once it is approved', async () => {
    const waitForDecision = vi.fn().mockResolvedValue(gated);
    const invocation = vi.fn().mockResolvedValue({ data: { id: 'inv_1', status: 'succeeded', grade: 'acknowledged' } });
    const client = { approvals: { waitForDecision }, actions: { invocation } } as unknown as Client;

    const result = await tool('wait_for_approval').handler(client, { approvalId: 'apr_1' });

    expect(invocation).toHaveBeenCalledWith('inv_1');
    expect(result).toEqual({ ...gated, invocation: { id: 'inv_1', status: 'succeeded', grade: 'acknowledged' } });
  });

  it('still returns the decision when the outcome cannot be read, and says how to read it', async () => {
    const waitForDecision = vi.fn().mockResolvedValue(gated);
    const invocation = vi.fn().mockRejectedValue(new Error('This key is missing actions:read'));
    const client = { approvals: { waitForDecision }, actions: { invocation } } as unknown as Client;

    const result = await tool('wait_for_approval').handler(client, { approvalId: 'apr_1' });

    expect(result).toMatchObject({ status: 'approved', next: expect.stringContaining('get_invocation') });
  });

  it('does not read an outcome for anything but an approved gated action', async () => {
    const invocation = vi.fn();
    for (const approval of [{ ...gated, status: 'pending' }, { ...gated, status: 'denied' }, { id: 'apr_2', status: 'approved', payload: {} }]) {
      const client = { approvals: { waitForDecision: vi.fn().mockResolvedValue(approval) }, actions: { invocation } } as unknown as Client;
      expect(await tool('wait_for_approval').handler(client, { approvalId: approval.id })).toEqual(approval);
    }
    expect(invocation).not.toHaveBeenCalled();
  });

  it('caps the timeout an MCP host is asked to hold open', async () => {
    const waitForDecision = vi.fn().mockResolvedValue({ id: 'apr_1', status: 'pending' });
    const client = { approvals: { waitForDecision } } as unknown as Client;

    await tool('wait_for_approval').handler(client, {
      approvalId: 'apr_1',
      timeoutSeconds: 9999,
    });

    expect(waitForDecision).toHaveBeenCalledWith('apr_1', { timeoutMs: 120_000 });
  });

  it('returns the still-pending approval rather than erroring on timeout', async () => {
    const waitForDecision = vi.fn().mockResolvedValue({ id: 'apr_1', status: 'pending' });
    const client = { approvals: { waitForDecision } } as unknown as Client;

    const result = await tool('wait_for_approval').handler(client, {
      approvalId: 'apr_1',
      timeoutSeconds: 5,
    });

    expect(result).toMatchObject({ status: 'pending' });
  });
});

describe('check_approval', () => {
  it('proxies to approvals.get', async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'apr_1', status: 'denied' } });
    const client = { approvals: { get } } as unknown as Client;

    expect(await tool('check_approval').handler(client, { approvalId: 'apr_1' })).toEqual({
      id: 'apr_1',
      status: 'denied',
    });
  });
});
