import { and, eq, exists, isNull, lt, not, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../../db/schema/oauth.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ module: "oauth-client-maintenance" });

const SWEEP_BATCH_SIZE = 500;
const MAX_BATCHES_PER_SWEEP = 20;

const ABANDONED_AFTER_MS = 60 * 60 * 1000;

export async function sweepAbandonedOAuthClients(): Promise<{ swept: number; batches: number }> {
  let swept = 0;
  let batches = 0;

  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);

  const hasConsent = exists(
    db.select({ one: sql`1` }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthClient.clientId)),
  );
  const hasRefresh = exists(
    db
      .select({ one: sql`1` })
      .from(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.clientId, oauthClient.clientId), isNull(oauthRefreshToken.revoked))),
  );
  const hasLiveAccess = exists(
    db
      .select({ one: sql`1` })
      .from(oauthAccessToken)
      .where(and(eq(oauthAccessToken.clientId, oauthClient.clientId), sql`${oauthAccessToken.expiresAt} > now()`)),
  );

  for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
    const batch = await db
      .select({ clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(
        and(
          isNull(oauthClient.userId),
          or(isNull(oauthClient.skipConsent), eq(oauthClient.skipConsent, false)),
          not(hasConsent),
          not(hasRefresh),
          not(hasLiveAccess),
          or(lt(oauthClient.createdAt, cutoff), eq(oauthClient.disabled, true)),
        ),
      )
      .limit(SWEEP_BATCH_SIZE);

    if (batch.length === 0) break;

    await db.delete(oauthClient).where(
      sql`${oauthClient.clientId} in ${batch.map((row) => row.clientId)}`,
    );

    swept += batch.length;
    batches += 1;
    if (batch.length < SWEEP_BATCH_SIZE) break;
  }

  if (swept > 0) logger.info({ swept, batches }, "Swept abandoned OAuth clients");
  return { swept, batches };
}

export async function countRegisteredOAuthClients(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(oauthClient);
  return row?.count ?? 0;
}
