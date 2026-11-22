import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { dbUtcNow } from "../../db/clock.ts";
import {
  actions,
  actionInvocations,
  actionVersions,
  type ActionAdapterConfig,
  type ActionDeclarations,
  type ActionMcpBinding,
  type ActionImpactDeclaration,
  type ActionVerifyDeclaration,
} from "../../db/schema/actions.ts";
import { createLogger } from "../../lib/logger.ts";
import { generateActionId, generateActionVersionId, generateEffectId, generateInvocationId } from "../../utils/crypto.ts";
import {
  ApiError,
  ActionDisabledError,
  AuthorizationError,
  ConflictError,
  InvocationNotFoundError,
  ValidationError,
} from "../../utils/errors.ts";
import { validateUrl } from "../../utils/url-validation.ts";
import { checkSchemaDefinition, validateAgainstSchema } from "../../utils/json-schema.ts";
import { validateMcpArguments } from "../../utils/mcp-json-schema.ts";
import { assertActionsEntitled, checkActionInvokeQuota, checkActionQuota } from "../billing/usage-enforcement.ts";
import { createActionApproval, type OAuthPrincipal } from "../approvals/service.ts";
import { evaluatePolicies, withDefaultDecider } from "../approvals/policy.ts";
import { endUserDeciderFor } from "../workspace/defaults.ts";
import { planDecision } from "../approvals/decision.ts";
import { executeInvocation, toInvocation, type InvocationResult } from "./execute.ts";
import { definitionOf, getDefaultEnvironmentId, resolveActionRow, resolvePinnedDefinition, type ActionRowLike } from "./definitions.ts";
import { applyRiskFloor, planApprovalCovers, shouldGate, type PlanApprovalCover } from "./gating.ts";
import { invocationLinks } from "./resolution.ts";
import {
  ACCOUNT_HOST_REF,
  assertAccountHostOnlyInUrl,
  extractSecretNames,
  hasInputRef,
  hasSecretRef,
  INPUT_REF,
  PATH_INPUT_REF,
  SECRET_REF,
  urlTemplateAuthority,
  usesAccountHost,
} from "./template.ts";
import { endUserIntegrationsFor, loadSecretPolicies, type SecretPolicy } from "./secrets.ts";
import { NO_END_USER, type EndUserContext } from "../end-users/identity.ts";
import { EndUserRequiredError } from "../end-users/errors.ts";
import { endUserFailureOf } from "../end-users/failures.ts";
import { assertEndUserConnected, assertEndUserConnectedToUpstream } from "../end-users/connections.ts";
import { assertSecretDestinationsAllowed, hostAllowed } from "./secret-destinations.ts";
import { getRunIdentity } from "../runs/service.ts";
import { findAdapter } from "../effects/registry.ts";
import { governedSpecOf, type GovernableDefinition } from "../effects/context.ts";
import { parseDeclarations, parseImpactDeclaration, type ImpactDeclarationInput, type VerifyDeclarationInput } from "../effects/declarations.ts";
import { buildMcpToolAdapter, schemaCheckOf } from "../effects/adapters/mcp-tool.ts";
import { canonicalJson } from "../effects/canonical.ts";
import { actingForCondition, type ActingFor } from "../end-users/acting-for.ts";
import {
  effectByOperationKey,
  isSameOperation,
  effectGradeForInvocation,
  insertEffectIn,
  policyAmount,
  operationKeyConflict,
  prepareEffectAdmission,
  previewAdmission,
  discardUnboundPreview,
  type EffectAdmission,
  type EffectAdmissionDraft,
} from "../effects/lifecycle.ts";

const logger = createLogger({ module: "actions" });

type ActionRow = typeof actions.$inferSelect;

export { resolveActionRow, resolvePinnedDefinition } from "./definitions.ts";
export { applyRiskFloor, shouldGate } from "./gating.ts";

export type ActionMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ActionView {
  id: string;
  name: string;
  description: string | null;
  method: ActionMethod;
  urlTemplate: string;
  headers: Record<string, unknown>;
  bodyTemplate: Record<string, unknown> | null;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  enabled: boolean;
  secrets: string[];
  currentVersionId: string | null;
  environmentId: string;
  adapter: ActionAdapterConfig | null;
  governed: boolean;
  impact: ActionImpactDeclaration | null;
  verify: ActionVerifyDeclaration | null;
  createdAt: Date;
  updatedAt: Date;
}

