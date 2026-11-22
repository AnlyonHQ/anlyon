import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { approvalPolicies } from "../../db/schema/approvals.ts";
import { recordAuditEvent } from "../audit/recorder.ts";
import type { AuditActor } from "../audit/event-schema.ts";
import type { AdoptChoice } from "../mcp-upstreams/service.ts";
import {
  type ActionInput,
  type BudgetPatch,
  type Classification,
  classification,
  classifyActionCreate,
  classifyActionImport,
  classifyActionUpdate,
  classifyBudgetDelete,
  classifyBudgetPut,
  classifyImpactLimitArchive,
  classifyImpactLimitUpdate,
  classifyMcpToolAdopt,
  classifyMcpUpstreamRefresh,
  classifyMcpUpstreamRegister,
  classifyOAuthAppPut,
  classifyPolicyCreate,
  classifyPolicyDelete,
  classifyPolicyFile,
  classifyPolicyUpdate,
  classifyResume,
  classifySecretPut,
  classifySecretStoreCreate,
  classifySecretStoreSettings,
  classifySecretStoreUpdate,
  type GovernanceOperation,
  type ImpactLimitPatch,
  type McpUpstreamRegisterInput,
  type PolicyCreateInput,
  type PolicyFileChange,
  type PolicyState,
  type PolicyUpdateInput,
  type SecretPutInput,
} from "./classify.ts";

export interface GovernanceScope {
  workspaceId: string;
  environmentId: string;
}

export interface ResourceRef {
  type: string;
  id: string;
  name?: string | null;
}

export interface Prepared {
  classification: Classification;
  summary: string;
  resource: ResourceRef | null;
  baseDigest: string;
  passThrough?: boolean;
  toolHashes?: Record<string, string>;
}

export interface ApplyContext {
  signOffId: string;
  approverUserId: string;
  requesterScopes: string[] | null;
  requestedBy: AuditActor;
  prepared?: Prepared;
}

