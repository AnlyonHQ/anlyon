import { and, eq } from "drizzle-orm";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import { getOAuthState } from "better-auth/api";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { nanoid } from "nanoid";
import { db } from "../../db/index.ts";
import { oauthConsent, oauthWorkspaceBinding } from "../../db/schema/oauth.ts";
import { MCP_RESOURCE_URL, OAUTH_ISSUER } from "../../utils/auth.ts";
import { AuthenticationError, AuthorizationError, ServiceUnavailableError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { redis } from "../../lib/redis.ts";
import { getDefaultEnvironment, getEnvironment } from "../environments/service.ts";
import { getUserWorkspaces } from "../workspace/service.ts";
import { hasWorkspaceAccess } from "../workspace/service.ts";
import { assertSsoSessionForWorkspace } from "../sso/sessions.ts";
import { expandOAuthScopes, parseScopeClaim } from "./oauth-scopes.ts";
import type { ApiKeyScope } from "./api-key-scopes.ts";

const logger = createLogger({ module: "oauth-tokens" });

const jwks = createRemoteJWKSet(new URL(`${OAUTH_ISSUER}/jwks`));

export interface OAuthIdentity {
  userId: string;
  clientId: string;
  workspaceId: string;
  environmentId: string;
  scopes: ApiKeyScope[];
  grantedGroups: string[];
  expiresAt: Date | null;
}

export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export function clientIdOf(payload: JWTPayload): string | undefined {
  const claim = payload.azp ?? (payload as { client_id?: unknown }).client_id;
  return typeof claim === "string" ? claim : undefined;
}

const bindingKey = (userId: string, clientId: string) => `oauth:binding:${userId}:${clientId}`;
const BINDING_TTL_SECONDS = 300;

export async function invalidateWorkspaceBinding(userId: string, clientId: string): Promise<void> {
  await redis.del(bindingKey(userId, clientId));
}

export async function setWorkspaceBinding(
  userId: string,
  clientId: string,
  workspaceId: string,
  environmentId: string,
  options: { sessionId?: string } = {},
): Promise<void> {
  if (!(await hasWorkspaceAccess(workspaceId, userId))) {
    throw new AuthorizationError("You don't have access to this workspace");
  }
  await assertSsoSessionForWorkspace(workspaceId, userId, options.sessionId);
  await getEnvironment(workspaceId, environmentId);

  const now = new Date();
  await db
    .insert(oauthWorkspaceBinding)
    .values({ id: nanoid(), userId, clientId, workspaceId, environmentId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [oauthWorkspaceBinding.userId, oauthWorkspaceBinding.clientId],
      set: { workspaceId, environmentId, updatedAt: now },
    });
  await invalidateWorkspaceBinding(userId, clientId);
}

const pendingKey = (userId: string) => `oauth:pending-binding:${userId}`;
const PENDING_TTL_SECONDS = 600;

export async function setPendingBindingReference(userId: string, workspaceId: string): Promise<void> {
  await redis.setex(pendingKey(userId), PENDING_TTL_SECONDS, workspaceId);
}

export async function getPendingBindingReference(userId: string): Promise<string | undefined> {
  return (await redis.get(pendingKey(userId))) ?? undefined;
}

export async function assertSsoForOAuthGrant(userId: string, sessionId: string | undefined): Promise<void> {
  const workspaceIds = new Set<string>();
  const pending = await getPendingBindingReference(userId);
  if (pending) workspaceIds.add(pending);
  const clientId = await currentOAuthClientId();
  if (clientId) {
    const [bound] = await db
      .select({ workspaceId: oauthWorkspaceBinding.workspaceId })
      .from(oauthWorkspaceBinding)
      .where(and(eq(oauthWorkspaceBinding.userId, userId), eq(oauthWorkspaceBinding.clientId, clientId)))
      .limit(1);
    if (bound) workspaceIds.add(bound.workspaceId);
  }
  if (workspaceIds.size === 0) {
    const memberships = await getUserWorkspaces(userId);
    if (memberships.length === 1) workspaceIds.add(memberships[0].workspace.id);
  }
  for (const workspaceId of workspaceIds) {
    await assertSsoSessionForWorkspace(workspaceId, userId, sessionId);
  }
}

export async function hasActiveConsent(userId: string, clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);
  return Boolean(row);
}

