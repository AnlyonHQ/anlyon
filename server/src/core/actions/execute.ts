import { redactCutTail } from "../../utils/redaction.ts";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { dbUtcNow } from "../../db/clock.ts";
import { toPublicDecision, type InvocationDecision } from "../approvals/decision.ts";
import { actions, actionInvocations } from "../../db/schema/actions.ts";
import type { EffectGrade } from "../../db/schema/effects.ts";
import { env } from "../../config/env.ts";
import { createLogger } from "../../lib/logger.ts";
import { safeFetch, SsrfBlockedError } from "../../lib/safe-http.ts";
import { readBodyLimited } from "../../lib/read-body.ts";
import { ValidationError } from "../../utils/errors.ts";
import { validateUrl } from "../../utils/url-validation.ts";
import { reserveActionExecution, recordInvocationOutcome } from "../billing/action-accounting.ts";
import { emitEvent } from "../events/emitter.ts";
import { assertSecretsMayReachHost, loadSecretPolicies, resolveAccountHost, resolveSecrets } from "./secrets.ts";
import { assertSecretDestinationsAllowed } from "./secret-destinations.ts";
import { probeRejectedCredentials } from "../connections/health.ts";
import { outcomeOfDispatchError, outcomeOfResponseStatus } from "./dispatch-errors.ts";

export { outcomeOfDispatchError, outcomeOfResponseStatus };
import { encodeFormBody, wantsFormBody } from "./form-encoding.ts";
import { isEnvironmentHalted } from "../environments/halt.ts";
import { getRunWithTree, ingestSpans } from "../runs/service.ts";
import { executeEffectInvocation } from "../effects/lifecycle.ts";
import { EndUserConnectionError } from "../end-users/errors.ts";
import { markEndUserFailure } from "../end-users/failures.ts";
import {
  applyAccountHost,
  assertAccountHostOnlyInUrl,
  extractSecretNames,
  interpolateObject,
  interpolateUrl,
  interpolateUrlWithStubbedSecrets,
  redactSecrets,
} from "./template.ts";

const logger = createLogger({ module: "actions-execute" });

type ActionRow = typeof actions.$inferSelect;
type InvocationRow = typeof actionInvocations.$inferSelect;

async function recordActionSpan(
  action: ActionRow,
  invocation: InvocationRow,
  startedAt: Date,
  status: "succeeded" | "failed",
  result: { responseBody?: string | null; errorMessage?: string | null; durationMs?: number | null },
): Promise<void> {
  if (!invocation.traceRunId) return;
  try {
    await getRunWithTree({ workspaceId: action.workspaceId, environmentId: action.environmentId }, invocation.traceRunId);
    await ingestSpans({ workspaceId: action.workspaceId, environmentId: action.environmentId }, invocation.traceRunId, [{
      id: `action_${invocation.invocationId}`,
      ...(invocation.traceParentSpanId ? { parentId: invocation.traceParentSpanId } : {}),
      name: action.name,
      type: "action_call",
      status,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      input: invocation.input,
      ...(result.responseBody ? { output: { responseBody: result.responseBody } } : {}),
      ...(result.errorMessage ? { error: { message: result.errorMessage } } : {}),
      attributes: { actionId: action.actionId, invocationId: invocation.invocationId, durationMs: result.durationMs ?? null },
    }]);
  } catch {
  }
}

