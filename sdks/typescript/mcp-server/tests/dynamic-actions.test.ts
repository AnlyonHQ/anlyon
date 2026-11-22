import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Action, Client } from '@anlyonhq/sdk';
import {
  buildActionTools,
  clearActionToolCache,
  getActionTools,
  isActionToolName,
  toToolName,
} from '../src/tools/dynamic-actions.ts';
import { agentTools } from '../src/tools/agent.ts';
import { requestContext } from '../src/auth.ts';

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
});

describe('buildActionTools', () => {
  it('turns an action into a prefixed tool carrying its input schema verbatim', () => {
    const [tool] = buildActionTools([action()]);

    expect(tool.name).toBe('action_refund-customer');
    expect(tool.actionName).toBe('refund-customer');
    expect(tool.description).toBe('Refund a Stripe charge.');
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { charge: { type: 'string' } },
      required: ['charge'],
    });
  });

  it('marks a gated action so the model knows a human is in the loop', () => {
    const [tool] = buildActionTools([action({ requiresApproval: true })]);
    expect(tool.description).toContain('requires human approval');
  });

  it('says what a declared action counts, and never that a limit is set', () => {
    const [emails] = buildActionTools([
      action({ impact: { dimension: 'emails', unit: 'emails', amount: 'count(input.to)', bound: 'exact' } }),
    ]);
    expect(emails.description).toBe(
      'Refund a Stripe charge. Each call counts emails toward any shared limit set for this environment (amount: count(input.to), exact).',
    );

    const [money] = buildActionTools([
      action({ requiresApproval: true, impact: { dimension: 'money', unit: 'usd', amount: 'input.amount', bound: 'upper_bound' } }),
    ]);
    expect(money.description.endsWith(
      'human decides. Each call counts money in usd toward any shared limit set for this environment (amount: input.amount, upper bound).',
    )).toBe(true);

    const [mutations] = buildActionTools([
      action({ impact: { dimension: 'resource_mutations', unit: 'resource_mutations', amount: '1', bound: 'exact' } }),
    ]);
    expect(mutations.description).toContain('Each call counts resource mutations toward any shared limit');
  });

  it('gives an adapter action the general sentence, and an undeclared action none', () => {
    const [adapter] = buildActionTools([action({ adapter: { type: 'stripe.refund', config: {}, credentialSecret: 'STRIPE_KEY' } })]);
    expect(adapter.description).toBe(
      'Refund a Stripe charge. Each call counts toward any shared limit set for this environment.',
    );

    const [plain] = buildActionTools([action({ adapter: null, governed: false, impact: null, verify: null })]);
    expect(plain.description).toBe('Refund a Stripe charge.');
    const [governedOnly] = buildActionTools([action({ governed: true })]);
    expect(governedOnly.description).toBe('Refund a Stripe charge.');
  });

  it('skips disabled actions', () => {
    expect(buildActionTools([action({ enabled: false })])).toEqual([]);
  });

  it('falls back to a description when the action has none', () => {
    const [tool] = buildActionTools([action({ description: null })]);
    expect(tool.description).toBe('Invoke the "refund-customer" action.');
  });

  it('handles an action with no input schema', () => {
    const [tool] = buildActionTools([action({ inputSchema: {} })]);
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('sanitizes and length-caps the tool name', () => {
    expect(toToolName('do.the/thing')).toMatch(/^action_do_the_thing-[0-9a-f]{8}$/);
    expect(toToolName('x'.repeat(100))).toHaveLength(51);
    expect(toToolName('refund-customer')).toBe('action_refund-customer');
  });

  it('leaves a name at the cap alone, so existing tools keep their names', () => {
    const name = 'x'.repeat(44);
    expect(toToolName(name)).toBe(`action_${name}`);
    expect(toToolName(name)).toHaveLength(51);
  });

  it('keeps names apart when they only differ past the cap, and each still names its own action', () => {
    const long = 'a'.repeat(80);
    const tools = buildActionTools([
      action({ name: `${long}-one` }),
      action({ name: `${long}-two` }),
    ]);
    expect(tools.map((t) => t.actionName)).toEqual([`${long}-one`, `${long}-two`]);
    expect(tools[0].name).not.toBe(tools[1].name);
  });

  it('gives an action the same tool name whatever order the list came in', () => {
    const long = 'a'.repeat(80);
    const forward = buildActionTools([action({ name: `${long}-one` }), action({ name: `${long}-two` })]);
    const backward = buildActionTools([action({ name: `${long}-two` }), action({ name: `${long}-one` })]);
    expect(forward.find((t) => t.actionName === `${long}-one`)!.name).toBe(backward.find((t) => t.actionName === `${long}-one`)!.name);
  });

  it('never collides with a static tool name', () => {
    const staticNames = new Set(agentTools.map((t) => t.name));
    const tools = buildActionTools([action({ name: 'invoke_action' })]);
    expect(staticNames.has(tools[0].name)).toBe(false);
    expect(isActionToolName(tools[0].name)).toBe(true);
  });
});

