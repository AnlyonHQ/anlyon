/**
 * What each resource command needs, and whether browser login (OAuth) can grant it.
 *
 * OAuth consent is by coarse group (server/src/core/auth/oauth-scopes.ts);
 * an API key carries fine scopes. `oauthGroup: null` means no consent group
 * expands to that scope, so only an API key created with it can run the command.
 * test/capabilities.test.ts pins this table to the server's source.
 */
export interface Capability {
  command: string;
  scope: string | null;
  oauthGroup: string | null;
  /** Set when the server on main has no endpoint for it yet. */
  pending?: string;
}

export const CAPABILITIES: Capability[] = [
  { command: 'actions list', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'actions get', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'actions versions', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'actions declare', scope: 'actions:write', oauthGroup: 'anlyon:actions' },
  { command: 'actions invoke', scope: 'actions:invoke', oauthGroup: 'anlyon:actions' },
  { command: 'invocations list', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'invocations get', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'runs list', scope: 'runs:read', oauthGroup: 'anlyon:observability' },
  { command: 'runs get', scope: 'runs:read', oauthGroup: 'anlyon:observability' },
  { command: 'approvals list', scope: 'approvals:read', oauthGroup: 'anlyon:actions' },
  { command: 'approvals get', scope: 'approvals:read', oauthGroup: 'anlyon:actions' },
  { command: 'approvals approve', scope: 'approvals:decide', oauthGroup: 'anlyon:approvals.decide' },
  { command: 'approvals deny', scope: 'approvals:decide', oauthGroup: 'anlyon:approvals.decide' },
  { command: 'policies list', scope: 'policies:read', oauthGroup: 'anlyon:guardrails' },
  { command: 'policies get', scope: 'policies:read', oauthGroup: 'anlyon:guardrails' },
  { command: 'policies versions', scope: 'policies:read', oauthGroup: 'anlyon:guardrails' },
  { command: 'effects list', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'effects get', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'impact-limits list', scope: 'impact-limits:read', oauthGroup: 'anlyon:actions' },
  { command: 'impact-limits get', scope: 'impact-limits:read', oauthGroup: 'anlyon:actions' },
  { command: 'connections integrations', scope: 'secrets:read', oauthGroup: 'anlyon:secrets' },
  { command: 'connections list', scope: 'secrets:read', oauthGroup: 'anlyon:secrets' },
  { command: 'connections add', scope: 'secrets:write', oauthGroup: 'anlyon:secrets' },
  { command: 'connections check', scope: 'secrets:write', oauthGroup: 'anlyon:secrets' },
  { command: 'connections reconnect', scope: 'secrets:write', oauthGroup: 'anlyon:secrets' },
  { command: 'integrations find', scope: null, oauthGroup: null },
  { command: 'packs plan', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'packs install', scope: 'actions:write', oauthGroup: 'anlyon:actions' },
  { command: 'packs exercise', scope: 'actions:invoke', oauthGroup: 'anlyon:actions' },
  { command: 'init', scope: null, oauthGroup: null },
  { command: 'setup claude-code', scope: null, oauthGroup: null },
  { command: 'setup cursor', scope: null, oauthGroup: null },
  { command: 'plan', scope: 'policies:read', oauthGroup: 'anlyon:guardrails' },
  { command: 'apply', scope: 'policies:write', oauthGroup: 'anlyon:guardrails' },
  { command: 'pull', scope: 'policies:read', oauthGroup: 'anlyon:guardrails' },
  { command: 'billing status', scope: 'billing:read', oauthGroup: 'anlyon:observability' },
  { command: 'billing upgrade', scope: null, oauthGroup: null },
  { command: 'sign-offs list', scope: null, oauthGroup: null },
  { command: 'sign-offs get', scope: null, oauthGroup: null },
  { command: 'sign-offs cancel', scope: null, oauthGroup: null },
  { command: 'mcp list', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'mcp tools', scope: 'actions:read', oauthGroup: 'anlyon:actions' },
  { command: 'mcp add', scope: 'actions:write', oauthGroup: 'anlyon:actions' },
  { command: 'mcp adopt', scope: 'actions:write', oauthGroup: 'anlyon:actions' },
  { command: 'mcp archive', scope: 'actions:write', oauthGroup: 'anlyon:actions' },
];

/**
 * What `anlyon auth login` asks for by default: identity, a refresh token, and
 * the two groups the read commands need. Nothing sensitive: approvals.decide,
 * secrets, budgets and the rest must be named with --scope.
 *
 * `anlyon:actions` also grants actions:write/invoke and approvals:write. There is
 * no read-only group; that over-grant is recorded in the capability matrix.
 */
export const DEFAULT_LOGIN_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'anlyon:actions', 'anlyon:observability'];

export function capabilityFor(command: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.command === command);
}