function toAction(row: ActionRow): ActionView {
  const headers = (row.headers as Record<string, unknown>) ?? {};
  const bodyTemplate = (row.bodyTemplate as Record<string, unknown> | null) ?? null;

  return {
    id: row.actionId,
    name: row.name,
    description: row.description,
    method: row.method as ActionMethod,
    urlTemplate: row.urlTemplate,
    headers,
    bodyTemplate,
    inputSchema: (row.inputSchema as Record<string, unknown>) ?? {},
    requiresApproval: row.requiresApproval,
    enabled: row.enabled,
    secrets: extractSecretNames(row.urlTemplate, headers, bodyTemplate, row.declarations?.verify?.url),
    currentVersionId: row.currentVersionId ?? null,
    environmentId: row.environmentId,
    adapter: row.adapter ?? null,
    governed: Boolean(row.adapter || row.declarations || row.mcp),
    impact: row.declarations?.impact ?? null,
    verify: row.declarations?.verify ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CallerAuthority {
  scopes: string[] | null;
}

export const UNSCOPED_AUTHORITY: CallerAuthority = { scopes: null };

export function assertMayReferenceSecrets(authority: CallerAuthority, names: string[]): void {
  if (names.length === 0) return;
  if (authority.scopes === null) return;
  if (authority.scopes.includes("secrets:read")) return;

  throw new AuthorizationError(
    `Referencing a secret requires the "secrets:read" scope. This definition references: ${names.join(", ")}.`
  );
}

function assertMayGovern(authority: CallerAuthority, what = "an action's approval requirement"): void {
  if (authority.scopes === null) return;
  if (authority.scopes.includes("actions:govern")) return;

  throw new AuthorizationError(
    `Changing ${what} needs the "actions:govern" scope, which is not granted by default.`
  );
}

function assertSecretDestinationIsPinned(urlTemplate: string): void {
  const authority = urlTemplateAuthority(urlTemplate);

  if (hasInputRef(authority)) {
    throw new ValidationError(
      "An action that references a secret must have a fixed scheme and host: " +
      "remove the {{input.*}} placeholder from the URL's host so the credential's destination cannot be chosen at invoke time."
    );
  }

  if (hasSecretRef(authority)) {
    throw new ValidationError(
      "A secret cannot be interpolated into a URL's host  it would be exposed to DNS resolution. Use a header, the path, or the body."
    );
  }
}

export function assertPlaceholdersWellFormed(input: {
  urlTemplate: string;
  headers?: Record<string, unknown>;
  bodyTemplate?: Record<string, unknown> | null;
}): void {
  const known = new RegExp(`${INPUT_REF.source}|${SECRET_REF.source}|${ACCOUNT_HOST_REF.source}`, "g");
  const stray = /\{\{[^}]*\}\}/.exec(input.urlTemplate.replace(known, ""));
  if (stray) {
    throw new ValidationError(
      `urlTemplate has an unrecognised placeholder ${stray[0]}. Use {{input.field}}, {{input.field:path}}, {{secret:NAME}}, {{connection:integration}} or {{connection.host}}.`
    );
  }
  usesAccountHost(input.urlTemplate);
  assertAccountHostOnlyInUrl(input.headers, input.bodyTemplate);

  const authorityEnd = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/.exec(input.urlTemplate)?.[0].length ?? 0;
  const queryStart = input.urlTemplate.slice(authorityEnd).search(/[?#]/);
  const pathEnd = queryStart === -1 ? input.urlTemplate.length : authorityEnd + queryStart;
  for (const match of input.urlTemplate.matchAll(new RegExp(PATH_INPUT_REF.source, "g"))) {
    const at = match.index ?? 0;
    if (at < authorityEnd || at >= pathEnd) {
      throw new ValidationError(`${match[0]} can only be used in the URL's path, not its host or query.`);
    }
  }

  for (const [label, template] of [["headers", input.headers], ["bodyTemplate", input.bodyTemplate]] as const) {
    if (template && new RegExp(PATH_INPUT_REF.source).test(JSON.stringify(template))) {
      throw new ValidationError(`The :path modifier only applies in urlTemplate, not in ${label}.`);
    }
  }
}

export interface CreateActionInput {
  name: string;
  description?: string;
  method?: ActionMethod;
  urlTemplate: string;
  headers?: Record<string, unknown>;
  bodyTemplate?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
  enabled?: boolean;
  adapter?: ActionAdapterConfig;
  impact?: ImpactDeclarationInput | null;
  verify?: VerifyDeclarationInput | null;
  governed?: boolean;
  mcp?: ActionMcpBinding;
}

function resolveDeclarations(
  input: Pick<CreateActionInput, "impact" | "verify" | "governed">,
  existing: ActionDeclarations | null,
  definition: { urlTemplate: string; adapter: ActionAdapterConfig | null },
): ActionDeclarations | null {
  const declares = input.impact != null || input.verify != null || input.governed !== undefined;
  if (definition.adapter) {
    if (declares) throw new ValidationError("An adapter action is already governed, and its impact and verification come from the adapter. Remove impact, verify and governed.");
    return null;
  }
  const kept = input.governed === false ? null : existing;
  return parseDeclarations({
    impact: input.impact !== undefined ? input.impact : kept?.impact,
    verify: input.verify !== undefined ? input.verify : kept?.verify,
    governed: input.governed ?? (kept ? true : undefined),
  }, definition.urlTemplate);
}

async function validateVerifySecrets(
  workspaceId: string, declarations: ActionDeclarations | null, authority: CallerAuthority, environmentId: string,
): Promise<void> {
  const url = declarations?.verify?.url;
  const names = url ? extractSecretNames(url) : [];
  if (!url || names.length === 0) return;
  assertMayReferenceSecrets(authority, names);
  assertSecretDestinationsAllowed(url, null, null, await loadSecretPolicies(workspaceId, names, environmentId));
}

async function validateAdapter(
  workspaceId: string,
  spec: ActionAdapterConfig,
  authority: CallerAuthority,
  environmentId: string,
): Promise<{ urlTemplate: string; inputSchema: Record<string, unknown> }> {
  const adapter = findAdapter(spec.type);
  if (!adapter) throw new ValidationError(`Unknown adapter "${spec.type}".`);
  adapter.parseConfig(spec.config);
  if (!/^[A-Z0-9_]{1,100}$/.test(spec.credentialSecret)) {
    throw new ValidationError("adapter.credentialSecret must be a secret name (^[A-Z0-9_]+$).");
  }
  assertMayReferenceSecrets(authority, [spec.credentialSecret]);
  const policies = await loadSecretPolicies(workspaceId, [spec.credentialSecret], environmentId);
  const policy = policies.get(spec.credentialSecret);
  if (policy?.allowedHosts?.length) {
    const refused = adapter.hosts.filter((host) => !hostAllowed(host, policy.allowedHosts!));
    if (refused.length) {
      throw new ValidationError(`Secret ${spec.credentialSecret} may not be sent to ${refused.join(", ")}, which ${spec.type} calls.`);
    }
  }
  return { urlTemplate: `https://${adapter.hosts[0]}/`, inputSchema: adapter.inputSchema };
}

async function validateDefinition(
  workspaceId: string,
  input: { mcp?: ActionMcpBinding | null; urlTemplate: string; headers?: Record<string, unknown>; bodyTemplate?: Record<string, unknown> | null; inputSchema?: Record<string, unknown> },
  authority: CallerAuthority,
  environmentId?: string,
): Promise<void> {
  assertPlaceholdersWellFormed(input);

  const probe = input.urlTemplate
    .replace(new RegExp(ACCOUNT_HOST_REF.source, "g"), "account-host.example.com")
    .replace(new RegExp(INPUT_REF.source, "g"), "placeholder")
    .replace(new RegExp(SECRET_REF.source, "g"), "placeholder");

  const check = validateUrl(probe);
  if (!check.valid) {
    throw new ValidationError(`urlTemplate is not a valid target: ${check.error}`);
  }

  if (!input.mcp && input.inputSchema && Object.keys(input.inputSchema).length > 0) {
    const problems = checkSchemaDefinition(input.inputSchema, "inputSchema");
    if (problems.length > 0) {
      throw new ValidationError(`inputSchema uses unsupported constructs: ${problems.join("; ")}`);
    }
  }

  const names = extractSecretNames(
    input.urlTemplate,
    input.headers ?? {},
    input.bodyTemplate ?? null
  );
  if (names.length > 0) {
    assertMayReferenceSecrets(authority, names);
    assertSecretDestinationIsPinned(input.urlTemplate);
    const policies = await loadSecretPolicies(workspaceId, names, environmentId);
    assertSecretDestinationsAllowed(
      input.urlTemplate,
      input.headers ?? {},
      input.bodyTemplate ?? null,
      policies,
    );
    assertAccountHostCredential(input.urlTemplate, policies);
  } else if (usesAccountHost(input.urlTemplate)) {
    assertAccountHostCredential(input.urlTemplate, new Map());
  }
}

function assertAccountHostCredential(urlTemplate: string, policies: Map<string, SecretPolicy>): void {
  if (!usesAccountHost(urlTemplate)) return;
  const accounts = [...policies.values()].filter((p) => p.accountIntegration);
  if (accounts.length !== 1) {
    throw new ValidationError(
      `An action on {{connection.host}} must send exactly one account whose host differs per account, as {{connection:<integration>}}; this one sends ${accounts.length}.`,
    );
  }
}

function definitionChanged(before: ActionRowLike, after: ActionRowLike): boolean {
  return JSON.stringify(definitionOf(before)) !== JSON.stringify(definitionOf(after));
}

async function appendActionVersion(row: ActionRowLike): Promise<string> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [{ max }] = await tx
          .select({ max: sql<number>`coalesce(max(${actionVersions.version}), 0)` })
          .from(actionVersions)
          .where(eq(actionVersions.actionId, row.id));

        const actionVersionId = generateActionVersionId();
        await tx.insert(actionVersions).values({
          workspaceId: row.workspaceId,
          environmentId: row.environmentId,
          actionId: row.id,
          actionVersionId,
          version: Number(max) + 1,
          ...definitionOf(row),
          method: row.method as ActionMethod,
        });

        await tx
          .update(actions)
          .set({ currentVersionId: actionVersionId })
          .where(eq(actions.id, row.id));

        return actionVersionId;
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
      if ((code === "23505" || causeCode === "23505") && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

function mcpDeclarations(input: CreateActionInput): ActionDeclarations | null {
  const declarations = input.impact != null ? { impact: parseImpactDeclaration(input.impact), verify: null } : null;
  buildMcpToolAdapter({
    urlTemplate: input.urlTemplate,
    headers: input.headers ?? {},
    inputSchema: input.inputSchema ?? {},
    mcp: input.mcp,
    declarations,
  });
  return declarations;
}

export async function createAction(
  workspaceId: string,
  input: CreateActionInput,
  authority: CallerAuthority,
  environmentId?: string,
): Promise<ActionView> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  if (input.adapter) {
    const derived = await validateAdapter(workspaceId, input.adapter, authority, scopedEnvironmentId);
    if (input.headers && Object.keys(input.headers).length || input.bodyTemplate) {
      throw new ValidationError("An adapter action builds its own request; headers and bodyTemplate are not accepted.");
    }
    input = { ...input, method: "POST", urlTemplate: derived.urlTemplate, headers: {}, bodyTemplate: undefined, inputSchema: derived.inputSchema };
  }
  if (input.mcp) {
    if (input.adapter || input.bodyTemplate || input.verify != null || input.governed === false) {
      throw new ValidationError("An adopted MCP tool sends the tool call itself: no adapter, body, read-back or ungoverned form.");
    }
    input = { ...input, method: "POST", bodyTemplate: undefined };
  }
  await validateDefinition(workspaceId, input, authority, scopedEnvironmentId);
  const declarations = input.mcp
    ? mcpDeclarations(input)
    : resolveDeclarations(input, null, { urlTemplate: input.urlTemplate, adapter: input.adapter ?? null });
  await validateVerifySecrets(workspaceId, declarations, authority, scopedEnvironmentId);

  const row = await db.transaction(async tx => {
  await checkActionQuota(workspaceId, tx);
  const [existing] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.environmentId, scopedEnvironmentId), eq(actions.name, input.name), isNull(actions.archivedAt)));

  if (existing) {
    throw new ConflictError(`An action named "${input.name}" already exists`);
  }

  const [row] = await tx
    .insert(actions)
    .values({
      workspaceId,
      environmentId: scopedEnvironmentId,
      actionId: generateActionId(),
      name: input.name,
      description: input.description ?? null,
      method: input.method ?? "POST",
      urlTemplate: input.urlTemplate,
      headers: input.headers ?? {},
      bodyTemplate: input.bodyTemplate ?? null,
      inputSchema: input.inputSchema ?? {},
      requiresApproval: input.requiresApproval ?? false,
      enabled: input.enabled ?? true,
      adapter: input.adapter ?? null,
      declarations,
      mcp: input.mcp ?? null,
    })
    .returning();

  const versionId = generateActionVersionId();
  await tx.insert(actionVersions).values({
    workspaceId, environmentId: scopedEnvironmentId, actionId: row.id,
    actionVersionId: versionId, version: 1, ...definitionOf(row), method: row.method as ActionMethod,
  });
  await tx.update(actions).set({ currentVersionId: versionId }).where(eq(actions.id, row.id));
  return { ...row, currentVersionId: versionId };
  });

  logger.info({ workspaceId, actionId: row.actionId, name: row.name }, "Action created");
  return toAction(row);
}

