import { asc, count, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { instanceAdmins } from "../../db/schema/instance.ts";
import { user } from "../../db/schema/user.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { readInternal } from "./internal.ts";
import { INTERNAL_KEYS } from "./registry.ts";
import { createLogger } from "../../lib/logger.ts";
import { ConflictError, NotFoundError } from "../../utils/errors.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { isCloudEdition } from "../edition/edition.ts";
import { instanceAuditRecords } from "./audit.ts";

const logger = createLogger({ module: "instance-admins" });

type Writer = Pick<typeof db, "insert">;

export async function isInstanceAdmin(userId: string): Promise<boolean> {
  if (isCloudEdition()) return false;
  const [row] = await db.select({ userId: instanceAdmins.userId }).from(instanceAdmins).where(eq(instanceAdmins.userId, userId)).limit(1);
  return Boolean(row);
}

export interface InstanceAdminView {
  userId: string;
  email: string;
  name: string;
  grantedBy: string | null;
  grantedAt: string;
}

export async function listInstanceAdmins(): Promise<InstanceAdminView[]> {
  const rows = await db
    .select({ userId: instanceAdmins.userId, email: user.email, name: user.name, grantedBy: instanceAdmins.grantedBy, grantedAt: instanceAdmins.grantedAt })
    .from(instanceAdmins)
    .innerJoin(user, eq(user.id, instanceAdmins.userId))
    .orderBy(asc(instanceAdmins.grantedAt));
  return rows.map((row) => ({ ...row, grantedAt: row.grantedAt.toISOString() }));
}

export async function insertInstanceAdmin(writer: Writer, userId: string, grantedBy: string | null): Promise<void> {
  await writer.insert(instanceAdmins).values({ userId, grantedBy }).onConflictDoNothing();
}

export async function grantInstanceAdmin(email: string, grantedBy: string, context?: StoredAuditContext): Promise<InstanceAdminView> {
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase())).limit(1);
  if (!account) throw new NotFoundError("Account with that email");
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(instanceAdmins).values({ userId: account.id, grantedBy }).onConflictDoNothing().returning();
    if (inserted.length === 0) return;
    await writeAuditEvents(tx, await instanceAuditRecords(tx, "instance.admin_granted", grantedBy, { userId: account.id }, context));
  });
  logger.info({ userId: account.id, by: grantedBy }, "Instance admin granted");
  const admins = await listInstanceAdmins();
  return admins.find((admin) => admin.userId === account.id)!;
}

export async function revokeInstanceAdmin(userId: string, revokedBy: string, context?: StoredAuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('instance_admins'))`);
    const [{ total }] = await tx.select({ total: count() }).from(instanceAdmins);
    const deleted = await tx.delete(instanceAdmins).where(eq(instanceAdmins.userId, userId)).returning();
    if (deleted.length === 0) throw new NotFoundError("Instance admin");
    if (Number(total) <= 1) throw new ConflictError("This is the only instance admin. Grant someone else first.");
    await writeAuditEvents(tx, await instanceAuditRecords(tx, "instance.admin_revoked", revokedBy, { userId }, context));
  });
  logger.info({ userId, by: revokedBy }, "Instance admin revoked");
}

export async function ensureInstanceAdmin(): Promise<void> {
  if (isCloudEdition()) return;
  const [{ admins }] = await db.select({ admins: count() }).from(instanceAdmins);
  if (Number(admins) > 0) return;
  if (await readInternal(INTERNAL_KEYS.setupCompletedAt)) {
    logger.error("This install has no instance admin. Create one with `pnpm admin:create` (scripts/create-admin).");
    return;
  }
  const [owner] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.emergencyAccess, true))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  if (!owner) return;
  await insertInstanceAdmin(db, owner.userId, null);
  logger.warn({ userId: owner.userId }, "This install had no instance admin; the emergency-access admin of its oldest workspace is now one");
}
