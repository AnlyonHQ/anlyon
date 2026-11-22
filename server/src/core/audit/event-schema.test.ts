import { describe, expect, it } from "vitest";
import type { AuditEventRow } from "../../db/schema/audit.ts";
import {
  AUDIT_EVENT_JSON_SCHEMA,
  AUDIT_EVENT_TYPES,
  AUDIT_SCHEMA,
  categoryOf,
  isAuditedPlatformEvent,
  outcomeOf,
  resourceOf,
  toExportEvent,
} from "./event-schema.ts";

function row(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    seq: 42,
    txId: 9001,
    eventId: "aud_abc",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    environmentId: null,
    type: "approval.vote",
    category: "approval",
    outcome: "approve",
    actorType: "oauth_client",
    actorId: "client_1",
    resourceType: "approval",
    resourceId: "apr_1",
    data: { approvalId: "apr_1" },
    backfilled: false,
    context: { requestId: "req_1", ip: "203.0.113.9", onBehalfOf: "user_7" },
    occurredAt: new Date("2026-10-19T00:00:00.000Z"),
    recordedAt: new Date("2026-10-19T00:00:01.000Z"),
    ...overrides,
  };
}

describe("the v1 export event", () => {
  it("has exactly the fields its JSON Schema requires", () => {
    const event = toExportEvent(row());
    expect(Object.keys(event).sort()).toEqual([...AUDIT_EVENT_JSON_SCHEMA.required].sort());
    expect(event.schema).toBe(AUDIT_SCHEMA);
  });

  it("carries the stored id unchanged, so every delivery of a record dedups on the same value", () => {
    expect(toExportEvent(row()).id).toBe("aud_abc");
    expect(toExportEvent(row()).id).toBe(toExportEvent(row()).id);
  });

  it("moves the OAuth user onto the actor and keeps only request metadata in context", () => {
    const event = toExportEvent(row());
    expect(event.actor).toEqual({ type: "oauth_client", id: "client_1", onBehalfOf: "user_7" });
    expect(event.context).toEqual({ requestId: "req_1", ip: "203.0.113.9" });
  });

  it("gives null, not an empty object, for a record with no request context or resource", () => {
    const event = toExportEvent(row({ context: null, resourceType: null, resourceId: null, actorType: "system", actorId: null }));
    expect(event.context).toBeNull();
    expect(event.resource).toBeNull();
    expect(event.actor).toEqual({ type: "system", id: null });
  });
});

describe("the catalogue", () => {
  it("files every listed type under the category it is listed in", () => {
    for (const [category, types] of Object.entries(AUDIT_EVENT_TYPES)) {
      for (const type of types) expect(categoryOf(type), type).toBe(category);
    }
  });

  it("separates invocation outcomes from action definition changes", () => {
    expect(categoryOf("action.failed")).toBe("invocation");
    expect(categoryOf("action.definition.updated")).toBe("action");
  });

  it("takes only connection events and budget alerts from the emitter", () => {
    for (const type of ["secret.disconnected", "secret.connected", "budget.alert"]) {
      expect(isAuditedPlatformEvent(type), type).toBe(true);
    }
    for (const type of [
      "approval.requested", "approval.approved", "action.succeeded", "action.invocation.blocked", "environment.halted",
      "message.delivered", "workflow.run.failed", "memory.ingest.completed", "schedule.fired", "connect.peer.joined",
    ]) {
      expect(isAuditedPlatformEvent(type), type).toBe(false);
    }
  });

  it("marks a backfilled record and only that one", () => {
    expect(toExportEvent(row({ backfilled: true })).backfilled).toBe(true);
    expect(toExportEvent(row())).not.toHaveProperty("backfilled");
  });

  it("derives outcomes and resources from what the platform event carries", () => {
    expect(outcomeOf("approval.denied", {})).toBe("denied");
    expect(outcomeOf("approval.vote", { decision: "deny" })).toBe("deny");
    expect(outcomeOf("action.unknown", {})).toBe("unknown");
    expect(outcomeOf("action.invocation.blocked", {})).toBe("blocked");
    expect(outcomeOf("policy.updated", {})).toBeNull();
    expect(resourceOf("action.succeeded", { invocationId: "inv_1", actionId: "act_1" })).toEqual({ type: "invocation", id: "inv_1" });
    expect(resourceOf("secret.connected", { secretName: "HUBSPOT" })).toEqual({ type: "secret", id: "HUBSPOT" });
    expect(resourceOf("approval.expired", {})).toBeNull();
  });
});
