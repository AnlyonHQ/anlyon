import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  workspaceScimConfigs,
  workspaceScimGroupMembers,
  workspaceScimGroups,
  workspaceScimUsers,
  type WorkspaceScimGroupRow,
  type WorkspaceScimUserRow,
} from "../../db/schema/scim.ts";
import { workspaceSsoConnections } from "../../db/schema/sso.ts";
import { workspaceMembers } from "../../db/schema/workspaces.ts";
import { revokeMemberAccess } from "../workspace/access-revocation.ts";
import { logMembershipEvent } from "../workspace/membership-audit.ts";
import { membershipRecord } from "../workspace/membership-records.ts";
import { type AuditRecordInput, writeAuditEvents } from "../audit/outbox.ts";
import type { WorkspaceRole } from "../workspace/provisioned-roles.ts";
import { emailDomain } from "../sso/domains.ts";
import { parseEqFilter } from "./filter.ts";
import { applyGroupPatch, applyUserPatch, coerceBoolean, type PatchRequest } from "./patch.ts";
import { MAX_ATTRIBUTE_LENGTH } from "./protocol.ts";
import {
  listResponse,
  ScimError,
  toScimGroup,
  toScimUser,
  type ScimGroupResource,
  type ScimUserResource,
} from "./protocol.ts";
import { resolveRole } from "./roles.ts";
import { listRoleMappings, SCIM_BASE_URL } from "./settings.ts";
import { createPerson, findPeople, findPersonByEmail } from "./users.ts";
import { assertAdminsRemain, LastAdminError } from "../workspace/admin-invariants.ts";
import { isAdmin } from "../workspace/permissions.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (resource: "User" | "Group") => new ScimError(404, `${resource} not found`);

function assertUuid(id: string, resource: "User" | "Group"): void {
  if (!UUID.test(id)) throw notFound(resource);
}

export interface ScimUserInput {
  userName: string;
  externalId: string | null;
  active: boolean;
  displayName: string | null;
  email: string | null;
}

function optionalString(value: unknown, attribute = "value"): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_ATTRIBUTE_LENGTH) {
    throw new ScimError(400, `${attribute} may be at most ${MAX_ATTRIBUTE_LENGTH} characters`, "invalidValue");
  }
  return trimmed;
}

export function parseUserBody(body: unknown): ScimUserInput {
  if (!body || typeof body !== "object") throw new ScimError(400, "Expected a SCIM User object", "invalidSyntax");
  const input = body as Record<string, unknown>;
  const userName = optionalString(input.userName, "userName");
  if (!userName) throw new ScimError(400, "userName is required", "invalidValue");

  const emails = Array.isArray(input.emails) ? (input.emails as Array<Record<string, unknown>>) : [];
  const primary = emails.find((e) => e?.primary === true || e?.primary === "true") ?? emails[0];
  const name = (input.name ?? {}) as Record<string, unknown>;
  const composed = [optionalString(name.givenName, "name.givenName"), optionalString(name.familyName, "name.familyName")]
    .filter(Boolean)
    .join(" ");

  return {
    userName,
    externalId: optionalString(input.externalId, "externalId"),
    active: input.active === undefined ? true : coerceBoolean(input.active),
    displayName:
      optionalString(input.displayName, "displayName") ?? optionalString(name.formatted, "name.formatted") ?? (composed || null),
    email: optionalString(primary?.value, "emails.value") ?? (userName.includes("@") ? userName : null),
  };
}

function parseGroupBody(body: unknown): { displayName: string; externalId: string | null; members: string[] } {
  if (!body || typeof body !== "object") throw new ScimError(400, "Expected a SCIM Group object", "invalidSyntax");
  const input = body as Record<string, unknown>;
  const displayName = optionalString(input.displayName, "displayName");
  if (!displayName) throw new ScimError(400, "displayName is required", "invalidValue");
  const members = Array.isArray(input.members)
    ? (input.members as Array<Record<string, unknown>>).map((m) => {
        if (typeof m?.value !== "string" || !m.value) {
          throw new ScimError(400, "Each member needs a value (the SCIM User id)", "invalidValue");
        }
        return m.value;
      })
    : [];
  return { displayName, externalId: optionalString(input.externalId, "externalId"), members };
}

