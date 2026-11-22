import { describe, expect, it } from 'vitest';
import { validateArgs } from '../src/validation.ts';
import { agentTools } from '../src/tools/agent.ts';
import { eventsTools } from '../src/tools/events.ts';
import { reviewerTools } from '../src/tools/reviewer.ts';

const requestApprovalSchema = agentTools.find((t) => t.name === 'request_approval')!.inputSchema;
const decideSchema = reviewerTools.find((t) => t.name === 'decide_approval')!.inputSchema;
const listEventsSchema = eventsTools.find((t) => t.name === 'list_events')!.inputSchema;
const subscriptionSchema = eventsTools.find((t) => t.name === 'create_subscription')!.inputSchema;

const nestedSchema = {
  type: 'object' as const,
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    },
  },
  required: ['items'],
};

describe('validateArgs', () => {
  it('accepts valid args', () => {
    expect(validateArgs(requestApprovalSchema, { title: 'Ship it', expiresInSeconds: 3600 })).toBeNull();
  });

  it('rejects missing required field', () => {
    expect(validateArgs(requestApprovalSchema, {})).toContain('"title" is required');
  });

  it('rejects wrong type', () => {
    expect(validateArgs(requestApprovalSchema, { title: 42 })).toContain('must be of type string');
  });

  it('rejects empty string below minLength', () => {
    expect(validateArgs(requestApprovalSchema, { title: '' })).toContain('at least 1');
  });

  it('rejects out-of-range integers', () => {
    expect(validateArgs(listEventsSchema, { limit: 0 })).toContain('>= 1');
    expect(validateArgs(listEventsSchema, { limit: 101 })).toContain('<= 100');
    expect(validateArgs(listEventsSchema, { limit: 1.5 })).toContain('must be of type integer');
  });

  it('rejects invalid enum value', () => {
    expect(validateArgs(decideSchema, { approvalId: 'apr_1', decision: 'maybe', reason: 'r' })).toContain('must be one of');
    expect(validateArgs(decideSchema, { approvalId: 'apr_1', decision: 'deny', reason: 'r' })).toBeNull();
  });

  it('validates nested array items', () => {
    expect(validateArgs(nestedSchema, { items: [{ content: 'a' }] })).toBeNull();
    expect(validateArgs(nestedSchema, { items: [{}] })).toContain('is required');
    expect(validateArgs(nestedSchema, { items: 'nope' })).toContain('must be of type array');
  });

  it('rejects arrays over maxItems', () => {
    const eventTypes = Array.from({ length: 51 }, () => '*');
    expect(validateArgs(subscriptionSchema, { topicRef: 'orders', url: 'https://example.com', eventTypes })).toContain('at most 50');
  });

  it('ignores unknown extra keys', () => {
    expect(validateArgs(requestApprovalSchema, { title: 'hello', extra: true })).toBeNull();
  });
});
