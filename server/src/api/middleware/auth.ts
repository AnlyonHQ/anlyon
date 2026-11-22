import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { verifyApiKeyAndGetWorkspace } from "../../core/auth/api-keys.ts";
import type { ApiKeyScope } from "../../core/auth/api-key-scopes.ts";
import { looksLikeJwt, verifyOAuthAccessToken } from "../../core/auth/oauth-tokens.ts";
import { auth } from "../../utils/auth.ts";
import { ApiError, AuthenticationError, AuthorizationError, ServiceUnavailableError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { env } from "../../config/env.ts";
import { getAllowedOrigins } from "../../utils/origins.ts";
import { redactSensitivePath } from "../../utils/sensitive-paths.ts";
import {
  guardPermissionFor,
  hasPermission,
  isMutatingMethod,
  permissionDeniedMessage,
  permissionScope,
  type Permission,
} from "../../core/workspace/permissions.ts";
import type { ResolvedRole } from "../../core/workspace/roles.ts";
import { assertSsoSessionForWorkspace } from "../../core/sso/sessions.ts";
import { markCredentialRejected } from "../credential-rejection.ts";
import { readEndUserHeader } from "../end-user-context.ts";
import { SESSION_TOKEN_PREFIX } from "../../core/end-users/session-token.ts";

const logger = createLogger({ module: "auth" });

function rejectCredential(c: Context, message: string): AuthenticationError {
  markCredentialRejected(c);
  return new AuthenticationError(message);
}

function authUnavailable(c: Context, error: unknown, credential: string): ServiceUnavailableError {
  logger.warn(
    { path: redactSensitivePath(c.req.path), error: error instanceof Error ? error.message : "Unknown" },
    `${credential} could not be checked`,
  );
  return new ServiceUnavailableError("Authentication is temporarily unavailable. Retry shortly.");
}

function isRefusedSession(error: unknown): boolean {
  return !(error instanceof ApiError) && (error as { statusCode?: unknown } | null)?.statusCode === 401;
}

export async function requireApiKey(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  const selfAuthRoutes = [
    '/api/v2/integrations/slack/oauth/start',
    '/api/v2/integrations/slack/callback',
  ];

  if (selfAuthRoutes.some(route => c.req.path === route)) {
    await next();
    return;
  }

  if (c.req.path.startsWith('/api/v2/')) {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });

      if (session) {
        const workspaceId = validateUUID(
          c.req.header("X-Workspace-Id") || c.req.query("workspaceId"),
          "Workspace ID",
        );

        const { hasWorkspaceAccess } = await import("../../core/workspace/service.ts");
        const hasAccess = await hasWorkspaceAccess(workspaceId, session.user.id);

        if (!hasAccess) {
          throw new AuthorizationError("You don't have access to this workspace");
        }
        await assertSsoSessionForWorkspace(workspaceId, session.user.id, session.session?.id);

        if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
          await validateOriginForSession(c);
        }

        c.set("userId", session.user.id);
        c.set("userEmail", session.user.email);
        c.set("sessionId", session.session?.id);
        c.set("workspaceId", workspaceId);
        const requestedEnvironment = c.req.header("X-Environment-Id") || c.req.query("environmentId");
        const { getEnvironment, getDefaultEnvironment } = await import("../../core/environments/service.ts");
        const environment = requestedEnvironment
          ? await getEnvironment(workspaceId, validateUUID(requestedEnvironment, "Environment ID"))
          : await getDefaultEnvironment(workspaceId);
        c.set("environmentId", environment.id);
        c.set("authType", "session");
        readEndUserHeader(c);
        await enforceRoleOnWrites(c);
        await next();
        return;
      }
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
        throw error;
      }
      if (!authHeader?.startsWith("Bearer ") && !isRefusedSession(error)) {
        if (error instanceof ApiError) throw error;
        throw authUnavailable(c, error, "Session");
      }
      logger.debug({ path: redactSensitivePath(c.req.path), error: error instanceof Error ? error.message : "Unknown" }, "Session auth failed, falling back to API key");
    }
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw rejectCredential(c, "Authentication required");
  }

  const apiKey = authHeader.substring(7);

  if (apiKey.startsWith(SESSION_TOKEN_PREFIX)) {
    throw new ApiError(403, "END_USER_SESSION_NOT_ALLOWED", "An end-user session token works only on /api/v2/end-user-session. Call this route from your server with an API key.");
  }

  if (looksLikeJwt(apiKey)) {
    let identity: Awaited<ReturnType<typeof verifyOAuthAccessToken>>;
    try {
      identity = await verifyOAuthAccessToken(apiKey);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        markCredentialRejected(c);
        throw error;
      }
      if (error instanceof ApiError) throw error;
      throw authUnavailable(c, error, "Access token");
    }
    c.set("userId", identity.userId);
    c.set("workspaceId", identity.workspaceId);
    c.set("environmentId", identity.environmentId);
    c.set("oauthClientId", identity.clientId);
    c.set("oauthGrantedGroups", identity.grantedGroups);
    c.set("authType", "oauth");
    c.set("apiKeyScopes", identity.scopes);
    c.set("credentialExpiresAt", identity.expiresAt);
    readEndUserHeader(c);
    await enforceRoleOnWrites(c);
    await next();
    return;
  }

  let verified: Awaited<ReturnType<typeof verifyApiKeyAndGetWorkspace>>;
  try {
    verified = await verifyApiKeyAndGetWorkspace(apiKey);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw rejectCredential(c, "Authentication failed");
    }
    throw authUnavailable(c, error, "API key");
  }
  const { workspaceId, keyId, environmentId, scopes, expiresAt, endUserRequired } = verified;
  c.set("workspaceId", workspaceId);
  c.set("credentialExpiresAt", expiresAt);
  c.set("environmentId", environmentId);
  c.set("apiKeyId", keyId);
  c.set("authType", "apiKey");
  c.set("apiKeyScopes", scopes);
  const endUserId = readEndUserHeader(c);
  if (endUserId) c.set("endUserId", endUserId);
  c.set("endUserRequired", endUserRequired);
  await next();
}

