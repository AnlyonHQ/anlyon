import { describe, expect, it, vi } from 'vitest';
import { runPolicyCli, type PolicyCliDeps } from '../cli/anlyon-policy';
import { Client } from '../client';
import type { PolicyFilePlan } from '../types/agent';

const DIGEST = 'd'.repeat(64);
const plan = (over: Partial<PolicyFilePlan> = {}): PolicyFilePlan => ({
  file: 'payments/refunds', environmentId: 'env_1', digest: DIGEST,
  changes: [
    { op: 'create', key: 'big-refunds', name: 'Big refunds' },
    { op: 'update', key: 'eu', name: 'EU', policyId: 'apol_1', version: 2, fields: ['requiredApprovals'] },
    { op: 'delete', key: 'old', name: 'Old', policyId: 'apol_2', version: 1 },
  ],
  summary: { create: 1, update: 1, delete: 1, unchanged: 0 }, errors: [], ...over,
});
const noChanges = () => plan({ changes: [], summary: { create: 0, update: 0, delete: 0, unchanged: 3 } });

function deps(over: Partial<PolicyCliDeps['policies']> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const policies = {
    planFile: vi.fn(async () => ({ data: plan() })),
    applyFile: vi.fn(async () => ({ data: { ...plan(), applied: true as const } })),
    testFile: vi.fn(async () => ({
      data: {
        file: 'f', passed: 2, failed: 0, results: [
          { name: 'big', pass: true, policy: 'big-refunds', effect: 'require_approval' as const, explanation: '' },
          { name: 'none', pass: true, policy: null, effect: 'require_approval' as const, explanation: '' },
        ],
      },
    })),
    ...over,
  };
  const d: PolicyCliDeps = {
    readFile: vi.fn(async (path: string) => `source of ${path}`),
    policies,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { d, out, err, policies };
}

describe('anlyon-policy', () => {
  it('plan prints the changes and digest, exiting 2 when there is something to apply', async () => {
    const { d, out } = deps();
    expect(await runPolicyCli(['plan', 'policies.yaml'], d)).toBe(2);
    expect(out).toContain('  + create  big-refunds  (Big refunds)');
    expect(out).toContain('  ~ update  eu  requiredApprovals');
    expect(out).toContain('  - delete  old  (apol_2)');
    expect(out).toContain(`digest: ${DIGEST}`);
  });

  it('plan exits 0 with no changes and 1 with errors, without a digest', async () => {
    const quiet = deps({ planFile: vi.fn(async () => ({ data: noChanges() })) });
    expect(await runPolicyCli(['plan', 'f.yaml'], quiet.d)).toBe(0);
    const broken = deps({ planFile: vi.fn(async () => ({ data: plan({ errors: ['policies.x: action "y" does not exist'] }) })) });
    expect(await runPolicyCli(['plan', 'f.yaml'], broken.d)).toBe(1);
    expect(broken.out).toContain('  ! policies.x: action "y" does not exist');
    expect(broken.out.some((line) => line.startsWith('digest:'))).toBe(false);
  });

  it('apply requires the reviewed digest or an explicit --auto-approve', async () => {
    const { d, err, policies } = deps();
    expect(await runPolicyCli(['apply', 'f.yaml'], d)).toBe(1);
    expect(err.join('\n')).toMatch(/--digest from a plan you reviewed/);
    expect(policies.applyFile).not.toHaveBeenCalled();

    expect(await runPolicyCli(['apply', 'f.yaml', '--digest', 'a'.repeat(64), '--note', 'FIN-42'], d)).toBe(0);
    expect(policies.applyFile).toHaveBeenCalledWith('source of f.yaml', { digest: 'a'.repeat(64), changeNote: 'FIN-42' });
    expect(policies.planFile).not.toHaveBeenCalled();
  });

  it('--auto-approve applies the plan it just made, and nothing when there are no changes', async () => {
    const { d, policies } = deps();
    expect(await runPolicyCli(['apply', 'f.yaml', '--auto-approve'], d)).toBe(0);
    expect(policies.applyFile).toHaveBeenCalledWith('source of f.yaml', { digest: DIGEST });
    const quiet = deps({ planFile: vi.fn(async () => ({ data: noChanges() })) });
    expect(await runPolicyCli(['apply', 'f.yaml', '--auto-approve'], quiet.d)).toBe(0);
    expect(quiet.policies.applyFile).not.toHaveBeenCalled();
  });

  it('reports a server refusal with its status and code', async () => {
    const stale = Object.assign(new Error('The policies changed since this plan was made.'), { status: 409, code: 'STALE_PLAN' });
    const { d, err } = deps({ applyFile: vi.fn(async () => { throw stale; }) });
    expect(await runPolicyCli(['apply', 'f.yaml', '--digest', 'a'.repeat(64)], d)).toBe(1);
    expect(err[0]).toBe('Error (409 STALE_PLAN): The policies changed since this plan was made.');
  });

  it('test prints each case and exits 3 on failures', async () => {
    const { d, out, policies } = deps();
    expect(await runPolicyCli(['test', 'f.yaml', 'cases.yaml'], d)).toBe(0);
    expect(policies.testFile).toHaveBeenCalledWith('source of f.yaml', 'source of cases.yaml');
    expect(out).toContain('  pass  big  -> require_approval by big-refunds');
    const failing = deps({
      testFile: vi.fn(async () => ({
        data: { file: 'f', passed: 0, failed: 1, results: [{ name: 'x', pass: false, policy: null, effect: 'auto_deny' as const, explanation: '' }] },
      })),
    });
    expect(await runPolicyCli(['test', 'f.yaml', 'c.yaml'], failing.d)).toBe(3);
    expect(failing.out).toContain('  FAIL  x  -> auto_deny (no policy matched)');
  });

  it('rejects unknown commands and options without calling the API', async () => {
    const { d, policies } = deps();
    expect(await runPolicyCli(['destroy', 'f.yaml'], d)).toBe(1);
    expect(await runPolicyCli(['plan', 'f.yaml', '--force'], d)).toBe(1);
    expect(await runPolicyCli(['test', 'f.yaml'], d)).toBe(1);
    expect(policies.planFile).not.toHaveBeenCalled();
    expect(await runPolicyCli(['--help'], d)).toBe(0);
  });
});

describe('ApprovalPoliciesResource files', () => {
  it('posts plan, apply and test to the file endpoints', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: url.toString(), body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new Client({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
    await client.approvalPolicies.planFile('src');
    await client.approvalPolicies.applyFile('src', { digest: DIGEST, changeNote: 'why' });
    await client.approvalPolicies.testFile('src', 'cases: []');
    expect(calls).toEqual([
      { url: 'https://api.test/api/v2/approval-policies/files/plan', body: { source: 'src' } },
      { url: 'https://api.test/api/v2/approval-policies/files/apply', body: { source: 'src', digest: DIGEST, changeNote: 'why' } },
      { url: 'https://api.test/api/v2/approval-policies/files/test', body: { source: 'src', cases: 'cases: []' } },
    ]);
  });
});
