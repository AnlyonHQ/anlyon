import type { ApiError, ErrorFix } from "../utils/errors.ts";
import { LEGACY_OAUTH_SCOPE_GROUPS, OAUTH_SCOPE_GROUPS, type OAuthScopeGroup } from "../core/auth/oauth-scopes.ts";
import { ALL_PERMISSIONS, ROLES, permissionDeniedMessage } from "../core/workspace/permissions.ts";
import { END_USER_HEADER } from "../core/end-users/identity.ts";
import { integrationRouteFix } from "../core/connections/integration-route.ts";

export type { ErrorFix } from "../utils/errors.ts";

export interface FixContext {
  consoleUrl: string;
  authType?: string;
  requiredScope?: string;
  environmentId?: string;
}

export type FixableError = Pick<ApiError, "code" | "message"> & { details?: unknown };

const DOCS = "https://docs.anlyon.com";

const docs = {
  apiReference: `${DOCS}/api-reference`,
  authentication: `${DOCS}/authentication`,
  cliAuthentication: `${DOCS}/cli/authentication`,
  workspaces: `${DOCS}/account/workspaces`,
  billing: `${DOCS}/account/billing`,
  actForUsers: `${DOCS}/guides/act-for-your-users`,
  endUserConnections: `${DOCS}/execution/end-user-connections`,
  environments: `${DOCS}/trust-control/environments`,
  approvals: `${DOCS}/trust-control/approvals`,
  policyAsCode: `${DOCS}/trust-control/policy-as-code`,
  secrets: `${DOCS}/execution/secrets`,
  connectedAccounts: `${DOCS}/execution/connected-accounts`,
  actions: `${DOCS}/execution/actions`,
  signOffs: `${DOCS}/trust-control/sign-offs`,
} as const;

const consolePages = {
  apiKeys: "/settings/api-keys",
  team: "/settings/team",
  billing: "/settings/billing",
  environments: "/environments",
  actions: "/actions",
  secrets: "/actions/secrets",
  approvals: "/approvals",
  integrations: "/integrations",
  connectSettings: "/integrations/settings",
  signOffs: "/sign-offs",
} as const;

function consoleLink(context: FixContext, path: string, search?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) if (value) params.set(key, value);
  const query = params.toString();
  return `${context.consoleUrl.replace(/\/$/, "")}${path}${query ? `?${query}` : ""}`;
}

