import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.ts";
import { approvalPolicies, approvalPolicyVersions, type ApprovalPolicy } from "../../db/schema/approvals.ts";
import { actions } from "../../db/schema/actions.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { getPlanLimits } from "../plans/limits.ts";
import { resourcePlan } from "../billing/plan-management.ts";
import { QuotaExceededError } from "../billing/usage-enforcement.ts";
import { getEnvironment } from "../environments/service.ts";
import { ApiError, ConflictError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { createLogger } from "../../lib/logger.ts";
import { writeAuditEvents } from "../audit/outbox.ts";
import { policyVersionRecord } from "../audit/records.ts";
import {
  CONDITION_FACTS, checkCondition, evaluateCondition, evaluateConditions, inputFieldsFromSchema, legacyCondition,
  type ConditionCheck, type ConditionOutcome, type InputField,
} from "./condition.ts";

const logger = createLogger({ module: "approval-policy" });

export function generatePolicyId(): string {
  return `apol_${nanoid(21)}`;
}

export type PolicyEffect = "require_approval" | "auto_approve" | "auto_deny";
export type PolicyMatchKind = "any" | "action" | "custom";

export interface RequestContext {
  kind: "action" | "custom";
  actionName?: string | null;
  agentId?: string | null;
  userId?: string | null;
  tags?: string[];
  amount?: number | null;
  amountCurrency?: string | null;
  payload?: Record<string, unknown>;
}

export interface PolicyDecision {
  matched: boolean;
  effect: PolicyEffect;
  requiredApprovals: number;
  matchedPolicyId: string | null;
  matchedPolicyVersion: number | null;
  matchedPolicyName: string | null;
  matchedActionName: string | null;
  decidedBy?: "team" | "end_user";
  explanation: string;
}

const DEFAULT_DECISION: Omit<PolicyDecision, "explanation"> = {
  matched: false,
  effect: "require_approval",
  requiredApprovals: 1,
  matchedPolicyId: null,
  matchedPolicyVersion: null,
  matchedPolicyName: null,
  matchedActionName: null,
};

function structuralMatch(policy: ApprovalPolicy, ctx: RequestContext): "match" | "no-match" | "indeterminate" {
  if (policy.matchKind !== "any" && policy.matchKind !== ctx.kind) return "no-match";
  if (policy.matchActionName && policy.matchActionName !== ctx.actionName) return "no-match";

  if (policy.matchAgentId && ctx.agentId == null) return "indeterminate";
  if (policy.matchAgentId && policy.matchAgentId !== ctx.agentId) return "no-match";
  if (policy.matchUserId && ctx.userId == null) return "indeterminate";
  if (policy.matchUserId && policy.matchUserId !== ctx.userId) return "no-match";
  if (policy.matchTags && policy.matchTags.length > 0) {
    const have = new Set(ctx.tags ?? []);
    if (!policy.matchTags.every((t: string) => have.has(t))) return "no-match";
  }
  if (policy.conditions) {
    const payload = ctx.payload ?? {};
    for (const [key, want] of Object.entries(policy.conditions)) {
      if (JSON.stringify(payload[key]) !== JSON.stringify(want)) return "no-match";
    }
  }
  if (hasMinAmount(policy)) {
    if (!hasComparableAmount(ctx)) return "indeterminate";
    if ((ctx.amount as number) < Number(policy.minAmount)) return "no-match";
  }
  return "match";
}

function hasMinAmount(policy: ApprovalPolicy): boolean {
  return policy.minAmount !== null && policy.minAmount !== undefined;
}

function hasComparableAmount(ctx: RequestContext): boolean {
  return typeof ctx.amount === "number" && Number.isFinite(ctx.amount);
}

export const POLICY_ORDER = [asc(approvalPolicies.priority), asc(approvalPolicies.createdAt), asc(approvalPolicies.id)] as const;

export async function evaluatePolicies(
  environmentId: string,
  ctx: RequestContext,
): Promise<PolicyDecision> {
  const policies = await db
    .select()
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.environmentId, environmentId), eq(approvalPolicies.enabled, true)))
    .orderBy(...POLICY_ORDER);
  return decideFromPolicies(policies, ctx);
}

