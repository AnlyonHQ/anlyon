import type { WorkspaceRole } from "../workspace/provisioned-roles.ts";

export interface RoleMapping {
  groupName: string;
  role: WorkspaceRole;
  priority: number;
  createdAt: Date;
}

export function resolveRole(groupNames: string[], mappings: RoleMapping[], defaultRole: WorkspaceRole): WorkspaceRole {
  const names = new Set(groupNames.map((name) => name.toLowerCase()));
  const matching = mappings
    .filter((mapping) => names.has(mapping.groupName.toLowerCase()))
    .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
  return matching[0]?.role ?? defaultRole;
}