export interface OperationDefinition {
  prepare(scope: GovernanceScope, target: Record<string, string>, input: Record<string, unknown>): Promise<Prepared>;
  apply(scope: GovernanceScope, target: Record<string, string>, input: Record<string, unknown>, context: ApplyContext): Promise<unknown>;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function audit(scope: GovernanceScope, context: ApplyContext, type: string, resource: ResourceRef, data: Record<string, unknown>): void {
  recordAuditEvent({
    workspaceId: scope.workspaceId, environmentId: scope.environmentId, type,
    actor: { type: "user", id: context.approverUserId },
    resource: { type: resource.type, id: resource.id },
    data: { ...data, signOffId: context.signOffId, requestedBy: context.requestedBy },
  });
}

const approver = (context: ApplyContext) => ({ type: "user" as const, id: context.approverUserId });
const authority = (context: ApplyContext) => ({ scopes: context.requesterScopes });

function firstLoosening(c: Classification): string {
  return c.changes.find((x) => x.direction === "loosening")?.reason ?? "Loosens a guardrail.";
}

async function limitState(scope: GovernanceScope, id: string) {
  const { getLimit } = await import("../effects/impact.ts");
  const view = await getLimit(scope.workspaceId, scope.environmentId, id);
  return { view, state: { name: view.name, amount: view.limit, archived: view.archived } };
}

const impactLimitUpdate: OperationDefinition = {
  async prepare(scope, target, input) {
    const { view, state } = await limitState(scope, target.id);
    const c = classifyImpactLimitUpdate(state, input as ImpactLimitPatch);
    const amount = (input as ImpactLimitPatch).amount;
    const summary = amount !== undefined && amount > state.amount
      ? `Raise impact limit "${view.name}" from ${state.amount} to ${amount} ${view.unit}`
      : `Change impact limit "${view.name}"`;
    return { classification: c, summary, resource: { type: "impact_limit", id: view.id, name: view.name }, baseDigest: digestOf([state, view.updatedAt]) };
  },
  async apply(scope, target, input, context) {
    const { updateLimit } = await import("../effects/impact.ts");
    const limit = await updateLimit(scope.workspaceId, scope.environmentId, target.id, input as ImpactLimitPatch);
    audit(scope, context, "impact_limit.updated", { type: "impact_limit", id: limit.id }, { limitId: limit.id, name: limit.name, limit: limit.limit });
    return limit;
  },
};

const impactLimitArchive: OperationDefinition = {
  async prepare(scope, target) {
    const { view, state } = await limitState(scope, target.id);
    return {
      classification: classifyImpactLimitArchive(state),
      summary: `Archive impact limit "${view.name}" (${state.amount} ${view.unit} per ${view.period})`,
      resource: { type: "impact_limit", id: view.id, name: view.name },
      baseDigest: digestOf([state, view.updatedAt]),
    };
  },
  async apply(scope, target, _input, context) {
    const { archiveLimit } = await import("../effects/impact.ts");
    const limit = await archiveLimit(scope.workspaceId, scope.environmentId, target.id);
    audit(scope, context, "impact_limit.archived", { type: "impact_limit", id: limit.id }, { limitId: limit.id, name: limit.name, limit: limit.limit });
    return limit;
  },
};

async function budgetState(scope: GovernanceScope, apiKeyId: string) {
  const { budgetKeyEnvironment, getBudgetConfig } = await import("../billing/budgets.ts");
  const environmentId = await budgetKeyEnvironment(scope.workspaceId, apiKeyId);
  if (environmentId !== scope.environmentId) return { missing: true as const };
  const config = await getBudgetConfig(apiKeyId);
  return {
    missing: false as const,
    state: config ? { monthlyCostCentsCap: config.monthlyCostCentsCap, dimensionCaps: config.dimensionCaps as Record<string, number>, alertThreshold: config.alertThreshold, enabled: config.enabled } : null,
  };
}

const budgetPut: OperationDefinition = {
  async prepare(scope, target, input) {
    const read = await budgetState(scope, target.apiKeyId);
    if (read.missing) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    const c = classifyBudgetPut(read.state, input as BudgetPatch);
    return { classification: c, summary: `Change the budget of key ${target.apiKeyId}: ${firstLoosening(c)}`, resource: { type: "budget", id: target.apiKeyId }, baseDigest: digestOf(read.state) };
  },
  async apply(scope, target, input, context) {
    const { putBudget } = await import("../billing/budgets.ts");
    const budget = await putBudget(scope.workspaceId, target.apiKeyId, input as BudgetPatch, scope.environmentId);
    audit(scope, context, "budget.updated", { type: "budget", id: target.apiKeyId }, { apiKeyId: target.apiKeyId, ...input });
    return budget;
  },
};

const budgetDelete: OperationDefinition = {
  async prepare(scope, target) {
    const read = await budgetState(scope, target.apiKeyId);
    if (read.missing) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    return { classification: classifyBudgetDelete(read.state), summary: `Remove the budget of key ${target.apiKeyId}`, resource: { type: "budget", id: target.apiKeyId }, baseDigest: digestOf(read.state) };
  },
  async apply(scope, target, _input, context) {
    const { deleteBudget } = await import("../billing/budgets.ts");
    await deleteBudget(scope.workspaceId, target.apiKeyId, scope.environmentId);
    audit(scope, context, "budget.removed", { type: "budget", id: target.apiKeyId }, { apiKeyId: target.apiKeyId });
    return { deleted: true };
  },
};

const environmentResume: OperationDefinition = {
  async prepare(scope) {
    const { getEnvironment } = await import("../environments/service.ts");
    const environment = await getEnvironment(scope.workspaceId, scope.environmentId);
    const halted = Boolean(environment.haltedAt);
    return {
      classification: classifyResume({ halted }),
      summary: `Resume the halted environment "${environment.name}"`,
      resource: { type: "environment", id: environment.id, name: environment.name },
      baseDigest: digestOf([halted, environment.haltedAt]),
    };
  },
  async apply(scope, _target, _input, context) {
    const { resumeEnvironment } = await import("../environments/halt.ts");
    const { toPublicEnvironment } = await import("../environments/service.ts");
    const environment = await resumeEnvironment(scope.workspaceId, scope.environmentId, { actor: context.approverUserId, context: {} });
    return toPublicEnvironment(environment);
  },
};

async function policyStates(scope: GovernanceScope): Promise<PolicyState[]> {
  const rows = await db.select().from(approvalPolicies)
    .where(and(eq(approvalPolicies.workspaceId, scope.workspaceId), eq(approvalPolicies.environmentId, scope.environmentId)));
  return rows.map((p) => ({
    policyId: p.policyId, name: p.name, priority: p.priority, enabled: p.enabled, createdAt: p.createdAt.getTime(),
    effect: p.effect, requiredApprovals: p.requiredApprovals, decidedBy: p.decidedBy,
    matchKind: p.matchKind, matchActionName: p.matchActionName, matchAgentId: p.matchAgentId, matchUserId: p.matchUserId,
    matchTags: p.matchTags ?? null, minAmount: p.minAmount === null ? null : Number(p.minAmount),
    conditions: p.conditions ?? null, condition: p.condition,
  }));
}

async function policiesDigest(scope: GovernanceScope, states?: PolicyState[]): Promise<string> {
  const rows = await db.select({ id: approvalPolicies.policyId, version: approvalPolicies.version })
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.workspaceId, scope.workspaceId), eq(approvalPolicies.environmentId, scope.environmentId)));
  return digestOf([rows.map((r) => [r.id, r.version]).sort(), states?.length ?? null]);
}

