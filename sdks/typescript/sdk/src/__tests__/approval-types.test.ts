import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Approval, Invocation } from '../types/agent';

function describePolicy(approval: Approval): string {
  if (approval.matchedPolicyId === null || approval.matchedPolicyVersion === null) {
    return approval.policyExplanation ?? 'No policy governed this approval.';
  }
  return `${approval.matchedPolicyId} v${approval.matchedPolicyVersion}: ${approval.policyExplanation ?? ''}`;
}

function explain(invocation: Invocation): string {
  return invocation.decision?.explanation ?? 'Reason unavailable for this historical invocation';
}

describe('Approval and Invocation types', () => {
  it('declare the policy fields with accurate nullability', () => {
    expectTypeOf<Approval['matchedPolicyId']>().toEqualTypeOf<string | null>();
    expectTypeOf<Approval['matchedPolicyVersion']>().toEqualTypeOf<number | null>();
    expectTypeOf<Approval['policyExplanation']>().toEqualTypeOf<string | null>();
    expectTypeOf<Approval['requiredApprovals']>().toEqualTypeOf<number>();
    expectTypeOf<Approval['approvedCount']>().toEqualTypeOf<number>();
    expectTypeOf<Approval['decisionOrigin']>().toEqualTypeOf<'human' | 'policy' | 'system' | 'unknown' | 'assistant' | null>();
    expectTypeOf<Invocation['decision']>().not.toBeAny();
  });

  it('are usable without assertions', () => {
    const governed = { matchedPolicyId: 'apol_1', matchedPolicyVersion: 2, policyExplanation: 'why' } as Approval;
    const historical = { matchedPolicyId: null, matchedPolicyVersion: null, policyExplanation: null } as Approval;
    expect(describePolicy(governed)).toBe('apol_1 v2: why');
    expect(describePolicy(historical)).toBe('No policy governed this approval.');
    expect(explain({ decision: null } as Invocation)).toBe('Reason unavailable for this historical invocation');
  });
});
