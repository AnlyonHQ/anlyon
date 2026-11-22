import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { isCloudEdition } from "../edition/edition.ts";
import { getPlanLimits, upgradesPurchasable, type WorkspaceAge } from "../plans/limits.ts";
import { PlanFeatureRequiredError } from "./usage-enforcement.ts";

export type TeamFeature = "sso" | "scim" | "audit_streaming" | "byo_vault" | "env_permissions";

export function teamFeaturesAvailable(workspace: { plan: string | null } & WorkspaceAge): boolean {
  if (!isCloudEdition()) return true;
  if (!upgradesPurchasable()) return true;
  return getPlanLimits(workspace.plan, workspace).features.teamFeatures;
}

export async function assertTeamFeature(workspaceId: string, feature: TeamFeature): Promise<void> {
  if (!isCloudEdition() || !upgradesPurchasable()) return;
  const [workspace] = await db
    .select({ plan: workspaces.plan, createdAt: workspaces.createdAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  if (!teamFeaturesAvailable(workspace)) throw new PlanFeatureRequiredError(feature);
}