export async function requireSessionOnly(c: Context, next: Next) {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      throw rejectCredential(c, "Session required for this action");
    }

    const workspaceIdRaw = c.req.param("workspaceId") ||
                           c.req.header("X-Workspace-Id") ||
                           c.req.query("workspaceId");

    const workspaceId = validateUUID(workspaceIdRaw, "Workspace ID");

    const { hasWorkspaceAccess } = await import("../../core/workspace/service.ts");
    const hasAccess = await hasWorkspaceAccess(workspaceId, session.user.id);

    if (!hasAccess) {
      throw new AuthorizationError("You don't have access to this workspace");
    }
    await assertSsoSessionForWorkspace(workspaceId, session.user.id, session.session?.id);

    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      await validateOriginForSession(c);
    }

    c.set("userId", session.user.id);
    c.set("userEmail", session.user.email);
    c.set("workspaceId", workspaceId);
    c.set("authType", "session");
    await enforceRoleOnWrites(c);
    await next();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (isRefusedSession(error)) {
      throw rejectCredential(c, "Session required for this action");
    }
    throw authUnavailable(c, error, "Session");
  }
}

export async function requireSession(c: Context, next: Next) {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      throw rejectCredential(c, "No active session");
    }

    c.set("userId", session.user.id);
    c.set("userEmail", session.user.email);
    c.set("session", session);
    c.set("authType", "session");

    const method = c.req.method;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      await validateOriginForSession(c);
    }

    await next();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (isRefusedSession(error)) {
      throw rejectCredential(c, "Invalid or expired session");
    }
    throw authUnavailable(c, error, "Session");
  }
}

const SCOPED_AUTH_TYPES = new Set(["apiKey", "oauth", "endUserSession"]);

export function assertScope(c: Context, requiredScope: ApiKeyScope): void {
  const authType = c.get("authType") as string | undefined;
  if (!authType || !SCOPED_AUTH_TYPES.has(authType)) return;

  const scopes = (c.get("apiKeyScopes") || []) as string[];
  if (!scopes.includes(requiredScope)) {
    const error = new AuthorizationError(
      authType === "oauth"
        ? `This authorization is missing required scope: ${requiredScope}`
        : `API key is missing required scope: ${requiredScope}`,
    );
    error.details = { requiredScope };
    throw error;
  }
}

export function callerAuthority(c: Context): { scopes: string[] | null } {
  const authType = c.get("authType") as string | undefined;
  if (!authType || !SCOPED_AUTH_TYPES.has(authType)) return { scopes: null };
  return { scopes: (c.get("apiKeyScopes") || []) as string[] };
}

export function requireApiKeyScope(scope: ApiKeyScope) {
  return async function scopeMiddleware(c: Context, next: Next) {
    assertScope(c, scope);
    await next();
  };
}

export function requireApiKeyResourceScopes(readScope: ApiKeyScope, writeScope: ApiKeyScope = readScope) {
  return async function resourceScopeMiddleware(c: Context, next: Next) {
    assertScope(c, c.req.method === "GET" ? readScope : writeScope);
    await next();
  };
}