const policyCreate: OperationDefinition = {
  async prepare(scope, _target, input) {
    const states = await policyStates(scope);
    const body = input as unknown as PolicyCreateInput;
    return {
      classification: classifyPolicyCreate(body, states),
      summary: `Add approval policy "${body.name}" (${body.effect ?? "require_approval"})`,
      resource: { type: "approval_policy", id: "(new)", name: body.name },
      baseDigest: await policiesDigest(scope, states),
    };
  },
  async apply(scope, _target, input, context) {
    const { createPolicy } = await import("../approvals/policy.ts");
    return createPolicy(scope.workspaceId, { ...(input as unknown as PolicyCreateInput), environmentId: scope.environmentId } as never, { actor: approver(context) });
  },
};

function policyBefore(states: PolicyState[], policyId: string): PolicyState | undefined {
  return states.find((p) => p.policyId === policyId);
}

const policyUpdate: OperationDefinition = {
  async prepare(scope, target, input) {
    const states = await policyStates(scope);
    const before = policyBefore(states, target.policyId);
    if (!before) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    return {
      classification: classifyPolicyUpdate(before, input as PolicyUpdateInput, states),
      summary: `Change approval policy "${before.name}"`,
      resource: { type: "approval_policy", id: before.policyId, name: before.name },
      baseDigest: await policiesDigest(scope, states),
    };
  },
  async apply(scope, target, input, context) {
    const { updatePolicy } = await import("../approvals/policy.ts");
    return updatePolicy(scope.workspaceId, target.policyId, input as never, { environmentId: scope.environmentId, actor: approver(context) });
  },
};

const policyDelete: OperationDefinition = {
  async prepare(scope, target) {
    const states = await policyStates(scope);
    const before = policyBefore(states, target.policyId);
    if (!before) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    return {
      classification: classifyPolicyDelete(before),
      summary: `Delete approval policy "${before.name}" (${before.effect})`,
      resource: { type: "approval_policy", id: before.policyId, name: before.name },
      baseDigest: await policiesDigest(scope, states),
    };
  },
  async apply(scope, target, _input, context) {
    const { deletePolicy } = await import("../approvals/policy.ts");
    await deletePolicy(scope.workspaceId, target.policyId, { environmentId: scope.environmentId, actor: approver(context) });
    return { deleted: true };
  },
};

const undef = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

