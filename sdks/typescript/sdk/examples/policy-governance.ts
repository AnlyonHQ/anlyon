import assert from 'node:assert/strict';
import { Client, SignOffRequiredError } from '@anlyonhq/sdk';

function unwrap<T>(response: { data?: T }): T {
  return response.data as T;
}

const baseUrl = process.env.ANLYON_BASE_URL ?? 'https://api.anlyon.com';
const operator = new Client({ apiKey: process.env.ANLYON_OPERATOR_KEY!, baseUrl });
const runtime = new Client({ apiKey: process.env.ANLYON_RUNTIME_KEY!, baseUrl });

async function main() {
  const identity = unwrap(await runtime.auth.identity());
  assert.ok(identity.scopes?.includes('actions:invoke'), 'runtime key needs actions:invoke');
  assert.ok(!identity.scopes?.includes('policies:write'), 'runtime key must not hold policies:write');
  console.log(`runtime key ${identity.apiKeyId} in environment ${identity.environmentId}`);

  const policy = unwrap(await operator.approvalPolicies.create({
    name: 'refund_order_denied',
    matchKind: 'action',
    matchActionName: 'refund_order',
    effect: 'auto_deny',
  }));
  console.log(`created ${policy.id}: applies to ${policy.scope}`);

  try {
    const read = unwrap(await runtime.actions.invoke('get_order', { orderId: 'ord_1' }));
    assert.equal(read.status, 'succeeded');
    console.log('get_order: succeeded');

    const refund = unwrap(await runtime.actions.invoke('refund_order', { orderId: 'ord_1' }));
    assert.equal(refund.status, 'denied');
    assert.equal(refund.responseStatus, null);
    assert.equal(refund.decision?.code, 'POLICY_DENIED');
    assert.equal(refund.decision?.policy?.name, 'refund_order_denied');
    console.log(`refund_order: ${refund.decision?.explanation}`);

    await assert.rejects(
      () => runtime.approvalPolicies.disable(policy.id),
      (error: { status?: number }) => error.status === 403,
    );
    console.log('runtime key was refused when it tried to disable the policy');
  } finally {
    try {
      await operator.approvalPolicies.delete(policy.id);
    } catch (error) {
      if (!(error instanceof SignOffRequiredError)) throw error;
      console.log(`removing the policy needs a workspace admin's sign-off: ${error.signOffUrl}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
