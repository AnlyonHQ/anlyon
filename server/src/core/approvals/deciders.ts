import { hasPermission } from "../workspace/permissions.ts";
import { resolveMemberRole } from "../workspace/roles.ts";

export async function canDecideApprovalsIn(input: {
  workspaceId: string;
  environmentId: string;
  userId: string;
}): Promise<boolean> {
  const resolved = await resolveMemberRole(input.workspaceId, input.userId, input.environmentId);
  return resolved !== null && hasPermission(resolved.role, "approvals.decide");
}
