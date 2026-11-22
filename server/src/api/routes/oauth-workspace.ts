import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { auth } from "../../utils/auth.ts";
import { hostsOf, listGrants, revokeGrant } from "../../core/auth/oauth-grants.ts";
import { getFirstPartyClient } from "../../core/auth/first-party-clients.ts";
import { validateOriginForSession } from "../middleware/auth.ts";
import { db } from "../../db/index.ts";
import { oauthClient } from "../../db/schema/oauth.ts";
import { getUserWorkspaces } from "../../core/workspace/service.ts";
import { listEnvironments } from "../../core/environments/service.ts";
import {
  looksLikeJwt,
  setPendingBindingReference,
  setWorkspaceBinding,
  verifyOAuthAccessToken,
} from "../../core/auth/oauth-tokens.ts";
import {
  OAUTH_SCOPE_GROUPS,
  OIDC_SCOPES,
  WORKSPACE_SWITCH_SCOPE,
  type OAuthScopeGroup,
} from "../../core/auth/oauth-scopes.ts";
import { AuthenticationError, AuthorizationError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { validateUUID } from "../../utils/uuid-validator.ts";
import { pathParam } from "../params.ts";

const oauthWorkspaceRouter = new Hono();

async function requireCaller(
  c: Context,
): Promise<{ id: string; clientId?: string; sessionId?: string; grantedGroups: string[] }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return { id: session.user.id, sessionId: session.session.id, grantedGroups: [] };

  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && looksLikeJwt(bearer)) {
    const identity = await verifyOAuthAccessToken(bearer);
    return { id: identity.userId, clientId: identity.clientId, grantedGroups: identity.grantedGroups };
  }

  throw new AuthenticationError("Sign in to choose a workspace");
}

async function requireSessionUser(c: Context): Promise<{ id: string }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new AuthenticationError("Sign in to manage connected apps");
  return { id: session.user.id };
}

oauthWorkspaceRouter.get("/workspaces", async (c: Context) => {
  const caller = await requireCaller(c);
  if (caller.clientId && !caller.grantedGroups.includes(WORKSPACE_SWITCH_SCOPE)) {
    throw new AuthorizationError(`This authorization is missing required scope: ${WORKSPACE_SWITCH_SCOPE}`);
  }
  const memberships = await getUserWorkspaces(caller.id);

  const workspaces = await Promise.all(
    memberships.map(async ({ workspace, role }) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role,
      environments: (await listEnvironments(workspace.id)).map((environment) => ({
        id: environment.id,
        name: environment.name,
        slug: environment.slug,
        isDefault: environment.isDefault,
      })),
    })),
  );

  return c.json({ success: true, data: { workspaces } });
});

oauthWorkspaceRouter.post("/workspace-binding", async (c: Context) => {
  const caller = await requireCaller(c);

  if (!caller.clientId) {
    await validateOriginForSession(c);
  }

  const body = await c.req.json<{ clientId?: string; workspaceId?: string; environmentId?: string }>();

  let clientId: string;
  if (caller.clientId) {
    if (body.clientId && body.clientId !== caller.clientId) {
      throw new AuthorizationError("A client may only change its own workspace.");
    }
    if (!caller.grantedGroups.includes(WORKSPACE_SWITCH_SCOPE)) {
      throw new AuthorizationError(
        "This app was not granted permission to switch workspaces. Reconnect it and allow \"Switch between your workspaces\".",
      );
    }
    clientId = caller.clientId;
  } else {
    if (!body.clientId) throw new ValidationError("clientId is required");
    clientId = body.clientId;
  }

  const workspaceId = validateUUID(body.workspaceId, "Workspace ID");
  const environmentId = validateUUID(body.environmentId, "Environment ID");

  await setWorkspaceBinding(caller.id, clientId, workspaceId, environmentId, { sessionId: caller.sessionId });
  if (!caller.clientId) await setPendingBindingReference(caller.id, workspaceId);

  return c.json({ success: true, data: { workspaceId, environmentId } });
});

oauthWorkspaceRouter.get("/grants", async (c: Context) => {
  const user = await requireSessionUser(c);
  return c.json({ success: true, data: { grants: await listGrants(user.id) } });
});

oauthWorkspaceRouter.delete("/grants/:clientId", async (c: Context) => {
  const user = await requireSessionUser(c);
  await validateOriginForSession(c);
  await revokeGrant(user.id, pathParam(c, "clientId"));
  return c.json({ success: true, data: { revoked: true } });
});

oauthWorkspaceRouter.get("/client-info", async (c: Context) => {
  await requireCaller(c);
  const clientId = c.req.query("client_id");
  if (!clientId) throw new ValidationError("client_id is required");

  const [client] = await db
    .select({
      name: oauthClient.name,
      uri: oauthClient.uri,
      redirectUris: oauthClient.redirectUris,
      createdAt: oauthClient.createdAt,
      userId: oauthClient.userId,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);

  if (!client) throw new NotFoundError("Unknown client");

  const redirectHosts = hostsOf(client.redirectUris);

  const registeredAt = client.createdAt ?? new Date();
  return c.json({
    success: true,
    data: {
      name: client.name ?? null,
      uri: client.uri ?? null,
      redirectHosts,
      registeredAt: registeredAt.toISOString(),
      selfRegistered: client.userId === null,
      firstSeenMinutesAgo: Math.max(0, Math.floor((Date.now() - registeredAt.getTime()) / 60_000)),
    },
  });
});

oauthWorkspaceRouter.get("/first-party-client", async (c: Context) => {
  const clientId = c.req.query("client_id");
  if (!clientId) throw new ValidationError("client_id is required");
  const client = await getFirstPartyClient(clientId);
  if (!client) throw new NotFoundError("Unknown client");
  return c.json({ success: true, data: { displayName: client.displayName, startUrl: client.startUrl } });
});

oauthWorkspaceRouter.get("/scope-descriptions", (c: Context) => {
  const requested = (c.req.query("scope") ?? "").split(/\s+/).filter(Boolean);

  const groups = requested
    .filter((scope): scope is OAuthScopeGroup => scope in OAUTH_SCOPE_GROUPS)
    .map((scope) => ({
      scope,
      label: OAUTH_SCOPE_GROUPS[scope].label,
      description: OAUTH_SCOPE_GROUPS[scope].description,
      sensitive: OAUTH_SCOPE_GROUPS[scope].sensitive,
      grants: OAUTH_SCOPE_GROUPS[scope].scopes,
    }));

  const identity = requested.filter((scope) => (OIDC_SCOPES as readonly string[]).includes(scope));

  return c.json({ success: true, data: { groups, identity, unknown: requested.filter((s) => !(s in OAUTH_SCOPE_GROUPS) && !(OIDC_SCOPES as readonly string[]).includes(s)) } });
});

export default oauthWorkspaceRouter;
