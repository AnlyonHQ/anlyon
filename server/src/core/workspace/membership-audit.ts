import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "workspace-members" });

export type MembershipEvent =
  | "member.provisioned"
  | "member.role_changed"
  | "member.deactivated"
  | "member.reactivated"
  | "member.deprovisioned"
  | "member.profile_updated"
  | "member.environment_role_granted"
  | "member.environment_role_removed"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "scim.token_created"
  | "scim.token_revoked"
  | "scim.role_mappings_replaced"
  | "scim.settings_updated"
  | "sso.connection_created"
  | "sso.connection_deleted"
  | "sso.domains_verified"
  | "sso.settings_updated";

export type MembershipEventSource = "scim" | "sso" | "dashboard";

export function logMembershipEvent(
  event: MembershipEvent,
  fields: {
    workspaceId: string;
    source: MembershipEventSource;
    userId?: string;
    actorUserId?: string;
    [key: string]: unknown;
  },
): void {
  logger.info({ event, ...fields }, `Membership event: ${event}`);
}
