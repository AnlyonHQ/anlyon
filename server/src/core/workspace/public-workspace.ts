interface StoredWorkspaceLike {
  id: string;
  name: string;
  slug: string;
  plan: string;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  monthlyMessageQuota: string | null;
  currentMonthMessages: number | null;
  currentMonthBandwidth: number | null;
  usageResetDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicWorkspace(workspace: StoredWorkspaceLike) {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    plan: workspace.plan,
    subscriptionStatus: workspace.subscriptionStatus,
    trialEndsAt: workspace.trialEndsAt,
    monthlyMessageQuota: workspace.monthlyMessageQuota,
    currentMonthMessages: workspace.currentMonthMessages,
    currentMonthBandwidth: workspace.currentMonthBandwidth,
    usageResetDate: workspace.usageResetDate,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}
