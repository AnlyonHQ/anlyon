import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/redis.ts", () => ({ redis: {}, RedisKeys: {} }));
import { parseEqFilter } from "../src/core/scim/filter.ts";
import { applyGroupPatch, applyUserPatch } from "../src/core/scim/patch.ts";
import { parsePagination, ScimError, SCIM_SCHEMAS } from "../src/core/scim/protocol.ts";
import { resolveRole } from "../src/core/scim/roles.ts";
import { parseUserBody } from "../src/core/scim/service.ts";
import type { WorkspaceRole } from "../src/core/workspace/provisioned-roles.ts";

const patch = (...Operations: unknown[]) => ({ schemas: [SCIM_SCHEMAS.patchOp], Operations });

describe("filters", () => {
  it("parses the lookups providers send before creating", () => {
    expect(parseEqFilter('userName eq "jane@acme.com"', ["userName", "externalId"])).toEqual({
      attribute: "userName",
      value: "jane@acme.com",
    });
    expect(parseEqFilter('externalid EQ "00u1"', ["userName", "externalId"])).toEqual({ attribute: "externalId", value: "00u1" });
    expect(parseEqFilter(`displayName eq "Eng \\"core\\""`, ["displayName"])).toEqual({
      attribute: "displayName",
      value: 'Eng "core"',
    });
    expect(parseEqFilter(undefined, ["userName"])).toBeNull();
  });

  it("refuses what it does not understand instead of returning everything", () => {
    for (const filter of ['userName sw "j"', 'title eq "x"', 'userName eq "a" and active eq true']) {
      expect(() => parseEqFilter(filter, ["userName", "externalId"])).toThrow(ScimError);
    }
  });
});

describe("user PATCH", () => {
  const state = { userName: "jane@acme.com", externalId: "00u1", active: true };

  it("deactivates with Entra ID's capitalised op and string boolean", () => {
    expect(applyUserPatch(state, patch({ op: "Replace", path: "active", value: "False" })).active).toBe(false);
  });

  it("deactivates with Okta's path-less replace", () => {
    expect(applyUserPatch(state, patch({ op: "replace", value: { active: false } })).active).toBe(false);
  });

  it("changes userName and externalId, and ignores profile attributes it does not store", () => {
    const next = applyUserPatch(
      state,
      patch(
        { op: "Replace", path: "userName", value: "jane.doe@acme.com" },
        { op: "Add", path: 'emails[type eq "work"].value', value: "jane.doe@acme.com" },
        { op: "Replace", path: "name.familyName", value: "Doe" },
        { op: "Remove", path: "externalId" },
      ),
    );
    expect(next).toEqual({ userName: "jane.doe@acme.com", externalId: null, active: true });
  });

  it("refuses a body that is not a PatchOp and a value that is not a boolean", () => {
    expect(() => applyUserPatch(state, { schemas: ["x"], Operations: [] })).toThrow(ScimError);
    expect(() => applyUserPatch(state, patch({ op: "replace", path: "active", value: "nope" }))).toThrow(ScimError);
    expect(() => applyUserPatch(state, patch({ op: "move", path: "active", value: false }))).toThrow(ScimError);
  });
});

describe("group PATCH", () => {
  const state = () => ({ displayName: "Engineering", externalId: null, members: new Set(["u1", "u2"]) });

  it("adds members (Okta and Entra ID)", () => {
    const next = applyGroupPatch(state(), patch({ op: "add", path: "members", value: [{ value: "u3" }] }));
    expect([...next.members].sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("removes by filter path (Okta) and by value list (Entra ID)", () => {
    expect([...applyGroupPatch(state(), patch({ op: "remove", path: 'members[value eq "u1"]' })).members]).toEqual(["u2"]);
    expect([
      ...applyGroupPatch(state(), patch({ op: "Remove", path: "members", value: [{ value: "u2" }] })).members,
    ]).toEqual(["u1"]);
  });

  it("replaces members and renames", () => {
    const next = applyGroupPatch(
      state(),
      patch({ op: "replace", path: "members", value: [{ value: "u9" }] }, { op: "replace", value: { displayName: "Platform" } }),
    );
    expect([...next.members]).toEqual(["u9"]);
    expect(next.displayName).toBe("Platform");
  });

  it("does not mutate the state it was given", () => {
    const original = state();
    applyGroupPatch(original, patch({ op: "remove", path: "members" }));
    expect(original.members.size).toBe(2);
  });
});

describe("user bodies", () => {
  it("reads Okta's create body", () => {
    expect(
      parseUserBody({
        schemas: [SCIM_SCHEMAS.user],
        userName: "jane@acme.com",
        name: { givenName: "Jane", familyName: "Doe" },
        emails: [{ primary: true, value: "jane@acme.com", type: "work" }],
        active: true,
        externalId: "00u1",
      }),
    ).toEqual({ userName: "jane@acme.com", externalId: "00u1", active: true, displayName: "Jane Doe", email: "jane@acme.com" });
  });

  it("reads Entra ID's string boolean and falls back to an email-shaped userName", () => {
    const body = parseUserBody({ userName: "sam@acme.com", active: "False", displayName: "Sam" });
    expect(body.active).toBe(false);
    expect(body.email).toBe("sam@acme.com");
  });

  it("requires userName", () => {
    expect(() => parseUserBody({ emails: [{ value: "x@acme.com" }] })).toThrow(ScimError);
  });
});

describe("pagination", () => {
  it("is 1-based and bounded", () => {
    expect(parsePagination({})).toEqual({ startIndex: 1, count: 100 });
    expect(parsePagination({ startIndex: "0", count: "5000" })).toEqual({ startIndex: 1, count: 200 });
    expect(parsePagination({ startIndex: "11", count: "0" })).toEqual({ startIndex: 11, count: 0 });
  });
});

describe("group-to-role resolution", () => {
  const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
  const role = (name: string) => name as WorkspaceRole;
  const mappings = [
    { groupName: "Engineering", role: role("member"), priority: 0, createdAt: at(1) },
    { groupName: "Anlyon Admins", role: role("admin"), priority: 10, createdAt: at(2) },
    { groupName: "Finance", role: role("approver"), priority: 5, createdAt: at(3) },
  ];

  it("takes the highest priority among the person's groups, case-insensitively", () => {
    expect(resolveRole(["engineering", "ANLYON ADMINS"], mappings, role("member"))).toBe("admin");
    expect(resolveRole(["Engineering", "Finance"], mappings, role("member"))).toBe("approver");
  });

  it("falls back to the directory default", () => {
    expect(resolveRole(["Sales"], mappings, role("viewer"))).toBe("viewer");
    expect(resolveRole([], [], role("member"))).toBe("member");
  });

  it("breaks a priority tie with the older mapping", () => {
    const tied = [
      { groupName: "A", role: role("member"), priority: 1, createdAt: at(1) },
      { groupName: "B", role: role("admin"), priority: 1, createdAt: at(2) },
    ];
    expect(resolveRole(["B", "A"], tied, role("member"))).toBe("member");
  });
});
