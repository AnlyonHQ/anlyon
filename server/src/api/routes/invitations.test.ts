import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/auth.ts", () => ({
  requireSession: vi.fn(),
  requireWorkspaceAccess: vi.fn(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../core/workspace/invitations.ts", () => ({
  createInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  declineInvitation: vi.fn(),
  cancelInvitation: vi.fn(),
  resendInvitation: vi.fn(),
  listWorkspaceInvitations: vi.fn(),
  getInvitationByToken: vi.fn(),
  getPendingInvitationsForEmail: vi.fn(),
}));
import workspaceInvitationsRouter, { publicInvitationsRouter } from "./invitations.ts";

function operations(router: { routes: Array<{ method: string; path: string }> }): string[] {
  return [...new Set(router.routes.map((route) => route.method + " " + route.path))].sort();
}

describe("invitation route boundaries", () => {
  it("keeps workspace management routes on the workspace router", () => {
    expect(operations(workspaceInvitationsRouter)).toEqual([
      "DELETE /:workspaceId/invitations/:invitationId",
      "GET /:workspaceId/invitations",
      "POST /:workspaceId/invitations",
      "POST /:workspaceId/invitations/:invitationId/resend",
    ]);
  });

  it("keeps token and current-user routes on the public invitation router", () => {
    expect(operations(publicInvitationsRouter)).toEqual([
      "GET /invitations/:token",
      "GET /invitations/pending",
      "POST /invitations/:token/accept",
      "POST /invitations/:token/decline",
    ]);
  });

  it("registers the static pending route before the token wildcard", () => {
    const routes = publicInvitationsRouter.routes;
    const pendingIndex = routes.findIndex(
      (route) => route.method === "GET" && route.path === "/invitations/pending"
    );
    const tokenIndex = routes.findIndex(
      (route) => route.method === "GET" && route.path === "/invitations/:token"
    );

    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeLessThan(tokenIndex);
  });
});