interface Directory {
  defaultRole: WorkspaceRole;
  mappings: Awaited<ReturnType<typeof listRoleMappings>>;
}

async function loadDirectory(workspaceId: string): Promise<Directory> {
  const [config] = await db
    .select({ defaultRole: workspaceScimConfigs.defaultRole })
    .from(workspaceScimConfigs)
    .where(eq(workspaceScimConfigs.workspaceId, workspaceId));
  return { defaultRole: config?.defaultRole ?? "member", mappings: await listRoleMappings(workspaceId) };
}

async function groupsOf(scimUserIds: string[]): Promise<Map<string, Array<{ id: string; displayName: string }>>> {
  const out = new Map<string, Array<{ id: string; displayName: string }>>();
  if (scimUserIds.length === 0) return out;
  const rows = await db
    .select({
      scimUserId: workspaceScimGroupMembers.scimUserId,
      id: workspaceScimGroups.id,
      displayName: workspaceScimGroups.displayName,
    })
    .from(workspaceScimGroupMembers)
    .innerJoin(workspaceScimGroups, eq(workspaceScimGroups.id, workspaceScimGroupMembers.groupId))
    .where(inArray(workspaceScimGroupMembers.scimUserId, scimUserIds));
  for (const row of rows) {
    const list = out.get(row.scimUserId) ?? [];
    list.push({ id: row.id, displayName: row.displayName });
    out.set(row.scimUserId, list);
  }
  return out;
}

async function membershipOf(workspaceId: string, userId: string) {
  const [member] = await db
    .select({ id: workspaceMembers.id, role: workspaceMembers.role, emergencyAccess: workspaceMembers.emergencyAccess })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return member ?? null;
}

async function syncMemberships(workspaceId: string, rows: WorkspaceScimUserRow[], directory?: Directory): Promise<void> {
  const active = rows.filter((row) => row.active);
  if (active.length === 0) return;
  const dir = directory ?? (await loadDirectory(workspaceId));
  const groups = await groupsOf(active.map((row) => row.id));

  for (const row of active) {
    const names = (groups.get(row.id) ?? []).map((g) => g.displayName);
    const role = resolveRole(names, dir.mappings, dir.defaultRole);
    const member = await membershipOf(workspaceId, row.userId);
    if (member?.emergencyAccess) continue;
    if (!member) {
      const fields = { workspaceId, userId: row.userId, role, source: "scim" as const, scimUserId: row.id };
      const inserted = await db.transaction(async (tx) => {
        const added = await tx
          .insert(workspaceMembers)
          .values({ workspaceId, userId: row.userId, role })
          .onConflictDoNothing()
          .returning({ id: workspaceMembers.id });
        if (added.length > 0) await writeAuditEvents(tx, [membershipRecord("member.provisioned", fields)]);
        return added;
      });
      if (inserted.length > 0) logMembershipEvent("member.provisioned", fields);
    } else if (member.role !== role) {
      const fields = {
        workspaceId,
        userId: row.userId,
        oldRole: member.role,
        newRole: role,
        source: "scim" as const,
        scimUserId: row.id,
      };
      await db.transaction(async (tx) => {
        if (isAdmin(member.role) && !isAdmin(role)) {
          await assertAdminsRemain(tx, workspaceId, { userId: row.userId, admin: false, emergencyAccess: false });
        }
        await tx.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, member.id));
        await writeAuditEvents(tx, [membershipRecord("member.role_changed", { ...fields, role, previousRole: member.role })]);
      });
      logMembershipEvent("member.role_changed", fields);
    }
  }
}