export async function listActions(workspaceId: string, environmentId?: string): Promise<ActionView[]> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const rows = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.environmentId, scopedEnvironmentId),
        isNull(actions.archivedAt)
      )
    )
    .orderBy(desc(actions.createdAt));

  return rows.map(toAction);
}

export async function getAction(workspaceId: string, ref: string, environmentId?: string): Promise<ActionView> {
  return toAction(await resolveActionRow(workspaceId, ref, environmentId));
}

export async function updateAction(
  workspaceId: string,
  ref: string,
  input: Partial<CreateActionInput>,
  authority: CallerAuthority,
  environmentId?: string,
): Promise<ActionView> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const row = await resolveActionRow(workspaceId, ref, scopedEnvironmentId);

  if (row.mcp || input.mcp) {
    const shaping = ["method", "urlTemplate", "headers", "bodyTemplate", "inputSchema", "adapter", "impact", "verify", "governed", "mcp"] as const;
    const changed = shaping.filter((field) => input[field] !== undefined);
    if (changed.length > 0) {
      throw new ValidationError(`An adopted MCP tool's ${changed.join(", ")} cannot be edited. Re-adopt the tool from its upstream to change it.`);
    }
  }

  if (row.adapter || input.adapter) {
    if (!row.adapter) throw new ValidationError("A template action cannot be converted to an adapter action. Create a new action.");
    if (input.urlTemplate !== undefined || input.headers !== undefined || input.bodyTemplate !== undefined ||
        input.inputSchema !== undefined || input.method !== undefined) {
      throw new ValidationError("An adapter action's request is defined by its adapter; change `adapter` instead.");
    }
    if (input.adapter) {
      if (input.adapter.type !== row.adapter.type) throw new ValidationError("An action's adapter type cannot change. Create a new action.");
      assertMayGovern(authority);
      await validateAdapter(workspaceId, input.adapter, authority, scopedEnvironmentId);
    }
  }

  if (input.name !== undefined && input.name !== row.name && (row.adapter || row.declarations)) {
    assertMayGovern(authority, "a governed action's name");
  }

  await validateDefinition(workspaceId, {
    urlTemplate: input.urlTemplate ?? row.urlTemplate,
    headers: (input.headers ?? (row.headers as Record<string, unknown>)) ?? {},
    bodyTemplate: input.bodyTemplate ?? (row.bodyTemplate as Record<string, unknown> | null),
    inputSchema: input.inputSchema ?? (row.inputSchema as Record<string, unknown>),
  }, authority, scopedEnvironmentId);

  if (input.requiresApproval !== undefined && input.requiresApproval !== row.requiresApproval) {
    assertMayGovern(authority);
  }

  const declarations = resolveDeclarations(input, row.declarations ?? null, {
    urlTemplate: input.urlTemplate ?? row.urlTemplate,
    adapter: row.adapter ?? null,
  });
  if (row.declarations && canonicalJson(declarations) !== canonicalJson(row.declarations)) {
    assertMayGovern(authority, "what a governed action declares");
  }
  await validateVerifySecrets(workspaceId, declarations, authority, scopedEnvironmentId);

  const [updated] = await db
    .update(actions)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.urlTemplate !== undefined ? { urlTemplate: input.urlTemplate } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
      ...(input.inputSchema !== undefined ? { inputSchema: input.inputSchema } : {}),
      ...(input.requiresApproval !== undefined
        ? { requiresApproval: input.requiresApproval }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
      declarations,
      updatedAt: new Date(),
    })
    .where(eq(actions.id, row.id))
    .returning();

  if (definitionChanged(row, updated)) {
    await appendActionVersion(updated);
  }

  return toAction(updated);
}

