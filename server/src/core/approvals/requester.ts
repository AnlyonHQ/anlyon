import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { apiKeys } from "../../db/schema/workspaces.ts";

export async function apiKeyCreator(keyId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: apiKeys.createdBy })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  return row?.createdBy ?? null;
}
