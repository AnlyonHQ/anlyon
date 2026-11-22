import { ALL_API_KEY_SCOPES, DEFAULT_API_KEY_SCOPES, type ApiKeyScope } from "./api-key-scopes.ts";

export const WORKSPACE_SWITCH_SCOPE = "anlyon:workspace.switch";

export const API_KEY_CREATE_SCOPE = "anlyon:keys";

export const OFFLINE_ACCESS_SCOPE = "offline_access";

export const OIDC_SCOPES = ["openid", "profile", "email", OFFLINE_ACCESS_SCOPE] as const;

export const OAUTH_SCOPE_GROUPS = {
  "anlyon:messaging": {
    label: "Messaging",
    description: "Read, retry and delete failed event deliveries. Read and publish events. Create, change and delete topics and webhook subscriptions.",
    sensitive: false,
    scopes: ["dlq:read", "dlq:write", "events:read", "events:write"],
  },
  "anlyon:actions": {
    label: "Actions",
    description: "List, create, edit and delete your actions, invoke them, and read their invocations, effects and previews. Register MCP servers and list their tools; adopting a tool still needs a person's sign-off. Request approval for them and read approval requests. Read how much of their impact limits remains.",
    sensitive: false,
    scopes: ["actions:read", "actions:write", "actions:invoke", "approvals:read", "approvals:write", "impact-limits:read"],
  },
  "anlyon:events": {
    label: "Events",
    description: "Read and publish events. Create, change and delete topics and webhook subscriptions that deliver events to a URL you choose.",
    sensitive: false,
    scopes: ["events:read", "events:write"],
  },
  "anlyon:approvals.decide": {
    label: "Approve on your behalf",
    description: "Approve or deny pending approval requests without a human clicking approve.",
    sensitive: true,
    scopes: ["approvals:decide"],
  },
  "anlyon:observability": {
    label: "Observability",
    description: "Read traces, logs, analytics, notifications and notification settings. Mark notifications read, dismiss them and change your own notification preferences. Read your plan, usage, quota and invoices. Write traces and feedback.",
    sensitive: false,
    scopes: ["runs:read", "runs:write", "logs:read", "analytics:read", "billing:read", "notifications:read", "notifications:write", "feedback:write"],
  },
  "anlyon:integrations": {
    label: "Notification channels",
    description: "Connect, change, test and disconnect Slack and Discord channels. Change which email addresses and which webhook URL receive alerts. Change which alert types and channels the workspace uses. Send a test webhook to a URL.",
    sensitive: true,
    scopes: ["integrations:read", "integrations:write", "notifications:manage"],
  },
  "anlyon:secrets": {
    label: "Secrets",
    description: "List secret names, store, replace and delete secrets, and reference them in actions and outgoing requests. No API returns a secret's value.",
    sensitive: true,
    scopes: ["secrets:read", "secrets:write"],
  },
  "anlyon:workspace.switch": {
    label: "Switch between your workspaces",
    description: "Move this app to another workspace you belong to, without asking you again.",
    sensitive: true,
    scopes: [],
  },
  "anlyon:keys": {
    label: "Create API keys",
    description: "Create an API key for the environment you choose here, with the standard agent scopes: define and invoke actions, request approvals, publish events and read runs. The key cannot read secrets, decide approvals, or change policies, limits or budgets. It is shown once, to the app that asked.",
    sensitive: true,
    scopes: [],
  },
  "anlyon:guardrails": {
    label: "Guardrails",
    description: "Read, add and change approval policies and impact limits in this environment, as `anlyon plan` and `anlyon apply` do from a project's anlyon.yaml.",
    sensitive: true,
    scopes: ["policies:read", "policies:write", "impact-limits:write"],
  },
  "anlyon:budgets": {
    label: "Budgets",
    description: "Read, change and remove per-key budgets. A budget caps the Anlyon operations a key can perform. It does not cap money an action moves.",
    sensitive: true,
    scopes: ["budgets:read", "budgets:write"],
  },
} as const satisfies Record<
  string,
  { label: string; description: string; sensitive: boolean; scopes: readonly ApiKeyScope[] }
>;

export type OAuthScopeGroup = keyof typeof OAUTH_SCOPE_GROUPS;

export const ALL_OAUTH_SCOPES: string[] = [...OIDC_SCOPES, ...Object.keys(OAUTH_SCOPE_GROUPS)];

export const LEGACY_OAUTH_SCOPE_GROUPS: readonly OAuthScopeGroup[] = ["anlyon:messaging"];

const isLegacyGroup = (scope: string) => (LEGACY_OAUTH_SCOPE_GROUPS as readonly string[]).includes(scope);

export const ADVERTISED_OAUTH_SCOPES: string[] = ALL_OAUTH_SCOPES.filter((scope) => !isLegacyGroup(scope));

export const DEFAULT_OAUTH_SCOPES: string[] = [...OIDC_SCOPES, "anlyon:actions", "anlyon:events", "anlyon:observability"];

export function expandOAuthScopes(granted: readonly string[]): ApiKeyScope[] {
  const expanded = new Set<ApiKeyScope>();
  for (const scope of granted) {
    const group = OAUTH_SCOPE_GROUPS[scope as OAuthScopeGroup];
    if (group) for (const fine of group.scopes) expanded.add(fine);
  }
  return [...expanded];
}

export function parseScopeClaim(scope: unknown): string[] {
  if (Array.isArray(scope)) return scope.map(String);
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  return [];
}

export function findUnknownGroupScopes(): string[] {
  const known = new Set<string>(ALL_API_KEY_SCOPES);
  return Object.values(OAUTH_SCOPE_GROUPS)
    .flatMap((group) => group.scopes as readonly string[])
    .filter((scope) => !known.has(scope));
}
