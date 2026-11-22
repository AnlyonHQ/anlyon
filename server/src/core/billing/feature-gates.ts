import { limitAdvice } from "./limit-advice.ts";
import { db } from "../../db/index.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { eq } from "drizzle-orm";
import { getPlanLimits, isFeatureAvailable as checkFeature, type PlanType } from "../plans/limits.ts";
import { FeatureNotAvailableError } from "./usage-enforcement.js";
import { ApiError } from "../../utils/errors.js";

export type Feature = keyof ReturnType<typeof getPlanLimits>["features"];

export async function isFeatureAvailable(workspaceId: string, feature: Feature): Promise<boolean> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    return false;
  }

  const plan = workspace.plan as PlanType;
  return checkFeature(plan, feature, workspace);
}

export async function requireFeature(workspaceId: string, feature: Feature): Promise<void> {
  const available = await isFeatureAvailable(workspaceId, feature);

  if (!available) {
    const featureNames: Record<Feature, string> = {
      customHeaders: "Custom Headers",
      webhooks: "Success/Failure Callbacks",
      events: "Events (Pub/Sub)",
      actions: "Hosted Actions",
      approvals: "Approvals (Human-in-the-Loop)",
      budgets: "API Key Budgets",
      analytics: "Analytics Dashboard",
      prioritySupport: "Priority Support",
      sla: "SLA Guarantee",
      dedicatedSupport: "Dedicated Support",
      protectedProduction: "Protected production",
      controlledPromotion: "Controlled promotion",
      teamFeatures: "Team features (SSO, SCIM, audit streaming, secret stores, roles per environment)",
    };

    const featureName = featureNames[feature] || feature;

    throw new FeatureNotAvailableError(
      `${featureName} is not included in your current plan. ${limitAdvice("paid_only")}`,
      "production"
    );
  }
}

export async function getAvailableFeatures(
  workspaceId: string
): Promise<Record<Feature, boolean>> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }

  const plan = workspace.plan as PlanType;
  const limits = getPlanLimits(plan, workspace);

  return limits.features;
}

export async function shouldBlockOperation(
  workspaceId: string,
  operation: "publish" | "customHeaders" | "webhooks"
): Promise<{ blocked: boolean; reason?: string }> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    return { blocked: true, reason: "Workspace not found" };
  }

  void operation;

  return { blocked: false };
}