export async function reapplyDirectoryRoles(workspaceId: string): Promise<void> {
  const rows = await db
    .select()
    .from(workspaceScimUsers)
    .where(and(eq(workspaceScimUsers.workspaceId, workspaceId), eq(workspaceScimUsers.active, true)));
  await syncMemberships(workspaceId, rows);
}

async function refuseEmergencyAccess(workspaceId: string, userId: string, action: string): Promise<void> {
  const member = await membershipOf(workspaceId, userId);
  if (member?.emergencyAccess) {
    throw new ScimError(
      400,
      `An admin with emergency access cannot be ${action} through SCIM. Remove their emergency access in the console first.`,
      "mutability",
    );
  }
}

async function deprovision(
  workspaceId: string,
  row: WorkspaceScimUserRow,
  event: "member.deactivated" | "member.deprovisioned",
): Promise<void> {
  const fields = { workspaceId, userId: row.userId, source: "scim" as const, scimUserId: row.id };
  let result;
  try {
    result = await revokeMemberAccess(workspaceId, row.userId, {
      reason: "member_deprovisioned",
      membershipRecord: (revoked) => membershipRecord(event, { ...fields, ...revoked }),
    }, async (tx) => {
      const [member] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, row.userId)));
      if (isAdmin(member?.role)) {
        await assertAdminsRemain(tx, workspaceId, { userId: row.userId, admin: false, emergencyAccess: false });
      }
    });
  } catch (error) {
    if (error instanceof LastAdminError) throw new ScimError(400, error.message, "mutability");
    throw error;
  }
  logMembershipEvent(event, { ...fields, ...result });
}

async function renderUsers(rows: WorkspaceScimUserRow[]): Promise<ScimUserResource[]> {
  const people = await findPeople(rows.map((row) => row.userId));
  const groups = await groupsOf(rows.map((row) => row.id));
  return rows.map((row) => {
    const person = people.get(row.userId) ?? { name: "", email: row.userName };
    return toScimUser(SCIM_BASE_URL, row, person, groups.get(row.id) ?? []);
  });
}

async function loadUser(workspaceId: string, id: string): Promise<WorkspaceScimUserRow> {
  assertUuid(id, "User");
  const [row] = await db
    .select()
    .from(workspaceScimUsers)
    .where(and(eq(workspaceScimUsers.workspaceId, workspaceId), eq(workspaceScimUsers.id, id)));
  if (!row) throw notFound("User");
  return row;
}

async function assertUserUnique(
  workspaceId: string,
  values: { userName: string; externalId: string | null },
  exceptId?: string,
): Promise<void> {
  const clauses = [
    eq(workspaceScimUsers.workspaceId, workspaceId),
    sql`(lower(${workspaceScimUsers.userName}) = ${values.userName.toLowerCase()}${
      values.externalId ? sql` OR ${workspaceScimUsers.externalId} = ${values.externalId}` : sql``
    })`,
  ];
  if (exceptId) clauses.push(ne(workspaceScimUsers.id, exceptId));
  const [clash] = await db.select({ id: workspaceScimUsers.id }).from(workspaceScimUsers).where(and(...clauses)).limit(1);
  if (clash) throw new ScimError(409, "A user with this userName or externalId already exists", "uniqueness");
}

