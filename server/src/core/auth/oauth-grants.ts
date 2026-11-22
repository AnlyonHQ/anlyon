import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  oauthWorkspaceBinding,
} from "../../db/schema/oauth.ts";
import { environments, workspaces } from "../../db/schema/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { invalidateWorkspaceBinding } from "./oauth-tokens.ts";
import { OAUTH_SCOPE_GROUPS, type OAuthScopeGroup } from "./oauth-scopes.ts";

const logger = createLogger({ module: "oauth-grants" });

export interface OAuthGrant {
  clientId: string;
  name: string | null;
  uri: string | null;
  redirectHosts: string[];
  permissions: Array<{ scope: string; label: string; sensitive: boolean }>;
  workspace: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  authorizedAt: string;
  lastRenewedAt: string | null;
  active: boolean;
}

export function hostsOf(uris: string[] | null): string[] {
  return [
    ...new Set(
      (uris ?? []).flatMap((uri) => {
        try {
          return [new URL(uri).host];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

export async function listGrants(userId: string): Promise<OAuthGrant[]> {
  const rows = await db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      authorizedAt: oauthConsent.createdAt,
      name: oauthClient.name,
      uri: oauthClient.uri,
      redirectUris: oauthClient.redirectUris,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      environmentId: environments.id,
      environmentName: environments.name,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .leftJoin(
      oauthWorkspaceBinding,
      and(eq(oauthWorkspaceBinding.clientId, oauthConsent.clientId), eq(oauthWorkspaceBinding.userId, userId)),
    )
    .leftJoin(workspaces, eq(workspaces.id, oauthWorkspaceBinding.workspaceId))
    .leftJoin(environments, eq(environments.id, oauthWorkspaceBinding.environmentId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.createdAt));

  if (rows.length === 0) return [];

  const activity = await db
    .select({
      clientId: oauthRefreshToken.clientId,
      lastRenewedAt: sql<Date | null>`max(${oauthRefreshToken.createdAt})`,
      live: sql<number>`count(*) filter (where ${oauthRefreshToken.revoked} is null and (${oauthRefreshToken.expiresAt} is null or ${oauthRefreshToken.expiresAt} > now()))`,
    })
    .from(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        inArray(
          oauthRefreshToken.clientId,
          rows.map((row) => row.clientId),
        ),
      ),
    )
    .groupBy(oauthRefreshToken.clientId);

  const byClient = new Map(activity.map((row) => [row.clientId, row]));

  return rows.map((row) => {
    const seen = byClient.get(row.clientId);
    return {
      clientId: row.clientId,
      name: row.name,
      uri: row.uri,
      redirectHosts: hostsOf(row.redirectUris),
      permissions: (row.scopes ?? [])
        .filter((scope): scope is OAuthScopeGroup => scope in OAUTH_SCOPE_GROUPS)
        .map((scope) => ({
          scope,
          label: OAUTH_SCOPE_GROUPS[scope].label,
          sensitive: OAUTH_SCOPE_GROUPS[scope].sensitive,
        })),
      workspace: row.workspaceId && row.workspaceName ? { id: row.workspaceId, name: row.workspaceName } : null,
      environment:
        row.environmentId && row.environmentName ? { id: row.environmentId, name: row.environmentName } : null,
      authorizedAt: (row.authorizedAt ?? new Date()).toISOString(),
      lastRenewedAt: seen?.lastRenewedAt ? new Date(seen.lastRenewedAt).toISOString() : null,
      active: Number(seen?.live ?? 0) > 0,
    };
  });
}

export async function revokeGrant(userId: string, clientId: string): Promise<void> {
  const [consent] = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);

  if (!consent) throw new NotFoundError("This app is not connected to your account");

  await db.transaction(async (tx) => {
    await tx.delete(oauthConsent).where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));

    await tx
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(
        and(
          eq(oauthRefreshToken.userId, userId),
          eq(oauthRefreshToken.clientId, clientId),
          isNull(oauthRefreshToken.revoked),
        ),
      );

    await tx
      .delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));

    await tx
      .delete(oauthWorkspaceBinding)
      .where(and(eq(oauthWorkspaceBinding.userId, userId), eq(oauthWorkspaceBinding.clientId, clientId)));
  });

  await invalidateWorkspaceBinding(userId, clientId);

  logger.info({ userId, clientId }, "OAuth grant revoked");
}
