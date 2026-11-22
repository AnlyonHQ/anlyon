import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { instanceSettings } from "../../db/schema/instance.ts";

type Writer = Pick<typeof db, "insert">;

export async function readInternal(key: string): Promise<{ value: string | null; updatedBy: string | null; updatedAt: Date } | null> {
  const [row] = await db
    .select({ value: instanceSettings.value, updatedBy: instanceSettings.updatedBy, updatedAt: instanceSettings.updatedAt })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return row ?? null;
}

export async function writeInternal(key: string, value: string, updatedBy: string | null = null, writer: Writer = db): Promise<void> {
  const row = { value, updatedBy, updatedAt: new Date() };
  await writer.insert(instanceSettings).values({ key, ...row }).onConflictDoUpdate({ target: instanceSettings.key, set: row });
}

export async function claimInternal(key: string, value: string, updatedBy: string | null = null): Promise<boolean> {
  const inserted = await db.insert(instanceSettings).values({ key, value, updatedBy }).onConflictDoNothing().returning({ key: instanceSettings.key });
  return inserted.length > 0;
}

export async function deleteInternal(key: string): Promise<void> {
  await db.delete(instanceSettings).where(eq(instanceSettings.key, key));
}