export async function readoptMcpTool(
  workspaceId: string,
  ref: string,
  change: { inputSchema: Record<string, unknown>; mcp: ActionMcpBinding },
  authority: CallerAuthority,
  environmentId?: string,
  options: { signedOff?: boolean } = {},
): Promise<ActionView> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const row = await resolveActionRow(workspaceId, ref, scopedEnvironmentId);
  if (!row.mcp) throw new ValidationError(`Action ${row.name} is not an adopted MCP tool.`);
  if (row.mcp.upstreamId !== change.mcp.upstreamId || row.mcp.toolName !== change.mcp.toolName) {
    throw new ValidationError(`Action ${row.name} was adopted from another tool.`);
  }
  if (!options.signedOff) assertMayGovern(authority, "an adopted MCP tool's definition");
  const headers = (row.headers as Record<string, unknown>) ?? {};
  await validateDefinition(workspaceId, { urlTemplate: row.urlTemplate, headers, inputSchema: change.inputSchema, mcp: change.mcp }, authority, scopedEnvironmentId);
  mcpDeclarations({
    name: row.name, urlTemplate: row.urlTemplate, headers, inputSchema: change.inputSchema, mcp: change.mcp,
    impact: row.declarations?.impact ?? null,
  });

  const [updated] = await db
    .update(actions)
    .set({ inputSchema: change.inputSchema, mcp: change.mcp, updatedAt: new Date() })
    .where(eq(actions.id, row.id))
    .returning();
  const currentVersionId = definitionChanged(row, updated) ? await appendActionVersion(updated) : updated.currentVersionId;
  logger.info({ workspaceId, actionId: row.actionId, tool: change.mcp.toolName }, "MCP tool re-adopted");
  return toAction({ ...updated, currentVersionId });
}

