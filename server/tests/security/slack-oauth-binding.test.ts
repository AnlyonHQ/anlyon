import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  used: false,
  exchanges: 0,
  inserts: 0,
}));

vi.mock("../../src/utils/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/auth.ts")>()),
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const user = headers.get("x-test-user");
        return user ? { user: { id: user, email: `${user}@example.com` } } : null;
      },
    },
  },
}));

vi.mock("../../src/core/workspace/service.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/workspace/service.ts")>()),
  hasWorkspaceAccess: async (_workspaceId: string, userId: string) => userId !== "removed_member",
}));

vi.mock("../../src/core/integrations/slack-service.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/integrations/slack-service.ts")>()),
  exchangeSlackCode: async () => {
    state.exchanges++;
    return { access_token: "xoxb-victim-token", team: { id: "T1", name: "Victim Co" }, bot_user_id: "B1" };
  },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => (state.row ? [state.row] : []) }) }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            if (state.used) return [];
            state.used = true;
            return [{ id: "state_row" }];
          },
        }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => { state.inserts++; return [{ id: "integration_1" }]; } }) }),
    delete: () => ({ where: async () => [] }),
  },
}));

const { Hono } = await import("hono");
const { default: integrationsRouter } = await import("../../src/api/routes/integrations.ts");
const { buildErrorResponse } = await import("../../src/api/middleware/error.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/api/v2/integrations", integrationsRouter);

const callback = (headers: Record<string, string> = {}) =>
  app.request("/api/v2/integrations/slack/callback?code=slack_code&state=abc", { headers });

beforeEach(() => {
  state.row = {
    id: "state_row",
    workspaceId: "11111111-1111-1111-1111-111111111111",
    userId: "initiator",
    provider: "slack",
    state: "abc",
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    redirectUrl: null,
  };
  state.used = false;
  state.exchanges = 0;
  state.inserts = 0;
});

describe("GET /integrations/slack/callback", () => {
  it("completes for the person who started the flow", async () => {
    const response = await callback({ "x-test-user": "initiator" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toContain("error=");
    expect(state.exchanges).toBe(1);
    expect(state.inserts).toBe(1);
  });

  it("refuses a different signed-in user, before exchanging the code", async () => {
    const response = await callback({ "x-test-user": "victim" });
    expect(response.headers.get("location")).toContain("error=");
    expect(state.exchanges).toBe(0);
    expect(state.inserts).toBe(0);
  });

  it("refuses a signed-out browser", async () => {
    const response = await callback();
    expect(response.headers.get("location")).toContain("error=");
    expect(state.exchanges).toBe(0);
  });

  it("refuses the initiator once they have left the workspace", async () => {
    state.row = { ...state.row, userId: "removed_member" };
    await callback({ "x-test-user": "removed_member" });
    expect(state.inserts).toBe(0);
  });

  it("burns a refused state, so the link cannot be retried on someone else", async () => {
    await callback({ "x-test-user": "victim" });
    const retried = await callback({ "x-test-user": "initiator" });
    expect(retried.headers.get("location")).toContain("already%20used");
    expect(state.inserts).toBe(0);
  });
});
