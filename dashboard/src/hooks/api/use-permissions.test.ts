import { describe, expect, it } from "vitest";
import type { WorkspacePermissions } from "@/lib/types";
import { canWith, ENVIRONMENT_SCOPED_PERMISSIONS } from "./use-permissions";

const PROD = "env_prod";
const STAGING = "env_staging";

const viewerApproverInProd: WorkspacePermissions = {
	role: "viewer",
	permissions: ["workspace.read"],
	environmentRolesEnabled: true,
	environments: [
		{
			environmentId: PROD,
			role: "approver",
			granted: true,
			permissions: ["approvals.decide", "workspace.read"],
		},
		{
			environmentId: STAGING,
			role: "viewer",
			granted: false,
			permissions: ["workspace.read"],
		},
	],
};

const adminViewerInProd: WorkspacePermissions = {
	role: "admin",
	permissions: [
		"workspace.read",
		"members.manage",
		"keys.manage",
		"resources.write",
		"actions.manage",
		"approvals.decide",
	],
	environmentRolesEnabled: true,
	environments: [
		{
			environmentId: PROD,
			role: "viewer",
			granted: true,
			permissions: ["keys.manage", "members.manage", "workspace.read"],
		},
	],
};

describe("canWith", () => {
	it("allows while the permissions are unknown: the server still checks", () => {
		expect(canWith(undefined, "billing.manage")).toBe(true);
	});

	it("reads an environment-scoped permission from that environment", () => {
		expect(canWith(viewerApproverInProd, "approvals.decide", PROD)).toBe(true);
		expect(canWith(viewerApproverInProd, "approvals.decide", STAGING)).toBe(
			false,
		);
	});

	it("uses the default environment when none is named", () => {
		expect(canWith(viewerApproverInProd, "approvals.decide", null, PROD)).toBe(
			true,
		);
		expect(
			canWith(viewerApproverInProd, "approvals.decide", undefined, STAGING),
		).toBe(false);
	});

	it("falls back to the workspace role for an environment it does not list", () => {
		expect(canWith(adminViewerInProd, "actions.manage", "env_new")).toBe(true);
		expect(canWith(viewerApproverInProd, "approvals.decide")).toBe(false);
	});

	it("a grant narrows environment work but not workspace administration", () => {
		expect(canWith(adminViewerInProd, "actions.manage", PROD)).toBe(false);
		expect(canWith(adminViewerInProd, "resources.write", PROD)).toBe(false);
		expect(canWith(adminViewerInProd, "members.manage", PROD)).toBe(true);
		expect(canWith(adminViewerInProd, "keys.manage")).toBe(true);
	});

	it("a viewer changes nothing", () => {
		expect(canWith(viewerApproverInProd, "billing.manage")).toBe(false);
		expect(canWith(viewerApproverInProd, "members.manage")).toBe(false);
		expect(canWith(viewerApproverInProd, "actions.invoke", STAGING)).toBe(
			false,
		);
	});

	it("mirrors the server's environment-scoped permissions", () => {
		expect([...ENVIRONMENT_SCOPED_PERMISSIONS].sort()).toEqual(
			[
				"actions.invoke",
				"actions.manage",
				"actions.resolve",
				"approvals.decide",
				"approvals.request",
				"connections.manage",
				"oauth-apps.manage",
				"environments.halt",
				"environments.resume",
				"limits.manage",
				"policies.manage",
				"resources.write",
			].sort(),
		);
	});
});
