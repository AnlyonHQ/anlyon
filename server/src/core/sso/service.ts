import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { ssoProvider, workspaceSsoConnections, type WorkspaceSsoConnectionRow } from "../../db/schema/sso.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { ApiError, ConflictError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { logMembershipEvent } from "../workspace/membership-audit.ts";
import { membershipRecord } from "../workspace/membership-records.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import type { WorkspaceRole } from "../workspace/provisioned-roles.ts";
import { normalizeDomains, unverifiedDomains, verificationRecord, type ResolveTxt } from "./domains.ts";
import { discoverOidcEndpoints } from "./oidc-discovery.ts";

const logger = createLogger({ module: "sso" });

const AUTH_BASE = `${env.BETTER_AUTH_URL}/api/auth`;

export type SsoProtocol = "oidc" | "saml";

export interface CreateSsoConnectionInput {
  protocol: SsoProtocol;
  domains: string[];
  defaultRole: WorkspaceRole;
  oidc?: { issuer: string; clientId: string; clientSecret: string };
  saml?: {
    entityId: string;
    ssoUrl: string;
    certificate: string;
    emailAttribute?: string;
    nameAttribute?: string;
  };
}

export interface SsoConnectionView {
  workspaceId: string;
  providerId: string;
  protocol: SsoProtocol;
  issuer: string;
  domains: string[];
  domainsVerified: boolean;
  domainsVerifiedAt: string | null;
  verificationRecords: Array<{ domain: string; name: string; type: "TXT"; value: string }>;
  enforced: boolean;
  defaultRole: string;
  serviceProvider: {
    oidcRedirectUri?: string;
    samlAcsUrl?: string;
    samlEntityId?: string;
    samlMetadataUrl?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export function serviceProviderUrls(providerId: string, protocol: SsoProtocol): SsoConnectionView["serviceProvider"] {
  if (protocol === "oidc") return { oidcRedirectUri: `${AUTH_BASE}/sso/callback/${providerId}` };
  const metadataUrl = `${AUTH_BASE}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
  return {
    samlAcsUrl: `${AUTH_BASE}/sso/saml2/sp/acs/${providerId}`,
    samlEntityId: metadataUrl,
    samlMetadataUrl: metadataUrl,
  };
}

function toView(row: WorkspaceSsoConnectionRow, issuer: string): SsoConnectionView {
  const protocol = row.protocol as SsoProtocol;
  return {
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    protocol,
    issuer,
    domains: row.domains,
    domainsVerified: row.domainsVerifiedAt !== null,
    domainsVerifiedAt: row.domainsVerifiedAt?.toISOString() ?? null,
    verificationRecords: row.domains.map((domain) => ({ domain, ...verificationRecord(domain, row.domainVerificationToken) })),
    enforced: row.enforced,
    defaultRole: row.defaultRole,
    serviceProvider: serviceProviderUrls(row.providerId, protocol),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadConnection(workspaceId: string) {
  const [row] = await db
    .select({ connection: workspaceSsoConnections, issuer: ssoProvider.issuer })
    .from(workspaceSsoConnections)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSsoConnections.providerId))
    .where(eq(workspaceSsoConnections.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}

export async function getSsoConnection(workspaceId: string): Promise<SsoConnectionView | null> {
  const row = await loadConnection(workspaceId);
  return row ? toView(row.connection, row.issuer) : null;
}

async function assertDomainsFree(domains: string[], workspaceId: string, executor: Tx | typeof db = db): Promise<void> {
  const others = await executor
    .select({ domains: workspaceSsoConnections.domains })
    .from(workspaceSsoConnections)
    .where(and(ne(workspaceSsoConnections.workspaceId, workspaceId), isNotNull(workspaceSsoConnections.domainsVerifiedAt)));
  const taken = new Set(others.flatMap((row) => row.domains));
  const clash = domains.filter((domain) => taken.has(domain));
  if (clash.length > 0) {
    throw new ConflictError(`Another workspace already uses single sign-on for ${clash.join(", ")}`);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockDomains(tx: Tx, domains: string[]): Promise<void> {
  for (const domain of [...domains].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sso-domain:${domain}`}))`);
  }
}

async function displaceUnverifiedClaims(tx: Tx, domains: string[], workspaceId: string, actorUserId: string, context?: StoredAuditContext): Promise<void> {
  await lockDomains(tx, domains);
  const others = await tx
    .select({ workspaceId: workspaceSsoConnections.workspaceId, providerId: workspaceSsoConnections.providerId, domains: workspaceSsoConnections.domains, verifiedAt: workspaceSsoConnections.domainsVerifiedAt })
    .from(workspaceSsoConnections)
    .where(ne(workspaceSsoConnections.workspaceId, workspaceId));
  for (const other of others) {
    const shared = other.domains.filter((domain) => domains.includes(domain));
    if (shared.length === 0) continue;
    if (other.verifiedAt) {
      throw new ConflictError(`Another workspace already uses single sign-on for ${shared.join(", ")}`);
    }
    await tx.delete(ssoProvider).where(eq(ssoProvider.providerId, other.providerId));
    await writeAuditEvents(tx, [
      membershipRecord(
        "sso.connection_deleted",
        { workspaceId: other.workspaceId, actorUserId, source: "dashboard" as const, providerId: other.providerId, reason: "domain_verified_elsewhere", domains: shared },
        { context },
      ),
    ]);
    logger.warn(
      { workspaceId: other.workspaceId, providerId: other.providerId, verifiedBy: workspaceId, domains: shared },
      "Removed an unverified SSO connection: another workspace verified one of its domains",
    );
  }
}

export async function createSsoConnection(
  workspaceId: string,
  actorUserId: string,
  headers: Headers,
  input: CreateSsoConnectionInput,
  context?: StoredAuditContext,
): Promise<SsoConnectionView> {
  if (await loadConnection(workspaceId)) {
    throw new ConflictError("This workspace already has an identity provider. Remove it before adding another.");
  }
  const domains = normalizeDomains(input.domains);
  await assertDomainsFree(domains, workspaceId);

  const providerId = `anlyon-${randomBytes(8).toString("hex")}`;
  const domainVerificationToken = randomBytes(24).toString("base64url");
  const { auth } = await import("../../utils/auth.ts");

  let issuer: string;
  if (input.protocol === "oidc") {
    if (!input.oidc) throw new ValidationError("oidc settings are required for an OIDC provider");
    const discovered = await discoverOidcEndpoints(input.oidc.issuer);
    issuer = discovered.issuer;
    await auth.api.registerSSOProvider({
      headers,
      body: {
        providerId,
        issuer,
        domain: domains.join(","),
        oidcConfig: {
          clientId: input.oidc.clientId,
          clientSecret: input.oidc.clientSecret,
          skipDiscovery: true,
          discoveryEndpoint: discovered.discoveryEndpoint,
          authorizationEndpoint: discovered.authorizationEndpoint,
          tokenEndpoint: discovered.tokenEndpoint,
          jwksEndpoint: discovered.jwksEndpoint,
          userInfoEndpoint: discovered.userInfoEndpoint,
          tokenEndpointAuthentication: discovered.tokenEndpointAuthentication,
          pkce: true,
          scopes: ["openid", "email", "profile"],
        },
      },
    });
  } else {
    if (!input.saml) throw new ValidationError("saml settings are required for a SAML provider");
    issuer = input.saml.entityId;
    const sp = serviceProviderUrls(providerId, "saml");
    await auth.api.registerSSOProvider({
      headers,
      body: {
        providerId,
        issuer,
        domain: domains.join(","),
        samlConfig: {
          entryPoint: input.saml.ssoUrl,
          cert: input.saml.certificate,
          callbackUrl: sp.samlAcsUrl as string,
          audience: sp.samlEntityId,
          spMetadata: { entityID: sp.samlEntityId },
          idpMetadata: { entityID: input.saml.entityId },
          wantAssertionsSigned: true,
          mapping: {
            email: input.saml.emailAttribute || "email",
            name: input.saml.nameAttribute || "displayName",
          },
        },
      },
    });
  }

  const fields = { workspaceId, actorUserId, source: "dashboard" as const, providerId, protocol: input.protocol, domains };
  try {
    await db.transaction(async (tx) => {
      await lockDomains(tx, domains);
      await assertDomainsFree(domains, workspaceId, tx);
      await tx.update(ssoProvider).set({ organizationId: workspaceId }).where(eq(ssoProvider.providerId, providerId));
      await tx.insert(workspaceSsoConnections).values({
        workspaceId,
        providerId,
        protocol: input.protocol,
        domains,
        domainVerificationToken,
        defaultRole: input.defaultRole,
        createdBy: actorUserId,
      });
      await writeAuditEvents(tx, [membershipRecord("sso.connection_created", fields, { context })]);
    });
  } catch (error) {
    await db.delete(ssoProvider).where(eq(ssoProvider.providerId, providerId));
    throw error;
  }

  logMembershipEvent("sso.connection_created", fields);

  const created = await getSsoConnection(workspaceId);
  if (!created) throw new ApiError(500, "SSO_CONNECTION_MISSING", "The identity provider was saved but could not be read back");
  return created;
}

export async function verifySsoDomains(
  workspaceId: string,
  actorUserId: string,
  resolveTxt?: ResolveTxt,
  context?: StoredAuditContext,
): Promise<SsoConnectionView> {
  const row = await loadConnection(workspaceId);
  if (!row) throw new NotFoundError("Identity provider");
  const { connection } = row;

  const missing = await unverifiedDomains(connection.domains, connection.domainVerificationToken, resolveTxt);
  if (missing.length > 0) {
    throw new ApiError(
      422,
      "DOMAIN_NOT_VERIFIED",
      `The TXT record was not found for ${missing.join(", ")}. DNS changes can take a while to appear; try again later.`,
      { domains: missing },
    );
  }

  await assertDomainsFree(connection.domains, workspaceId);

  const now = new Date();
  const fields = {
    workspaceId,
    actorUserId,
    source: "dashboard" as const,
    providerId: connection.providerId,
    domains: connection.domains,
  };
  await db.transaction(async (tx) => {
    await displaceUnverifiedClaims(tx, connection.domains, workspaceId, actorUserId, context);
    await tx
      .update(workspaceSsoConnections)
      .set({ domainsVerifiedAt: now, updatedAt: now })
      .where(eq(workspaceSsoConnections.workspaceId, workspaceId));
    await tx.update(ssoProvider).set({ domainVerified: true }).where(eq(ssoProvider.providerId, connection.providerId));
    await writeAuditEvents(tx, [membershipRecord("sso.domains_verified", fields, { context })]);
  });

  logMembershipEvent("sso.domains_verified", fields);
  return toView({ ...connection, domainsVerifiedAt: now, updatedAt: now }, row.issuer);
}

export async function updateSsoConnection(
  workspaceId: string,
  actorUserId: string,
  patch: { enforced?: boolean; defaultRole?: WorkspaceRole },
  context?: StoredAuditContext,
): Promise<SsoConnectionView> {
  const row = await loadConnection(workspaceId);
  if (!row) throw new NotFoundError("Identity provider");
  const { connection } = row;

  if (patch.enforced && !connection.domainsVerifiedAt) {
    throw new ApiError(422, "DOMAIN_NOT_VERIFIED", "Verify the domains before requiring single sign-on");
  }

  const now = new Date();
  const { updated, fields } = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(workspaceSsoConnections)
      .set({
        ...(patch.enforced !== undefined ? { enforced: patch.enforced } : {}),
        ...(patch.defaultRole !== undefined ? { defaultRole: patch.defaultRole } : {}),
        updatedAt: now,
      })
      .where(eq(workspaceSsoConnections.workspaceId, workspaceId))
      .returning();
    const changeFields = {
      workspaceId,
      actorUserId,
      source: "dashboard" as const,
      providerId: connection.providerId,
      enforced: changed.enforced,
      defaultRole: changed.defaultRole,
      previousEnforced: connection.enforced,
      previousDefaultRole: connection.defaultRole,
    };
    await writeAuditEvents(tx, [membershipRecord("sso.settings_updated", changeFields, { context })]);
    return { updated: changed, fields: changeFields };
  });

  logMembershipEvent("sso.settings_updated", fields);
  return toView(updated, row.issuer);
}

export async function deleteSsoConnection(workspaceId: string, actorUserId: string, context?: StoredAuditContext): Promise<void> {
  const row = await loadConnection(workspaceId);
  if (!row) throw new NotFoundError("Identity provider");
  const fields = { workspaceId, actorUserId, source: "dashboard" as const, providerId: row.connection.providerId };
  await db.transaction(async (tx) => {
    await tx.delete(ssoProvider).where(eq(ssoProvider.providerId, row.connection.providerId));
    await writeAuditEvents(tx, [membershipRecord("sso.connection_deleted", fields, { context })]);
  });
  logMembershipEvent("sso.connection_deleted", fields);
}