export async function listScimUsers(
  workspaceId: string,
  query: { filter?: string; startIndex: number; count: number },
) {
  const filter = parseEqFilter(query.filter, ["userName", "externalId", "id"]);
  const clauses = [eq(workspaceScimUsers.workspaceId, workspaceId)];
  if (filter?.attribute === "userName") clauses.push(sql`lower(${workspaceScimUsers.userName}) = ${filter.value.toLowerCase()}`);
  if (filter?.attribute === "externalId") clauses.push(eq(workspaceScimUsers.externalId, filter.value));
  if (filter?.attribute === "id") {
    if (!UUID.test(filter.value)) return listResponse([], 0, query.startIndex);
    clauses.push(eq(workspaceScimUsers.id, filter.value));
  }
  const where = and(...clauses);
  const [{ total }] = await db.select({ total: count() }).from(workspaceScimUsers).where(where);
  const rows =
    query.count === 0
      ? []
      : await db
          .select()
          .from(workspaceScimUsers)
          .where(where)
          .orderBy(asc(workspaceScimUsers.createdAt), asc(workspaceScimUsers.id))
          .offset(query.startIndex - 1)
          .limit(query.count);
  return listResponse(await renderUsers(rows), Number(total), query.startIndex);
}

export async function getScimUser(workspaceId: string, id: string): Promise<ScimUserResource> {
  const [resource] = await renderUsers([await loadUser(workspaceId, id)]);
  return resource;
}

async function canLinkExistingAccount(workspaceId: string, userId: string, email: string): Promise<boolean> {
  if (await membershipOf(workspaceId, userId)) return true;
  return onVerifiedSsoDomain(workspaceId, email);
}

async function onVerifiedSsoDomain(workspaceId: string, email: string): Promise<boolean> {
  const [connection] = await db
    .select({ domains: workspaceSsoConnections.domains, verifiedAt: workspaceSsoConnections.domainsVerifiedAt })
    .from(workspaceSsoConnections)
    .where(eq(workspaceSsoConnections.workspaceId, workspaceId));
  const domain = emailDomain(email);
  return Boolean(connection?.verifiedAt && domain && connection.domains.includes(domain));
}

export async function createScimUser(workspaceId: string, body: unknown): Promise<ScimUserResource> {
  const input = parseUserBody(body);
  if (!input.email) {
    throw new ScimError(400, "An email address is required: send emails, or a userName that is an email address", "invalidValue");
  }
  await assertUserUnique(workspaceId, input);

  let person = await findPersonByEmail(input.email);
  if (person) {
    const [linked] = await db
      .select({ id: workspaceScimUsers.id })
      .from(workspaceScimUsers)
      .where(and(eq(workspaceScimUsers.workspaceId, workspaceId), eq(workspaceScimUsers.userId, person.id)));
    if (linked) throw new ScimError(409, "This person is already provisioned in this workspace", "uniqueness");
  }

  const canProvision = person
    ? await canLinkExistingAccount(workspaceId, person.id, input.email)
    : await onVerifiedSsoDomain(workspaceId, input.email);
  if (!canProvision) {
    throw new ScimError(
      400,
      "This address cannot be provisioned. Directory sync adds a person only if their email is on a domain verified for this workspace's single sign-on, or if they are a member of the workspace already. Verify the domain under Settings, Single sign-on in the Anlyon console, or add the person to the workspace first.",
      "invalidValue",
    );
  }

  if (person) {
    if (!input.active) await refuseEmergencyAccess(workspaceId, person.id, "deactivated");
  } else {
    person = await createPerson({
      email: input.email,
      name: input.displayName ?? input.userName,
      emailVerified: true,
    });
  }

  const [row] = await db
    .insert(workspaceScimUsers)
    .values({
      workspaceId,
      userId: person.id,
      userName: input.userName,
      externalId: input.externalId,
      active: input.active,
    })
    .returning();

  if (row.active) await syncMemberships(workspaceId, [row]);
  else if (await membershipOf(workspaceId, row.userId)) await deprovision(workspaceId, row, "member.deactivated");

  return getScimUser(workspaceId, row.id);
}

