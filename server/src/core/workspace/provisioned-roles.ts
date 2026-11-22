import { z } from "zod";
import { roleEnum } from "../../db/schema/workspaces.ts";
import { RETIRED_OWNER_ROLE } from "./permissions.ts";

export type WorkspaceRole = (typeof roleEnum.enumValues)[number];

export const PROVISIONABLE_ROLES = roleEnum.enumValues.filter((role) => role !== RETIRED_OWNER_ROLE) as [
  WorkspaceRole,
  ...WorkspaceRole[],
];

export const provisionableRoleSchema = z.enum(PROVISIONABLE_ROLES);

export function isProvisionableRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (PROVISIONABLE_ROLES as string[]).includes(value);
}
