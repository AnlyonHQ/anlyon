import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getMonthKey } from "../../lib/workspace-cache.ts";
import { getActionUsage } from "./action-accounting.ts";
import { getPlanLimits, usageAllowance } from "../plans/limits.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { getDurableMessageUsage } from "./message-accounting.ts";
import { getWorkspaceStorageUsage } from "./storage-accounting.ts";

export async function getUsageAllowances(workspaceId: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  const limits = getPlanLimits(workspace.plan, workspace);
  const month = getMonthKey();
  const { messages, bandwidth } = await getDurableMessageUsage(workspaceId, month);
  const actions = await getActionUsage(workspaceId, month);
  const dimensions = {
    actionInvokes: { ...usageAllowance(limits.usagePolicy.actionInvokes, actions.billed), reservedUnits: actions.reserved },
    messages: usageAllowance(limits.usagePolicy.messages, Number(messages ?? 0)),
    bandwidth: usageAllowance(limits.usagePolicy.bandwidth, Number(bandwidth ?? 0)),
    storage: usageAllowance(limits.usagePolicy.storage, (await getWorkspaceStorageUsage(workspaceId)).usedBytes),
  };
  return { ...dimensions, projectedOverageCents: Object.values(dimensions).reduce((sum, d) => sum + d.projectedOverageCents, 0),
    monthlyFeeCents: limits.pricing.monthlyFee };
}