async function applyUserState(
  workspaceId: string,
  current: WorkspaceScimUserRow,
  next: { userName: string; externalId: string | null; active: boolean },
): Promise<ScimUserResource> {
  if (next.userName.toLowerCase() !== current.userName.toLowerCase() || next.externalId !== current.externalId) {
    await assertUserUnique(workspaceId, next, current.id);
  }
  if (!next.active) await refuseEmergencyAccess(workspaceId, current.userId, "deactivated");

  const reactivated = next.active && !current.active;
  const profileChanged = next.userName !== current.userName || next.externalId !== current.externalId;
  const base = { workspaceId, userId: current.userId, source: "scim" as const, scimUserId: current.id };
  const profile = { ...base, userName: next.userName, externalId: next.externalId };
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(workspaceScimUsers)
      .set({ userName: next.userName, externalId: next.externalId, active: next.active, updatedAt: new Date() })
      .where(eq(workspaceScimUsers.id, current.id))
      .returning();
    await writeAuditEvents(tx, [
      ...(reactivated ? [membershipRecord("member.reactivated", base)] : []),
      ...(profileChanged ? [membershipRecord("member.profile_updated", profile)] : []),
    ]);
    return updated;
  });

  if (!row.active) {
    if (current.active || (await membershipOf(workspaceId, row.userId))) {
      await deprovision(workspaceId, row, "member.deactivated");
    }
  } else {
    if (reactivated) logMembershipEvent("member.reactivated", base);
    await syncMemberships(workspaceId, [row]);
  }
  if (profileChanged) logMembershipEvent("member.profile_updated", profile);
  return getScimUser(workspaceId, row.id);
}

export async function replaceScimUser(workspaceId: string, id: string, body: unknown): Promise<ScimUserResource> {
  const current = await loadUser(workspaceId, id);
  const input = parseUserBody(body);
  return applyUserState(workspaceId, current, input);
}

export async function patchScimUser(workspaceId: string, id: string, body: PatchRequest): Promise<ScimUserResource> {
  const current = await loadUser(workspaceId, id);
  const next = applyUserPatch(
    { userName: current.userName, externalId: current.externalId, active: current.active },
    body,
  );
  return applyUserState(workspaceId, current, next);
}

export async function deleteScimUser(workspaceId: string, id: string): Promise<void> {
  const row = await loadUser(workspaceId, id);
  await refuseEmergencyAccess(workspaceId, row.userId, "deleted");
  await deprovision(workspaceId, row, "member.deprovisioned");
  await db.delete(workspaceScimUsers).where(eq(workspaceScimUsers.id, row.id));
}

async function membersOf(groupIds: string[]): Promise<Map<string, Array<{ id: string; userName: string }>>> {
  const out = new Map<string, Array<{ id: string; userName: string }>>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ groupId: workspaceScimGroupMembers.groupId, id: workspaceScimUsers.id, userName: workspaceScimUsers.userName })
    .from(workspaceScimGroupMembers)
    .innerJoin(workspaceScimUsers, eq(workspaceScimUsers.id, workspaceScimGroupMembers.scimUserId))
    .where(inArray(workspaceScimGroupMembers.groupId, groupIds));
  for (const row of rows) {
    const list = out.get(row.groupId) ?? [];
    list.push({ id: row.id, userName: row.userName });
    out.set(row.groupId, list);
  }
  return out;
}

async function renderGroups(rows: WorkspaceScimGroupRow[], withMembers: boolean): Promise<ScimGroupResource[]> {
  const members = withMembers ? await membersOf(rows.map((row) => row.id)) : null;
  return rows.map((row) => toScimGroup(SCIM_BASE_URL, row, members ? (members.get(row.id) ?? []) : null));
}

async function loadGroup(workspaceId: string, id: string): Promise<WorkspaceScimGroupRow> {
  assertUuid(id, "Group");
  const [row] = await db
    .select()
    .from(workspaceScimGroups)
    .where(and(eq(workspaceScimGroups.workspaceId, workspaceId), eq(workspaceScimGroups.id, id)));
  if (!row) throw notFound("Group");
  return row;
}

