import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  ASSIGNABLE_ROLES,
  ENVIRONMENT_ROLES,
  ROLES,
  WRITE_ROUTE_EXCEPTIONS,
  guardPermissionFor,
  hasPermission,
  permissionDeniedMessage,
  permissionsFor,
  type Permission,
} from "../src/core/workspace/permissions.ts";

const ADMIN_AND_UP: Permission[] = [
  "workspace.delete",
  "environments.delete",
  "billing.manage",
  "workspace.update",
  "members.manage",
  "keys.manage",
  "environments.manage",
  "environments.resume",
  "notifications.manage",
  "assistant.manage",
  "agents.manage",
  "identity.manage",
  "audit.manage",
  "secret-stores.manage",
  "governance.sign_off",
  "policies.manage",
  "actions.resolve",
  "limits.manage",
  "oauth-apps.manage",
];
const MEMBER_AND_UP: Permission[] = [
  "workspace.read",
  "environments.halt",
  "actions.manage",
  "actions.invoke",
  "connections.manage",
  "integrations.manage",
  "approvals.request",
  "approvals.decide",
  "resources.write",
];

describe("the matrix: admin holds everything, member the day-to-day work", () => {
  it("covers every permission in one of the two tiers", () => {
    expect([...ADMIN_AND_UP, ...MEMBER_AND_UP].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("admin holds everything", () => {
    expect(permissionsFor("admin").sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("the retired owner role holds nothing", () => {
    expect(permissionsFor("owner")).toEqual([]);
  });

  it("member holds the day-to-day permissions only", () => {
    expect(permissionsFor("member").sort()).toEqual([...MEMBER_AND_UP].sort());
  });
});

describe("approver and viewer", () => {
  it("an approver reads and decides approvals, nothing else", () => {
    expect(permissionsFor("approver").sort()).toEqual(["approvals.decide", "workspace.read"]);
  });

  it("a viewer only reads", () => {
    expect(permissionsFor("viewer")).toEqual(["workspace.read"]);
  });

  it.each([
    "actions.manage", "policies.manage", "keys.manage", "members.manage", "resources.write", "approvals.request",
  ] as Permission[])("an approver cannot %s", (permission) => {
    expect(hasPermission("approver", permission)).toBe(false);
  });

  it("an unknown or missing role holds nothing", () => {
    for (const role of [undefined, null, "", "superuser", "OWNER"]) {
      expect(permissionsFor(role)).toEqual([]);
    }
  });
});

describe("assignable roles", () => {
  it("every role can be given, and owner is not a role any more", () => {
    expect(ROLES).not.toContain("owner");
    expect([...ASSIGNABLE_ROLES].sort()).toEqual([...ROLES].sort());
    expect([...ENVIRONMENT_ROLES].sort()).toEqual([...ROLES].sort());
  });
});

describe("refusal messages", () => {
  it("say what the role can do and who to ask", () => {
    expect(permissionDeniedMessage("viewer", "resources.write")).toMatch(/read-only/);
    expect(permissionDeniedMessage("approver", "actions.manage")).toMatch(/decide approvals/);
    expect(permissionDeniedMessage("member", "billing.manage")).toBe("Only a workspace admin can do this.");
    expect(permissionDeniedMessage("member", "workspace.delete")).toBe("Only a workspace admin can do this.");
    expect(permissionDeniedMessage("member", "policies.manage")).toBe("Only a workspace admin can do this.");
    expect(permissionDeniedMessage("viewer", "approvals.decide")).toMatch(/read-only/);
  });
});

describe("the read-only guard", () => {
  it("does not gate reads", () => {
    expect(guardPermissionFor("GET", "/api/v2/actions")).toBeNull();
    expect(guardPermissionFor("HEAD", "/api/v2/actions")).toBeNull();
  });

  it.each([
    ["POST", "/api/v2/actions"],
    ["POST", "/api/v2/actions/refund/invoke"],
    ["PUT", "/api/v2/secrets/STRIPE"],
    ["DELETE", "/api/v2/approval-policies/pol_1"],
    ["POST", "/api/v2/approvals"],
    ["POST", "/api/v2/workspaces/ws/api-keys"],
    ["PATCH", "/api/v2/notifications/n_1/read"],
    ["POST", "/api/v2/environment/halt"],
    ["POST", "/api/v2/events"],
  ])("needs resources.write for %s %s", (method, path) => {
    expect(guardPermissionFor(method, path)).toBe("resources.write");
  });

  it.each([
    ["POST", "/api/v2/approvals/apr_1/approve", "approvals.decide"],
    ["POST", "/api/v2/approvals/apr_1/deny/", "approvals.decide"],
    ["POST", "/api/v2/approval-policies/evaluate", "workspace.read"],
    ["POST", "/api/v2/approval-policies/files/plan", "workspace.read"],
    ["PATCH", "/api/v2/notifications/preferences/me", "workspace.read"],
    ["POST", "/api/v2/workspaces/ws/leave", "workspace.read"],
  ])("lets %s %s through on %s", (method, path, permission) => {
    expect(guardPermissionFor(method, path)).toBe(permission);
  });

  it("an exception matches its method only", () => {
    expect(guardPermissionFor("DELETE", "/api/v2/approvals/apr_1/approve")).toBe("resources.write");
  });

  it("every exception says why it exists", () => {
    for (const exception of WRITE_ROUTE_EXCEPTIONS) expect(exception.why.length).toBeGreaterThan(5);
  });
});

describe("no role check outside the matrix", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && path !== join(SRC, "core", "workspace", "permissions.ts")) files.push(path);
    }
  };
  walk(SRC);

  const FORBIDDEN = [
    /role\s*[!=]==\s*["'](owner|admin|member|approver|viewer)["']/,
    /\[\s*["']owner["']\s*,\s*["']admin["']\s*\]\s*\.includes/,
    /requireRole\(/,
    /roleRank/,
  ];

  it("finds none", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (FORBIDDEN.some((pattern) => pattern.test(line))) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
