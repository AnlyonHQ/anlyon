import { describe, it, expect } from 'vitest';
import { actionVerifySchema } from './validation';

describe('Validation Schemas', () => {
  describe('actionVerifySchema', () => {
    const rule = { url: 'https://api.linear.app/graphql', status: 200, match: [{ path: 'data.issue.title', equals: '{{input.title}}' }] };

    it('takes a GraphQL read-back, whose query rule is checked by the declarations', () => {
      const graphql = { query: 'query($id: String!) { issue(id: $id) { title } }', variables: { id: '{{response.data.issueCreate.issue.id}}' } };
      expect(actionVerifySchema.safeParse({ ...rule, graphql }).success).toBe(true);
    });

    it('refuses an unknown key, a nested variable and more than 20 variables', () => {
      expect(actionVerifySchema.safeParse({ ...rule, graphql: { query: 'query { a }', extra: 1 } }).success).toBe(false);
      expect(actionVerifySchema.safeParse({ ...rule, graphql: { query: 'query { a }', variables: { a: { b: 1 } } } }).success).toBe(false);
      const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`v${i}`, i]));
      expect(actionVerifySchema.safeParse({ ...rule, graphql: { query: 'query { a }', variables: many } }).success).toBe(false);
    });
  });
});