const policyFileApply: OperationDefinition = {
  async prepare(scope, _target, input) {
    const { planPolicyFile } = await import("../approvals/policy-files.ts");
    const source = String(input.source);
    const plan = await planPolicyFile(scope.workspaceId, scope.environmentId, source);
    if (plan.digest !== input.digest || plan.errors.length) {
      return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    }
    const states = await policyStates(scope);
    const changes: PolicyFileChange[] = plan.changes.map((change) => {
      if (change.op === "create") {
        const a = change.after;
        return { op: "create", name: change.name, after: {
          name: a.name, priority: a.priority, enabled: a.enabled, matchKind: a.matchKind, effect: a.effect, requiredApprovals: a.requiredApprovals,
          matchActionName: undef(a.matchActionName), matchAgentId: undef(a.matchAgentId), matchUserId: undef(a.matchUserId),
          matchTags: undef(a.matchTags), condition: undef(a.condition),
        } };
      }
      if (change.op === "update") {
        const a = change.after;
        return { op: "update", name: change.name, policyId: change.policyId, after: {
          name: a.name, priority: a.priority, enabled: a.enabled, matchKind: a.matchKind, effect: a.effect, requiredApprovals: a.requiredApprovals,
          matchActionName: a.matchActionName, matchAgentId: a.matchAgentId, matchUserId: a.matchUserId, matchTags: a.matchTags, condition: a.condition,
          minAmount: null, conditions: null,
        } };
      }
      if (change.op === "delete") return { op: "delete", name: change.name, policyId: change.policyId };
      return { op: "unchanged", name: change.name };
    });
    const { summary } = plan;
    return {
      classification: classifyPolicyFile(changes, states),
      summary: `Apply policy file "${plan.file}": ${summary.create} to create, ${summary.update} to change, ${summary.delete} to delete`,
      resource: { type: "policy_file", id: plan.file, name: plan.file },
      baseDigest: plan.digest,
    };
  },
  async apply(scope, _target, input, context) {
    const { applyPolicyFile } = await import("../approvals/policy-files.ts");
    return applyPolicyFile(scope.workspaceId, scope.environmentId, String(input.source), String(input.digest), {
      environmentId: scope.environmentId, actor: approver(context),
    }, typeof input.changeNote === "string" ? input.changeNote : `Signed off (${context.signOffId})`);
  },
};

function actionAuditData(action: { id: string; name: string; method: string; urlTemplate: string; requiresApproval: boolean; enabled: boolean; currentVersionId: string | null }) {
  return {
    actionId: action.id, actionName: action.name, method: action.method, urlTemplate: action.urlTemplate,
    requiresApproval: action.requiresApproval, enabled: action.enabled, versionId: action.currentVersionId,
  };
}

const actionCreate: OperationDefinition = {
  async prepare(scope, _target, input) {
    const body = input as unknown as ActionInput & { name: string };
    const { listActions } = await import("../actions/service.ts");
    const names = (await listActions(scope.workspaceId, scope.environmentId)).map((a) => a.name).sort();
    if (names.includes(body.name)) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    const c = classifyActionCreate(body);
    return {
      classification: c,
      summary: `Add action "${body.name}" (${body.adapter ? "adapter" : (body.method ?? "POST")} ${body.urlTemplate ?? ""})`.trim(),
      resource: { type: "action", id: body.name, name: body.name },
      baseDigest: digestOf(body.name),
    };
  },
  async apply(scope, _target, input, context) {
    const { createAction } = await import("../actions/service.ts");
    const action = await createAction(scope.workspaceId, input as never, authority(context), scope.environmentId);
    audit(scope, context, "action.definition.created", { type: "action", id: action.id }, actionAuditData(action));
    return action;
  },
};

