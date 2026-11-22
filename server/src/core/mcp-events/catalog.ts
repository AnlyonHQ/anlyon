import type { ApiKeyScope } from "../auth/api-key-scopes.ts";

export const MCP_SUBSCRIPTION_HEADER = "X-MCP-Subscription-Id";

export interface McpEventDefinition {
  name: string;
  description: string;
  platformTypes: readonly string[];
  readScope: ApiKeyScope;
  payloadSchema: Record<string, unknown>;
}

const id = { type: "string" } as const;
const environmentId = { type: "string", description: "The environment the event happened in." } as const;

const approvalPayload = {
  type: "object",
  properties: {
    environmentId,
    approvalId: { type: "string", description: "apr_..." },
    kind: { type: "string", enum: ["action", "custom"] },
    title: id,
  },
  required: ["approvalId"],
} as const;

const invocationPayload = {
  type: "object",
  properties: {
    environmentId,
    actionId: id,
    actionName: id,
    invocationId: { type: "string", description: "inv_..." },
    outcome: { type: "string", enum: ["succeeded", "failed", "unknown"] },
    responseStatus: { type: ["integer", "null"] },
  },
  required: ["invocationId", "outcome"],
} as const;

export const MCP_EVENTS: readonly McpEventDefinition[] = [
  {
    name: "approval.requested",
    description: "A request is waiting for a person to approve or deny it.",
    platformTypes: ["approval.requested"],
    readScope: "approvals:read",
    payloadSchema: {
      ...approvalPayload,
      properties: { ...approvalPayload.properties, expiresAt: { type: "string", format: "date-time" } },
    },
  },
  {
    name: "approval.decided",
    description: "An approval was approved or denied, by an approver or a policy. An approver is a user or an API key.",
    platformTypes: ["approval.approved", "approval.denied"],
    readScope: "approvals:read",
    payloadSchema: {
      ...approvalPayload,
      properties: { ...approvalPayload.properties, decision: { type: "string", enum: ["approved", "denied"] } },
      required: ["approvalId", "decision"],
    },
  },
  {
    name: "approval.expired",
    description: "An approval expired before anyone decided it. A gated action it held is never sent.",
    platformTypes: ["approval.expired"],
    readScope: "approvals:read",
    payloadSchema: approvalPayload,
  },
  {
    name: "action.invocation.completed",
    description: "An action invocation finished with a known outcome: succeeded or failed.",
    platformTypes: ["action.succeeded", "action.failed"],
    readScope: "actions:read",
    payloadSchema: invocationPayload,
  },
  {
    name: "action.invocation.unknown",
    description:
      "An action invocation may have reached its destination but the outcome could not be confirmed. Anlyon does not retry it; a person has to reconcile it.",
    platformTypes: ["action.unknown"],
    readScope: "actions:read",
    payloadSchema: invocationPayload,
  },
  {
    name: "environment.halted",
    description: "An environment was halted: new action dispatch and outbound delivery stop until it is resumed.",
    platformTypes: ["environment.halted"],
    readScope: "actions:read",
    payloadSchema: {
      type: "object",
      properties: { environmentId, slug: id, reason: { type: ["string", "null"] } },
      required: ["environmentId"],
    },
  },
];

const byName = new Map(MCP_EVENTS.map((event) => [event.name, event]));

export function mcpEvent(name: string): McpEventDefinition | undefined {
  return byName.get(name);
}

export function mcpEventData(platformType: string, data: Record<string, unknown>): Record<string, unknown> {
  if (platformType === "approval.approved") return { ...data, decision: "approved" };
  if (platformType === "approval.denied") return { ...data, decision: "denied" };
  if (platformType.startsWith("action.")) {
    const { error: _error, durationMs: _durationMs, ...rest } = data;
    return { ...rest, outcome: platformType.slice("action.".length), responseStatus: data.responseStatus ?? null };
  }
  return data;
}
