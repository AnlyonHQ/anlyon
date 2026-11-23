import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const addMember = vi.hoisted(() => vi.fn());

vi.mock("../../src/api/middleware/auth.ts", () => {
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  const session = async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("authType", "session");
    c.set("userId", "user_admin");
    await next();
  };
  return { requireSession: session, requireWorkspaceAccess: pass, requirePermission: () => pass };
});
vi.mock("../../src/core/workspace/members.ts", () => ({
  addMember, updateMemberRole: vi.fn(), removeMember: vi.fn(), leaveWorkspace: vi.fn(),
  handOverEmergencyAccess: vi.fn(), setEmergencyAccess: vi.fn(), getMemberDetails: vi.fn(), listMembersWithDetails: vi.fn(),
}));

const { default: members } = await import("../../src/api/routes/members.ts");
const { buildErrorResponse } = await import("../../src/api/middleware/error.ts");

const app = new Hono();
app.onError((error, c) => buildErrorResponse(error, c));
app.route("/api/v2/workspaces", members);

describe("POST /workspaces/:id/members", () => {
  it.each([{ userId: "user_victim" }, { userId: "user_victim", role: "viewer" }, { userId: "someone@example.com" }])(
    "refuses %o with 410 and adds nobody",
    async (body) => {
      const response = await app.request("/api/v2/workspaces/11111111-1111-4111-8111-111111111111/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(410);
      expect(JSON.stringify(await response.json())).toContain("USE_INVITATIONS");
      expect(addMember).not.toHaveBeenCalled();
    },
  );
});
