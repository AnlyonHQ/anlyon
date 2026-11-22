import { describe, expect, it } from "vitest";
import {
	integrationName,
	isAllowedRedirect,
	isEndUserId,
	matchesRedirectUrl,
	normalizeRedirectUrl,
	redirectUrlProblem,
} from "./end-users";

describe("end-user ids", () => {
	it("accepts the developer's own ids", () => {
		for (const id of ["user_42", "u-1", "a@b.co", "org:7:user.9", "x"]) {
			expect(isEndUserId(id)).toBe(true);
		}
	});

	it("refuses empty, long and unexpected characters", () => {
		expect(isEndUserId("")).toBe(false);
		expect(isEndUserId("a".repeat(129))).toBe(false);
		expect(isEndUserId("a".repeat(128))).toBe(true);
		for (const id of ["user 42", "a/b", "é", "a?b", "<script>"]) {
			expect(isEndUserId(id)).toBe(false);
		}
	});
});

describe("redirect URLs", () => {
	it("accepts an https origin with or without a path", () => {
		expect(redirectUrlProblem("https://app.acme.com")).toBeNull();
		expect(redirectUrlProblem("http://localhost:3000/settings")).toBeNull();
		expect(redirectUrlProblem("http://app.acme.com/settings")).toMatch(/https/);
		expect(redirectUrlProblem("https://app.acme.com/settings/apps")).toBeNull();
		expect(redirectUrlProblem("  https://app.acme.com:8443/x  ")).toBeNull();
	});

	it("refuses what could become an open redirect or a leak", () => {
		expect(redirectUrlProblem("")).toBe("Enter a URL.");
		expect(redirectUrlProblem("app.acme.com")).toMatch(/full URL/);
		expect(redirectUrlProblem("http://app.acme.com")).toMatch(/https URL/);
		expect(redirectUrlProblem("javascript:alert(1)")).toMatch(/https URL/);
		expect(redirectUrlProblem("https://u:p@app.acme.com")).toMatch(/user name/);
		expect(redirectUrlProblem("https://app.acme.com/x?next=y")).toMatch(
			/query/,
		);
		expect(redirectUrlProblem("https://app.acme.com/x?")).toMatch(/query/);
		expect(redirectUrlProblem("https://app.acme.com/x#y")).toMatch(/fragment/);
	});

	it("stores origin plus path, without a trailing slash", () => {
		expect(normalizeRedirectUrl("https://App.Acme.com/")).toBe(
			"https://app.acme.com",
		);
		expect(normalizeRedirectUrl("https://app.acme.com/settings/")).toBe(
			"https://app.acme.com/settings",
		);
		expect(normalizeRedirectUrl("https://app.acme.com:443/a")).toBe(
			"https://app.acme.com/a",
		);
	});

	it("matches the same origin and a path at or under the prefix", () => {
		const rule = "https://app.acme.com/settings";
		expect(matchesRedirectUrl("https://app.acme.com/settings", rule)).toBe(
			true,
		);
		expect(
			matchesRedirectUrl("https://app.acme.com/settings/connected", rule),
		).toBe(true);
		expect(matchesRedirectUrl("https://app.acme.com/settingsx", rule)).toBe(
			false,
		);
		expect(matchesRedirectUrl("https://evil.com/settings", rule)).toBe(false);
		expect(
			matchesRedirectUrl("https://app.acme.com.evil.com/settings", rule),
		).toBe(false);
		expect(matchesRedirectUrl("http://app.acme.com/settings", rule)).toBe(
			false,
		);
		expect(
			isAllowedRedirect("https://app.acme.com/anything", [
				"https://other.com",
				"https://app.acme.com",
			]),
		).toBe(true);
		expect(isAllowedRedirect("https://app.acme.com/x", [])).toBe(false);
	});
});

describe("integration names", () => {
	it("names sign-in integrations, services and MCP server keys, and falls back to the id", () => {
		expect(integrationName("google-calendar")).toBe("Google Calendar");
		expect(integrationName("stripe")).toBe("Stripe");
		expect(integrationName("linear-key")).toBe("Linear");
		expect(integrationName("mcp-0b6f3c1e-5d2a-4c8e-9f10-2a3b4c5d6e7f")).toBe(
			"MCP server",
		);
		expect(integrationName("something-else")).toBe("something-else");
	});
});