export async function hasWorkspaceBinding(userId: string, clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: oauthWorkspaceBinding.id })
    .from(oauthWorkspaceBinding)
    .where(and(eq(oauthWorkspaceBinding.userId, userId), eq(oauthWorkspaceBinding.clientId, clientId)))
    .limit(1);
  return Boolean(row);
}

export async function currentOAuthClientId(): Promise<string | undefined> {
  const fromQuery = (query: unknown) =>
    typeof query === "string" && query ? new URLSearchParams(query).get("client_id") ?? undefined : undefined;
  try {
    const state = await getOAuthProviderState();
    const clientId = fromQuery(state?.query);
    if (clientId) return clientId;
  } catch {
  }
  try {
    return fromQuery((await getOAuthState())?.query);
  } catch {
    return undefined;
  }
}

export async function resolveBinding(userId: string, clientId: string): Promise<{ workspaceId: string; environmentId: string }> {
  const cached = await redis.get(bindingKey(userId, clientId));
  if (cached) {
    const [workspaceId, environmentId] = cached.split(":");
    if (workspaceId && environmentId) return { workspaceId, environmentId };
  }

  if (!(await hasActiveConsent(userId, clientId))) {
    logger.warn({ userId, clientId }, "Token presented for an app with no active consent; refusing");
    throw new AuthenticationError("This app is no longer connected to your Anlyon account.");
  }

  const [bound] = await db
    .select()
    .from(oauthWorkspaceBinding)
    .where(and(eq(oauthWorkspaceBinding.userId, userId), eq(oauthWorkspaceBinding.clientId, clientId)))
    .limit(1);

  let resolved: { workspaceId: string; environmentId: string };
  if (bound) {
    if (!(await hasWorkspaceAccess(bound.workspaceId, userId))) {
      logger.warn(
        { userId, clientId, workspaceId: bound.workspaceId },
        "OAuth binding points at a workspace the user is no longer a member of; refusing and clearing it",
      );
      await db
        .delete(oauthWorkspaceBinding)
        .where(and(eq(oauthWorkspaceBinding.userId, userId), eq(oauthWorkspaceBinding.clientId, clientId)));
      await invalidateWorkspaceBinding(userId, clientId);
      throw new AuthorizationError("You no longer have access to the workspace this app was connected to.");
    }
    resolved = { workspaceId: bound.workspaceId, environmentId: bound.environmentId };
  } else {
    const memberships = await getUserWorkspaces(userId);
    if (memberships.length === 0) {
      throw new AuthorizationError("This account is not a member of any workspace.");
    }
    if (memberships.length > 1) {
      throw new AuthorizationError(
        "This account belongs to multiple workspaces and none is selected. Re-authorize and choose one.",
      );
    }
    const workspaceId = memberships[0].workspace.id;
    const environment = await getDefaultEnvironment(workspaceId);
    resolved = { workspaceId, environmentId: environment.id };
  }

  await redis.setex(bindingKey(userId, clientId), BINDING_TTL_SECONDS, `${resolved.workspaceId}:${resolved.environmentId}`);
  return resolved;
}

function isKeySetUnavailable(error: unknown): boolean {
  if (!(error instanceof joseErrors.JOSEError)) return true;
  return error.code === joseErrors.JOSEError.code || error.code === joseErrors.JWKSTimeout.code || error.code === joseErrors.JWKSInvalid.code;
}

export async function verifyOAuthAccessToken(token: string): Promise<OAuthIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: OAUTH_ISSUER,
      audience: MCP_RESOURCE_URL,
    }));
  } catch (error) {
    if (isKeySetUnavailable(error)) {
      logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "OAuth signing keys could not be fetched");
      throw new ServiceUnavailableError("Authentication is temporarily unavailable. Retry shortly.");
    }
    logger.debug({ error: error instanceof Error ? error.message : "unknown" }, "OAuth token verification failed");
    throw new AuthenticationError("Invalid or expired access token");
  }

  const userId = payload.sub;
  const clientId = clientIdOf(payload);
  if (!userId || !clientId) {
    throw new AuthenticationError("Access token is missing subject or client");
  }
  if (userId === clientId) {
    throw new AuthenticationError("Access token is not bound to a user");
  }

  const { workspaceId, environmentId } = await resolveBinding(userId, clientId);
  const grantedGroups = parseScopeClaim(payload.scope);

  return {
    userId,
    clientId,
    workspaceId,
    environmentId,
    scopes: expandOAuthScopes(grantedGroups),
    grantedGroups,
    expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null,
  };
}