async function assertGroupNameFree(workspaceId: string, displayName: string, exceptId?: string): Promise<void> {
  const clauses = [
    eq(workspaceScimGroups.workspaceId, workspaceId),
    sql`lower(${workspaceScimGroups.displayName}) = ${displayName.toLowerCase()}`,
  ];
  if (exceptId) clauses.push(ne(workspaceScimGroups.id, exceptId));
  const [clash] = await db.select({ id: workspaceScimGroups.id }).from(workspaceScimGroups).where(and(...clauses)).limit(1);
  if (clash) throw new ScimError(409, "A group with this displayName already exists", "uniqueness");
}

async function assertMembersExist(workspaceId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (ids.some((id) => !UUID.test(id))) throw new ScimError(400, "A member is not a user in this directory", "invalidValue");
  const rows = await db
    .select({ id: workspaceScimUsers.id })
    .from(workspaceScimUsers)
    .where(and(eq(workspaceScimUsers.workspaceId, workspaceId), inArray(workspaceScimUsers.id, ids)));
  if (rows.length !== new Set(ids).size) throw new ScimError(400, "A member is not a user in this directory", "invalidValue");
}

async function currentMemberIds(groupId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: workspaceScimGroupMembers.scimUserId })
    .from(workspaceScimGroupMembers)
    .where(eq(workspaceScimGroupMembers.groupId, groupId));
  return new Set(rows.map((row) => row.id));
}

async function writeGroup(
  workspaceId: string,
  groupId: string,
  previous: Set<string>,
  next: { displayName: string; externalId: string | null; members: Set<string> },
  renamed: boolean,
  record?: AuditRecordInput,
): Promise<void> {
  const added = [...next.members].filter((id) => !previous.has(id));
  const removed = [...previous].filter((id) => !next.members.has(id));
  await db.transaction(async (tx) => {
    await tx
      .update(workspaceScimGroups)
      .set({ displayName: next.displayName, externalId: next.externalId, updatedAt: new Date() })
      .where(eq(workspaceScimGroups.id, groupId));
    if (removed.length > 0) {
      await tx
        .delete(workspaceScimGroupMembers)
        .where(and(eq(workspaceScimGroupMembers.groupId, groupId), inArray(workspaceScimGroupMembers.scimUserId, removed)));
    }
    if (added.length > 0) {
      await tx
        .insert(workspaceScimGroupMembers)
        .values(added.map((scimUserId) => ({ groupId, scimUserId })))
        .onConflictDoNothing();
    }
    if (record) await writeAuditEvents(tx, [record]);
  });

  const affected = renamed ? [...new Set([...previous, ...next.members])] : [...added, ...removed];
  if (affected.length > 0) {
    const rows = await db.select().from(workspaceScimUsers).where(inArray(workspaceScimUsers.id, affected));
    await syncMemberships(workspaceId, rows);
  }
}

export async function listScimGroups(
  workspaceId: string,
  query: { filter?: string; startIndex: number; count: number; excludedAttributes?: string },
) {
  const filter = parseEqFilter(query.filter, ["displayName", "externalId", "id"]);
  const clauses = [eq(workspaceScimGroups.workspaceId, workspaceId)];
  if (filter?.attribute === "displayName") {
    clauses.push(sql`lower(${workspaceScimGroups.displayName}) = ${filter.value.toLowerCase()}`);
  }
  if (filter?.attribute === "externalId") clauses.push(eq(workspaceScimGroups.externalId, filter.value));
  if (filter?.attribute === "id") {
    if (!UUID.test(filter.value)) return listResponse([], 0, query.startIndex);
    clauses.push(eq(workspaceScimGroups.id, filter.value));
  }
  const where = and(...clauses);
  const [{ total }] = await db.select({ total: count() }).from(workspaceScimGroups).where(where);
  const rows =
    query.count === 0
      ? []
      : await db
          .select()
          .from(workspaceScimGroups)
          .where(where)
          .orderBy(asc(workspaceScimGroups.createdAt), asc(workspaceScimGroups.id))
          .offset(query.startIndex - 1)
          .limit(query.count);
  const withMembers = !/\bmembers\b/i.test(query.excludedAttributes ?? "");
  return listResponse(await renderGroups(rows, withMembers), Number(total), query.startIndex);
}

