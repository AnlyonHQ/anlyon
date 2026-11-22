import { ValidationError } from "../../utils/errors.ts";

export const MAX_GRAPHQL_QUERY_LENGTH = 10_000;

export function isReadOnlyGraphqlQuery(query: unknown): boolean {
  if (typeof query !== "string" || query.length === 0 || query.length > MAX_GRAPHQL_QUERY_LENGTH) return false;
  if (query.includes("{{")) return false;
  if (/\b(mutation|subscription)\b/i.test(query)) return false;
  const body = query.replace(/#[^\n\r]*/g, "").trim();
  return /^(query\b|\{)/.test(body);
}

export function assertReadOnlyGraphqlQuery(query: unknown, label: string): string {
  if (!isReadOnlyGraphqlQuery(query)) {
    throw new ValidationError(
      `${label} must be a fixed, read-only GraphQL query: a literal of at most ${MAX_GRAPHQL_QUERY_LENGTH} characters that starts with "query" or "{", with no placeholder, and no mutation or subscription.`,
    );
  }
  return query as string;
}
