import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FunctionRun, HostedFunction } from '@anlyonhq/sdk';

const listActions = vi.fn();
const listFunctions = vi.fn();
const run = vi.fn();

vi.mock('../src/client-factory.ts', () => ({
  getClient: () => ({ actions: { list: listActions }, functions: { list: listFunctions, run } }),
}));

const { listTools, callTool } = await import('../src/server.ts');
const { clearActionToolCache } = await import('../src/tools/dynamic-actions.ts');
const { buildFunctionTools, clearFunctionToolCache } = await import('../src/tools/dynamic-functions.ts');

function fn(overrides: Partial<HostedFunction> = {}): HostedFunction {
  return {
    id: 'fn_1',
    name: 'refund-with-checks',
    description: 'Refund a paid order.',
    environmentId: '00000000-0000-4000-8000-000000000001',
    currentVersion: {
      id: 'fnv_1',
      version: 1,
      language: 'javascript',
      digest: 'sha256:abc',
      allowedActions: ['refund'],
      inputSchema: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] },
      budgets: { maxActionCalls: 50, maxCpuMs: 1000, maxSubrequests: 100, timeoutMs: 30000 },
      straightThrough: null,
      createdAt: '2026-10-24T00:00:00.000Z',
    },
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  } as HostedFunction;
}

function planned(): FunctionRun {
  return {
    id: 'frn_plan',
    status: 'awaiting_approval',
    plan: {
      digest: 'sha256:plan',
      writes: [{ sequence: 1, action: 'refund', input: { order: 'o_1' } }],
      approval: { id: 'apr_1', status: 'pending', decider: 'end_user' },
      appliedByRunId: null,
    },
  } as unknown as FunctionRun;
}

beforeEach(() => {
  clearActionToolCache();
  clearFunctionToolCache();
  listActions.mockReset().mockResolvedValue({ data: [] });
  listFunctions.mockReset().mockResolvedValue({ data: [fn(), fn({ id: 'fn_2', name: 'draft', currentVersion: null })] });
  run.mockReset();
  process.env.ANLYON_API_KEY = 'anlyon_live_test';
  delete process.env.ANLYON_MCP_DYNAMIC_ACTIONS;
});

afterEach(() => {
  delete process.env.ANLYON_API_KEY;
});

describe('buildFunctionTools', () => {
  it('serves each published function with its input schema under input, and a planRunId to apply', () => {
    const [tool, ...rest] = buildFunctionTools([fn(), fn({ name: 'draft', currentVersion: null })]);
    expect(rest).toEqual([]);
    expect(tool).toMatchObject({
      name: 'function_refund-with-checks',
      functionName: 'refund-with-checks',
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
    expect(tool!.inputSchema.properties.input).toEqual(fn().currentVersion!.inputSchema);
    expect(tool!.inputSchema.properties.planRunId).toMatchObject({ type: 'string' });
    expect(tool!.description).toContain('Refund a paid order.');
  });
});

describe('function tools on the server', () => {
  it('are listed beside the action tools, and not on an integration server', async () => {
    expect((await listTools()).tools.map((t) => t.name)).toContain('function_refund-with-checks');
    clearFunctionToolCache();
    expect((await listTools({ functions: false })).tools.map((t) => t.name)).not.toContain('function_refund-with-checks');
  });

  it('plan without planRunId, and say how to apply once approved', async () => {
    run.mockResolvedValue({ data: planned() });
    const result = await callTool('function_refund-with-checks', { input: { order: 'o_1' } });
    expect(run).toHaveBeenCalledWith('refund-with-checks', { input: { order: 'o_1' }, mode: 'plan' });
    const body = (result.content[0] as { text: string }).text;
    expect(body).toContain('nothing was sent');
    expect(body).toContain('approvalId=apr_1');
    expect(body).toContain('planRunId=frn_plan');
  });

  it('apply with planRunId', async () => {
    run.mockResolvedValue({ data: { id: 'frn_apply', status: 'succeeded' } });
    await callTool('function_refund-with-checks', { planRunId: 'frn_plan' });
    expect(run).toHaveBeenCalledWith('refund-with-checks', { mode: 'apply', planRunId: 'frn_plan' });
  });

  it('answer as unknown when functions cannot be listed, or on an integration server', async () => {
    listFunctions.mockRejectedValue(new Error('404'));
    expect((await listTools()).tools.some((t) => t.name.startsWith('function_'))).toBe(false);
    expect((await callTool('function_refund-with-checks', {})).isError).toBe(true);
    expect((await callTool('function_refund-with-checks', {}, { functions: false })).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
