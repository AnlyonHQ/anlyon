import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { traceArchives } from "../../db/schema/files.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getWorkspaceStorageUsage(workspaceId: string, connection: typeof db | Transaction = db) {
  const [archive] = await connection.select({ bytes: sql<number>`coalesce(sum(${traceArchives.sizeBytes}), 0)` })
    .from(traceArchives).where(eq(traceArchives.workspaceId, workspaceId));
  const archiveBytes = Number(archive.bytes);
  return { archiveBytes, usedBytes: archiveBytes };
}