export interface ActionVersionView {
  id: string;
  version: number;
  method: ActionMethod;
  urlTemplate: string;
  headers: Record<string, unknown>;
  bodyTemplate: Record<string, unknown> | null;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  adapter: ActionAdapterConfig | null;
  governed: boolean;
  impact: ActionImpactDeclaration | null;
  verify: ActionVerifyDeclaration | null;
  secrets: string[];
  current: boolean;
  createdAt: Date;
}

export async function listActionVersions(
  workspaceId: string,
  ref: string,
  environmentId?: string,
): Promise<ActionVersionView[]> {
  const action = await resolveActionRow(workspaceId, ref, environmentId);
  const rows = await db
    .select()
    .from(actionVersions)
    .where(eq(actionVersions.actionId, action.id))
    .orderBy(actionVersions.version);

  return rows.map((row) => {
    const headers = (row.headers as Record<string, unknown>) ?? {};
    const bodyTemplate = (row.bodyTemplate as Record<string, unknown> | null) ?? null;
    return {
      id: row.actionVersionId,
      version: row.version,
      method: row.method as ActionMethod,
      urlTemplate: row.urlTemplate,
      headers,
      bodyTemplate,
      inputSchema: (row.inputSchema as Record<string, unknown>) ?? {},
      requiresApproval: row.requiresApproval,
      adapter: row.adapter ?? null,
      governed: Boolean(row.adapter || row.declarations || row.mcp),
      impact: row.declarations?.impact ?? null,
      verify: row.declarations?.verify ?? null,
      secrets: extractSecretNames(row.urlTemplate, headers, bodyTemplate, row.declarations?.verify?.url),
      current: row.actionVersionId === action.currentVersionId,
      createdAt: row.createdAt,
    };
  });
}

export async function deleteAction(
  workspaceId: string,
  ref: string,
  authority: CallerAuthority,
  environmentId?: string,
): Promise<void> {
  const row = await resolveActionRow(workspaceId, ref, environmentId);

  if (row.requiresApproval) {
    assertMayGovern(authority);
  }

  await db
    .update(actions)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(actions.id, row.id));

  logger.info({ workspaceId, actionId: row.actionId }, "Action archived");
}