export async function getScimGroup(workspaceId: string, id: string, excludedAttributes?: string): Promise<ScimGroupResource> {
  const row = await loadGroup(workspaceId, id);
  const [resource] = await renderGroups([row], !/\bmembers\b/i.test(excludedAttributes ?? ""));
  return resource;
}

export async function createScimGroup(workspaceId: string, body: unknown): Promise<ScimGroupResource> {
  const input = parseGroupBody(body);
  await assertGroupNameFree(workspaceId, input.displayName);
  await assertMembersExist(workspaceId, input.members);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(workspaceScimGroups)
      .values({ workspaceId, displayName: input.displayName, externalId: input.externalId })
      .returning();
    const fields = { workspaceId, source: "scim" as const, groupId: created.id, displayName: created.displayName };
    await writeAuditEvents(tx, [membershipRecord("group.created", fields)]);
    return created;
  });
  await writeGroup(workspaceId, row.id, new Set(), { ...input, members: new Set(input.members) }, false);
  logMembershipEvent("group.created", { workspaceId, source: "scim", groupId: row.id, displayName: row.displayName });
  return getScimGroup(workspaceId, row.id);
}

export async function replaceScimGroup(workspaceId: string, id: string, body: unknown): Promise<ScimGroupResource> {
  const row = await loadGroup(workspaceId, id);
  const input = parseGroupBody(body);
  const renamed = input.displayName.toLowerCase() !== row.displayName.toLowerCase();
  if (renamed) await assertGroupNameFree(workspaceId, input.displayName, row.id);
  await assertMembersExist(workspaceId, input.members);
  const fields = { workspaceId, source: "scim" as const, groupId: row.id, displayName: input.displayName };
  await writeGroup(
    workspaceId,
    row.id,
    await currentMemberIds(row.id),
    { ...input, members: new Set(input.members) },
    renamed,
    membershipRecord("group.updated", fields),
  );
  logMembershipEvent("group.updated", fields);
  return getScimGroup(workspaceId, row.id);
}

export async function patchScimGroup(workspaceId: string, id: string, body: PatchRequest): Promise<void> {
  const row = await loadGroup(workspaceId, id);
  const previous = await currentMemberIds(row.id);
  const next = applyGroupPatch({ displayName: row.displayName, externalId: row.externalId, members: previous }, body);
  const renamed = next.displayName.toLowerCase() !== row.displayName.toLowerCase();
  if (renamed) await assertGroupNameFree(workspaceId, next.displayName, row.id);
  await assertMembersExist(workspaceId, [...next.members].filter((memberId) => !previous.has(memberId)));
  const fields = { workspaceId, source: "scim" as const, groupId: row.id, displayName: next.displayName };
  await writeGroup(workspaceId, row.id, previous, next, renamed, membershipRecord("group.updated", fields));
  logMembershipEvent("group.updated", fields);
}

export async function deleteScimGroup(workspaceId: string, id: string): Promise<void> {
  const row = await loadGroup(workspaceId, id);
  const previous = await currentMemberIds(row.id);
  const fields = { workspaceId, source: "scim" as const, groupId: row.id, displayName: row.displayName };
  await db.transaction(async (tx) => {
    await tx.delete(workspaceScimGroups).where(eq(workspaceScimGroups.id, row.id));
    await writeAuditEvents(tx, [membershipRecord("group.deleted", fields)]);
  });
  if (previous.size > 0) {
    const rows = await db.select().from(workspaceScimUsers).where(inArray(workspaceScimUsers.id, [...previous]));
    await syncMemberships(workspaceId, rows);
  }
  logMembershipEvent("group.deleted", fields);
}
