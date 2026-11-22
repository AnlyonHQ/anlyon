import { and, eq } from "drizzle-orm";
import type { db } from "../../db/index.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { ApiError } from "../../utils/errors.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const MAX_EMERGENCY_ACCESS_ADMINS = 2;

export const LAST_ADMIN_MESSAGE =
  "A workspace needs at least one admin. Make someone else an admin first.";
export const LAST_EMERGENCY_ACCESS_MESSAGE =
  "A workspace needs at least one admin with emergency access, so it can be reached if single sign-on fails. Give another admin emergency access first.";

export class LastAdminError extends ApiError {
  constructor(message: string = LAST_ADMIN_MESSAGE, code = "LAST_ADMIN") {
    super(409, code, message);
    this.name = "LastAdminError";
  }
}

export interface AdminRow {
  userId: string;
  emergencyAccess: boolean;
}

export interface MembershipAfter {
  userId: string;
  admin: boolean;
  emergencyAccess: boolean;
}

export function adminChangeRefusal(admins: readonly AdminRow[], after: MembershipAfter): LastAdminError | null {
  const others = admins.filter((row) => row.userId !== after.userId);
  const adminsAfter = others.length + (after.admin ? 1 : 0);
  if (adminsAfter === 0) return new LastAdminError();

  const emergencyNow = admins.filter((row) => row.emergencyAccess).length;
  const emergencyAfter = others.filter((row) => row.emergencyAccess).length + (after.emergencyAccess ? 1 : 0);
  if (emergencyNow > 0 && emergencyAfter === 0) {
    return new LastAdminError(LAST_EMERGENCY_ACCESS_MESSAGE, "LAST_EMERGENCY_ACCESS_ADMIN");
  }
  if (emergencyAfter > MAX_EMERGENCY_ACCESS_ADMINS && emergencyAfter > emergencyNow) {
    return new LastAdminError(
      `At most ${MAX_EMERGENCY_ACCESS_ADMINS} admins can hold emergency access. Remove it from another admin first.`,
      "EMERGENCY_ACCESS_LIMIT",
    );
  }
  return null;
}

export async function assertAdminsRemain(tx: Transaction, workspaceId: string, after: MembershipAfter): Promise<void> {
  const admins = await tx
    .select({ userId: workspaceMembers.userId, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")))
    .for("update");
  const refusal = adminChangeRefusal(admins, after);
  if (refusal) throw refusal;
}
