import { describe, expect, it } from "vitest";
import {
	isSafeStartUrl,
	parseAuthorizeRequest,
	verifiedDestination,
	withAuthorizeRequest,
} from "./oauth-return";

const NOW = 1_800_000_000_000;
const live = `response_type=code&client_id=abc&scope=openid&exp=${NOW / 1000 + 300}&sig=s1g`;
const stale = `response_type=code&client_id=abc&scope=openid&exp=${NOW / 1000 - 1}&sig=s1g`;
const anlyonDev = {
	displayName: "anlyon.dev",
	startUrl: "https://anlyon.dev/auth/login",
};

describe("parseAuthorizeRequest", () => {
	it("reads a signed query verbatim and knows when it has expired", () => {
		expect(parseAuthorizeRequest(`?${live}`, NOW)).toEqual({
			query: live,
			clientId: "abc",
			expired: false,
		});
		expect(parseAuthorizeRequest(`?${stale}`, NOW)?.expired).toBe(true);
	});

	it("ignores a query that is not a signed authorize request", () => {
		expect(parseAuthorizeRequest("", NOW)).toBeNull();
		expect(parseAuthorizeRequest("?redirect=/dashboard", NOW)).toBeNull();
		expect(
			parseAuthorizeRequest("?client_id=abc&exp=1900000000", NOW),
		).toBeNull();
	});
});

describe("withAuthorizeRequest", () => {
	it("keeps a live request on the sign-up and login links, and drops an expired one", () => {
		expect(
			withAuthorizeRequest("/auth/signup", parseAuthorizeRequest(live, NOW)),
		).toBe(`/auth/signup?${live}`);
		expect(
			withAuthorizeRequest("/auth/signup", parseAuthorizeRequest(stale, NOW)),
		).toBe("/auth/signup");
		expect(withAuthorizeRequest("/auth/signup", null)).toBe("/auth/signup");
		expect(withAuthorizeRequest("/auth/signup", null, "/a?b=c&d=e")).toBe(
			"/auth/signup?redirect=%2Fa%3Fb%3Dc%26d%3De",
		);
		expect(
			withAuthorizeRequest(
				"/auth/signup",
				parseAuthorizeRequest(live, NOW),
				"/a",
			),
		).toBe(`/auth/signup?${live}`);
	});
});

describe("verifiedDestination", () => {
	it("sends a person who came from a first-party site back to its start page, even after the query expired", () => {
		expect(
			verifiedDestination(parseAuthorizeRequest(stale, NOW), anlyonDev),
		).toEqual({
			kind: "first-party",
			url: "https://anlyon.dev/auth/login",
			displayName: "anlyon.dev",
		});
	});

	it("returns to a live MCP authorize request on the console's login page", () => {
		expect(verifiedDestination(parseAuthorizeRequest(live, NOW), null)).toEqual(
			{ kind: "authorize", to: `/auth/login?${live}` },
		);
	});

	it("never replays an expired query", () => {
		expect(
			verifiedDestination(parseAuthorizeRequest(stale, NOW), null),
		).toEqual({ kind: "login" });
		expect(verifiedDestination(null, null)).toEqual({ kind: "login" });
	});

	it("goes on to log in, then the page they were heading to", () => {
		expect(verifiedDestination(null, null, "/mcp-servers/new?url=x")).toEqual({
			kind: "login",
			returnTo: "/mcp-servers/new?url=x",
		});
		expect(
			verifiedDestination(parseAuthorizeRequest(live, NOW), null, "/a"),
		).toEqual({ kind: "authorize", to: `/auth/login?${live}` });
	});

	it("refuses a start URL that is not https", () => {
		expect(
			verifiedDestination(null, {
				displayName: "x",
				startUrl: "javascript:alert(1)",
			}),
		).toEqual({ kind: "login" });
	});
});

describe("isSafeStartUrl", () => {
	it("allows https and loopback http only", () => {
		expect(isSafeStartUrl("https://anlyon.dev/auth/login")).toBe(true);
		expect(isSafeStartUrl("http://localhost:3000/auth/login")).toBe(true);
		expect(isSafeStartUrl("http://anlyon.dev/")).toBe(false);
		expect(isSafeStartUrl("/auth/login")).toBe(false);
	});
});
