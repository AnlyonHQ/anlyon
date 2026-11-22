import { createHash } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { approvals, approvalPolicies, type ApprovalPolicy } from "../../db/schema/approvals.ts";
import { approvalAdvice } from "../../db/schema/assistant.ts";
import { runs } from "../../db/schema/runs.ts";
import { NotFoundError } from "../../utils/errors.ts";
import { createPolicy, decideFromPolicies, sortPolicies, type CreatePolicyInput, type PublicPolicy } from "../approvals/policy.ts";

export const MIN_APPROVALS = 20;
const WINDOW_DAYS = 30;
const REQUIRE_PRIORITY = 49;
const AUTO_PRIORITY = 50;

export interface SuggestedPolicy {
  name: string;
  priority: number;
  matchKind: "action";
  matchActionName: string;
  matchAgentId: string | null;
  minAmount: number | null;
  effect: "auto_approve" | "require_approval";
}

export interface PolicySuggestion {
  key: string;
  environmentId: string;
  actionName: string;
  agentId: string | null;
  approved: number;
  maxAmount: number | null;
  averageRisk: number | null;
  policies: SuggestedPolicy[];
  preview: {
    wouldAutoApprove: number;
    wouldStillReview: number;
    wouldApproveDenied: number;
  };
}

export interface HistoryRow {
  environmentId: string;
  actionName: string;
  agentId: string | null;
  status: "approved" | "denied";
  origin: string | null;
  amount: number | null;
  risk: number | null;
}

export async function listPolicySuggestions(workspaceId: string, now: Date = new Date()): Promise<PolicySuggestion[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const raw = await db
    .select({
      environmentId: approvals.environmentId,
      actionName: sql<string>`${approvals.payload}->>'actionName'`,
      agentId: runs.agentId,
      status: approvals.status,
      origin: approvals.decisionOrigin,
      amount: sql<string | null>`${approvals.payload}->'input'->>'amount'`,
      risk: approvalAdvice.risk,
    })
    .from(approvals)
    .leftJoin(runs, eq(runs.runId, approvals.traceRunId))
    .leftJoin(approvalAdvice, eq(approvalAdvice.approvalId, approvals.id))
    .where(and(
      eq(approvals.workspaceId, workspaceId),
      eq(approvals.kind, "action"),
      gte(approvals.createdAt, since),
      inArray(approvals.status, ["approved", "denied"]),
    ))
    .limit(20_000);

  const rows: HistoryRow[] = raw
    .filter((r) => typeof r.actionName === "string" && r.actionName.length > 0)
    .map((r) => {
      const amount = r.amount === null ? null : Number(r.amount);
      return {
        environmentId: r.environmentId,
        actionName: r.actionName,
        agentId: r.agentId ?? null,
        status: r.status as "approved" | "denied",
        origin: r.origin,
        amount: amount !== null && Number.isFinite(amount) ? amount : null,
        risk: r.risk,
      };
    });

  const existing = await db.select().from(approvalPolicies)
    .where(and(eq(approvalPolicies.workspaceId, workspaceId), eq(approvalPolicies.enabled, true)));
  return mineSuggestions(rows, existing, now);
}