export async function countActions(workspaceId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(actions)
    .where(and(eq(actions.workspaceId, workspaceId), isNull(actions.archivedAt)));
  return total;
}

export interface InvokeResult extends InvocationResult {
  pendingApproval: boolean;
}

export type InvokeOutcome = InvokeResult & { replayed?: true };

async function withGrade<T extends InvocationResult>(result: T, invocationRowId: string): Promise<T> {
  if (!result.effectId) return result;
  return { ...result, grade: await effectGradeForInvocation(invocationRowId) };
}

const IDEMPOTENCY_INDEX = "action_invocations_idempotency_unique";

export async function replayInvocationForKey(
  workspaceId: string,
  environmentId: string,
  key: string,
  fingerprint: string,
): Promise<InvokeOutcome | null> {
  const [row] = await db
    .select({ invocation: actionInvocations, actionName: actions.name })
    .from(actionInvocations)
    .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.environmentId, environmentId),
      eq(actionInvocations.idempotencyKey, key),
    ))
    .limit(1);
  if (!row) return null;
  if (row.invocation.idempotencyFingerprint !== fingerprint) {
    throw new ApiError(409, "idempotency_key_reuse", "This Idempotency-Key was already used for a different request.");
  }
  return withGrade<InvokeOutcome>({
    ...toInvocation(row.invocation, row.actionName),
    pendingApproval: row.invocation.status === "pending_approval",
    replayed: true,
  }, row.invocation.id);
}

function isUniqueOn(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (e?.code === "23505" && e.constraint === constraint) ||
    (e?.cause?.code === "23505" && e.cause.constraint === constraint);
}

function isIdempotencyCollision(error: unknown): boolean {
  return isUniqueOn(error, IDEMPOTENCY_INDEX);
}

async function assertRetryable(
  workspaceId: string, environmentId: string, actionRowId: string, retryOf: string, hasKey: boolean,
): Promise<void> {
  if (!hasKey) throw new ValidationError("A retry needs its own Idempotency-Key, different from the original's.");
  const [original] = await db
    .select({ status: actionInvocations.status, actionId: actionInvocations.actionId })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.environmentId, environmentId),
      eq(actionInvocations.invocationId, retryOf),
    ))
    .limit(1);
  if (!original) throw new InvocationNotFoundError(retryOf);
  if (original.actionId !== actionRowId) throw new ValidationError(`${retryOf} is an invocation of a different action.`);
  if (original.status === "unknown") {
    throw new ConflictError(`${retryOf} has an unknown outcome. Check the destination and resolve it before retrying.`);
  }
  if (original.status !== "failed") {
    throw new ConflictError(`Only a failed invocation can be retried. ${retryOf} is ${original.status}.`);
  }
}

