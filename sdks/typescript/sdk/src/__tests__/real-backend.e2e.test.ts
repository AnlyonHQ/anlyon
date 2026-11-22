import { describe, it, expect, vi } from 'vitest';
import { Client } from '../client';
import { AnlyonError } from '../core/errors';

function unwrap<T>(response: { data?: T }): T {
  return response.data as T;
}

vi.setConfig({ testTimeout: 120_000 });

const env = process.env;
const enabled = Boolean(env.ANLYON_E2E_BASE_URL);

async function status(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (error) {
    if (error instanceof AnlyonError && error.status) return error.status;
    throw error;
  }
}

describe.runIf(enabled)('policy governance against a real backend (TypeScript)', () => {
  const baseUrl = env.ANLYON_E2E_BASE_URL ?? 'http://unset.invalid';
  const make = (key?: string) => new Client({ apiKey: key ?? 'unset', baseUrl, retry: { maxAttempts: 1 } });
  const operator = make(env.ANLYON_E2E_OPERATOR_KEY);
  const runtime = make(env.ANLYON_E2E_RUNTIME_KEY);
  const otherOperator = make(env.ANLYON_E2E_OTHER_OPERATOR_KEY);
  const readAction = env.ANLYON_E2E_READ_ACTION!;
  const refundAction = env.ANLYON_E2E_REFUND_ACTION!;
  const foreignAction = env.ANLYON_E2E_FOREIGN_ACTION!;
  const suffix = Math.random().toString(36).slice(2, 8);

  it('a scoped deny affects only the intended action, and the invocation explains itself', async () => {
    const policy = unwrap(await operator.approvalPolicies.create({
      name: `ts_refund_denied_${suffix}`,
      matchKind: 'action',
      matchActionName: refundAction,
      effect: 'auto_deny',
    }));
    expect(policy).toMatchObject({ scope: 'specific_action', needsScopeReview: false, version: 1 });

    const read = unwrap(await runtime.actions.invoke(readAction, {}));
    expect(read.status).toBe('succeeded');

    const refund = unwrap(await runtime.actions.invoke(refundAction, {}));
    expect(refund.status).toBe('denied');
    expect(refund.responseStatus).toBeNull();
    expect(refund.body).toBeNull();
    expect(refund.decision).toMatchObject({
      source: 'policy',
      code: 'POLICY_DENIED',
      effect: 'denied',
      policy: { id: policy.id, name: policy.name, version: 1 },
    });

    await operator.approvalPolicies.update(policy.id, { priority: 9 });
    await operator.approvalPolicies.delete(policy.id);
    const later = unwrap(await runtime.actions.invocation(refund.id));
    expect(later.decision).toEqual(refund.decision);
  });

  it('runtime credentials cannot read or modify policy', async () => {
    const policy = unwrap(await operator.approvalPolicies.create({
      name: `ts_guarded_${suffix}`,
      matchKind: 'custom',
      effect: 'require_approval',
    }));
    try {
      expect(await status(() => runtime.approvalPolicies.list())).toBe(403);
      expect(await status(() => runtime.approvalPolicies.get(policy.id))).toBe(403);
      expect(
        await status(() =>
          runtime.approvalPolicies.create({ name: `ts_mine_${suffix}`, matchKind: 'custom', effect: 'auto_approve' })
        )
      ).toBe(403);
      expect(await status(() => runtime.approvalPolicies.disable(policy.id))).toBe(403);
      expect(await status(() => runtime.approvalPolicies.delete(policy.id))).toBe(403);
      expect(unwrap(await operator.approvalPolicies.get(policy.id)).enabled).toBe(true);
    } finally {
      await operator.approvalPolicies.delete(policy.id);
    }
  });

  it('other environments are unreachable, whatever the request says', async () => {
    const policy = unwrap(await operator.approvalPolicies.create({
      name: `ts_scoped_${suffix}`,
      matchKind: 'custom',
      effect: 'require_approval',
    }));
    try {
      expect(await status(() => otherOperator.approvalPolicies.get(policy.id))).toBe(404);
      expect(await status(() => otherOperator.approvalPolicies.update(policy.id, { enabled: false }))).toBe(404);
      expect(await status(() => otherOperator.approvalPolicies.delete(policy.id))).toBe(404);
      const seen = unwrap(await otherOperator.approvalPolicies.list()).map((p) => p.id);
      expect(seen).not.toContain(policy.id);
      expect(
        await status(() =>
          operator.approvalPolicies.create({
            name: `ts_cross_${suffix}`,
            matchKind: 'action',
            matchActionName: foreignAction,
            effect: 'auto_deny',
          })
        )
      ).toBe(400);
    } finally {
      await operator.approvalPolicies.delete(policy.id);
    }
  });

  it('serialises create/update and clears with null, identically to the Python SDK', async () => {
    const created = unwrap(await operator.approvalPolicies.create({
      name: `ts_null_${suffix}`,
      matchKind: 'action',
      matchActionName: refundAction,
      matchAgentId: 'agent_1',
      minAmount: 50,
      effect: 'require_approval',
      priority: 40,
    }));
    try {
      expect(created.match).toMatchObject({ actionName: refundAction, agentId: 'agent_1', minAmount: 50 });
      const unchanged = unwrap(await operator.approvalPolicies.update(created.id, { priority: 41 }));
      expect(unchanged.match).toMatchObject({ actionName: refundAction, agentId: 'agent_1', minAmount: 50 });
      const cleared = unwrap(await operator.approvalPolicies.update(created.id, { matchAgentId: null, minAmount: null }));
      expect(cleared.match).toMatchObject({ actionName: refundAction, agentId: null, minAmount: null });
      expect(await status(() => operator.approvalPolicies.update(created.id, { matchKind: 'custom' }))).toBe(400);
      const ok = unwrap(await operator.approvalPolicies.update(created.id, { matchKind: 'custom', matchActionName: null }));
      expect(ok.scope).toBe('custom_requests');
      expect(unwrap(await operator.approvalPolicies.disable(created.id)).enabled).toBe(false);
      expect(unwrap(await operator.approvalPolicies.enable(created.id)).enabled).toBe(true);
    } finally {
      await operator.approvalPolicies.delete(created.id);
    }
  });

  it('auth.identity() reports the credential', async () => {
    const required = ['actions:invoke', 'runs:write'];
    const checked = await runtime.auth.requireScopes(required, { forbidden: ['policies:write'] });
    expect(checked.scopes).toEqual(expect.arrayContaining(required));
    await expect(make(env.ANLYON_E2E_NARROW_KEY).auth.requireScopes(required))
      .rejects.toMatchObject({ missing: ['runs:write'] });
    await expect(operator.auth.requireScopes(required, { forbidden: ['policies:write'] }))
      .rejects.toMatchObject({ forbidden: ['policies:write'] });
    const identity = unwrap(await runtime.auth.identity());
    expect(identity.credentialType).toBe('api_key');
    expect(identity.apiKeyId).toBeTruthy();
    expect(identity.scopes).toContain('actions:invoke');
    expect(identity.scopes).not.toContain('policies:write');
    const op = unwrap(await operator.auth.identity());
    expect(op.scopes).toEqual(expect.arrayContaining(['policies:read', 'policies:write']));
    expect(op.environmentId).toBe(identity.environmentId);
  });
});
