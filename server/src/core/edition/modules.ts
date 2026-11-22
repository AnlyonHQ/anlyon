import { currentEdition, EDITIONS, type Edition } from "./edition.ts";

export type ModuleKind = "core" | "enterprise" | "cloud" | "self-hosted";

export interface ModuleDefinition {
  kind: ModuleKind;
  editions: readonly Edition[];
  paths: readonly string[];
  summary: string;
}

const ALL: readonly Edition[] = EDITIONS;
const CLOUD: readonly Edition[] = ["cloud"];
const SELF_HOSTED: readonly Edition[] = ["community", "team", "enterprise"];
const LICENSABLE: readonly Edition[] = ["cloud", "team", "enterprise"];

export const MODULES = {
  core: {
    kind: "core",
    editions: ALL,
    paths: [
      "/api/auth/*",
      "/api/oauth/*",
      "/.well-known/oauth-authorization-server/*",
      "/.well-known/openid-configuration/*",
      "/.well-known/oauth-protected-resource/*",
      "/mcp/*",
      "/mcp/{pack}",
      "/health/*",
      "/assets/*",
      "/api/v2/workspaces/*",
      "/api/v2/invitations/*",
      "/api/v2/auth/*",
      "/api/v2/actions/*",
      "/api/v2/mcp-upstreams/*",
      "/api/v2/mcp-vendors",
      "/api/v2/approvals/*",
      "/api/v2/approval-policies/*",
      "/api/v2/secrets/*",
      "/api/v2/connections/*",
      "/api/v2/connection-consent/*",
      "/api/v2/end-users/*",
      "/api/v2/end-user-session/*",
      "/api/v2/environments/{environmentId}/oauth-apps/*",
      "/api/v2/budgets/*",
      "/api/v2/impact-limits/*",
      "/api/v2/api-keys/*",
      "/api/v2/sign-offs/*",
      "/api/v2/sign-off-links/*",
      "/api/v2/environment/*",
      "/api/v2/edition/*",
      "/api/v2/events/*",
      "/api/v2/runs/*",
      "/api/v2/stream/*",
      "/api/v2/logs/*",
      "/api/v2/notifications/*",
      "/api/v2/integrations/*",
      "/api/v2/analytics/*",
      "/api/internal/metrics/*",
    ],
    summary: "Actions, approvals, limits, receipts, connections, environments, events, runs, workspaces, sign-in and MCP.",
  },

  dlq: { kind: "core", editions: ALL, paths: ["/api/v2/dlq/*"], summary: "Dead-letter queue: list, inspect, replay and delete failed event-webhook deliveries." },
  sandbox: { kind: "core", editions: ALL, paths: ["/api/v2/sandbox/*"], summary: "First-run tour sandbox token." },
  "public-sandbox": {
    kind: "core",
    editions: ALL,
    paths: ["/api/v2/public/sandbox/*"],
    summary: "First-run tour echo destination.",
  },

  functions: {
    kind: "core",
    editions: CLOUD,
    paths: ["/api/v2/functions/*", "/api/v2/function-runs/*", "/api/internal/function-runs/*"],
    summary: "Hosted functions: publish versions with an allow-list and budgets, run them, and take the runner's calls back into governed dispatch.",
  },

  "slack-approvals": {
    kind: "core",
    editions: ALL,
    paths: ["/api/v2/slack-approvals/*", "/api/slack/*"],
    summary: "Approve and deny in Slack: per-environment channel routing, member linking and Slack's interaction callbacks.",
  },

  sso: {
    kind: "enterprise",
    editions: ALL,
    paths: ["/api/v2/workspaces/{workspaceId}/sso/*", "/api/v2/workspaces/{workspaceId}/scim/*"],
    summary: "Single sign-on and SCIM settings for a workspace.",
  },
  scim: {
    kind: "enterprise",
    editions: LICENSABLE,
    paths: ["/api/v2/scim/*"],
    summary: "SCIM 2.0 provisioning for identity directories.",
  },
  "audit-streaming": {
    kind: "enterprise",
    editions: LICENSABLE,
    paths: ["/api/v2/audit/*", "/api/v2/workspaces/{workspaceId}/audit/*"],
    summary: "Audit records, sinks (webhook, S3, Datadog, Splunk), retention and evidence export.",
  },
  "secret-stores": {
    kind: "enterprise",
    editions: LICENSABLE,
    paths: ["/api/v2/secret-stores/*", "/api/v2/secret-store-settings/*"],
    summary: "Secrets read from the customer's own AWS Secrets Manager or Vault at dispatch.",
  },

  instance: {
    kind: "self-hosted",
    editions: SELF_HOSTED,
    paths: ["/api/v2/instance/*", "/api/v2/setup/*"],
    summary: "First-run setup, instance settings and instance admins, and anonymous telemetry. anlyon.com is configured by its operators, not from the console.",
  },
  "self-hosted-plan": {
    kind: "self-hosted",
    editions: SELF_HOSTED,
    paths: ["/api/v2/billing/plan", "/api/v2/billing/quota", "/api/v2/billing/usage/current"],
    summary: "The read-only plan and usage views the console needs, answering with the self-hosted limits.",
  },
} as const satisfies Record<string, ModuleDefinition>;

export type CoreModuleId = keyof typeof MODULES;
export type ModuleId = CoreModuleId | (string & {});

const defined = new Map<string, ModuleDefinition>();

export function defineModule(id: string, definition: ModuleDefinition): void {
  if (Object.hasOwn(MODULES, id)) throw new Error(`Module "${id}" is a core module`);
  const existing = defined.get(id);
  if (existing && existing !== definition) throw new Error(`Module "${id}" is already defined`);
  defined.set(id, definition);
}

export function resetDefinedModules(): void {
  defined.clear();
}

export function moduleDefinition(id: ModuleId): ModuleDefinition | undefined {
  return Object.hasOwn(MODULES, id) ? (MODULES[id as CoreModuleId] as ModuleDefinition) : defined.get(id);
}

export function moduleIds(): ModuleId[] {
  return [...(Object.keys(MODULES) as CoreModuleId[]), ...defined.keys()];
}

export function isModuleEnabled(id: ModuleId, edition: Edition = currentEdition()): boolean {
  const definition = moduleDefinition(id);
  return definition !== undefined && definition.editions.includes(edition);
}

export function enabledModules(edition: Edition = currentEdition()): ModuleId[] {
  return moduleIds().filter((id) => isModuleEnabled(id, edition));
}

function owns(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(`${base}/`);
  }
  return path === pattern;
}

export function modulesOwningPath(path: string): ModuleId[] {
  return moduleIds().filter((id) => moduleDefinition(id)!.paths.some((pattern) => owns(pattern, path)));
}

export function isPathEnabled(path: string, edition: Edition = currentEdition()): boolean {
  const owners = modulesOwningPath(path);
  if (owners.some((id) => moduleDefinition(id)!.kind === "enterprise" && !isModuleEnabled(id, edition))) return false;
  return owners.some((id) => isModuleEnabled(id, edition));
}

export function filterOpenApiPaths<T extends { paths?: Record<string, unknown> }>(
  document: T,
  edition: Edition = currentEdition(),
): T {
  if (!document.paths) return document;
  const paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) => isPathEnabled(path, edition)),
  );
  return { ...document, paths };
}