const actionUpdate: OperationDefinition = {
  async prepare(scope, target, input) {
    const { getAction } = await import("../actions/service.ts");
    const view = await getAction(scope.workspaceId, target.ref, scope.environmentId);
    const before: ActionInput = {
      name: view.name, description: view.description ?? undefined, method: view.method, urlTemplate: view.urlTemplate,
      headers: view.headers as Record<string, string>, bodyTemplate: view.bodyTemplate ?? undefined, inputSchema: view.inputSchema,
      requiresApproval: view.requiresApproval, enabled: view.enabled, adapter: view.adapter, impact: view.impact, verify: view.verify,
      governed: view.governed,
    };
    return {
      classification: classifyActionUpdate(before, input as ActionInput),
      summary: `Change action "${view.name}"`,
      resource: { type: "action", id: view.id, name: view.name },
      baseDigest: digestOf([view.currentVersionId, view.updatedAt]),
    };
  },
  async apply(scope, target, input, context) {
    const { updateAction } = await import("../actions/service.ts");
    const action = await updateAction(scope.workspaceId, target.ref, input as never, authority(context), scope.environmentId);
    audit(scope, context, "action.definition.updated", { type: "action", id: action.id }, { ...actionAuditData(action), changed: Object.keys(input) });
    return action;
  },
};

const actionImport: OperationDefinition = {
  async prepare(scope, _target, input) {
    const { importActionsFromOpenApi } = await import("../actions/import.ts");
    const dry = await importActionsFromOpenApi(scope.workspaceId, input.spec as never, {
      ...(input as Record<string, unknown>), dryRun: true, environmentId: scope.environmentId,
    } as never);
    if (input.dryRun === true || dry.created.length === 0) {
      return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    }
    return {
      classification: classifyActionImport(dry.created),
      summary: `Import ${dry.created.length} action${dry.created.length === 1 ? "" : "s"} from an OpenAPI spec`,
      resource: { type: "action_import", id: digestOf(input.spec).slice(0, 12) },
      baseDigest: digestOf(dry.created.map((a) => a.name).sort()),
    };
  },
  async apply(scope, _target, input, context) {
    const { importActionsFromOpenApi } = await import("../actions/import.ts");
    const result = await importActionsFromOpenApi(scope.workspaceId, input.spec as never, {
      ...(input as Record<string, unknown>), authority: authority(context), environmentId: scope.environmentId,
    } as never);
    for (const imported of result.created) {
      audit(scope, context, "action.definition.created", { type: "action", id: imported.name }, {
        actionName: imported.name, method: imported.method, urlTemplate: imported.urlTemplate, source: "openapi_import",
      });
    }
    return result;
  },
};

const secretPut: OperationDefinition = {
  async prepare(scope, target, input) {
    const { getSecretMetadata } = await import("../actions/secrets.ts");
    const before = await getSecretMetadata(scope.workspaceId, target.name, scope.environmentId).catch((error: { code?: string }) => {
      if (error?.code === "SECRET_NOT_FOUND") return null;
      throw error;
    });
    const state = before ? {
      allowedHosts: before.allowedHosts, allowedPlacements: before.allowedPlacements,
      external: before.kind === "external", description: before.description,
    } : null;
    return {
      classification: classifySecretPut(state, input as SecretPutInput),
      summary: `Change where secret "${target.name}" may be sent`,
      resource: { type: "secret", id: target.name, name: target.name },
      baseDigest: digestOf(before),
    };
  },
  async apply(scope, target, input) {
    const secrets = await import("../actions/secrets.ts");
    const { value, external, ...rest } = input as SecretPutInput & Record<string, unknown>;
    if (external) {
      const { secret } = await secrets.putExternalSecret(scope.workspaceId, target.name, { external, ...rest } as never, scope.environmentId);
      return secret;
    }
    await secrets.assertSecretWillBeBound(scope.workspaceId, target.name, rest as { allowedHosts?: string[] | null }, scope.environmentId);
    return secrets.putSecret(scope.workspaceId, target.name, { value: String(value), ...rest } as never, scope.environmentId);
  },
};

const secretStoreCreate: OperationDefinition = {
  async prepare(_scope, _target, input) {
    const name = String(input.name);
    return {
      classification: classifySecretStoreCreate({ name }),
      summary: `Connect secret store "${name}"`,
      resource: { type: "secret_store", id: name, name },
      baseDigest: digestOf(name),
    };
  },
  async apply(scope, _target, input) {
    const { createSecretStore } = await import("../secret-stores/service.ts");
    return createSecretStore(scope, input as never);
  },
};

