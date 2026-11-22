import { and, eq, count, gt, isNull } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaces, workspaceMembers } from "../../db/schema/workspaces.ts";
import { workspaceInvitations } from "../../db/schema/invitations.ts";
import { environments } from "../../db/schema/environments.ts";
import { actions } from "../../db/schema/actions.ts";
import { getPlanLimits, type PlanId } from "../plans/limits.ts";
import { invalidateWorkspaceCache } from "../../lib/workspace-cache.ts";
import { ApiError, NotFoundError } from "../../utils/errors.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function resourcePlan(workspace: { plan: PlanId; pendingPlan?: PlanId | null }) {
  return workspace.pendingPlan ?? workspace.plan;
}

export async function prepareDowngrade(workspaceId: string, plan: PlanId) {
  await db.transaction(async tx => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) throw new NotFoundError("Workspace");
    await assertFitsPlan(workspaceId, plan, tx);
    await tx.update(workspaces).set({ pendingPlan: plan, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  });
  await invalidateWorkspaceCache(workspaceId);
}

export async function setWorkspacePlan(
  workspaceId: string,
  plan: PlanId,
  patch: Partial<typeof workspaces.$inferInsert> = {},
  alsoInTransaction?: (tx: Transaction) => Promise<void>,
) {
  await db.transaction(async tx => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    await tx.update(workspaces).set({ ...patch, plan, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
    if (alsoInTransaction) await alsoInTransaction(tx);
  });
  await invalidateWorkspaceCache(workspaceId);
}

export async function assertFitsPlan(workspaceId: string, plan: PlanId, connection: typeof db | Transaction = db) {
  const [owner] = await connection.select({ createdAt: workspaces.createdAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const limits = getPlanLimits(plan, owner);
  const [members, pending, definitions, envs] = await Promise.all([
    connection.select({ value: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    connection.select({ value: count() }).from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, "pending"), gt(workspaceInvitations.expiresAt, new Date()))),
    connection.select({ value: count() }).from(actions).where(and(eq(actions.workspaceId, workspaceId), isNull(actions.archivedAt))),
    connection.select().from(environments).where(eq(environments.workspaceId, workspaceId)),
  ]);
  const violations: string[] = [];
  if (limits.maxSeats !== "unlimited" && members[0].value + pending[0].value > limits.maxSeats) violations.push(`reduce seats (including invitations) to ${limits.maxSeats}`);
  if (limits.maxActions !== "unlimited" && definitions[0].value > limits.maxActions) violations.push(`reduce actions to ${limits.maxActions}`);
  if (limits.maxEnvironments !== "unlimited" && envs.length > limits.maxEnvironments) violations.push(`reduce environments to ${limits.maxEnvironments}`);
  if (!limits.features.protectedProduction && envs.some(env => env.isProtected)) violations.push("remove environment protection");
  if (violations.length) throw new ApiError(409, "PLAN_RESOURCES_EXCEEDED", `Before switching to ${plan}, ${violations.join("; ")}.`);
}
