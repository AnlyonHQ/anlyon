import { instanceSetting } from "../instance/settings.ts";
import { oauthClientKeys } from "../instance/registry.ts";
import { GITHUB_HEADERS, NOTION_HEADERS } from "./catalogue.ts";

export interface OAuthAppSpec {
  issuer?: string;
  requireIssuerInResponse?: boolean;
  credentials: "HUBSPOT" | "SLACK" | "GOOGLE" | "LINEAR" | "SALESFORCE" | "GITHUB" | "NOTION"
    | "MCP_UPSTREAM";
  authorizeUrl: string;
  tokenUrl: string;
  tokenBody?: "form" | "json";
  apiHeaders?: Readonly<Record<string, string>>;
  tokenHeaders?: Readonly<Record<string, string>>;
  deadGrantErrors?: string[];
  scopeSeparator: " " | ",";
  extraScopes?: string[];
  authorizeParams?: Record<string, string>;
  pkce: boolean;
  clientAuth: "body" | "basic" | "none";
  tokenParams?: Readonly<Record<string, string>>;
  response: "standard" | "slack";
  connectionConfig?: Record<string, string>;
  assumedLifetimeSeconds?: number;
  revoke?: {
    url: string;
    token: "refresh" | "access";
    style: "form" | "form_with_client" | "bearer" | "json_basic";
    method?: "POST" | "DELETE";
    field?: string;
  };
  check?: { url: string; method: "GET" | "POST"; okField?: string };
  sharedAppEndUserScopes?: string[];
}

export const OAUTH_APPS: Readonly<Record<string, OAuthAppSpec>> = {
  hubspot: {
    credentials: "HUBSPOT",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v3/token",
    scopeSeparator: " ",
    extraScopes: ["oauth"],
    pkce: false,
    clientAuth: "body",
    response: "standard",
    connectionConfig: { hub_id: "hub_id" },
    revoke: { url: "https://api.hubapi.com/oauth/2026-03/token/revoke", token: "refresh", style: "form_with_client" },
  },
  slack: {
    credentials: "SLACK",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopeSeparator: ",",
    pkce: false,
    clientAuth: "body",
    response: "slack",
    connectionConfig: { team_id: "team.id" },
    revoke: { url: "https://slack.com/api/auth.revoke", token: "access", style: "bearer" },
    check: { url: "https://slack.com/api/auth.test", method: "POST", okField: "ok" },
  },
  "google-calendar": {
    credentials: "GOOGLE",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopeSeparator: " ",
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    pkce: true,
    clientAuth: "body",
    response: "standard",
    revoke: { url: "https://oauth2.googleapis.com/revoke", token: "refresh", style: "form" },
  },
  gmail: {
    credentials: "GOOGLE",
    sharedAppEndUserScopes: ["https://www.googleapis.com/auth/gmail.send"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopeSeparator: " ",
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    pkce: true,
    clientAuth: "body",
    response: "standard",
    revoke: { url: "https://oauth2.googleapis.com/revoke", token: "refresh", style: "form" },
  },
  linear: {
    credentials: "LINEAR",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopeSeparator: ",",
    pkce: true,
    clientAuth: "body",
    response: "standard",
    revoke: { url: "https://api.linear.app/oauth/revoke", token: "refresh", style: "form" },
  },
  salesforce: {
    credentials: "SALESFORCE",
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    scopeSeparator: " ",
    pkce: true,
    clientAuth: "body",
    response: "standard",
    connectionConfig: { instance_url: "instance_url" },
    assumedLifetimeSeconds: 60 * 60,
    revoke: { url: "https://login.salesforce.com/services/oauth2/revoke", token: "refresh", style: "form" },
  },
  github: {
    credentials: "GITHUB",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopeSeparator: " ",
    pkce: true,
    clientAuth: "body",
    response: "standard",
    apiHeaders: GITHUB_HEADERS,
    deadGrantErrors: ["bad_refresh_token"],
    revoke: { url: "https://api.github.com/applications/{client_id}/token", token: "access", style: "json_basic", method: "DELETE", field: "access_token" },
    check: { url: "https://api.github.com/user", method: "GET" },
  },
  notion: {
    credentials: "NOTION",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    tokenBody: "json",
    tokenHeaders: NOTION_HEADERS,
    scopeSeparator: " ",
    authorizeParams: { owner: "user" },
    pkce: false,
    clientAuth: "basic",
    response: "standard",
    apiHeaders: NOTION_HEADERS,
    connectionConfig: { workspace_id: "workspace_id", workspace_name: "workspace_name", bot_id: "bot_id" },
    revoke: { url: "https://api.notion.com/v1/oauth/revoke", token: "access", style: "json_basic", method: "POST", field: "token" },
    check: { url: "https://api.notion.com/v1/users/me", method: "GET" },
  },
};

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function isDeploymentClientId(clientId: string): boolean {
  return Object.values(OAUTH_APPS).some((spec) => oauthClientFromEnv(spec)?.clientId === clientId);
}

export function oauthClientFromEnv(spec: OAuthAppSpec): OAuthClient | null {
  if (spec.credentials === "MCP_UPSTREAM") return null;
  const keys = oauthClientKeys(spec.credentials);
  const clientId = instanceSetting(keys.clientId);
  const clientSecret = instanceSetting(keys.clientSecret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