export async function previewPolicies(workspaceId: string, environmentId: string, context: RequestContext) {
  await getEnvironment(workspaceId, environmentId);
  if (context.kind === "action") {
    if (!context.actionName) throw new ValidationError("Action context requires actionName.");
    await assertActionExists(workspaceId, environmentId, context.actionName);
  }
  const ctx = {
    ...context,
    amount: typeof context.payload?.amount === "number" ? context.payload.amount : null,
    tags: context.kind === "custom" ? (context.payload?.tags as string[] | undefined) ?? [] : [],
  };
  const decision = await evaluatePolicies(environmentId, ctx);
  return {
    evaluation: "policy_only" as const,
    environmentId,
    decision,
    limitations: "Policy matching only. Does not resolve action versions, apply the action approval floor, validate input schemas, check runtime authority, budgets or halt state, or dispatch. An unmatched ungated action can execute even though the policy default is require_approval.",
  };
}

export async function decideFromPolicies(policies: ApprovalPolicy[], ctx: RequestContext): Promise<PolicyDecision> {
  const conditioned: ApprovalPolicy[] = [];
  let terminal: { policy: ApprovalPolicy; result: "match" | "indeterminate" } | null = null;
  for (const policy of policies) {
    const result = structuralMatch(policy, ctx);
    if (result === "no-match") continue;
    if (result === "match" && policy.condition) {
      conditioned.push(policy);
      continue;
    }
    terminal = { policy, result };
    break;
  }

  if (conditioned.length) {
    const outcome = await evaluateConditions(
      conditioned.map((policy) => ({ source: policy.condition as string, environmentId: policy.environmentId })),
      {
        input: ctx.payload ?? {},
        agent: { id: ctx.agentId ?? null },
        user: { id: ctx.userId ?? null },
        tags: ctx.tags ?? [],
        action: { name: ctx.kind === "action" ? ctx.actionName ?? null : null },
        kind: ctx.kind,
      },
    );
    if (outcome.index !== -1) {
      const policy = conditioned[outcome.index];
      if ("error" in outcome) {
        return {
          matched: true,
          effect: "require_approval",
          requiredApprovals: policy.requiredApprovals,
          matchedPolicyId: policy.policyId,
          matchedPolicyVersion: policy.version,
          matchedPolicyName: policy.name,
          matchedActionName: policy.matchActionName ?? null,
          decidedBy: policy.decidedBy,
          explanation:
            `Policy "${policy.name}" (${policy.policyId} v${policy.version}) has a condition that could not be ` +
            `evaluated for this request (${outcome.error}). Required approval rather than skip it. ` +
            `If a field can be absent, guard it with has(), for example has(input.amount) && input.amount >= 500.`,
        };
      }
      return matchedDecision(policy, ctx);
    }
  }

  if (terminal?.result === "indeterminate") {
    const { policy } = terminal;
    const unattributed = (policy.matchAgentId && ctx.agentId == null) || (policy.matchUserId && ctx.userId == null);
    const missingAmount = !unattributed && hasMinAmount(policy) && !hasComparableAmount(ctx);
    return {
      matched: true,
      effect: "require_approval",
      requiredApprovals: policy.requiredApprovals,
      matchedPolicyId: policy.policyId,
      matchedPolicyVersion: policy.version,
      matchedPolicyName: policy.name,
      matchedActionName: policy.matchActionName ?? null,
      decidedBy: policy.decidedBy,
      explanation: missingAmount
        ? `Policy "${policy.name}" (${policy.policyId} v${policy.version}) applies from a minimum amount, and this ` +
          `request carried no numeric amount (it was missing, null or not a number). Required approval rather than ` +
          `assume it is under the minimum; send input.amount as a number to have it evaluated.`
        : `Policy "${policy.name}" (${policy.policyId} v${policy.version}) is scoped to a specific ` +
          `agent or user, and this request named none. Required approval rather than assume it does not apply; ` +
          `start a run with the agent and user this call is made for to have it evaluated.`,
    };
  }
  if (terminal) return matchedDecision(terminal.policy, ctx);

  return {
    ...DEFAULT_DECISION,
    explanation: "No policy matched; applied the default (require one approval).",
  };
}

export function withDefaultDecider(
  decision: PolicyDecision,
  endUserId: string | null | undefined,
  defaultDecider: "team" | "end_user",
): PolicyDecision {
  if (decision.matched || !endUserId || defaultDecider !== "end_user") return decision;
  return {
    ...decision,
    decidedBy: "end_user",
    explanation: `${decision.explanation} The workspace default sends a call made for a user, with no policy that says who decides, to that user.`,
  };
}