export async function invokeAction(
  workspaceId: string,
  ref: string,
  input: Record<string, unknown>,
  opts: {
    requestedByKeyId?: string | null; environmentId?: string | null; traceRunId?: string; traceParentSpanId?: string; budgetReservationId?: string;
    requestedByOAuth?: OAuthPrincipal | null;
    requestedByUserId?: string | null;
    idempotency?: { key: string; fingerprint: string };
    retryOf?: string;
    endUser?: EndUserContext;
    effect?: {
      operationKey?: string;
      previewId?: string;
      dependsOn?: Array<{ effect: string; outcome: "succeeded" | "failed" }>;
      compensates?: string;
    };
    planApproval?: PlanApprovalCover;
  } = {}
): Promise<InvokeOutcome> {
  const environmentId = opts.environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const endUser = opts.endUser ?? NO_END_USER;
  if (endUser.required && !endUser.endUserId) throw new EndUserRequiredError();
  const action = await resolveActionRow(workspaceId, ref, environmentId);

  if (!action.enabled) {
    throw new ActionDisabledError(action.name);
  }

  await assertActionsEntitled(workspaceId);

  const identityForPin = opts.traceRunId
    ? await getRunIdentity({ workspaceId, environmentId }, opts.traceRunId)
    : { agentId: null, agentVersionId: null, userId: null };
  const pinned = await resolvePinnedDefinition(action, identityForPin.agentId);
  const spec = governedSpecOf(pinned.definition);
  if (opts.effect && !spec) {
    const used = Object.entries(opts.effect).filter(([, value]) => value !== undefined).map(([key]) => key);
    if (used.length) throw new ValidationError(`${used.join(", ")} only apply to governed actions: those with an adapter or a declaration.`);
  }

  const schema = (pinned.definition.inputSchema as Record<string, unknown>) ?? {};
  const mcpBinding = (pinned.definition as { mcp?: ActionMcpBinding | null }).mcp ?? null;
  if (mcpBinding) {
    const check = schemaCheckOf(mcpBinding);
    if (check === "loose" || Object.keys(schema).length > 0) {
      const result = validateMcpArguments(schema, input, check);
      if (!result.valid) throw new ValidationError(`Invalid input: ${result.errors.join("; ")}`);
    }
  } else if (Object.keys(schema).length > 0) {
    const result = validateAgainstSchema(schema, input);
    if (!result.valid) {
      throw new ValidationError(`Invalid input: ${result.errors.join("; ")}`);
    }
  }

  const identity = identityForPin;

  if (endUser.endUserId) {
    const definition = pinned.definition as GovernableDefinition & { adapter?: ActionAdapterConfig | null };
    const names = definition.adapter
      ? [definition.adapter.credentialSecret]
      : extractSecretNames(definition.urlTemplate, definition.headers, definition.bodyTemplate, definition.declarations?.verify?.url ?? null);
    await assertEndUserConnected(
      { workspaceId, environmentId },
      endUser.endUserId,
      await endUserIntegrationsFor(workspaceId, names, environmentId),
    );
    const upstreamConnection = definition.mcp?.oauthConnection ?? definition.mcp?.endUserKey?.connection;
    if (upstreamConnection) {
      const { liveEndUserUpstream } = await import("../mcp-upstreams/end-user-key.ts");
      const upstream = await liveEndUserUpstream({ workspaceId, environmentId }, upstreamConnection);
      if (upstream) {
        await assertEndUserConnectedToUpstream({ workspaceId, environmentId }, endUser.endUserId, { integrationKey: upstreamConnection, name: upstream.name });
      }
    }
  }

  let draft: EffectAdmissionDraft | null = null;
  if (spec) {
    if (!pinned.actionVersionId) throw new ValidationError("This governed action has no version to bind to.");
    const prepared = await prepareEffectAdmission({
      workspaceId,
      environmentId,
      action,
      actionVersionId: pinned.actionVersionId,
      spec,
      input,
      operationKey: opts.effect?.operationKey ?? opts.idempotency?.key ?? null,
      previewId: opts.effect?.previewId ?? null,
      dependsOn: opts.effect?.dependsOn,
      compensates: opts.effect?.compensates ?? null,
      requestedByKeyId: opts.requestedByKeyId ?? null,
      endUserId: endUser.endUserId,
    });
    if (prepared.kind === "existing") return replayEffectInvocation(prepared.effect.invocationId, action.name);
    draft = prepared.admission;
  }

  const evaluated = await evaluatePolicies(environmentId, {
    kind: "action",
    actionName: action.name,
    agentId: identity.agentId,
    userId: identity.userId,
    ...(draft
      ? policyAmount(draft.impact)
      : { amount: typeof (input as Record<string, unknown>)?.amount === "number" ? (input as Record<string, number>).amount : null }),
    payload: input,
  });
  const decision = endUser.endUserId && !evaluated.matched
    ? withDefaultDecider(evaluated, endUser.endUserId, await endUserDeciderFor(workspaceId))
    : evaluated;

  const governed = applyRiskFloor(pinned.definition.requiresApproval, decision);
  const coveredByPlan = opts.planApproval !== undefined
    && opts.planApproval.actionVersionId === pinned.actionVersionId
    && planApprovalCovers(opts.planApproval, governed, endUser.endUserId);
  const gated = !coveredByPlan && shouldGate(pinned.definition.requiresApproval, governed);

  if (!gated) {
    await checkActionInvokeQuota(workspaceId);
  }

  if (opts.retryOf) await assertRetryable(workspaceId, environmentId, action.id, opts.retryOf, !!opts.idempotency);

  const previewed = draft ? await previewAdmission(draft) : null;
  const admission: EffectAdmission | null = previewed?.admission ?? null;

  const effectId = admission ? generateEffectId() : null;
  const insertInvocation = async (query: Pick<typeof db, "insert">) => {
    const [created] = await query
      .insert(actionInvocations)
      .values({
        workspaceId,
        environmentId,
        actionId: action.id,
        invocationId: generateInvocationId(),
        idempotencyKey: opts.idempotency?.key ?? null,
        idempotencyFingerprint: opts.idempotency?.fingerprint ?? null,
        retryOfInvocationId: opts.retryOf ?? null,
        budgetReservationId: opts.budgetReservationId,
        status: gated ? "pending_approval" : "running",
        input,
        actionVersionId: pinned.actionVersionId,
        definitionSnapshot: {
          method: pinned.definition.method,
          urlTemplate: pinned.definition.urlTemplate,
          headers: pinned.definition.headers,
          bodyTemplate: pinned.definition.bodyTemplate,
          actionVersionId: pinned.actionVersionId,
        },
        requestedByKeyId: opts.requestedByKeyId ?? null,
        traceRunId: opts.traceRunId ?? null,
        traceParentSpanId: opts.traceParentSpanId ?? null,
        effectId,
        endUserId: endUser.endUserId,
        ...(coveredByPlan && opts.planApproval
          ? { approvalId: opts.planApproval.approvalId, decision: planDecision(opts.planApproval.approvalId, opts.planApproval.decidedAt) }
          : {}),
        createdAt: dbUtcNow(),
      })
      .returning();
    if (admission && effectId) await insertEffectIn(query, admission, created, gated, effectId);
    return created;
  };

  let invocation: typeof actionInvocations.$inferSelect;
  try {
    if (gated) {
      const approval = await createActionApproval(workspaceId, {
        action, invocation: insertInvocation, decision: governed,
        requestedByKeyId: opts.requestedByKeyId ?? null, requestedByOAuth: opts.requestedByOAuth ?? null,
        requestedByUserId: opts.requestedByUserId ?? null, environmentId,
        traceRunId: opts.traceRunId, traceParentSpanId: opts.traceParentSpanId,
        endUserId: endUser.endUserId,
        ...(admission ? {
          effect: {
            effectId: effectId!,
            previewId: admission.preview.previewId,
            bindingDigest: admission.preview.bindingDigest,
            expiresAt: admission.preview.expiresAt,
          },
        } : {}),
      });
      const [linked] = await db.select().from(actionInvocations)
        .where(and(eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.approvalId, approval.id)));
      logger.info(
        {
          workspaceId,
          actionId: action.actionId,
          invocationId: linked.invocationId,
          approvalId: approval.id,
          approvalStatus: approval.status,
        },
        approval.status === "pending" ? "Action invocation parked for approval" : "Action invocation auto-decided by policy"
      );
      return withGrade<InvokeOutcome>({ ...toInvocation(linked, action.name), pendingApproval: linked.status === "pending_approval" }, linked.id);
    }
    invocation = admission ? await db.transaction((tx) => insertInvocation(tx)) : await insertInvocation(db);
  } catch (error) {
    if (previewed?.built) await discardUnboundPreview(previewed.admission.preview.id).catch(() => undefined);
    if (admission && isUniqueOn(error, "action_effects_operation_unique")) {
      const winner = await effectByOperationKey(workspaceId, environmentId, admission.operationKey);
      if (winner && isSameOperation(winner, admission.requestDigest, endUser.endUserId)) return replayEffectInvocation(winner.invocationId, action.name);
      throw operationKeyConflict(admission.operationKey);
    }
    if (admission && isUniqueOn(error, "action_effects_preview_unique")) {
      throw new ApiError(409, "PREVIEW_ALREADY_USED", `Preview ${admission.preview.previewId} is already bound to another effect.`);
    }
    if (opts.idempotency && (isIdempotencyCollision(error) || (error instanceof ApiError && error.code === "QUOTA_EXCEEDED"))) {
      const winner = await replayInvocationForKey(workspaceId, environmentId, opts.idempotency.key, opts.idempotency.fingerprint);
      if (winner) return winner;
    }
    if (opts.retryOf && isUniqueOn(error, "action_invocations_retry_of_unique")) {
      throw new ConflictError(`${opts.retryOf} has already been retried. Retry the latest invocation in the chain instead.`);
    }
    throw error;
  }

  const result = await executeInvocation(action, invocation);
  const endUserFailure = endUserFailureOf(result);
  if (endUserFailure) throw endUserFailure;
  return withGrade<InvokeOutcome>({ ...result, pendingApproval: false }, invocation.id);
}

