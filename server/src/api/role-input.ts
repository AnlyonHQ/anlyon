import type { Context, Next } from "hono";
import { z } from "zod";
import { ASSIGNABLE_ROLES, RETIRED_OWNER_ROLE } from "../core/workspace/permissions.ts";
import { ApiError } from "../utils/errors.ts";

export const roleInputSchema = z.enum([...ASSIGNABLE_ROLES, RETIRED_OWNER_ROLE]);

export const OWNER_ROLE_RETIRED_MESSAGE =
  'The owner role was merged into admin. Send "role": "admin". Emergency access (password sign-in when single sign-on is required) is set separately with PUT /api/v2/workspaces/{workspaceId}/members/{userId}/emergency-access.';

export async function refuseRetiredOwnerRole(c: Context, next: Next): Promise<void> {
  const body = c.get("validatedBody") as { role?: unknown } | undefined;
  if (body?.role === RETIRED_OWNER_ROLE) throw new ApiError(400, "OWNER_ROLE_RETIRED", OWNER_ROLE_RETIRED_MESSAGE);
  await next();
}