export async function validateOriginForSession(c: Context): Promise<void> {
  const origin = c.req.header("origin") || c.req.header("referer");

  if (!origin) {
    const method = c.req.method.toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      logger.warn({ path: redactSensitivePath(c.req.path), method }, "Rejected session request without origin header");
      throw new AuthorizationError("Missing origin");
    }
    logger.debug({ path: redactSensitivePath(c.req.path) }, "Session request without origin header");
    return;
  }

  const allowedOrigins = getAllowedOrigins();

  try {
    const requestOrigin = new URL(origin).origin;
    if (!allowedOrigins.includes(requestOrigin)) {
      logger.warn({ origin: requestOrigin, path: redactSensitivePath(c.req.path) }, "Invalid origin for session request");
      throw new AuthorizationError("Invalid origin");
    }
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    throw new AuthorizationError("Invalid origin");
  }
}

export async function requireWorkspaceAccess(c: Context, next: Next) {
  const workspaceIdRaw = c.req.param("workspaceId") || c.req.query("workspaceId");
  const workspaceId = validateUUID(workspaceIdRaw, "Workspace ID");
  const userId = c.get("userId");

  if (!userId) {
    throw new AuthenticationError("User ID not found in context");
  }

  const { hasWorkspaceAccess } = await import("../../core/workspace/service.ts");
  const hasAccess = await hasWorkspaceAccess(workspaceId, userId);

  if (!hasAccess) {
    throw new AuthorizationError("You don't have access to this workspace");
  }
  if (c.get("authType") === "session") {
    await assertSsoSessionForWorkspace(workspaceId, userId, c.get("session")?.session?.id);
  }

  c.set("workspaceId", workspaceId);
  await enforceRoleOnWrites(c);

  await next();
}

function personCaller(c: Context): { userId: string; workspaceId: string } | null {
  const authType = c.get("authType");
  const userId = c.get("userId") as string | undefined;
  if (authType === "apiKey" || !userId) return null;
  return { userId, workspaceId: c.get("workspaceId") as string };
}

export async function assertCallerPermission(
  c: Context,
  permission: Permission,
  environmentId: string | null | undefined = c.get("environmentId") as string | undefined,
): Promise<void> {
  const person = personCaller(c);
  if (!person) return;

  const scopedEnvironment = permissionScope(permission) === "environment" ? (environmentId ?? null) : null;
  const cache = (c.get("memberRoles") as Map<string, ResolvedRole | null> | undefined) ?? new Map<string, ResolvedRole | null>();
  const cacheKey = scopedEnvironment ?? "";
  let resolved = cache.get(cacheKey);
  if (resolved === undefined) {
    const { resolveMemberRole } = await import("../../core/workspace/roles.ts");
    resolved = await resolveMemberRole(person.workspaceId, person.userId, scopedEnvironment);
    cache.set(cacheKey, resolved);
    c.set("memberRoles", cache);
  }
  if (!resolved) {
    throw new AuthorizationError("You don't have access to this workspace");
  }

  const role = permissionScope(permission) === "environment" ? resolved.role : resolved.workspaceRole;
  if (!hasPermission(role, permission)) {
    throw new AuthorizationError(permissionDeniedMessage(role, permission));
  }
}

async function enforceRoleOnWrites(c: Context): Promise<void> {
  const permission = guardPermissionFor(c.req.method, c.req.path);
  if (!permission) return;
  await assertCallerPermission(c, permission);
}

export function requirePermission(
  permission: Permission,
  options: { environmentId?: (c: Context) => string | undefined } = {},
) {
  return async function permissionMiddleware(c: Context, next: Next) {
    const environmentId = options.environmentId
      ? options.environmentId(c)
      : (c.get("environmentId") as string | undefined);
    await assertCallerPermission(c, permission, environmentId);
    await next();
  };
}

export function requirePermissionForWrites(permission: Permission) {
  return async function writePermissionMiddleware(c: Context, next: Next) {
    if (isMutatingMethod(c.req.method)) {
      await assertCallerPermission(c, permission);
    }
    await next();
  };
}

export async function requireInternalAuth(c: Context, next: Next) {
  const secret = env.INTERNAL_AUTH_SECRET;

  if (!secret) {
    throw new AuthenticationError("Internal endpoint is not configured");
  }

  const provided = c.req.header("X-Internal-Auth");
  if (!provided) {
    throw new AuthenticationError("Internal authentication required");
  }

  const expectedBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  const valid =
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf);

  if (!valid) {
    throw new AuthenticationError("Invalid internal authentication token");
  }

  await next();
}