export async function mineSuggestions(rows: HistoryRow[], existing: ApprovalPolicy[], now: Date = new Date()): Promise<PolicySuggestion[]> {
  const groups = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const key = `${row.environmentId}|${row.actionName}|${row.agentId ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const suggestions: PolicySuggestion[] = [];
  for (const [, group] of groups) {
    const { environmentId, actionName, agentId } = group[0];
    const denied = group.filter((r) => r.status === "denied").length;
    const humanApproved = group.filter((r) => r.status === "approved" && r.origin === "human");
    if (denied > 0 || humanApproved.length < MIN_APPROVALS) continue;

    const alreadyAutomated = existing.some((p) =>
      p.environmentId === environmentId && p.effect === "auto_approve" && p.matchActionName === actionName &&
      (p.matchAgentId ?? null) === (agentId ?? null));
    if (alreadyAutomated) continue;

    const risks = group.map((r) => r.risk).filter((r): r is number => r !== null);
    const averageRisk = risks.length > 0 ? risks.reduce((a, b) => a + b, 0) / risks.length : null;
    if (averageRisk !== null && averageRisk > 1) continue;

    const amounts = humanApproved.map((r) => r.amount).filter((a): a is number => a !== null);
    const maxAmount = amounts.length > 0 ? Math.max(...amounts) : null;
    const cap = maxAmount === null ? null : amounts.every(Number.isInteger) ? maxAmount + 1 : Math.round((maxAmount + 0.01) * 100) / 100;

    const label = agentId ? `${actionName} by ${agentId}` : actionName;
    const policies: SuggestedPolicy[] = [];
    if (cap !== null) {
      policies.push({
        name: `Review ${label} at or above ${cap}`.slice(0, 80),
        priority: REQUIRE_PRIORITY, matchKind: "action", matchActionName: actionName, matchAgentId: agentId,
        minAmount: cap, effect: "require_approval",
      });
    }
    policies.push({
      name: `Auto-approve ${label}`.slice(0, 80),
      priority: AUTO_PRIORITY, matchKind: "action", matchActionName: actionName, matchAgentId: agentId,
      minAmount: null, effect: "auto_approve",
    });

    const key = createHash("sha256").update(`${environmentId}|${actionName}|${agentId ?? ""}|${cap ?? ""}`).digest("hex").slice(0, 16);
    suggestions.push({
      key, environmentId, actionName, agentId,
      approved: humanApproved.length, maxAmount, averageRisk,
      policies,
      preview: await preview(group, existing.filter((p) => p.environmentId === environmentId), policies, now),
    });
  }
  return suggestions.sort((a, b) => b.approved - a.approved);
}

async function preview(group: HistoryRow[], existing: ApprovalPolicy[], candidates: SuggestedPolicy[], now: Date) {
  const synthetic: ApprovalPolicy[] = candidates.map((c, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i}`,
    workspaceId: "", environmentId: group[0].environmentId,
    policyId: `suggested_${i}`, name: c.name, priority: c.priority, enabled: true,
    matchKind: c.matchKind, matchActionName: c.matchActionName, matchAgentId: c.matchAgentId, matchUserId: null,
    matchTags: null, minAmount: c.minAmount === null ? null : String(c.minAmount), conditions: null,
    effect: c.effect, requiredApprovals: 1, version: 1, scopeReviewedAt: now, createdAt: now, updatedAt: now,
  } as ApprovalPolicy));
  const ordered = sortPolicies([...existing, ...synthetic]);

  let wouldAutoApprove = 0;
  let wouldStillReview = 0;
  let wouldApproveDenied = 0;
  for (const row of group) {
    const decision = await decideFromPolicies(ordered, {
      kind: "action", actionName: row.actionName, agentId: row.agentId ?? undefined, amount: row.amount ?? undefined,
    });
    const auto = decision.effect === "auto_approve";
    if (auto && row.status === "denied") wouldApproveDenied++;
    if (auto) wouldAutoApprove++;
    else wouldStillReview++;
  }
  return { wouldAutoApprove, wouldStillReview, wouldApproveDenied };
}

export async function acceptPolicySuggestion(workspaceId: string, key: string): Promise<PublicPolicy[]> {
  const suggestion = (await listPolicySuggestions(workspaceId)).find((s) => s.key === key);
  if (!suggestion) throw new NotFoundError("Policy suggestion (it may no longer apply)");
  const created: PublicPolicy[] = [];
  for (const policy of suggestion.policies) {
    const input: CreatePolicyInput = {
      environmentId: suggestion.environmentId,
      name: policy.name,
      priority: policy.priority,
      matchKind: policy.matchKind,
      matchActionName: policy.matchActionName,
      ...(policy.matchAgentId ? { matchAgentId: policy.matchAgentId } : {}),
      ...(policy.minAmount !== null ? { minAmount: policy.minAmount } : {}),
      effect: policy.effect,
    };
    created.push(await createPolicy(workspaceId, input));
  }
  return created;
}