export interface InvocationResult {
  id: string;
  actionName: string;
  actionVersionId: string | null;
  status: InvocationRow["status"];
  responseStatus: number | null;
  body: string | null;
  error: string | null;
  durationMs: number | null;
  approvalId: string | null;
  decision: InvocationDecision | null;
  retryOf: string | null;
  effectId: string | null;
  grade?: EffectGrade | null;
  retriedBy?: string | null;
  resolution?: InvocationResolutionView | null;
  endUserId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface InvocationResolutionView {
  outcome: "succeeded" | "failed";
  evidence: string;
  externalReference: string | null;
  resolvedBy: { type: "api_key" | "user"; id: string };
  resolvedAt: Date;
}

export function toInvocation(row: InvocationRow, actionName: string): InvocationResult {
  return {
    id: row.invocationId,
    actionName,
    actionVersionId: row.actionVersionId ?? null,
    status: row.status,
    responseStatus: row.responseStatus,
    body: row.responseBody,
    error: row.errorMessage,
    durationMs: row.durationMs,
    approvalId: row.approvalId,
    decision: toPublicDecision(row.decision),
    retryOf: row.retryOfInvocationId ?? null,
    effectId: row.effectId ?? null,
    endUserId: row.endUserId ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

const endUserField = (invocation: InvocationRow) => (invocation.endUserId ? { endUserId: invocation.endUserId } : {});

export function effectiveDefinition(
  action: ActionRow,
  invocation: InvocationRow
): { method: string; urlTemplate: string; headers: Record<string, unknown>; bodyTemplate: Record<string, unknown> | null } {
  const snapshot = invocation.definitionSnapshot as Record<string, unknown> | null;

  if (snapshot && typeof snapshot.urlTemplate === "string") {
    return {
      method: typeof snapshot.method === "string" ? snapshot.method : action.method,
      urlTemplate: snapshot.urlTemplate,
      headers: (snapshot.headers as Record<string, unknown>) ?? {},
      bodyTemplate: (snapshot.bodyTemplate as Record<string, unknown> | null) ?? null,
    };
  }

  return {
    method: action.method,
    urlTemplate: action.urlTemplate,
    headers: (action.headers as Record<string, unknown>) ?? {},
    bodyTemplate: (action.bodyTemplate as Record<string, unknown> | null) ?? null,
  };
}

const notDispatchedHere = new WeakSet<object>();

export function markNotDispatchedHere<T extends object>(result: T): T {
  notDispatchedHere.add(result);
  return result;
}

export function dispatchedByThisCall(result: InvocationResult): boolean {
  return !notDispatchedHere.has(result);
}

export async function executeInvocation(
  action: ActionRow,
  invocation: InvocationRow
): Promise<InvocationResult> {
  const started = performance.now();
  const startedAt = new Date();
  const input = (invocation.input as Record<string, unknown>) ?? {};

  if (invocation.effectId) {
    return executeEffectInvocation(action, invocation);
  }

  if (!await reserveActionExecution(action.workspaceId, invocation.id)) {
    const [existing] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocation.id));
    const lost = toInvocation(existing, action.name);
    notDispatchedHere.add(lost);
    return lost;
  }

  if (await isEnvironmentHalted(action.environmentId)) {
    const blocked = await recordInvocationOutcome(action.workspaceId, invocation.id, {
        status: "failed",
        errorMessage: "Environment is halted: execution blocked by the halt switch",
        completedAt: dbUtcNow(),
      }, "released");
    await recordActionSpan(action, invocation, startedAt, "failed", {
      errorMessage: "environment_halted",
      durationMs: 0,
    });
    emitEvent(action.workspaceId, "action.invocation.blocked", {
      environmentId: action.environmentId,
      actionId: action.actionId,
      invocationId: invocation.invocationId,
      reason: "environment_halted",
      ...endUserField(invocation),
    });
    return toInvocation(blocked, action.name);
  }

  let secrets = new Map<string, string>();
  let receivedStatus: number | null = null;
  let dispatchStarted = false;
  let receivedBody: string | null = null;

  try {
    const definition = effectiveDefinition(action, invocation);
    const headerTemplate = definition.headers;
    const bodyTemplate = definition.bodyTemplate;

    const secretNames = extractSecretNames(definition.urlTemplate, headerTemplate, bodyTemplate);
    const endUser = { endUserId: invocation.endUserId ?? null, required: false };

    const accountHost = await resolveAccountHost(action.workspaceId, secretNames, action.environmentId, endUser);
    assertAccountHostOnlyInUrl(headerTemplate, bodyTemplate);

    const probeUrl = interpolateUrlWithStubbedSecrets(definition.urlTemplate, input, accountHost);

    const check = validateUrl(probeUrl);
    if (!check.valid) {
      throw new SsrfBlockedError(check.error ?? "Resolved URL failed validation");
    }

    if (secretNames.length > 0) {
      await assertSecretsMayReachHost(
        action.workspaceId,
        secretNames,
        probeUrl,
        action.environmentId,
        accountHost,
      );
      assertSecretDestinationsAllowed(
        applyAccountHost(definition.urlTemplate, accountHost),
        definition.headers as Record<string, unknown> | null | undefined,
        definition.bodyTemplate as Record<string, unknown> | null | undefined,
        await loadSecretPolicies(action.workspaceId, secretNames, action.environmentId, accountHost),
      );
    }

    secrets = await resolveSecrets(action.workspaceId, secretNames, action.environmentId, endUser, accountHost);

    const finalUrl = interpolateUrl(definition.urlTemplate, input, secrets, accountHost);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      interpolateObject(headerTemplate, input, secrets)
    )) {
      headers[key] = typeof value === "string" ? value : JSON.stringify(value);
    }

