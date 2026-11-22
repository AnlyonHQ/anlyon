import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { generatePreviewId } from "../../utils/crypto.ts";
import { env } from "../../config/env.ts";
import { actions } from "../../db/schema/actions.ts";
import { actionEffects, effectPreviews, type EffectPreview } from "../../db/schema/effects.ts";
import { ApiError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import type { AnyEffectAdapter, ImpactQuantity, NormalizedOperation, PreviewBlock } from "./adapter.ts";
import { bindingDigest, requestDigest } from "./binding.ts";
import { adapterFromSpec, buildAdapterContext, configForCall, environmentIdentity, type CredentialScope, type EnvironmentIdentity, type GovernedSpec } from "./context.ts";
import { describeAllowances } from "./impact.ts";

export const DEFAULT_PREVIEW_TTL_SECONDS = 3600;
export const MAX_PREVIEW_TTL_SECONDS = 7 * 24 * 3600;
export const MIN_PREVIEW_TTL_SECONDS = 60;

export function implicitPreviewTtlSeconds(approvalWindowHours: number = env.APPROVAL_DEFAULT_TTL_HOURS): number {
  return Math.min(Math.max(approvalWindowHours * 3600, MIN_PREVIEW_TTL_SECONDS), MAX_PREVIEW_TTL_SECONDS);
}

type ActionLike = { id: string; actionId: string; name: string; workspaceId: string; environmentId: string; description?: string | null };

export interface PreviewSource {
  action: ActionLike;
  actionVersionId: string;
  spec: GovernedSpec;
}

export interface PreviewView {
  id: string;
  action: { id: string; name: string; versionId: string };
  adapter: { type: string; version: string };
  environment: EnvironmentIdentity;
  target: Record<string, unknown>;
  request: Record<string, unknown>;
  impact: ImpactQuantity[];
  blocks: PreviewBlock[];
  preconditions: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  allowances: Array<Record<string, unknown>>;
  evidenceObservedAt: Date;
  expiresAt: Date;
  expired: boolean;
  requestDigest: string;
  bindingDigest: string;
  supersedes: string | null;
  effectId: string | null;
  endUserId: string | null;
  createdAt: Date;
}

export async function normalizeFor(adapter: AnyEffectAdapter, config: unknown, input: Record<string, unknown>, scope: CredentialScope) {
  const operation: NormalizedOperation = adapter.normalize(await configForCall(scope, adapter, config), input);
  const impact = adapter.describeImpact(operation);
  return { operation, impact };
}

function quantityText(q: ImpactQuantity): string {
  const bound = q.bound === "exact" ? "" : "up to ";
  if (q.dimension === "money") return `${bound}${q.amount} ${(q.currency ?? "").toUpperCase()} minor units`;
  if (q.dimension === "resource_mutations") return `${bound}${q.amount} resource mutation${q.amount === 1 ? "" : "s"}`;
  return `${bound}${q.amount} ${unitText(q.dimension, q.amount)}`;
}

export function unitText(dimension: string, amount: number): string {
  if (amount !== 1 || !/[^s]s$/.test(dimension)) return dimension;
  return dimension.slice(0, -1);
}

export const EXECUTION_TARGET_TITLE = "Execution target";

function coreBlocks(input: {
  environment: EnvironmentIdentity;
  action: ActionLike;
  actionVersionId: string;
  adapter: AnyEffectAdapter;
  operation: NormalizedOperation;
  impact: ImpactQuantity[];
  evidenceObservedAt: Date;
  expiresAt: Date;
}): { head: PreviewBlock; impact: PreviewBlock; limitations: PreviewBlock } {
  const caps = input.adapter.capabilities;
  const items: Array<{ kind: "unsupported" | "guarantee" | "irreversible" | "freshness"; text: string }> = [];
  items.push({
    kind: caps.conditionalMutation.supported ? "guarantee" : "freshness",
    text: caps.conditionalMutation.supported
      ? `Stale-state protection: ${caps.conditionalMutation.description}`
      : `No atomic stale-state protection: ${caps.conditionalMutation.description}`,
  });
  items.push({ kind: "guarantee", text: `Exact request: the reviewed request is the one dispatched; any change needs a new preview and approval.` });
  items.push({ kind: caps.idempotency.supported ? "guarantee" : "unsupported", text: `Idempotency: ${caps.idempotency.description}` });
  items.push({ kind: caps.outcomeLookup.supported ? "guarantee" : "unsupported", text: `Recovery: ${caps.outcomeLookup.description}` });
  if (!caps.reversible.supported) items.push({ kind: "irreversible", text: caps.reversible.description });
  else items.push({ kind: "guarantee", text: `Reversal: ${caps.compensation.description}` });
  for (const text of caps.unsupported) items.push({ kind: "unsupported", text: `Not supported: ${text}` });

  return {
    head: {
      type: "fields",
      title: EXECUTION_TARGET_TITLE,
      fields: [
        { label: "Environment", value: `${input.environment.name} (${input.environment.kind})` },
        { label: "Target account", value: input.operation.target.account },
        { label: "Resource", value: input.operation.target.resourceKey },
        { label: "Action", value: `${input.action.name} @ ${input.actionVersionId}` },
        ...(input.action.description ? [{ label: "Action notes", value: input.action.description }] : []),
        { label: "Adapter", value: `${input.adapter.type} v${input.adapter.version}` },
        { label: "Success means", value: input.adapter.successDefinition },
        { label: "Evidence observed", value: input.evidenceObservedAt.toISOString() },
        { label: "Preview expires", value: input.expiresAt.toISOString() },
      ],
    },
    impact: {
      type: "impact",
      title: `Expected impact: ${[
        ...input.impact.map(quantityText),
        ...caps.impactDimensions.filter((d) => !input.impact.some((q) => q.dimension === d)).map((d) => `no bound for ${d}`),
      ].join(", ") || "none"}`,
      quantities: input.impact,
    },
    limitations: { type: "limitations", title: "What is supported and what is not", items },
  };
}

export async function buildPreview(
  source: PreviewSource,
  input: Record<string, unknown>,
  opts: { requestedByKeyId?: string | null; ttlSeconds?: number; supersedes?: string | null; endUserId?: string | null } = {},
): Promise<EffectPreview> {
  const { action, actionVersionId, spec } = source;
  const ttl = opts.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < MIN_PREVIEW_TTL_SECONDS || ttl > MAX_PREVIEW_TTL_SECONDS) {
    throw new ValidationError(`ttlSeconds must be between ${MIN_PREVIEW_TTL_SECONDS} and ${MAX_PREVIEW_TTL_SECONDS}.`);
  }
  const { adapter, config } = adapterFromSpec(spec);
  const scope = { workspaceId: action.workspaceId, environmentId: action.environmentId };
  const { operation, impact } = await normalizeFor(adapter, config, input, { ...scope, endUserId: opts.endUserId ?? null });
  const ctx = await buildAdapterContext({ ...scope, endUserId: opts.endUserId ?? null }, adapter, config, spec, "preview");
  const draft = await adapter.preparePreview(ctx, operation);
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + ttl * 1000);
  const target = operation.target as unknown as Record<string, unknown>;
  const reqDigest = requestDigest({ actionName: action.name, adapterType: adapter.type, request: operation.request, target });
  const binding = bindingDigest({
    ...scope,
    requestDigest: reqDigest,
    target,
    actionVersionId,
    adapterType: adapter.type,
    adapterVersion: adapter.version,
    preconditions: draft.preconditions,
    expiresAt,
  });
  const allowances = await describeAllowances({
    ...scope,
    actionName: action.name,
    resourceKey: operation.target.resourceKey,
    impact,
    dimensions: adapter.capabilities.impactDimensions,
    endUserId: opts.endUserId ?? null,
  });
  const blocks = coreBlocks({
    environment: ctx.environment, action, actionVersionId, adapter, operation, impact,
    evidenceObservedAt: draft.evidence.observedAt, expiresAt,
  });
  const [row] = await db.insert(effectPreviews).values({
    ...scope,
    actionId: action.id,
    previewId: generatePreviewId(),
    actionName: action.name,
    actionVersionId,
    adapterType: adapter.type,
    adapterVersion: adapter.version,
    requestDigest: reqDigest,
    bindingDigest: binding,
    targetAccount: operation.target.account,
    resourceKey: operation.target.resourceKey,
    target,
    request: operation.request,
    input,
    impact: impact as unknown as Array<Record<string, unknown>>,
    evidence: { ...draft.evidence, observedAt: draft.evidence.observedAt.toISOString() },
    blocks: [blocks.head, ...draft.blocks, blocks.impact, blocks.limitations] as unknown as Array<Record<string, unknown>>,
    preconditions: draft.preconditions,
    capabilities: adapter.capabilities as unknown as Record<string, unknown>,
    allowances,
    evidenceObservedAt: draft.evidence.observedAt,
    expiresAt,
    supersedesPreviewId: opts.supersedes ?? null,
    requestedByKeyId: opts.requestedByKeyId ?? null,
    endUserId: opts.endUserId ?? null,
  }).returning();
  return row;
}

