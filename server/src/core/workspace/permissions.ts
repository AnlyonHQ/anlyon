export const ROLES = ["admin", "member", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ASSIGNABLE_ROLES = ROLES;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ENVIRONMENT_ROLES = ROLES;
export type EnvironmentRole = (typeof ENVIRONMENT_ROLES)[number];

export type PermissionScope = "workspace" | "environment";

export const RETIRED_OWNER_ROLE = "owner";

const ALL: readonly Role[] = ROLES;
const ADMINS: readonly Role[] = ["admin"];
const WRITERS: readonly Role[] = ["admin", "member"];
const DECIDERS: readonly Role[] = ["admin", "member", "approver"];

export const PERMISSIONS = {
  "workspace.read": { scope: "workspace", roles: ALL },
  "workspace.update": { scope: "workspace", roles: ADMINS },
  "workspace.delete": { scope: "workspace", roles: ADMINS },
  "members.manage": { scope: "workspace", roles: ADMINS },
  "billing.manage": { scope: "workspace", roles: ADMINS },
  "keys.manage": { scope: "workspace", roles: ADMINS },
  "environments.manage": { scope: "workspace", roles: ADMINS },
  "environments.delete": { scope: "workspace", roles: ADMINS },
  "notifications.manage": { scope: "workspace", roles: ADMINS },
  "assistant.manage": { scope: "workspace", roles: ADMINS },
  "agents.manage": { scope: "workspace", roles: ADMINS },
  "identity.manage": { scope: "workspace", roles: ADMINS },
  "audit.manage": { scope: "workspace", roles: ADMINS },
  "secret-stores.manage": { scope: "workspace", roles: ADMINS },
  "governance.sign_off": { scope: "workspace", roles: ADMINS },

  "environments.halt": { scope: "environment", roles: WRITERS },
  "environments.resume": { scope: "environment", roles: ADMINS },
  "policies.manage": { scope: "environment", roles: ADMINS },
  "actions.manage": { scope: "environment", roles: WRITERS },
  "actions.invoke": { scope: "environment", roles: WRITERS },
  "actions.resolve": { scope: "environment", roles: ADMINS },
  "connections.manage": { scope: "environment", roles: WRITERS },
  "oauth-apps.manage": { scope: "environment", roles: ADMINS },
  "limits.manage": { scope: "environment", roles: ADMINS },
  "integrations.manage": { scope: "workspace", roles: WRITERS },
  "approvals.request": { scope: "environment", roles: WRITERS },
  "approvals.decide": { scope: "environment", roles: DECIDERS },
  "resources.write": { scope: "environment", roles: WRITERS },
} as const satisfies Record<string, { scope: PermissionScope; roles: readonly Role[] }>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function permissionScope(permission: Permission): PermissionScope {
  return PERMISSIONS[permission].scope;
}

export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return (PERMISSIONS[permission].roles as readonly Role[]).includes(role);
}

export function permissionsFor(role: string | null | undefined): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => hasPermission(role, permission));
}

export function permissionDeniedMessage(role: string | null | undefined, permission: Permission): string {
  if (role === "viewer") return "Viewers have read-only access. Ask a workspace admin for a different role.";
  if (role === "approver") {
    return permission === "approvals.decide"
      ? "Your role cannot decide approvals in this environment."
      : "Approvers can view everything and decide approvals, but cannot change anything else. Ask a workspace admin for a different role.";
  }
  if (permission === "approvals.decide") return "Your role cannot decide approvals in this environment.";
  const holders = PERMISSIONS[permission].roles as readonly Role[];
  if (holders.every((r) => r === "admin")) return "Only a workspace admin can do this.";
  return "Your role in this workspace cannot do this.";
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export const WRITE_ROUTE_EXCEPTIONS: ReadonlyArray<{
  method: string;
  path: RegExp;
  permission: Permission;
  why: string;
}> = [
  { method: "POST", path: /^\/api\/v2\/approvals\/[^/]+\/(approve|deny)$/, permission: "approvals.decide", why: "deciding is what an approver is for" },
  { method: "POST", path: /^\/api\/v2\/end-users\/[^/]+\/approvals\/[^/]+\/decide$/, permission: "approvals.decide", why: "relaying an end user's decision is deciding" },
  { method: "POST", path: /^\/api\/v2\/approval-policies\/(evaluate|files\/plan|files\/test)$/, permission: "workspace.read", why: "dry runs: evaluate and plan change nothing" },
  { method: "PATCH", path: /^\/api\/v2\/notifications\/preferences\/me$/, permission: "workspace.read", why: "a member's own mutes" },
  { method: "POST", path: /^\/api\/v2\/workspaces\/[^/]+\/leave$/, permission: "workspace.read", why: "anyone may leave, except the last admin" },
  { method: "POST", path: /^\/api\/v2\/feedback\/receive-feedback$/, permission: "workspace.read", why: "feedback to Anlyon, not a workspace change" },
];

export function guardPermissionFor(method: string, path: string): Permission | null {
  if (!isMutatingMethod(method)) return null;
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const upper = method.toUpperCase();
  const exception = WRITE_ROUTE_EXCEPTIONS.find((entry) => entry.method === upper && entry.path.test(normalized));
  return exception ? exception.permission : "resources.write";
}
