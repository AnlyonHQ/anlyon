import { describe, expect, it, vi } from "vitest";

const lookups = vi.hoisted(() => ({ userTable: 0 }));

vi.mock("../../src/db/index.ts", async () => {
  const { user } = await import("../../src/db/schema/user.ts");
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === user) {
              lookups.userTable++;
              return [];
            }
            return [{ role: "admin", userId: "admin_1" }];
          },
        }),
      }),
    },
  };
});

const { addMember } = await import("../../src/core/workspace/members.ts");

describe("addMember by email", () => {
  it.each(["someone@registered.example", "nobody@unregistered.example"])(
    "refuses %s with 410 and never looks the address up",
    async (email) => {
      lookups.userTable = 0;
      await expect(addMember("ws_1", "admin_1", email, "member")).rejects.toMatchObject({
        statusCode: 410,
        code: "USE_INVITATIONS",
      });
      expect(lookups.userTable).toBe(0);
    },
  );
});
