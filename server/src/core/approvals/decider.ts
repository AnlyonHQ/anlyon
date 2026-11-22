import { AuthorizationError, SelfApprovalError } from "../../utils/errors.ts";
import { hasPermission, permissionDeniedMessage } from "../workspace/permissions.ts";
import { approvalDecidersIn, resolveMemberRole } from "../workspace/roles.ts";
import { apiKeyCreator } from "./requester.ts";

const SECOND_APPROVER =
  "Another member who can decide approvals in this environment must decide it, or decide it with a separate approver key.";

export interface DecidableApproval {
  environmentId: string;
  requestedByKeyId: string | null;
  requestedByOAuthClientId: string | null;
  requestedByUserId: string | null;
}

export interface Decider {
  deciderKeyId?: string | null;
  deciderOAuthClientId?: string | null;
  deciderUserId?: string | null;
  assistant?: { model: string };
}

export interface DecisionAllowance {
  selfApproved: boolean;
}

async function anotherDeciderIn(workspaceId: string, environmentId: string, userId: string): Promise<boolean> {
  return (await approvalDecidersIn(workspaceId, environmentId)).some((id) => id !== userId);
}

export async function assertMayDecide(
  workspaceId: string,
  approval: DecidableApproval,
  decider: Decider,
): Promise<DecisionAllowance> {
  let selfApproved = false;
  if (
    decider.deciderKeyId &&
    approval.requestedByKeyId &&
    decider.deciderKeyId === approval.requestedByKeyId
  ) {
    throw new AuthorizationError(
      "An API key cannot decide an approval it requested. Use a different key, or the dashboard. " +
        "If this decision should not need a human at all, express it as an auto_approve policy."
    );
  }
  if (
    decider.deciderOAuthClientId &&
    approval.requestedByOAuthClientId &&
    decider.deciderOAuthClientId === approval.requestedByOAuthClientId &&
    decider.deciderUserId === approval.requestedByUserId
  ) {
    throw new AuthorizationError(
      "An app cannot decide an approval it requested. Decide it in the dashboard, or from a different app. " +
        "If this decision should not need a human at all, express it as an auto_approve policy."
    );
  }

  if (decider.deciderUserId && !decider.assistant) {
    const ownApp = Boolean(approval.requestedByOAuthClientId) && approval.requestedByUserId === decider.deciderUserId;
    const ownRequest = !ownApp && !approval.requestedByKeyId && !approval.requestedByOAuthClientId &&
      approval.requestedByUserId === decider.deciderUserId;
    const ownKey = !ownApp && !ownRequest && Boolean(approval.requestedByKeyId) &&
      (await apiKeyCreator(approval.requestedByKeyId as string)) === decider.deciderUserId;
    if (ownApp || ownRequest || ownKey) {
      const direct = !decider.deciderOAuthClientId && !decider.deciderKeyId;
      if (!direct || (await anotherDeciderIn(workspaceId, approval.environmentId, decider.deciderUserId))) {
        throw new SelfApprovalError(
          ownApp
            ? `You cannot decide this approval: an app acting for you requested it. ${SECOND_APPROVER}`
            : ownRequest
              ? `You cannot decide this approval: you requested it. ${SECOND_APPROVER}`
              : `You cannot decide this approval: an API key you created requested it. ${SECOND_APPROVER}`,
        );
      }
      selfApproved = true;
    }
  }

  if (decider.deciderUserId && !decider.assistant) {
    const resolved = await resolveMemberRole(workspaceId, decider.deciderUserId, approval.environmentId);
    if (!resolved) {
      throw new AuthorizationError("You are not a member of this workspace");
    }
    if (!hasPermission(resolved.role, "approvals.decide")) {
      throw new AuthorizationError(permissionDeniedMessage(resolved.role, "approvals.decide"));
    }
  }
  return { selfApproved };
}

export interface QuorumVote {
  id: string;
  deciderKeyId: string | null;
  deciderUserId: string | null;
  keyCreatedBy: string | null;
}

export function distinctApprovers(votes: readonly QuorumVote[]): number {
  return new Set(votes.map((vote) =>
    vote.keyCreatedBy ? `user:${vote.keyCreatedBy}`
      : vote.deciderUserId ? `user:${vote.deciderUserId}`
        : vote.deciderKeyId ? `key:${vote.deciderKeyId}`
          : "assistant")).size;
}
