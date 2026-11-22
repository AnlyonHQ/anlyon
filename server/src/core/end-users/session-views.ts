import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { effectPreviews } from "../../db/schema/effects.ts";
import { findIntegration } from "../connections/catalogue.ts";
import type { ApprovalView } from "../approvals/service.ts";
import type { ImpactQuantity, PreviewBlock } from "../effects/adapter.ts";
import { HTTP_DECLARED_TYPE } from "../effects/adapters/http-declared.ts";
import { MCP_TOOL_TYPE } from "../effects/adapters/mcp-tool.ts";
import { EXECUTION_TARGET_TITLE } from "../effects/previews.ts";
import type { EndUserConnectionView } from "./connections.ts";

type Scope = { workspaceId: string; environmentId: string };

export interface SessionApprovalPreview {
  target: { account: string | null; display: Record<string, string> };
  blocks: PreviewBlock[];
  impact: ImpactQuantity[];
  reversible: boolean;
  undo: string;
  expiresAt: Date;
}

const OPERATOR_FIELD_LABELS = new Set(["Reviewed blob", "HTML body", "Sending domain", "Fault drill", "Read-back"]);

const REQUEST_ONLY_ADAPTERS = new Set([HTTP_DECLARED_TYPE, MCP_TOOL_TYPE]);

export function endUserBlocks(blocks: PreviewBlock[], adapterType: string): PreviewBlock[] {
  if (REQUEST_ONLY_ADAPTERS.has(adapterType)) return [];
  return blocks.flatMap((block): PreviewBlock[] => {
    if (block.type === "limitations" || block.type === "impact") return [];
    if (block.type !== "fields") return [block];
    if (block.title === EXECUTION_TARGET_TITLE) return [];
    const fields = block.fields.filter((field) => !OPERATOR_FIELD_LABELS.has(field.label));
    return fields.length > 0 ? [{ ...block, fields }] : [];
  });
}

export function endUserUndo(capabilities: Record<string, unknown>): { reversible: boolean; undo: string } {
  const claim = capabilities.reversible as { supported?: unknown } | undefined;
  const reversible = claim?.supported === true;
  return { reversible, undo: reversible ? "This can be undone later." : "This can't be undone once it runs." };
}

export interface SessionApprovalView {
  id: string;
  kind: ApprovalView["kind"];
  status: ApprovalView["status"];
  title: string;
  description: string | null;
  actionName: string | null;
  input: Record<string, unknown> | null;
  preview: SessionApprovalPreview | null;
  decisionNote: string | null;
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
}

const INTERNAL_PAYLOAD_KEYS = new Set([
  "invocationId", "actionId", "actionName", "method", "urlTemplate", "endUserId",
  "environmentId", "effectId", "previewId", "bindingDigest",
]);

function inputOf(approval: ApprovalView): Record<string, unknown> | null {
  const payload = approval.payload ?? {};
  if (approval.kind === "action") {
    const input = payload.input;
    return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  }
  const rest = Object.fromEntries(Object.entries(payload).filter(([key]) => !INTERNAL_PAYLOAD_KEYS.has(key)));
  return Object.keys(rest).length > 0 ? rest : null;
}

function displayOf(target: Record<string, unknown>, adapterType: string): SessionApprovalPreview["target"] {
  const display = target.display && typeof target.display === "object" ? (target.display as Record<string, unknown>) : {};
  return {
    account: typeof target.account === "string" && !REQUEST_ONLY_ADAPTERS.has(adapterType) ? target.account : null,
    display: Object.fromEntries(Object.entries(display).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

export async function sessionApprovalViews(scope: Scope, endUserId: string, approvals: ApprovalView[]): Promise<SessionApprovalView[]> {
  const previewIds = [...new Set(approvals.map((a) => a.payload?.previewId).filter((id): id is string => typeof id === "string"))];
  const previews = previewIds.length === 0 ? [] : await db.select({
    previewId: effectPreviews.previewId,
    target: effectPreviews.target,
    blocks: effectPreviews.blocks,
    impact: effectPreviews.impact,
    adapterType: effectPreviews.adapterType,
    capabilities: effectPreviews.capabilities,
    expiresAt: effectPreviews.expiresAt,
  }).from(effectPreviews).where(and(
    eq(effectPreviews.workspaceId, scope.workspaceId),
    eq(effectPreviews.environmentId, scope.environmentId),
    eq(effectPreviews.endUserId, endUserId),
    inArray(effectPreviews.previewId, previewIds),
  ));
  const byId = new Map(previews.map((p) => [p.previewId, p]));

  return approvals.map((approval) => {
    const preview = typeof approval.payload?.previewId === "string" ? byId.get(approval.payload.previewId) : undefined;
    const actionName = approval.kind === "action" && typeof approval.payload?.actionName === "string" ? approval.payload.actionName : null;
    return {
      id: approval.id,
      kind: approval.kind,
      status: approval.status,
      title: approval.title,
      description: approval.description,
      actionName,
      input: inputOf(approval),
      preview: preview
        ? {
          target: displayOf(preview.target, preview.adapterType),
          blocks: endUserBlocks(preview.blocks as unknown as PreviewBlock[], preview.adapterType),
          impact: preview.impact as unknown as ImpactQuantity[],
          ...endUserUndo(preview.capabilities ?? {}),
          expiresAt: preview.expiresAt,
        }
        : null,
      decisionNote: approval.decisionNote,
      expiresAt: approval.expiresAt,
      decidedAt: approval.decidedAt,
      createdAt: approval.createdAt,
    };
  });
}

export interface SessionConnectionView extends EndUserConnectionView {
  displayName: string;
}

export function sessionConnectionView(view: EndUserConnectionView): SessionConnectionView {
  return { ...view, displayName: findIntegration(view.integration)?.displayName ?? view.integration };
}