const secretStoreUpdate: OperationDefinition = {
  async prepare(scope, target, input) {
    const { getSecretStore } = await import("../secret-stores/service.ts");
    const before = await getSecretStore(scope, target.name);
    return {
      classification: classifySecretStoreUpdate(Object.keys(input)),
      summary: `Change secret store "${target.name}"`,
      resource: { type: "secret_store", id: target.name, name: target.name },
      baseDigest: digestOf(before),
    };
  },
  async apply(scope, target, input) {
    const { updateSecretStore } = await import("../secret-stores/service.ts");
    return updateSecretStore(scope, target.name, input as never, { confirmProtected: target.confirmProtected === "true" });
  },
};

const secretStoreSettings: OperationDefinition = {
  async prepare(scope, _target, input) {
    const { getSecretStoreSettings } = await import("../secret-stores/service.ts");
    const before = await getSecretStoreSettings(scope.workspaceId);
    return {
      classification: classifySecretStoreSettings({ allowPrivateNetwork: Boolean(before.allowPrivateNetwork) }, { allowPrivateNetwork: Boolean(input.allowPrivateNetwork) }),
      summary: "Let secret store requests reach private addresses",
      resource: { type: "secret_store_settings", id: scope.workspaceId },
      baseDigest: digestOf(before),
    };
  },
  async apply(scope, _target, input, context) {
    const { updateSecretStoreSettings } = await import("../secret-stores/service.ts");
    return updateSecretStoreSettings(scope.workspaceId, input as never, context.approverUserId);
  },
};

const oauthAppPut: OperationDefinition = {
  async prepare(scope, target, input) {
    const { getEnvironmentOAuthApp } = await import("../end-users/oauth-apps.ts");
    const before = await getEnvironmentOAuthApp(scope, target.integration);
    const current = before.configured && before.clientId ? { clientId: before.clientId } : null;
    return {
      classification: classifyOAuthAppPut(current, { clientId: String(input.clientId) }),
      summary: `${current ? "Replace" : "Set"} the ${target.integration} OAuth app end users sign in to`,
      resource: { type: "oauth_app", id: target.integration, name: target.integration },
      baseDigest: digestOf([current, before.updatedAt]),
    };
  },
  async apply(scope, target, input, context) {
    const { putEnvironmentOAuthApp } = await import("../end-users/oauth-apps.ts");
    const app = await putEnvironmentOAuthApp(scope, target.integration, input as never);
    audit(scope, context, "secret.oauth_app_set", { type: "oauth_app", id: app.integration }, { integration: app.integration, clientId: app.clientId });
    return app;
  },
};

const mcpUpstreamRegister: OperationDefinition = {
  async prepare(scope, _target, input) {
    const { planRegistration } = await import("../mcp-upstreams/service.ts");
    const body = input as unknown as McpUpstreamRegisterInput;
    const planned = await planRegistration(scope.workspaceId, scope.environmentId, body as never);
    if (!planned) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    const c = classifyMcpUpstreamRegister(body, planned);
    return {
      classification: c,
      summary: `Register MCP server "${body.name}" at ${planned.host}: ${firstLoosening(c)}`,
      resource: { type: "mcp_upstream", id: body.name, name: body.name },
      baseDigest: digestOf([body.name, body.url, planned.secrets]),
    };
  },
  async apply(scope, _target, input, context) {
    const { registerUpstream } = await import("../mcp-upstreams/service.ts");
    const upstream = await registerUpstream(scope.workspaceId, scope.environmentId, input as never, authority(context), { signedOff: true });
    audit(scope, context, "mcp_upstream.registered", { type: "mcp_upstream", id: upstream.id }, {
      name: upstream.name, url: upstream.url, tools: upstream.tools.length, toolsHash: upstream.toolsHash,
      ...(upstream.oauth ? { oauth: { issuer: upstream.oauth.issuer, clientId: upstream.oauth.clientId, publicClient: upstream.oauth.publicClient } } : {}),
    });
    return upstream;
  },
};

