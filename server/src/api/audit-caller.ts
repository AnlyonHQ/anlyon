import type { Context } from "hono";
import type { AuditCaller } from "../core/audit/service.ts";
import { type AuditRecordInput, recordAuditEvent } from "../core/audit/recorder.ts";
import { trustedClientIp } from "./client-ip.ts";

export function auditCaller(c: Context): AuditCaller {
  const authType = c.get("authType") as string | undefined;
  const userId = c.get("userId") as string | undefined;
  let actor: AuditCaller["actor"];
  if (authType === "apiKey") {
    actor = { type: "api_key", id: (c.get("apiKeyId") as string | undefined) ?? null };
  } else if (authType === "oauth") {
    actor = { type: "oauth_client", id: (c.get("oauthClientId") as string | undefined) ?? null, onBehalfOf: userId ?? null };
  } else if (userId) {
    actor = { type: "user", id: userId };
  } else {
    actor = { type: "system", id: null };
  }
  const ip = (c.get("clientIp") as string | undefined) ?? trustedClientIp((name) => c.req.header(name));
  const userAgent = c.req.header("user-agent");
  const requestId = c.get("requestId") as string | undefined;
  return {
    actor,
    context: {
      ...(requestId ? { requestId } : {}),
      ...(ip && ip !== "local" ? { ip } : {}),
      ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}),
    },
  };
}

export function auditRequest(c: Context, input: Omit<AuditRecordInput, "actor" | "context">): void {
  const caller = auditCaller(c);
  recordAuditEvent({ ...input, actor: caller.actor, context: caller.context });
}
