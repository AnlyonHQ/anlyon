import { describe, expect, it } from "vitest";
import type { InstanceSetting } from "@/hooks/api/use-instance";
import {
	checkSettingValue,
	combineStatus,
	configuredOAuthApps,
	groupStatus,
	ownerProblems,
	systemChecks,
} from "./instance-onboarding";

function setting(
	key: string,
	patch: Partial<InstanceSetting> = {},
): InstanceSetting {
	const group = key.split(".")[0] as InstanceSetting["group"];
	return {
		key,
		group,
		label: key,
		description: "",
		secret: false,
		value: null,
		set: false,
		source: "unset",
		env: key.toUpperCase(),
		default: null,
		updatedAt: null,
		updatedBy: null,
		...patch,
	};
}

const saved = (value: string, at = "2026-10-19T10:00:00.000Z") => ({
	value,
	set: true,
	source: "database" as const,
	updatedAt: at,
	updatedBy: "usr_1",
});

describe("groupStatus", () => {
	it("mcp: the default, then what was set", () => {
		const key = "mcp.tool_check_interval_hours";
		expect(groupStatus("mcp", [setting(key, { default: "24" })])).toMatchObject(
			{ tone: "idle", label: "Default", detail: "Every 24 hours" },
		);
		expect(groupStatus("mcp", [setting(key, saved("1"))])).toMatchObject({
			tone: "ok",
			label: "Configured",
			detail: "Every 1 hour",
		});
		expect(
			groupStatus("mcp", [
				setting(key, { value: "6", set: true, source: "environment" }),
			]),
		).toMatchObject({ label: "Set by environment", detail: "Every 6 hours" });
	});

	it("network: left to the workspaces by default, then what an admin chose", () => {
		const key = "network.private_destinations";
		expect(
			groupStatus("network", [
				setting(key, { default: "workspace", value: "workspace" }),
			]),
		).toMatchObject({
			tone: "idle",
			label: "Default",
			detail: "Workspace admins decide on private destinations",
		});
		expect(groupStatus("network", [setting(key, saved("off"))])).toMatchObject({
			tone: "ok",
			label: "Configured",
			detail: "Private network destinations off",
		});
		expect(
			groupStatus("network", [
				setting(key, { value: "off", set: true, source: "environment" }),
			]),
		).toMatchObject({
			label: "Set by environment",
			detail: "Private network destinations off",
		});
	});

	it("email: off, incomplete, configured", () => {
		const off = [
			setting("email.smtp_url", { secret: true }),
			setting("email.from"),
		];
		expect(groupStatus("email", off)).toMatchObject({
			tone: "idle",
			label: "Not configured",
		});
		const half = [
			setting("email.smtp_url", {
				secret: true,
				set: true,
				source: "database",
			}),
			setting("email.from"),
		];
		expect(groupStatus("email", half)).toMatchObject({
			tone: "warn",
			detail: "Needs a sender address",
		});
		const full = [
			setting("email.smtp_url", {
				secret: true,
				set: true,
				source: "database",
				updatedAt: "2026-10-18T10:00:00.000Z",
				updatedBy: "usr_2",
			}),
			setting("email.from", saved("ops@acme.example")),
		];
		expect(groupStatus("email", full)).toMatchObject({
			tone: "ok",
			label: "Configured",
			detail: "Sends as ops@acme.example",
			updatedAt: "2026-10-19T10:00:00.000Z",
			updatedBy: "usr_1",
		});
	});

	it("says when the environment sets every value in force", () => {
		const env = [
			setting("storage.backend", {
				value: "s3",
				set: true,
				source: "environment",
			}),
			setting("storage.s3_bucket", {
				value: "logs",
				set: true,
				source: "environment",
			}),
		];
		expect(groupStatus("storage", env)).toMatchObject({
			tone: "ok",
			label: "Set by environment",
			fromEnvironment: true,
			detail: "S3 bucket logs",
		});
		const noBucket = [setting("storage.backend", saved("s3"))];
		expect(groupStatus("storage", noBucket).tone).toBe("warn");
	});

	it("sign-up and telemetry at their defaults are grey, open sign-up is amber", () => {
		expect(
			groupStatus("accounts", [
				setting("accounts.signup_mode", {
					default: "invite",
					source: "default",
				}),
			]),
		).toMatchObject({ tone: "idle", label: "Default", detail: "Invite only" });
		expect(
			groupStatus("accounts", [setting("accounts.signup_mode", saved("open"))])
				.tone,
		).toBe("warn");
		expect(
			groupStatus("telemetry", [setting("telemetry.enabled", saved("false"))]),
		).toMatchObject({ tone: "idle", detail: "Off" });
	});

	it("OAuth apps count only complete pairs, and a half pair is incomplete", () => {
		const list = [
			setting("oauth.hubspot.client_id", saved("x")),
			setting("oauth.hubspot.client_secret", {
				secret: true,
				set: true,
				source: "database",
			}),
			setting("oauth.linear.client_id", saved("y")),
			setting("oauth.linear.client_secret", { secret: true }),
		];
		expect(configuredOAuthApps(list)).toEqual(["HubSpot"]);
		expect(groupStatus("oauth", list)).toMatchObject({ tone: "warn" });
	});

	it("combines two groups, the less settled first", () => {
		const a = groupStatus("oauth", []);
		const b = groupStatus("slack", [setting("slack.client_id", saved("x"))]);
		expect(combineStatus(a, b).tone).toBe("warn");
	});
});

