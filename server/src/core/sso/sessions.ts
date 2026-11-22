import { and, eq, gt } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db } from "../../db/index.ts";
import { session } from "../../db/schema/session.ts";
import { ssoSessions, workspaceSsoConnections } from "../../db/schema/sso.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { AuthorizationError } from "../../utils/errors.ts";
import { isFeatureEnabled } from "../edition/features.ts";

const SSO_CALLBACK_PREFIXES = ["/sso/callback/", "/sso/saml2/callback/", "/sso/saml2/sp/acs/"];

const PASSWORD_OR_SOCIAL_PATHS = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/sign-in/social",
  "/one-tap/callback",
  "/verify-email",
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
]);
const PASSWORD_OR_SOCIAL_PREFIXES = ["/callback/", "/oauth2/callback/"];

export const SSO_REQUIRED_MESSAGE =
  "This workspace requires single sign-on. Sign in with SSO using your work email.";

export interface AuthHookContext {
  path?: string;
  params?: Record<string, string | undefined>;
  context?: { session?: { session?: { id?: string } } | null };
}

const SHARED_SSO_CALLBACK = "/sso/callback";

export function isSsoCallback(path: string | undefined): boolean {
  if (!path) return false;
  return path === SHARED_SSO_CALLBACK || SSO_CALLBACK_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function ssoProviderIdFromContext(ctx: AuthHookContext | null | undefined): string | null {
  const path = ctx?.path ?? "";
  if (!SSO_CALLBACK_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  return ctx?.params?.providerId ?? path.split("/").pop() ?? null;
}

export function isPasswordOrSocialSignIn(path: string | undefined): boolean {
  if (!path) return false;
  return PASSWORD_OR_SOCIAL_PATHS.has(path) || PASSWORD_OR_SOCIAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function findEnforcingWorkspace(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaceSsoConnections, eq(workspaceSsoConnections.workspaceId, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceSsoConnections.enforced, true),
        eq(workspaceMembers.emergencyAccess, false),
      ),
    )
    .limit(1);
  return row?.workspaceId ?? null;
}

export async function beforeSessionCreate(
  newSession: { userId: string },
  ctx: AuthHookContext | null | undefined,
): Promise<void> {
  if (!isFeatureEnabled("sso")) return;
  if (!isPasswordOrSocialSignIn(ctx?.path)) return;
  if (await findEnforcingWorkspace(newSession.userId)) {
    throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED" });
  }
}

export async function afterSessionCreate(
  created: { id: string } | null | undefined,
  ctx: AuthHookContext | null | undefined,
): Promise<void> {
  if (!created?.id) return;
  let providerId = ssoProviderIdFromContext(ctx);
  if (!providerId) {
    const previousId = ctx?.context?.session?.session?.id;
    if (!previousId || previousId === created.id) return;
    const [previous] = await db
      .select({ providerId: ssoSessions.providerId })
      .from(ssoSessions)
      .where(eq(ssoSessions.sessionId, previousId))
      .limit(1);
    providerId = previous?.providerId ?? null;
  }
  if (!providerId) return;
  await db.insert(ssoSessions).values({ sessionId: created.id, providerId }).onConflictDoNothing();
}

export class SsoRequiredError extends AuthorizationError {
  constructor() {
    super(SSO_REQUIRED_MESSAGE);
    this.code = "SSO_REQUIRED";
    this.name = "SsoRequiredError";
  }
}

export async function assertSsoSessionForWorkspace(
  workspaceId: string,
  userId: string,
  sessionId: string | undefined,
): Promise<void> {
  if (!isFeatureEnabled("sso")) return;
  const [connection] = await db
    .select({ providerId: workspaceSsoConnections.providerId, enforced: workspaceSsoConnections.enforced })
    .from(workspaceSsoConnections)
    .where(eq(workspaceSsoConnections.workspaceId, workspaceId))
    .limit(1);
  if (!connection?.enforced) return;

  const [member] = await db
    .select({ emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (member?.emergencyAccess) return;

  if (sessionId) {
    const [row] = await db
      .select({ providerId: ssoSessions.providerId })
      .from(ssoSessions)
      .where(eq(ssoSessions.sessionId, sessionId))
      .limit(1);
    if (row?.providerId === connection.providerId) return;
  }
  throw new SsoRequiredError();
}

export async function assertLiveSsoSessionForWorkspace(workspaceId: string, userId: string): Promise<void> {
  if (!isFeatureEnabled("sso")) return;
  const [connection] = await db
    .select({ providerId: workspaceSsoConnections.providerId, enforced: workspaceSsoConnections.enforced })
    .from(workspaceSsoConnections)
    .where(eq(workspaceSsoConnections.workspaceId, workspaceId))
    .limit(1);
  if (!connection?.enforced) return;

  const [member] = await db
    .select({ emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (member?.emergencyAccess) return;

  const [live] = await db
    .select({ sessionId: ssoSessions.sessionId })
    .from(ssoSessions)
    .innerJoin(session, eq(session.id, ssoSessions.sessionId))
    .where(and(
      eq(session.userId, userId),
      eq(ssoSessions.providerId, connection.providerId),
      gt(session.expiresAt, new Date()),
    ))
    .limit(1);
  if (!live) throw new SsoRequiredError();
}
