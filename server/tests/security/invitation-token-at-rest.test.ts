import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const compared = vi.hoisted(() => [] as unknown[]);

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => {
      compared.push(value);
      return actual.eq(column as never, value as never);
    },
  };
});

vi.mock("../../src/db/index.ts", () => {
  const empty = { from: () => ({ where: async () => [] }) };
  return { db: { select: () => empty } };
});

const { hashInvitationToken, declineInvitation, getInvitationByToken, acceptInvitation } = await import(
  "../../src/core/workspace/invitations.ts"
);
const { redactSensitivePath } = await import("../../src/utils/sensitive-paths.ts");

const TOKEN = "fixture_invitation_token_0000000";

describe("invitation tokens at rest", () => {
  it("hash to 64 lowercase hex characters, the shape the migration treats as done", () => {
    const hashed = hashInvitationToken(TOKEN);
    expect(hashed).toBe(createHash("sha256").update(TOKEN).digest("hex"));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(TOKEN).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["getInvitationByToken", () => getInvitationByToken(TOKEN)],
    ["declineInvitation", () => declineInvitation(TOKEN)],
    ["acceptInvitation", () => acceptInvitation(TOKEN, "user_1")],
  ])("%s looks the invitation up by hash, never by the raw token", async (_name, call) => {
    compared.length = 0;
    await call().catch(() => {});
    expect(compared).toContain(hashInvitationToken(TOKEN));
    expect(compared).not.toContain(TOKEN);
  });
});

describe("redactSensitivePath", () => {
  it("hides invitation tokens in API and console paths", () => {
    expect(redactSensitivePath(`/api/v2/invitations/${TOKEN}`)).toBe("/api/v2/invitations/[token]");
    expect(redactSensitivePath(`/api/v2/invitations/${TOKEN}/accept`)).toBe("/api/v2/invitations/[token]/accept");
    expect(redactSensitivePath(`https://console.anlyon.com/invite/${TOKEN}`)).toBe("https://console.anlyon.com/invite/[token]");
    expect(redactSensitivePath(`GET /api/v2/invitations/${TOKEN}/decline`)).toBe("GET /api/v2/invitations/[token]/decline");
  });

  it("leaves real routes alone", () => {
    expect(redactSensitivePath("/api/v2/invitations/pending")).toBe("/api/v2/invitations/pending");
    expect(redactSensitivePath("/api/v2/workspaces/1b4e28ba-2fa1-11d2-883f-0016d3cca427/invitations")).toBe(
      "/api/v2/workspaces/1b4e28ba-2fa1-11d2-883f-0016d3cca427/invitations",
    );
  });
});
