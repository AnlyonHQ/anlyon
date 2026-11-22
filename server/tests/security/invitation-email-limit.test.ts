import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const counters = vi.hoisted(() => new Map<string, number>());

vi.mock("../../src/lib/redis.ts", () => ({
  redis: {
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
  },
  RedisKeys: {},
}));

const { INVITATION_EMAILS_PER_HOUR, limitInvitationEmails } = await import("../../src/api/middleware/rateLimit.ts");
const { buildErrorResponse } = await import("../../src/api/middleware/error.ts");

function app() {
  const sent: string[] = [];
  const hono = new Hono();
  hono.onError((err, c) => buildErrorResponse(err, c));
  hono.post("/:workspaceId/invitations", limitInvitationEmails, (c) => {
    sent.push(c.req.param("workspaceId"));
    return c.json({ success: true });
  });
  hono.post("/:workspaceId/invitations/:invitationId/resend", limitInvitationEmails, (c) => {
    sent.push(c.req.param("workspaceId"));
    return c.json({ success: true });
  });
  return { hono, sent };
}

describe("invitation email limit", () => {
  it("refuses the email past the hourly cap, counting creates and resends together", async () => {
    counters.clear();
    const { hono, sent } = app();
    for (let i = 0; i < INVITATION_EMAILS_PER_HOUR; i += 1) {
      const path = i % 2 === 0 ? "/ws_a/invitations" : "/ws_a/invitations/inv_1/resend";
      expect((await hono.request(path, { method: "POST" })).status).toBe(200);
    }
    const refused = await hono.request("/ws_a/invitations/inv_1/resend", { method: "POST" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    expect(sent).toHaveLength(INVITATION_EMAILS_PER_HOUR);
  });

  it("counts each workspace on its own", async () => {
    counters.clear();
    const { hono } = app();
    for (let i = 0; i < INVITATION_EMAILS_PER_HOUR; i += 1) {
      await hono.request("/ws_a/invitations", { method: "POST" });
    }
    expect((await hono.request("/ws_b/invitations", { method: "POST" })).status).toBe(200);
  });
});
