import { describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { Client } from '@anlyonhq/sdk';
import { createAnlyonTools } from '../src/tools.ts';

const model = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
      warnings: [],
    },
  });

describe('tools through generateText', () => {
  it('converts every tool schema before calling the provider', async () => {
    const provider = model('Ready.');
    const client = {} as Client;
    const tools = createAnlyonTools(client, { legacy: true });
    const result = await generateText({ model: provider, tools, prompt: 'What can you do?' });

    expect(result.text).toBe('Ready.');
    expect(provider.doGenerateCalls).toHaveLength(1);
    expect(provider.doGenerateCalls[0].tools).toHaveLength(Object.keys(tools).length);
  });

  it('validates a record input and executes the selected hosted-action tool', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { pendingApproval: true, approvalId: 'apr_1' } });
    const client = { actions: { invoke } } as unknown as Client;
    const provider = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'invokeAction',
          input: JSON.stringify({ name: 'refund', input: { order: 'order_1', amount: 10 } }) }],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const result = await generateText({ model: provider, tools: createAnlyonTools(client), prompt: 'Propose a refund.' });

    expect(invoke).toHaveBeenCalledExactlyOnceWith('refund', { order: 'order_1', amount: 10 });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].output).toContain('apr_1');
  });
});