function amountCompared(policy: ApprovalPolicy, ctx: RequestContext): string {
  if (policy.minAmount === null || policy.minAmount === undefined) return "";
  const unit = ctx.amountCurrency
    ? `${ctx.amountCurrency.toUpperCase()} minor units (the adapter's money quantity)`
    : "(input.amount as sent, in the action's own unit)";
  return ` Compared the policy's minimum amount with ${ctx.amount} ${unit}.`;
}

function matchedDecision(policy: ApprovalPolicy, ctx: RequestContext): PolicyDecision {
  return {
    matched: true,
    effect: policy.effect,
    requiredApprovals: policy.requiredApprovals,
    matchedPolicyId: policy.policyId,
    matchedPolicyVersion: policy.version,
    matchedPolicyName: policy.name,
    matchedActionName: policy.matchActionName ?? null,
    decidedBy: policy.decidedBy,
    explanation: `Matched policy "${policy.name}" (${policy.policyId} v${policy.version}, priority ${policy.priority}): effect=${policy.effect}, requiredApprovals=${policy.requiredApprovals}.${amountCompared(policy, ctx)}`,
  };
}

export function sortPolicies(policies: ApprovalPolicy[]): ApprovalPolicy[] {
  return [...policies].sort((a, b) =>
    a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type PolicyScope = "specific_action" | "all_actions" | "custom_requests" | "all_requests";

export function policyScope(kind: PolicyMatchKind, actionName: string | null | undefined): PolicyScope {
  if (kind === "custom") return "custom_requests";
  if (kind === "any") return "all_requests";
  return actionName ? "specific_action" : "all_actions";
}

export function isBroad(scope: PolicyScope): boolean {
  return scope === "all_actions" || scope === "all_requests";
}

export type PublicPolicy = {
  id: string;
  environmentId: string;
  name: string;
  priority: number;
  enabled: boolean;
  scope: PolicyScope;
  needsScopeReview: boolean;
  match: {
    kind: PolicyMatchKind;
    actionName: string | null;
    agentId: string | null;
    userId: string | null;
    tags: string[] | null;
    minAmount: number | null;
    conditions: Record<string, unknown> | null;
    condition: string | null;
  };
  effect: PolicyEffect;
  requiredApprovals: number;
  decidedBy: "team" | "end_user";
  version: number;
  scopeReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  managedBy: { file: string; key: string } | null;
};

export function toPublicPolicy(p: ApprovalPolicy): PublicPolicy {
  const scope = policyScope(p.matchKind, p.matchActionName);
  return {
    id: p.policyId,
    environmentId: p.environmentId,
    name: p.name,
    priority: p.priority,
    enabled: p.enabled,
    scope,
    needsScopeReview: isBroad(scope) && p.scopeReviewedAt === null,
    match: {
      kind: p.matchKind,
      actionName: p.matchActionName,
      agentId: p.matchAgentId,
      userId: p.matchUserId,
      tags: p.matchTags ?? null,
      minAmount: p.minAmount === null ? null : Number(p.minAmount),
      conditions: p.conditions ?? null,
      condition: p.condition ?? null,
    },
    effect: p.effect,
    requiredApprovals: p.requiredApprovals,
    decidedBy: p.decidedBy === "end_user" ? "end_user" : "team",
    version: p.version,
    scopeReviewedAt: p.scopeReviewedAt ? p.scopeReviewedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    managedBy: p.managedByFile && p.managedKey ? { file: p.managedByFile, key: p.managedKey } : null,
  };
}

export interface CreatePolicyInput {
  changeNote?: string;
  environmentId: string;
  name: string;
  priority?: number;
  enabled?: boolean;
  matchKind: PolicyMatchKind;
  matchActionName?: string;
  matchAgentId?: string;
  matchUserId?: string;
  matchTags?: string[];
  minAmount?: number;
  conditions?: Record<string, unknown>;
  condition?: string;
  effect?: PolicyEffect;
  requiredApprovals?: number;
  decidedBy?: "team" | "end_user";
  acknowledgeBroadScope?: boolean;
}

export type UpdatePolicyInput = {
  changeNote?: string;
  name?: string;
  priority?: number;
  enabled?: boolean;
  matchKind?: PolicyMatchKind;
  matchActionName?: string | null;
  matchAgentId?: string | null;
  matchUserId?: string | null;
  matchTags?: string[] | null;
  minAmount?: number | null;
  conditions?: Record<string, unknown> | null;
  condition?: string | null;
  effect?: PolicyEffect;
  requiredApprovals?: number;
  decidedBy?: "team" | "end_user";
  acknowledgeBroadScope?: boolean;
};

export interface PolicyScopeContext {
  environmentId?: string;
  actor?: { type: "api_key" | "user"; id: string };
}

type PolicyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function assertPolicyAllowance(tx: PolicyTransaction, workspaceId: string, environmentId: string): Promise<void> {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new NotFoundError("Workspace");
  const limit = getPlanLimits(resourcePlan(workspace), workspace).maxApprovalPoliciesPerEnvironment;
  if (limit === "unlimited") return;
  const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(approvalPolicies)
    .where(eq(approvalPolicies.environmentId, environmentId));
  if (total >= limit) {
    throw new QuotaExceededError(
      `This plan allows ${limit} approval policies per environment, and this environment has ${total}. ` +
        "Delete or combine policies, or upgrade for more.",
      0,
    );
  }
}

export async function policyWrite<T>(
  workspaceId: string,
  scope: PolicyScopeContext,
  note: string | undefined,
  write: (tx: PolicyTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('anlyon.policy_actor', ${JSON.stringify({ ...scope.actor, note: note ?? null })}, true)`);
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const result = await write(tx);
    const versions = await tx.select().from(approvalPolicyVersions).where(and(
      eq(approvalPolicyVersions.workspaceId, workspaceId),
      sql`${approvalPolicyVersions.createdAt} = now()`,
    ));
    const records = versions.map((version) => policyVersionRecord(version)).filter((record) => record !== null);
    await writeAuditEvents(tx, records);
    return result;
  });
}

export type { PolicyTransaction };

function assertNotFileManaged(policy: ApprovalPolicy): void {
  if (policy.managedByFile) {
    throw new ApiError(409, "POLICY_MANAGED_BY_FILE",
      `Policy "${policy.name}" is managed by policy file "${policy.managedByFile}". Change it in that file and apply, or remove it from the file.`);
  }
}

export const POLICY_VERSIONS_DEFAULT_LIMIT = 50;
export const POLICY_VERSIONS_MAX_LIMIT = 100;

type PolicyVersionRow = typeof approvalPolicyVersions.$inferSelect;
function toPolicyVersion(row: PolicyVersionRow) {
  return {
    policyId: row.policyId, version: row.version, operation: row.operation,
    snapshot: row.snapshot, contentHash: row.contentHash,
    actor: row.actorId ? { type: row.actorType, id: row.actorId } : null,
    changeNote: row.changeNote, createdAt: row.createdAt.toISOString(),
  };
}
export type PolicyVersionView = ReturnType<typeof toPolicyVersion>;

function versionScope(workspaceId: string, policyId: string, scope: PolicyScopeContext) {
  return [
    eq(approvalPolicyVersions.workspaceId, workspaceId),
    eq(approvalPolicyVersions.policyId, policyId),
    ...(scope.environmentId ? [eq(approvalPolicyVersions.environmentId, scope.environmentId)] : []),
  ];
}

export interface PolicyVersionPage {
  versions: PolicyVersionView[];
  nextBefore: number | null;
  earliestVersion: number;
  latestVersion: number;
}

export async function listPolicyVersions(
  workspaceId: string,
  policyId: string,
  scope: PolicyScopeContext = {},
  page: { limit?: number; before?: number } = {},
): Promise<PolicyVersionPage> {
  const where = versionScope(workspaceId, policyId, scope);
  const [bounds] = await db
    .select({
      earliest: sql<number | null>`min(${approvalPolicyVersions.version})`,
      latest: sql<number | null>`max(${approvalPolicyVersions.version})`,
    })
    .from(approvalPolicyVersions)
    .where(and(...where));
  if (bounds?.earliest == null || bounds.latest == null) throw new NotFoundError("Approval policy history");
  const limit = Math.min(Math.max(page.limit ?? POLICY_VERSIONS_DEFAULT_LIMIT, 1), POLICY_VERSIONS_MAX_LIMIT);
  const rows = await db.select().from(approvalPolicyVersions)
    .where(and(...where, ...(page.before !== undefined ? [lt(approvalPolicyVersions.version, page.before)] : [])))
    .orderBy(desc(approvalPolicyVersions.version))
    .limit(limit + 1);
  const versions = rows.slice(0, limit).map(toPolicyVersion);
  return {
    versions,
    nextBefore: rows.length > limit ? versions[versions.length - 1].version : null,
    earliestVersion: Number(bounds.earliest),
    latestVersion: Number(bounds.latest),
  };
}

export async function getPolicyVersion(
  workspaceId: string,
  policyId: string,
  version: number,
  scope: PolicyScopeContext = {},
): Promise<PolicyVersionView> {
  const [row] = await db.select().from(approvalPolicyVersions)
    .where(and(...versionScope(workspaceId, policyId, scope), eq(approvalPolicyVersions.version, version)))
    .limit(1);
  if (!row) throw new NotFoundError("Approval policy version");
  return toPolicyVersion(row);
}

async function assertActionExists(workspaceId: string, environmentId: string, name: string): Promise<void> {
  const [row] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.environmentId, environmentId),
        eq(actions.name, name),
        isNull(actions.archivedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ValidationError(
      `No action named "${name}" exists in this environment. A policy can only target an action in its own environment.`,
    );
  }
}

async function assertValidCondition(
  workspaceId: string,
  environmentId: string,
  condition: string,
  target: { kind: PolicyMatchKind; actionName: string | null },
): Promise<void> {
  const check = checkCondition(condition, { inputSchema: await targetInputSchema(workspaceId, environmentId, target) });
  if (!check.valid) throw new ValidationError(`Invalid condition: ${check.message}`);
}

export async function targetInputSchema(
  workspaceId: string,
  environmentId: string,
  target: { kind: PolicyMatchKind; actionName: string | null },
): Promise<unknown> {
  if (target.kind !== "action" || !target.actionName) return undefined;
  const [action] = await db
    .select({ inputSchema: actions.inputSchema })
    .from(actions)
    .where(and(
      eq(actions.workspaceId, workspaceId),
      eq(actions.environmentId, environmentId),
      eq(actions.name, target.actionName),
      isNull(actions.archivedAt),
    ))
    .limit(1);
  return action?.inputSchema;
}

export interface ConditionAssistInput {
  environmentId: string;
  matchKind: PolicyMatchKind;
  matchActionName?: string | null;
  condition?: string | null;
  sampleInput?: Record<string, unknown>;
  agentId?: string | null;
  userId?: string | null;
  tags?: string[];
  policyId?: string;
}

export interface ConditionAssist {
  check: ConditionCheck | null;
  sample: ConditionOutcome | null;
  inputFields: InputField[];
  facts: typeof CONDITION_FACTS;
  legacyCondition: string | null;
}

export async function assistCondition(workspaceId: string, input: ConditionAssistInput): Promise<ConditionAssist> {
  await getEnvironment(workspaceId, input.environmentId);
  const target = { kind: input.matchKind, actionName: input.matchActionName ?? null };
  const inputSchema = await targetInputSchema(workspaceId, input.environmentId, target);
  const check = input.condition ? checkCondition(input.condition, { inputSchema }) : null;
  const sample = input.condition && input.sampleInput && check?.valid
    ? await evaluateCondition(input.condition, {
      input: input.sampleInput,
      agent: { id: input.agentId ?? null },
      user: { id: input.userId ?? null },
      tags: input.matchKind === "custom" ? input.tags ?? [] : [],
      action: { name: input.matchKind === "action" ? input.matchActionName ?? null : null },
      kind: input.matchKind === "custom" ? "custom" : "action",
      environment: { id: input.environmentId },
    })
    : null;
  const existing = input.policyId
    ? await requirePolicy(workspaceId, input.policyId, { environmentId: input.environmentId })
    : null;
  return {
    check,
    sample,
    inputFields: conditionInputFields(inputSchema),
    facts: CONDITION_FACTS,
    legacyCondition: existing ? legacyCondition(existing) : null,
  };
}

export function conditionInputFields(schema: unknown): InputField[] {
  try { return inputFieldsFromSchema(schema); }
  catch { throw new ValidationError("The action schema is too large or deeply nested for condition assistance."); }
}

async function validateTargeting(
  workspaceId: string,
  environmentId: string,
  target: { kind: PolicyMatchKind; actionName: string | null; effect: PolicyEffect },
  acknowledgeBroadScope: boolean | undefined,
  checkBroad: boolean,
): Promise<void> {
  const { kind, actionName } = target;
  if (actionName !== null) {
    if (actionName.trim() === "") throw new ValidationError("matchActionName must not be empty. Send null to clear it.");
    if (kind !== "action") {
      throw new ValidationError(
        `matchActionName only applies when matchKind is "action" (this policy is "${kind}"). Clear matchActionName or change matchKind.`,
      );
    }
    await assertActionExists(workspaceId, environmentId, actionName);
  }
  if (checkBroad && target.effect === "auto_deny" && isBroad(policyScope(kind, actionName)) && !acknowledgeBroadScope) {
    throw new ValidationError(
      "This auto_deny applies to every " +
        (kind === "any" ? "request" : "action") +
        " in the environment. Name an action with matchActionName, or set acknowledgeBroadScope to true to confirm that is intended.",
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

export async function createPolicy(workspaceId: string, input: CreatePolicyInput, scope: PolicyScopeContext = {}): Promise<PublicPolicy> {
  const env = await getEnvironment(workspaceId, input.environmentId);
  if (input.requiredApprovals !== undefined && input.requiredApprovals < 1) {
    throw new ValidationError("requiredApprovals must be at least 1.");
  }
  if (!input.matchKind) {
    throw new ValidationError('matchKind is required: "action", "custom" or "any". Say what this policy applies to.');
  }
  const effect = input.effect ?? "require_approval";
  await validateTargeting(
    workspaceId,
    env.id,
    { kind: input.matchKind, actionName: input.matchActionName ?? null, effect },
    input.acknowledgeBroadScope,
    true,
  );

  if (input.condition) {
    await assertValidCondition(workspaceId, env.id, input.condition, { kind: input.matchKind, actionName: input.matchActionName ?? null });
  }

  const duplicate = await db
    .select({ id: approvalPolicies.id })
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.environmentId, env.id), eq(approvalPolicies.name, input.name)))
    .limit(1);
  if (duplicate[0]) throw new ConflictError(`A policy named "${input.name}" already exists in this environment.`);

  let row: ApprovalPolicy;
  try {
    [row] = await policyWrite(workspaceId, scope, input.changeNote, async (tx) => {
      await assertPolicyAllowance(tx, workspaceId, env.id);
      return tx
      .insert(approvalPolicies)
      .values({
        workspaceId,
        environmentId: env.id,
        policyId: generatePolicyId(),
        name: input.name,
        priority: input.priority ?? 100,
        enabled: input.enabled ?? true,
        matchKind: input.matchKind,
        matchActionName: input.matchActionName ?? null,
        matchAgentId: input.matchAgentId ?? null,
        matchUserId: input.matchUserId ?? null,
        matchTags: input.matchTags ?? null,
        minAmount: input.minAmount === undefined ? null : String(input.minAmount),
        conditions: input.conditions ?? null,
        condition: input.condition ?? null,
        effect,
        requiredApprovals: input.requiredApprovals ?? 1,
        decidedBy: input.decidedBy ?? "team",
        scopeReviewedAt: sql`clock_timestamp()`,
      })
      .returning();
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`A policy named "${input.name}" already exists in this environment.`);
    throw error;
  }
  logger.info(
    { workspaceId, policyId: row.policyId, environmentId: env.id, scope: policyScope(row.matchKind, row.matchActionName) },
    "Approval policy created",
  );
  return toPublicPolicy(row);
}

export async function listPolicies(
  workspaceId: string,
  environmentId?: string,
  filter: { actionName?: string } = {},
): Promise<PublicPolicy[]> {
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(
      environmentId
        ? and(eq(approvalPolicies.workspaceId, workspaceId), eq(approvalPolicies.environmentId, environmentId))
        : eq(approvalPolicies.workspaceId, workspaceId),
    )
    .orderBy(...POLICY_ORDER);
  const policies = rows.map(toPublicPolicy);
  if (!filter.actionName) return policies;
  return policies.filter(
    (p) =>
      p.match.kind === "any" ||
      (p.match.kind === "action" && (p.match.actionName === null || p.match.actionName === filter.actionName)),
  );
}

async function requirePolicy(
  workspaceId: string,
  policyPublicId: string,
  scope: PolicyScopeContext = {},
): Promise<ApprovalPolicy> {
  const [row] = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.workspaceId, workspaceId),
        eq(approvalPolicies.policyId, policyPublicId),
        ...(scope.environmentId ? [eq(approvalPolicies.environmentId, scope.environmentId)] : []),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Approval policy not found");
  return row;
}

export async function getPolicy(
  workspaceId: string,
  policyPublicId: string,
  scope: PolicyScopeContext = {},
): Promise<PublicPolicy> {
  return toPublicPolicy(await requirePolicy(workspaceId, policyPublicId, scope));
}

export async function updatePolicy(
  workspaceId: string,
  policyPublicId: string,
  input: UpdatePolicyInput,
  scope: PolicyScopeContext = {},
): Promise<PublicPolicy> {
  const policy = await requirePolicy(workspaceId, policyPublicId, scope);
  assertNotFileManaged(policy);
  if (input.requiredApprovals !== undefined && input.requiredApprovals < 1) {
    throw new ValidationError("requiredApprovals must be at least 1.");
  }
  const has = (key: keyof UpdatePolicyInput) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  const nextKind = input.matchKind ?? policy.matchKind;
  const nextActionName = has("matchActionName") ? (input.matchActionName as string | null) : policy.matchActionName;
  const nextEffect = input.effect ?? policy.effect;
  const targetingChanged = has("matchKind") || has("matchActionName");
  await validateTargeting(
    workspaceId,
    policy.environmentId,
    { kind: nextKind, actionName: nextActionName, effect: nextEffect },
    input.acknowledgeBroadScope,
    targetingChanged || has("effect"),
  );

  const patch: Partial<typeof approvalPolicies.$inferInsert> = {
    version: policy.version + 1,
    updatedAt: sql`clock_timestamp()` as unknown as Date,
  };
  if (has("name")) patch.name = input.name;
  if (has("priority")) patch.priority = input.priority;
  if (has("enabled")) patch.enabled = input.enabled;
  if (has("matchKind")) patch.matchKind = input.matchKind;
  if (has("matchActionName")) patch.matchActionName = input.matchActionName as string | null;
  if (has("matchAgentId")) patch.matchAgentId = input.matchAgentId as string | null;
  if (has("matchUserId")) patch.matchUserId = input.matchUserId as string | null;
  if (has("matchTags")) patch.matchTags = input.matchTags as string[] | null;
  if (has("minAmount")) patch.minAmount = input.minAmount === null ? null : String(input.minAmount);
  if (has("conditions")) patch.conditions = input.conditions as Record<string, unknown> | null;
  if (has("condition")) patch.condition = input.condition as string | null;
  const nextCondition = has("condition") ? (input.condition as string | null) : policy.condition;
  if (nextCondition && (has("condition") || targetingChanged)) {
    await assertValidCondition(workspaceId, policy.environmentId, nextCondition, { kind: nextKind, actionName: nextActionName });
  }
  if (has("effect")) patch.effect = input.effect;
  if (has("requiredApprovals")) patch.requiredApprovals = input.requiredApprovals;
  if (has("decidedBy")) patch.decidedBy = input.decidedBy;
  if (targetingChanged) patch.scopeReviewedAt = sql`clock_timestamp()` as unknown as Date;

  try {
    const [row] = await policyWrite(workspaceId, scope, input.changeNote, (tx) => tx.update(approvalPolicies).set(patch)
      .where(and(eq(approvalPolicies.id, policy.id), eq(approvalPolicies.version, policy.version))).returning());
    if (!row) throw new ConflictError("Policy changed while it was being edited. Read it again and retry.");
    return toPublicPolicy(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`A policy named "${input.name}" already exists in this environment.`);
    throw error;
  }
}

export async function deletePolicy(
  workspaceId: string,
  policyPublicId: string,
  scope: PolicyScopeContext = {},
): Promise<void> {
  const policy = await requirePolicy(workspaceId, policyPublicId, scope);
  assertNotFileManaged(policy);
  const rows = await policyWrite(workspaceId, scope, "Policy deleted", (tx) => tx.delete(approvalPolicies)
    .where(and(eq(approvalPolicies.id, policy.id), eq(approvalPolicies.version, policy.version))).returning({ id: approvalPolicies.id }));
  if (!rows.length) throw new ConflictError("Policy changed while it was being deleted. Read it again and retry.");
}