describe('getActionTools', () => {
  it('caches the action list per key', async () => {
    const list = vi.fn().mockResolvedValue({ data: [action()] });
    const client = { actions: { list } } as unknown as Client;

    await getActionTools(client, 'key-a');
    await getActionTools(client, 'key-a');

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not share a cache entry between keys', async () => {
    const list = vi.fn().mockResolvedValue({ data: [action()] });
    const client = { actions: { list } } as unknown as Client;

    await getActionTools(client, 'key-a');
    await getActionTools(client, 'key-b');

    expect(list).toHaveBeenCalledTimes(2);
  });

  it('re-fetches once the TTL expires', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue({ data: [action()] });
    const client = { actions: { list } } as unknown as Client;

    await getActionTools(client, 'key-a');
    vi.advanceTimersByTime(31_000);
    await getActionTools(client, 'key-a');

    expect(list).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('degrades to no dynamic tools when the list call fails (never breaks tools/list)', async () => {
    const list = vi.fn().mockRejectedValue(new Error('insufficient scope: actions:read required'));
    const client = { actions: { list } } as unknown as Client;

    await expect(getActionTools(client, 'key-a')).resolves.toEqual([]);
  });
});

describe('getActionTools under OAuth', () => {
  const clientFor = (tools: string[]) =>
    ({
      actions: {
        list: vi.fn().mockResolvedValue({ data: tools.map((name) => action({ name })) }),
      },
    }) as unknown as Client;

  it('keeps two tenants apart even when their tokens are the same length', async () => {
    clearActionToolCache();
    const alpha = clientFor(['alpha_deploy']);
    const beta = clientFor(['beta_refund']);

    const alphaTools = await requestContext.run({ apiKey: 'jwt.aaa.sig', cacheScope: 'user_a:client_1' }, () =>
      getActionTools(alpha, 'jwt.aaa.sig'),
    );
    const betaTools = await requestContext.run({ apiKey: 'jwt.bbb.sig', cacheScope: 'user_b:client_1' }, () =>
      getActionTools(beta, 'jwt.bbb.sig'),
    );

    expect(alphaTools.map((t) => t.actionName)).toEqual(['alpha_deploy']);
    expect(betaTools.map((t) => t.actionName)).toEqual(['beta_refund']);
  });

  it('survives token rotation without re-fetching', async () => {
    clearActionToolCache();
    const client = clientFor(['deploy']);

    await requestContext.run({ apiKey: 'jwt.first.sig', cacheScope: 'user_a:client_1' }, () =>
      getActionTools(client, 'jwt.first.sig'),
    );
    await requestContext.run({ apiKey: 'jwt.second.sig', cacheScope: 'user_a:client_1' }, () =>
      getActionTools(client, 'jwt.second.sig'),
    );

    expect((client.actions.list as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('still separates two clients of the same user', async () => {
    clearActionToolCache();
    const client = clientFor(['deploy']);

    await requestContext.run({ apiKey: 'jwt.x.sig', cacheScope: 'user_a:client_1' }, () =>
      getActionTools(client, 'jwt.x.sig'),
    );
    await requestContext.run({ apiKey: 'jwt.x.sig', cacheScope: 'user_a:client_2' }, () =>
      getActionTools(client, 'jwt.x.sig'),
    );

    expect((client.actions.list as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});
