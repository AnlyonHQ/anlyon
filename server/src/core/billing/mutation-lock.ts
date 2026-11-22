import { sql } from "drizzle-orm";
import { db } from "../../db/index.ts";

export async function withBillingMutation<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${workspaceId}`}, 0))`);
    return run();
  });
}