function detail(error: FixableError, key: string): string | undefined {
  const details = error.details;
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

const SCOPE_IN_MESSAGE = [/missing required scope: ([\w:.-]+)/, /requires the "([\w:.-]+)" scope/];

export function requiredScopeOf(error: FixableError, context: Pick<FixContext, "requiredScope"> = {}): string | undefined {
  if (context.requiredScope) return context.requiredScope;
  const fromDetails = detail(error, "requiredScope");
  if (fromDetails) return fromDetails;
  for (const pattern of SCOPE_IN_MESSAGE) {
    const match = pattern.exec(error.message);
    if (match) return match[1];
  }
  return undefined;
}

const isLegacyGroup = (group: string) => (LEGACY_OAUTH_SCOPE_GROUPS as readonly string[]).includes(group);

export function consentGroupFor(scope: string): OAuthScopeGroup | null {
  if (scope in OAUTH_SCOPE_GROUPS && !isLegacyGroup(scope)) return scope as OAuthScopeGroup;
  for (const [group, definition] of Object.entries(OAUTH_SCOPE_GROUPS)) {
    if (isLegacyGroup(group)) continue;
    if ((definition.scopes as readonly string[]).includes(scope)) return group as OAuthScopeGroup;
  }
  return null;
}

function missingScopeFix(scope: string, context: FixContext): ErrorFix | undefined {
  if (context.authType === "endUserSession") return undefined;
  const group = consentGroupFor(scope);
  const apiKeys = consoleLink(context, consolePages.apiKeys);
  if (context.authType === "oauth") {
    if (group) {
      return {
        summary: `Log in again and approve the ${group} consent group, which grants ${scope}.`,
        command: `anlyon auth login --scope ${group}`,
        docs: docs.cliAuthentication,
      };
    }
    return {
      summary: `Ask a workspace admin to create an API key with ${scope} in the console, since no browser login grants it.`,
      url: apiKeys,
      docs: docs.authentication,
    };
  }
  if (group) {
    return {
      summary: `Log in with the ${group} consent group, or ask a workspace admin for an API key with ${scope}.`,
      command: `anlyon auth login --scope ${group}`,
      url: apiKeys,
      docs: docs.authentication,
    };
  }
  return {
    summary: `Ask a workspace admin to create an API key with ${scope} in the console, since no browser login grants it.`,
    url: apiKeys,
    docs: docs.authentication,
  };
}

const ROLE_REFUSALS: ReadonlySet<string> = new Set(
  [...ROLES, null].flatMap((role) => ALL_PERMISSIONS.map((permission) => permissionDeniedMessage(role, permission))),
);

export function isRoleRefusal(error: FixableError): boolean {
  return error.code === "AUTHORIZATION_ERROR" && ROLE_REFUSALS.has(error.message);
}

function authorizationFix(error: FixableError, context: FixContext): ErrorFix | undefined {
  const scope = requiredScopeOf(error, context);
  if (scope) return missingScopeFix(scope, context);
  if (isRoleRefusal(error)) {
    return {
      summary: "Ask a workspace admin for a role that can do this.",
      url: consoleLink(context, consolePages.team),
      docs: docs.workspaces,
    };
  }
  return undefined;
}

type FixRule = (error: FixableError, context: FixContext) => ErrorFix | undefined;

const billingUrl = (error: FixableError, context: FixContext) => detail(error, "billingUrl") ?? consoleLink(context, consolePages.billing);

export const ERROR_FIXES: Readonly<Record<string, FixRule>> = {
  AUTHENTICATION_ERROR: () => ({
    summary: "Log in again, or send a valid API key as Authorization: Bearer <key>.",
    command: "anlyon auth login",
    docs: docs.authentication,
  }),
  AUTHORIZATION_ERROR: authorizationFix,
  SELF_APPROVAL_NOT_ALLOWED: (_error, context) => ({
    summary: "Ask another person to decide this approval in the console, since a credential cannot decide what it requested.",
    url: consoleLink(context, consolePages.approvals),
    docs: docs.approvals,
  }),
  SIGN_OFF_NOT_PENDING: () => ({
    summary: "Read the request to see how it ended, and if it expired or failed, make the change again to ask for a new sign-off.",
    command: "anlyon sign-offs list",
    docs: docs.signOffs,
  }),
  SIGN_OFF_CANCEL_BY_REQUESTER: (_error, context) => ({
    summary: "Reject the request in the console instead, since the credential that asked is the one that can withdraw it.",
    url: consoleLink(context, consolePages.signOffs),
    docs: docs.signOffs,
  }),
  VALIDATION_ERROR: (error, context) => {
    const integration = detail(error, "reason") === "integration_not_connectable" ? detail(error, "integration") : undefined;
    if (integration) return integrationRouteFix(integration, context.consoleUrl);
    return {
      summary: "Correct the request against the API reference, then send it again.",
      docs: docs.apiReference,
    };
  },

  PAYMENT_REQUIRED: (error, context) => ({
    summary: "Ask a workspace admin to choose a plan in billing settings.",
    url: billingUrl(error, context),
    docs: docs.billing,
  }),
  PLAN_FEATURE_REQUIRED: (error, context) => ({
    summary: "Ask a workspace admin to upgrade to the Team plan in billing settings.",
    url: billingUrl(error, context),
    docs: docs.billing,
  }),
  FEATURE_NOT_AVAILABLE: (error, context) => ({
    summary: "Ask a workspace admin to move to a plan that includes this in billing settings.",
    url: billingUrl(error, context),
    docs: docs.billing,
  }),
  PAID_PLAN_REQUIRED: (error, context) => ({
    summary: "Ask a workspace admin to choose a paid plan in billing settings, then buy the action pack.",
    url: billingUrl(error, context),
    docs: docs.billing,
  }),
  QUOTA_EXCEEDED: (error, context) => ({
    summary: "Free up room, wait for the allowance to reset, or change the plan in billing settings, as the message says.",
    url: billingUrl(error, context),
    docs: docs.billing,
  }),
  RATE_LIMIT_EXCEEDED: () => ({
    summary: "Wait for the Retry-After interval, or a few seconds when there is none, then retry.",
  }),
  BUDGET_EXCEEDED: (_error, context) => ({
    summary: "Raise this API key's monthly budget in the console, or wait until next month.",
    url: consoleLink(context, consolePages.apiKeys),
  }),
  FEATURE_NOT_IN_EDITION: () => ({
    summary: "Stop retrying: this deployment does not include this feature.",
  }),

  ENVIRONMENT_HALTED: (_error, context) => ({
    summary: "Ask a workspace admin to resume this environment in the console, then retry.",
    url: consoleLink(context, consolePages.environments),
    docs: docs.environments,
  }),
  ACTION_DISABLED: (_error, context) => ({
    summary: "Enable the action in the console, then retry.",
    url: consoleLink(context, consolePages.actions),
    docs: docs.actions,
  }),
  ACTION_NOT_FOUND: () => ({
    summary: "Use an action name that exists in this environment.",
    command: "anlyon actions list",
    docs: docs.actions,
  }),

  SECRET_NOT_FOUND: (_error, context) => ({
    summary: "Create the secret in this environment, or connect the account it names, then retry.",
    url: consoleLink(context, consolePages.secrets),
    docs: docs.secrets,
  }),
  SECRET_KIND_MISMATCH: (_error, context) => ({
    summary: "Delete the secret, then create it again as the kind you need.",
    url: consoleLink(context, consolePages.secrets),
    docs: docs.secrets,
  }),
  CONNECTION_NEEDS_REAUTH: (error, context) => {
    const secret = detail(error, "secret");
    return {
      summary: "Reconnect the connected account, then retry.",
      ...(secret ? { command: `anlyon connections reconnect ${secret}` } : { url: consoleLink(context, consolePages.integrations) }),
      docs: docs.connectedAccounts,
    };
  },
  CONNECTION_SESSION_EXPIRED: () => ({
    summary: "Start the connection again.",
    docs: docs.connectedAccounts,
  }),
  OWN_OAUTH_APP_REQUIRED: (error, context) => ({
    summary: "Ask a workspace admin to add this environment's own OAuth app for the integration in the console, then retry.",
    url: consoleLink(context, consolePages.integrations, { integration: detail(error, "integration"), tab: "sign-in" }),
    docs: docs.endUserConnections,
  }),
  REDIRECT_URL_REQUIRED: (_error, context) => ({
    summary: "Send a redirectUrl from this environment's allowed redirect URLs, or set a default redirect URL in Connect settings.",
    url: consoleLink(context, consolePages.connectSettings, { environmentId: context.environmentId }),
    docs: docs.actForUsers,
  }),
  REDIRECT_URL_NOT_ALLOWED: (_error, context) => ({
    summary: "Use a redirectUrl under one of this environment's allowed redirect URLs, or add it to them in Connect settings.",
    url: consoleLink(context, consolePages.connectSettings, { environmentId: context.environmentId }),
    docs: docs.actForUsers,
  }),

  END_USER_REQUIRED: () => ({
    summary: `Send the ${END_USER_HEADER} header with the id of the end user this call acts for.`,
    docs: docs.actForUsers,
  }),
  END_USER_HEADER_NOT_ALLOWED: () => ({
    summary: `Remove the ${END_USER_HEADER} header, or make this call from your server with an API key.`,
    docs: docs.actForUsers,
  }),
  END_USER_HEADER_MISMATCH: () => ({
    summary: `Send the same end user id in the ${END_USER_HEADER} header and the path.`,
    docs: docs.actForUsers,
  }),
  END_USER_SESSION_NOT_ALLOWED: () => ({
    summary: "Call this route from your server with an API key, not an end-user session token.",
    docs: docs.actForUsers,
  }),
  END_USER_SESSION_API_KEY_REQUIRED: () => ({
    summary: "Create end-user session tokens from your server with an API key.",
    docs: docs.actForUsers,
  }),
  END_USER_SESSION_SCOPE: (error, context) => {
    const scope = /(end-users:[\w-]+)/.exec(error.message)?.[1] ?? "the end-users scope it needs";
    return {
      summary: `Ask a workspace admin for an API key with ${scope}, and create the session with it.`,
      url: consoleLink(context, consolePages.apiKeys),
      docs: docs.actForUsers,
    };
  },

  POLICY_MANAGED_BY_FILE: () => ({
    summary: "Change this policy in the policy file that manages it, then plan and apply that file with anlyon-policy.",
    docs: docs.policyAsCode,
  }),
  STALE_PLAN: () => ({
    summary: "Plan the file again, review the changes, and apply with the new digest.",
    docs: docs.policyAsCode,
  }),
  POLICY_FILE_INVALID: () => ({
    summary: "Fix the errors the message lists in the policy file, then plan it again.",
    docs: docs.policyAsCode,
  }),
};

export const FIXED_ERROR_CODES: readonly string[] = Object.keys(ERROR_FIXES);

export function fixFor(error: FixableError & { fix?: ErrorFix }, context: FixContext): ErrorFix | undefined {
  if (error.fix) return error.fix;
  const rule = Object.prototype.hasOwnProperty.call(ERROR_FIXES, error.code) ? ERROR_FIXES[error.code] : undefined;
  return rule?.(error, context);
}