const mcpUpstreamRefresh: OperationDefinition = {
  async prepare(scope, target) {
    const { getUpstream } = await import("../mcp-upstreams/service.ts");
    const upstream = await getUpstream(scope.workspaceId, scope.environmentId, target.id);
    return { classification: classifyMcpUpstreamRefresh(upstream), summary: `List MCP server "${upstream.name}" again`, resource: { type: "mcp_upstream", id: upstream.id, name: upstream.name }, baseDigest: digestOf(upstream.toolsHash) };
  },
  async apply(scope, target) {
    const { refreshUpstream } = await import("../mcp-upstreams/service.ts");
    return refreshUpstream(scope.workspaceId, scope.environmentId, target.id);
  },
};

const mcpToolAdopt: OperationDefinition = {
  async prepare(scope, target, input) {
    const { planAdoption } = await import("../mcp-upstreams/service.ts");
    const planned = await planAdoption(scope.workspaceId, scope.environmentId, target.id, (input as { tools: Record<string, never> }).tools);
    if (!planned) return { classification: classification([]), summary: "", resource: null, baseDigest: "", passThrough: true };
    const { upstream, tools } = planned;
    const classes = [...new Set(tools.map((t) => t.suggestedClass))].sort().join(", ");
    const readopted = tools.filter((t) => t.readopted).length;
    return {
      classification: classifyMcpToolAdopt(tools),
      summary: `${readopted === tools.length ? "Re-adopt" : "Adopt"} ${tools.length} tool${tools.length === 1 ? "" : "s"} from MCP server "${upstream.name}" (suggested: ${classes})`,
      resource: { type: "mcp_upstream", id: upstream.id, name: upstream.name },
      baseDigest: digestOf([upstream.id, tools.map((t) => [t.tool, t.hash, t.fromHash, t.readopted])]),
      toolHashes: Object.fromEntries(tools.map((t) => [t.tool, t.hash])),
    };
  },
  async apply(scope, target, input, context) {
    const { adoptTools } = await import("../mcp-upstreams/service.ts");
    const requested = (input as { tools: Record<string, AdoptChoice> }).tools;
    const choices = Object.fromEntries(Object.entries(requested).map(([name, choice]) => {
      const reviewed = context.prepared?.toolHashes?.[name];
      return [name, reviewed && choice.toolHash === undefined ? { ...choice, toolHash: reviewed } : choice];
    }));
    const result = await adoptTools(scope.workspaceId, scope.environmentId, target.id, choices, authority(context), { signedOff: true });
    for (const adopted of result.adopted) {
      audit(scope, context, adopted.readopted ? "action.definition.updated" : "action.definition.created", { type: "action", id: adopted.action.id }, {
        actionName: adopted.action.name, source: "mcp_adopt", upstreamId: target.id, tool: adopted.tool, requiresApproval: adopted.action.requiresApproval,
      });
    }
    return result;
  },
};

export const OPERATIONS: Partial<Record<GovernanceOperation, OperationDefinition>> = {
  "policy.create": policyCreate,
  "policy.update": policyUpdate,
  "policy.delete": policyDelete,
  "policy_file.apply": policyFileApply,
  "impact_limit.update": impactLimitUpdate,
  "impact_limit.archive": impactLimitArchive,
  "budget.put": budgetPut,
  "budget.delete": budgetDelete,
  "environment.resume": environmentResume,
  "action.create": actionCreate,
  "action.update": actionUpdate,
  "action.import": actionImport,
  "secret.put": secretPut,
  "secret_store.create": secretStoreCreate,
  "secret_store.update": secretStoreUpdate,
  "secret_store_settings.update": secretStoreSettings,
  "oauth_app.put": oauthAppPut,
  "mcp_upstream.register": mcpUpstreamRegister,
  "mcp_upstream.refresh": mcpUpstreamRefresh,
  "mcp_upstream.adopt": mcpToolAdopt,
};

export function operationDefinition(operation: GovernanceOperation): OperationDefinition {
  const definition = OPERATIONS[operation];
  if (!definition) throw new Error(`No sign-off definition for ${operation}`);
  return definition;
}