async function replayEffectInvocation(invocationRowId: string, actionName: string): Promise<InvokeOutcome> {
  const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationRowId));
  return withGrade<InvokeOutcome>({ ...toInvocation(row, actionName), pendingApproval: row.status === "pending_approval", replayed: true }, row.id);
}

export async function listInvocations(
  workspaceId: string,
  opts: {
    actionRef?: string; limit?: number; offset?: number; environmentId?: string; status?: InvocationResult["status"];
    endUserId?: string;
    actingFor?: ActingFor;
  } = {}
): Promise<{ invocations: InvocationResult[]; total: number }> {
  const environmentId = opts.environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const action = opts.actionRef ? await resolveActionRow(workspaceId, opts.actionRef, environmentId) : null;

  const where = and(
    eq(actionInvocations.workspaceId, workspaceId),
    eq(actionInvocations.environmentId, environmentId),
    ...(action ? [eq(actionInvocations.actionId, action.id)] : []),
    ...(opts.status ? [eq(actionInvocations.status, opts.status)] : []),
    ...(opts.endUserId ? [eq(actionInvocations.endUserId, opts.endUserId)] : []),
    actingForCondition(actionInvocations.endUserId, opts.actingFor),
  );

  const rows = await db
    .select({ invocation: actionInvocations, actionName: actions.name })
    .from(actionInvocations)
    .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
    .where(where)
    .orderBy(desc(actionInvocations.createdAt), desc(actionInvocations.id))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(actionInvocations)
    .where(where);

  return {
    invocations: rows.map((r) => toInvocation(r.invocation, r.actionName)),
    total,
  };
}

export async function getInvocation(
  workspaceId: string,
  invocationId: string,
  environmentId?: string,
): Promise<InvocationResult> {
  const scopedEnvironmentId = environmentId ?? await getDefaultEnvironmentId(workspaceId);
  const [row] = await db
    .select({ invocation: actionInvocations, actionName: actions.name })
    .from(actionInvocations)
    .innerJoin(actions, eq(actions.id, actionInvocations.actionId))
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.environmentId, scopedEnvironmentId),
        eq(actionInvocations.invocationId, invocationId)
      )
    );

  if (!row) throw new InvocationNotFoundError(invocationId);
  return withGrade(
    { ...toInvocation(row.invocation, row.actionName), ...await invocationLinks(row.invocation.id, row.invocation.invocationId) },
    row.invocation.id,
  );
}