describe("systemChecks", () => {
	it("is grey while checking and before sign-in, never green by guess", () => {
		const checks = systemChecks({}, undefined);
		expect(checks.map((c) => c.tone)).toEqual([
			"idle",
			"idle",
			"idle",
			"idle",
			"idle",
		]);
		expect(checks[3]!.detail).toBe("After sign-in");
	});

	it("marks the services the server reports down", () => {
		const checks = systemChecks(
			{ api: true, database: true, redis: false },
			[],
		);
		expect(checks.find((c) => c.id === "redis")).toMatchObject({
			tone: "warn",
			detail: "Not reachable",
		});
		expect(checks.find((c) => c.id === "database")!.tone).toBe("ok");
	});

	it("an API that does not answer takes the database and Redis with it", () => {
		const checks = systemChecks({ api: false }, undefined);
		expect(checks.slice(0, 3).every((c) => c.tone === "warn")).toBe(true);
	});
});

describe("checkSettingValue", () => {
	it("holds the check interval to whole hours, 1 to 168", () => {
		const key = "mcp.tool_check_interval_hours";
		expect(checkSettingValue(key, "")).toBeNull();
		expect(checkSettingValue(key, "1")).toBeNull();
		expect(checkSettingValue(key, "168")).toBeNull();
		for (const bad of ["0", "169", "1.5", "-1", "daily"]) {
			expect(checkSettingValue(key, bad)).toMatch(/from 1 to 168/);
		}
	});

	it("mirrors the server's rules", () => {
		expect(
			checkSettingValue("email.smtp_url", "smtp://u:p@host:587"),
		).toBeNull();
		expect(checkSettingValue("email.smtp_url", "host:587")).toMatch(
			/smtp:\/\//,
		);
		expect(checkSettingValue("email.from", "ops@acme.example")).toBeNull();
		expect(checkSettingValue("email.from", "ops@")).not.toBeNull();
		expect(checkSettingValue("storage.s3_endpoint", "minio")).not.toBeNull();
		expect(checkSettingValue("storage.s3_bucket", "anything")).toBeNull();
		expect(checkSettingValue("email.from", "")).toBeNull();
	});
});

describe("ownerProblems", () => {
	it("one message per field", () => {
		expect(
			ownerProblems({
				name: "",
				email: "x@",
				password: "short",
				confirm: "other",
			}),
		).toEqual({
			name: "Enter your name",
			email: "Not an email address",
			password: "7 more characters",
			confirm: "Does not match",
		});
		expect(
			ownerProblems({
				name: "Sam",
				email: "sam@example.com",
				password: "correct horse battery",
				confirm: "correct horse battery",
			}),
		).toEqual({});
	});
});
