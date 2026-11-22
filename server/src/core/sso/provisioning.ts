import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceSsoConnections } from "../../db/schema/sso.ts";
import { workspaceScimConfigs } from "../../db/schema/scim.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { user as users } from "../../db/schema/user.ts";
import { createLogger } from "../../lib/logger.ts";
import { isFeatureEnabled } from "../edition/features.ts";
import { logMembershipEvent } from "../workspace/membership-audit.ts";
import { membershipRecord } from "../workspace/membership-records.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { emailDomain } from "./domains.ts";
import { type AuthHookContext, isSsoCallback, ssoProviderIdFromContext } from "./sessions.ts";

const logger = createLogger({ module: "sso" });

export const SSO_DOMAIN_REFUSED_MESSAGE =
  "This identity provider can sign in only addresses on its workspace's verified domains.";

export async function ssoSignupRefusal(email: string, ctx: AuthHookContext | null | undefined): Promise<string | null> {
  if (!isSsoCallback(ctx?.path)) return null;
  const providerId = ssoProviderIdFromContext(ctx);
  if (!providerId) return SSO_DOMAIN_REFUSED_MESSAGE;
  const [connection] = await db
    .select({ domains: workspaceSsoConnections.domains, verifiedAt: workspaceSsoConnections.domainsVerifiedAt })
    .from(workspaceSsoConnections)
    .where(eq(workspaceSsoConnections.providerId, providerId))
    .limit(1);
  const domain = emailDomain(email);
  if (connection?.verifiedAt && domain && connection.domains.includes(domain)) return null;
  logger.warn({ providerId }, "SSO sign-in refused: the email is outside the connection's verified domains");
  return SSO_DOMAIN_REFUSED_MESSAGE;
}

export async function ssoLinkRefusal(
  account: { userId: string; providerId?: string | null },
  ctx: AuthHookContext | null | undefined,
): Promise<string | null> {
  if (!isSsoCallback(ctx?.path)) return null;
  const providerId = ssoProviderIdFromContext(ctx) ?? account.providerId ?? null;
  if (!providerId) return SSO_DOMAIN_REFUSED_MESSAGE;
  const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, account.userId)).limit(1);
  if (!person) return null;
  const [connection] = await db
    .select({ domains: workspaceSsoConnections.domains, verifiedAt: workspaceSsoConnections.domainsVerifiedAt })
    .from(workspaceSsoConnections)
    .where(eq(workspaceSsoConnections.providerId, providerId))
    .limit(1);
  const domain = emailDomain(person.email);
  if (connection?.verifiedAt && domain && connection.domains.includes(domain)) return null;
  logger.warn({ providerId, userId: account.userId }, "SSO link refused: the account's email is outside the connection's verified domains");
  return SSO_DOMAIN_REFUSED_MESSAGE;
}

export async function provisionSsoUser(input: {
  user: { id: string; email: string };
  provider: { providerId: string };
}): Promise<void> {
  if (!isFeatureEnabled("sso")) return;
  const [connection] = await db
    .select()
    .from(workspaceSsoConnections)
    .where(eq(workspaceSsoConnections.providerId, input.provider.providerId))
    .limit(1);
  if (!connection?.domainsVerifiedAt) return;

  const domain = emailDomain(input.user.email);
  if (!domain || !connection.domains.includes(domain)) {
    logger.warn(
      { workspaceId: connection.workspaceId, userId: input.user.id },
      "SSO sign-in with an email outside the connection's verified domains; no membership added",
    );
    return;
  }

  const [directory] = await db
    .select({ workspaceId: workspaceScimConfigs.workspaceId })
    .from(workspaceScimConfigs)
    .where(eq(workspaceScimConfigs.workspaceId, connection.workspaceId))
    .limit(1);
  if (directory) return;

  const fields = {
    workspaceId: connection.workspaceId,
    userId: input.user.id,
    role: connection.defaultRole,
    source: "sso" as const,
    providerId: input.provider.providerId,
  };
  const inserted = await db.transaction(async (tx) => {
    const added = await tx
      .insert(workspaceMembers)
      .values({ workspaceId: connection.workspaceId, userId: input.user.id, role: connection.defaultRole })
      .onConflictDoNothing()
      .returning({ id: workspaceMembers.id });
    if (added.length > 0) {
      await writeAuditEvents(tx, [membershipRecord("member.provisioned", fields, { actor: { type: "user", id: input.user.id } })]);
    }
    return added;
  });

  if (inserted.length > 0) logMembershipEvent("member.provisioned", fields);
}
