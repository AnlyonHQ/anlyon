import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaceScimConfigs, workspaceScimRoleMappings } from "../../db/schema/scim.ts";
import { env } from "../../config/env.ts";
import { hashApiKey } from "../../utils/crypto.ts";
import { NotFoundError, ValidationError } from "../../utils/errors.ts";
import { TtlCache } from "../../lib/ttl-cache.ts";
import { logMembershipEvent } from "../workspace/membership-audit.ts";
import { membershipRecord } from "../workspace/membership-records.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import type { StoredAuditContext } from "../audit/event-schema.ts";
import type { WorkspaceRole } from "../workspace/provisioned-roles.ts";

export const SCIM_BASE_URL = `${env.BETTER_AUTH_URL}/api/v2/scim`;

const TOKEN_PREFIX = "anlyon_scim_";

export function generateScimToken(): { token: string; hash: string; prefix: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashApiKey(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

export interface ScimSettingsView {
  connected: boolean;
  baseUrl: string;
  tokenPrefix: string | null;
  defaultRole: string;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  roleMappings: Array<{ groupName: string; role: string; priority: number }>;
}

export async function getScimSettings(workspaceId: string): Promise<ScimSettingsView> {
  const [config] = await db.select().from(workspaceScimConfigs).where(eq(workspaceScimConfigs.workspaceId, workspaceId));
  const mappings = await listRoleMappings(workspaceId);
  return {
    connected: Boolean(config),
    baseUrl: SCIM_BASE_URL,
    tokenPrefix: config?.tokenPrefix ?? null,
    defaultRole: config?.defaultRole ?? "member",
    createdAt: config?.createdAt.toISOString() ?? null,
    rotatedAt: config?.rotatedAt?.toISOString() ?? null,
    lastUsedAt: config?.lastUsedAt?.toISOString() ?? null,
    roleMappings: mappings.map(({ groupName, role, priority }) => ({ groupName, role, priority })),
  };
}

export async function listRoleMappings(workspaceId: string) {
  return db
    .select()
    .from(workspaceScimRoleMappings)
    .where(eq(workspaceScimRoleMappings.workspaceId, workspaceId))
    .orderBy(asc(workspaceScimRoleMappings.createdAt));
}

export async function issueScimToken(
  workspaceId: string,
  actorUserId: string,
  context?: StoredAuditContext,
): Promise<{ token: string; settings: ScimSettingsView }> {
  const { token, hash, prefix } = generateScimToken();
  const now = new Date();
  const [existing] = await db
    .select({ workspaceId: workspaceScimConfigs.workspaceId })
    .from(workspaceScimConfigs)
    .where(eq(workspaceScimConfigs.workspaceId, workspaceId));

  const fields = { workspaceId, actorUserId, source: "dashboard" as const, rotated: Boolean(existing), tokenPrefix: prefix };
  await db.transaction(async (tx) => {
    await tx
      .insert(workspaceScimConfigs)
      .values({ workspaceId, tokenHash: hash, tokenPrefix: prefix, createdBy: actorUserId })
      .onConflictDoUpdate({
        target: workspaceScimConfigs.workspaceId,
        set: { tokenHash: hash, tokenPrefix: prefix, rotatedAt: now, lastUsedAt: null },
      });
    await writeAuditEvents(tx, [membershipRecord("scim.token_created", fields, { context })]);
  });

  logMembershipEvent("scim.token_created", fields);
  return { token, settings: await getScimSettings(workspaceId) };
}

export async function revokeScimToken(workspaceId: string, actorUserId: string, context?: StoredAuditContext): Promise<void> {
  const fields = { workspaceId, actorUserId, source: "dashboard" as const };
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(workspaceScimConfigs)
      .where(eq(workspaceScimConfigs.workspaceId, workspaceId))
      .returning({ workspaceId: workspaceScimConfigs.workspaceId });
    if (!deleted) throw new NotFoundError("SCIM token");
    await writeAuditEvents(tx, [membershipRecord("scim.token_revoked", fields, { context })]);
  });
  logMembershipEvent("scim.token_revoked", fields);
}

export async function updateScimDefaultRole(
  workspaceId: string,
  actorUserId: string,
  defaultRole: WorkspaceRole,
  context?: StoredAuditContext,
) {
  const fields = { workspaceId, actorUserId, source: "dashboard" as const, defaultRole };
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(workspaceScimConfigs)
      .set({ defaultRole })
      .where(eq(workspaceScimConfigs.workspaceId, workspaceId))
      .returning({ workspaceId: workspaceScimConfigs.workspaceId });
    if (!updated) throw new NotFoundError("SCIM token");
    await writeAuditEvents(tx, [membershipRecord("scim.settings_updated", fields, { context })]);
  });
  logMembershipEvent("scim.settings_updated", fields);
}

export async function replaceRoleMappings(
  workspaceId: string,
  actorUserId: string,
  mappings: Array<{ groupName: string; role: WorkspaceRole; priority?: number }>,
  context?: StoredAuditContext,
): Promise<void> {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const key = mapping.groupName.trim().toLowerCase();
    if (!key) throw new ValidationError("A group name cannot be empty");
    if (seen.has(key)) throw new ValidationError(`The group "${mapping.groupName}" is mapped twice`);
    seen.add(key);
  }
  const fields = {
    workspaceId,
    actorUserId,
    source: "dashboard" as const,
    mappings: mappings.map(({ groupName, role, priority }) => ({ groupName, role, priority: priority ?? 0 })),
  };
  const base = Date.now();
  await db.transaction(async (tx) => {
    await tx.delete(workspaceScimRoleMappings).where(eq(workspaceScimRoleMappings.workspaceId, workspaceId));
    if (mappings.length > 0) {
      await tx.insert(workspaceScimRoleMappings).values(
        mappings.map((mapping, index) => ({
          workspaceId,
          groupName: mapping.groupName.trim(),
          role: mapping.role,
          priority: mapping.priority ?? 0,
          createdAt: new Date(base + index),
        })),
      );
    }
    await writeAuditEvents(tx, [membershipRecord("scim.role_mappings_replaced", fields, { context })]);
  });
  logMembershipEvent("scim.role_mappings_replaced", fields);
}

const lastUsedWritten = new TtlCache<true>({ ttlMs: 5 * 60_000, maxEntries: 1_000 });

export async function authenticateScimToken(token: string): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashApiKey(token);

  const [config] = await db
    .select({ workspaceId: workspaceScimConfigs.workspaceId })
    .from(workspaceScimConfigs)
    .where(eq(workspaceScimConfigs.tokenHash, hash));
  if (!config) return null;

  if (!lastUsedWritten.has(hash)) {
    lastUsedWritten.set(hash, true);
    await db.update(workspaceScimConfigs).set({ lastUsedAt: new Date() }).where(eq(workspaceScimConfigs.tokenHash, hash));
  }
  return config.workspaceId;
}

export function resetScimTokenCacheForTests(): void {
  lastUsedWritten.clear();
}