export function recomputeBinding(preview: EffectPreview): string {
  return bindingDigest({
    workspaceId: preview.workspaceId,
    environmentId: preview.environmentId,
    requestDigest: preview.requestDigest,
    target: preview.target,
    actionVersionId: preview.actionVersionId,
    adapterType: preview.adapterType,
    adapterVersion: preview.adapterVersion,
    preconditions: preview.preconditions,
    expiresAt: preview.expiresAt,
  });
}

export async function previewRow(workspaceId: string, environmentId: string, previewId: string): Promise<EffectPreview> {
  const [row] = await db.select().from(effectPreviews).where(and(
    eq(effectPreviews.workspaceId, workspaceId),
    eq(effectPreviews.environmentId, environmentId),
    eq(effectPreviews.previewId, previewId),
  ));
  if (!row) throw new NotFoundError("Preview");
  return row;
}

export async function toPreviewView(row: EffectPreview, now = new Date()): Promise<PreviewView> {
  const [bound] = await db.select({ effectId: actionEffects.effectId }).from(actionEffects)
    .where(eq(actionEffects.previewId, row.id)).limit(1);
  const actionPublic = await actionPublicId(row.actionId);
  return {
    id: row.previewId,
    action: { id: actionPublic, name: row.actionName, versionId: row.actionVersionId },
    adapter: { type: row.adapterType, version: row.adapterVersion },
    environment: await environmentIdentity(row.environmentId),
    target: row.target,
    request: row.request,
    impact: row.impact as unknown as ImpactQuantity[],
    blocks: row.blocks as unknown as PreviewBlock[],
    preconditions: row.preconditions,
    capabilities: row.capabilities,
    allowances: row.allowances,
    evidenceObservedAt: row.evidenceObservedAt,
    expiresAt: row.expiresAt,
    expired: row.expiresAt.getTime() <= now.getTime(),
    requestDigest: row.requestDigest,
    bindingDigest: row.bindingDigest,
    supersedes: row.supersedesPreviewId,
    effectId: bound?.effectId ?? null,
    endUserId: row.endUserId ?? null,
    createdAt: row.createdAt,
  };
}

