import type { AuditActor } from "./event-schema.ts";

export function deciderActor(ctx: {
  deciderKeyId?: string | null;
  deciderOAuthClientId?: string | null;
  deciderUserId?: string | null;
  assistant?: { model: string };
}): AuditActor {
  if (ctx.assistant) return { type: "assistant", id: null };
  if (ctx.deciderOAuthClientId) return { type: "oauth_client", id: ctx.deciderOAuthClientId, onBehalfOf: ctx.deciderUserId ?? null };
  if (ctx.deciderKeyId) return { type: "api_key", id: ctx.deciderKeyId };
  if (ctx.deciderUserId) return { type: "user", id: ctx.deciderUserId };
  return { type: "system", id: null };
}

export function haltActor(actor: string | undefined | null): AuditActor {
  if (!actor) return { type: "system", id: null };
  if (actor.startsWith("key:")) return { type: "api_key", id: actor.slice(4) };
  return { type: "user", id: actor };
}

export function provenanceActor(actor: { type: "api_key" | "user"; id: string } | undefined): AuditActor {
  return actor ? { type: actor.type, id: actor.id } : { type: "system", id: null };
}
