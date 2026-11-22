export const ALL_API_KEY_SCOPES = [
  "integrations:read",
  "integrations:write",
  "logs:read",
  "dlq:read",
  "dlq:write",
  "billing:read",
  "notifications:read",
  "notifications:write",
  "feedback:write",
  "analytics:read",
  "events:read",
  "events:write",
  "secrets:read",
  "secrets:write",
  "actions:read",
  "actions:write",
  "actions:invoke",
  "approvals:read",
  "approvals:write",
  "approvals:decide",
  "budgets:read",
  "budgets:write",
  "runs:read",
  "runs:write",
  "actions:govern",
  "actions:resolve",
  "environments:halt",
  "messages:ingest",
  "policies:read",
  "policies:write",
  "impact-limits:read",
  "impact-limits:write",
  "notifications:manage",
  "secret-stores:read",
  "secret-stores:write",
  "audit:read",
  "end-users:read",
  "end-users:write",
  "end-users:approvals",
  "functions:read",
  "functions:write",
  "functions:run",
] as const;

export type ApiKeyScope = (typeof ALL_API_KEY_SCOPES)[number];

export const PRIVILEGED_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "secrets:read",
  "secrets:write",
  "approvals:decide",
  "integrations:read",
  "integrations:write",
  "budgets:read",
  "budgets:write",
  "actions:govern",
  "actions:resolve",
  "environments:halt",
  "messages:ingest",
  "policies:read",
  "policies:write",
  "impact-limits:write",
  "notifications:manage",
  "secret-stores:read",
  "secret-stores:write",
  "audit:read",
  "end-users:read",
  "end-users:write",
  "end-users:approvals",
  "functions:read",
  "functions:write",
  "functions:run",
];

export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = ALL_API_KEY_SCOPES.filter(
  (scope) => !PRIVILEGED_API_KEY_SCOPES.includes(scope)
);

const LIVE_SCOPES = new Set<string>(ALL_API_KEY_SCOPES);

export const isApiKeyScope = (scope: string): scope is ApiKeyScope => LIVE_SCOPES.has(scope);

export function liveApiKeyScopes(stored: readonly string[]): ApiKeyScope[] {
  return stored.filter(isApiKeyScope);
}