async function actionPublicId(actionRowId: string): Promise<string> {
  const [row] = await db.select({ actionId: actions.actionId }).from(actions).where(eq(actions.id, actionRowId));
  return row?.actionId ?? "";
}

export async function assertPreviewMatches(
  preview: EffectPreview,
  expected: { actionRowId: string; actionVersionId: string; adapter: AnyEffectAdapter; requestDigest: string; endUserId?: string | null },
): Promise<void> {
  const mismatch = (field: string, message: string) =>
    new ApiError(409, "PREVIEW_MISMATCH", `Preview ${preview.previewId} does not match this invocation: ${message}`, { field });
  if (preview.actionId !== expected.actionRowId) throw mismatch("action", "it previews another action.");
  if ((preview.endUserId ?? null) !== (expected.endUserId ?? null)) throw mismatch("endUser", "it was prepared for another end user, or for none.");
  if (preview.actionVersionId !== expected.actionVersionId) {
    throw mismatch("actionVersion", `it reviewed ${preview.actionVersionId}; this invocation runs ${expected.actionVersionId}.`);
  }
  if (preview.adapterType !== expected.adapter.type || preview.adapterVersion !== expected.adapter.version) {
    throw mismatch("adapterVersion", "the adapter has changed since review.");
  }
  if (preview.requestDigest !== expected.requestDigest) throw mismatch("request", "the destination, resource, amount or content differs.");
  if (recomputeBinding(preview) !== preview.bindingDigest) throw mismatch("binding", "its binding does not verify.");
  if (preview.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(409, "PREVIEW_EXPIRED", `Preview ${preview.previewId} expired at ${preview.expiresAt.toISOString()}. Create a new preview.`);
  }
  const [bound] = await db.select({ effectId: actionEffects.effectId }).from(actionEffects)
    .where(eq(actionEffects.previewId, preview.id)).limit(1);
  if (bound) throw new ApiError(409, "PREVIEW_ALREADY_USED", `Preview ${preview.previewId} is already bound to ${bound.effectId}.`);
}
