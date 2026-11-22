import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { apiKeys, workspaceMembers } from "../../db/schema/workspaces.ts";
import { oauthWorkspaceBinding } from "../../db/schema/oauth.ts";
import { redis, RedisKeys } from "../../lib/redis.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { assertSsoSessionForWorkspace } from "../sso/sessions.ts";
import { type AuditRecordInput, writeAuditEvents } from "../audit/outbox.ts";
import type { AuditActor, StoredAuditContext } from "../audit/event-schema.ts";
import { createLogger } from "../../lib/logger.ts";

export interface AccessRevocation {
  membershipRemoved: boolean;
  apiKeysRevoked: number;
  oauthGrantsRevoked: number;
}

export interface RevocationAudit {
  reason: "member_removed" | "member_deprovisioned" | "member_left";
  actor?: AuditActor;
  context?: StoredAuditContext;
  membershipRecord: (result: { membershipRemoved: boolean; apiKeysRevoked: number }) => AuditRecordInput | null;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const logger = createLogger({ module: "access-revocation" });

async function dropCachedKeys(keys: ReadonlyArray<{ id: string; keyHash: string }>): Promise<void> {
  if (keys.length === 0) return;
  await redis.del(...keys.flatMap((key) => [RedisKeys.apiKey(key.keyHash), RedisKeys.apiKeyPrevious(key.id)]));
}

export async function revokeMemberAccess(
  workspaceId: string,
  userId: string,
  audit?: RevocationAudit,
  guard?: (tx: Transaction) => Promise<void>,
): Promise<AccessRevocation> {
  const { removed, keys } = await db.transaction(async (tx) => {
    if (guard) await guard(tx);
    const removed = await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .returning({ id: workspaceMembers.id });

    const keys = await tx
      .update(apiKeys)
      .set({ isActive: "false" })
      .where(
        and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.createdBy, userId), eq(apiKeys.isActive, "true")),
      )
      .returning({
        id: apiKeys.id,
        keyHash: apiKeys.keyHash,
        environmentId: apiKeys.environmentId,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
      });

    if (audit) {
      const actor = audit.actor ?? { type: "system", id: null };
      const membership = audit.membershipRecord({ membershipRemoved: removed.length > 0, apiKeysRevoked: keys.length });
      await writeAuditEvents(tx, [
        ...(membership ? [membership] : []),
        ...keys.map((key): AuditRecordInput => ({
          workspaceId,
          environmentId: key.environmentId,
          type: "api_key.revoked",
          actor,
          context: audit.context,
          resource: { type: "api_key", id: key.id },
          data: { keyId: key.id, name: key.name, keyPrefix: key.keyPrefix, createdBy: userId, reason: audit.reason },
        })),
      ]);
    }

    await dropCachedKeys(keys);

    return { removed, keys };
  });

  try {
    await dropCachedKeys(keys);
  } catch (error) {
    logger.error({ workspaceId, userId, error }, "Revoked API keys could not be dropped from the cache after commit");
  }

  const bindings = await db
    .select({ clientId: oauthWorkspaceBinding.clientId })
    .from(oauthWorkspaceBinding)
    .where(and(eq(oauthWorkspaceBinding.userId, userId), eq(oauthWorkspaceBinding.workspaceId, workspaceId)));

  let oauthGrantsRevoked = 0;
  for (const { clientId } of bindings) {
    try {
      const { revokeGrant } = await import("../auth/oauth-grants.ts");
      await revokeGrant(userId, clientId);
      oauthGrantsRevoked += 1;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        logger.error({ workspaceId, userId, clientId, error }, "An app's grant could not be revoked after the member's access ended");
      }
    }
  }

  return {
    membershipRemoved: removed.length > 0,
    apiKeysRevoked: keys.length,
    oauthGrantsRevoked,
  };
}

export async function streamStillAuthorized(input: {
  authType: string | undefined;
  workspaceId: string;
  userId?: string;
  sessionId?: string;
  apiKeyId?: string;
}): Promise<boolean> {
  if (input.authType === "session" || input.authType === "oauth") {
    if (!input.userId) return false;
    const [member] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)))
      .limit(1);
    if (!member) return false;
    if (input.authType === "session") {
      try {
        await assertSsoSessionForWorkspace(input.workspaceId, input.userId, input.sessionId);
      } catch {
        return false;
      }
    }
    return true;
  }
  if (input.apiKeyId) {
    const [key] = await db
      .select({ isActive: apiKeys.isActive, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, input.apiKeyId))
      .limit(1);
    return key?.isActive === "true" && (!key.expiresAt || key.expiresAt > new Date());
  }
  return true;
}