    let body: string | undefined;
    if (definition.method !== "GET" && definition.method !== "DELETE") {
      const payload =
        bodyTemplate !== null
          ? interpolateObject(bodyTemplate, input, secrets, { typed: true })
          : input;
      if (wantsFormBody(headers)) {
        body = encodeFormBody(payload);
      } else {
        body = JSON.stringify(payload);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    dispatchStarted = true;
    const response = await safeFetch(finalUrl, {
      method: definition.method,
      headers,
      body,
      signal: AbortSignal.timeout(env.ACTION_TIMEOUT_MS),
    });

    receivedStatus = response.status;

    let responseBody: string;
    try {
      const read = await readBodyLimited(response, env.ACTION_MAX_RESPONSE_BYTES);
      const cut = read.truncated ? redactCutTail(read.text.replace(/�$/, ""), secrets.values()) : read.text;
      responseBody = redactSecrets(cut, secrets) + (read.truncated ? "…[truncated]" : "");
    } catch (readError) {
      const reason = redactSecrets(
        readError instanceof Error ? readError.message : "unreadable",
        secrets
      ).slice(0, 200);
      responseBody = `[response body unavailable: ${reason}]`;
    }

    receivedBody = responseBody;
    const outcome = outcomeOfResponseStatus(response.status);
    const ok = outcome === "succeeded";
    const durationMs = Math.round(performance.now() - started);

    const updated = await recordInvocationOutcome(action.workspaceId, invocation.id, {
        status: outcome,
        responseStatus: response.status,
        responseBody,
        errorMessage: ok
          ? null
          : outcome === "unknown"
            ? `Upstream returned ${response.status}; the outcome is indeterminate. The destination may have applied this request. Reconcile with the provider before retrying.`
            : `Upstream returned ${response.status}`,
        durationMs,
        completedAt: dbUtcNow(),
      }, outcome === "unknown" ? "unknown" : "billed");

    logger.info(
      {
        workspaceId: action.workspaceId,
        actionId: action.actionId,
        invocationId: invocation.invocationId,
        urlTemplate: action.urlTemplate,
        method: action.method,
        responseStatus: response.status,
        outcome,
        durationMs,
      },
      ok
        ? "Action invocation succeeded"
        : outcome === "unknown"
          ? "Action invocation outcome unknown  the destination reported a server error"
          : "Action invocation failed"
    );

    emitEvent(action.workspaceId, `action.${outcome}`, {
      environmentId: action.environmentId,
      actionId: action.actionId,
      actionName: action.name,
      invocationId: invocation.invocationId,
      responseStatus: response.status,
      durationMs,
      ...endUserField(invocation),
    });

    if (response.status === 401 && secretNames.length > 0 && !invocation.endUserId) {
      probeRejectedCredentials({ workspaceId: action.workspaceId, environmentId: action.environmentId }, secretNames);
    }

    await recordActionSpan(action, invocation, startedAt, ok ? "succeeded" : "failed", updated);

    return toInvocation(updated, action.name);
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = redactSecrets(
      error instanceof Error ? error.message : "Unknown error",
      secrets
    ).slice(0, 1000);

    const answered = receivedStatus !== null ? outcomeOfResponseStatus(receivedStatus) : null;
    const outcome = answered ?? (!dispatchStarted ? "failed" : outcomeOfDispatchError(error));

    const updated = await recordInvocationOutcome(action.workspaceId, invocation.id, {
        status: outcome,
        responseStatus: receivedStatus,
        ...(receivedBody !== null ? { responseBody: receivedBody } : {}),
        errorMessage:
          outcome === "succeeded"
            ? null
            : outcome === "unknown"
              ? `The destination may have received this request; Anlyon cannot confirm the outcome. Reconcile with the provider before retrying. Cause: ${message}`
              : answered === "failed" ? `Upstream returned ${receivedStatus}` : message,
        durationMs,
        completedAt: dbUtcNow(),
      }, outcome === "unknown" ? "unknown" : receivedStatus !== null ? "billed" : "released");

    if (outcome === "succeeded") {
      logger.warn(
        { workspaceId: action.workspaceId, actionId: action.actionId, invocationId: invocation.invocationId, urlTemplate: action.urlTemplate, responseStatus: receivedStatus, error: message, durationMs },
        "Action invocation succeeded; an error after the destination answered was recorded as the success it was"
      );
      emitEvent(action.workspaceId, "action.succeeded", {
        environmentId: action.environmentId,
        actionId: action.actionId,
        actionName: action.name,
        invocationId: invocation.invocationId,
        responseStatus: receivedStatus,
        durationMs,
        ...endUserField(invocation),
      });
      await recordActionSpan(action, invocation, startedAt, "succeeded", updated);
      return toInvocation(updated, action.name);
    }

    logger.warn(
      {
        workspaceId: action.workspaceId,
        actionId: action.actionId,
        invocationId: invocation.invocationId,
        urlTemplate: action.urlTemplate,
        error: message,
        outcome,
        durationMs,
      },
      outcome === "unknown"
        ? "Action invocation outcome unknown  the request may have been received"
        : "Action invocation failed"
    );

    emitEvent(action.workspaceId, outcome === "unknown" ? "action.unknown" : "action.failed", {
      environmentId: action.environmentId,
      actionId: action.actionId,
      actionName: action.name,
      invocationId: invocation.invocationId,
      error: message,
      durationMs,
      ...endUserField(invocation),
    });

    await recordActionSpan(action, invocation, startedAt, "failed", updated);

    const result = toInvocation(updated, action.name);
    if (error instanceof EndUserConnectionError && !dispatchStarted) markEndUserFailure(result, error);
    return result;
  } finally {
    secrets.clear();
  }
}
