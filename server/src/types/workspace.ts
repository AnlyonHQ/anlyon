export type { PlanId as Plan } from "../core/plans/limits.ts";
import type { PlanId as Plan } from "../core/plans/limits.ts";
export type { Role } from "../core/workspace/permissions.ts";
import type { Role } from "../core/workspace/permissions.ts";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "trialing";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt?: Date;
  monthlyMessageQuota: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: Role;
  invitedBy?: string;
  invitedAt?: Date;
  joinedAt: Date;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  isActive: boolean;
  lastUsedAt?: Date;
  createdBy: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
}

export interface InviteMemberInput {
  email: string;
  role: Role;
}
