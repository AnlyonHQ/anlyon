import { serviceOfIntegration } from "@anlyon/known-vendors/services";
import type { EndUserConnectionStatus } from "./types";

const END_USER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

export function isEndUserId(value: string): boolean {
	return END_USER_ID.test(value);
}

export const OAUTH_INTEGRATIONS = [
	{ id: "hubspot", name: "HubSpot" },
	{ id: "slack", name: "Slack" },
	{ id: "google-calendar", name: "Google Calendar" },
	{ id: "gmail", name: "Gmail" },
	{ id: "linear", name: "Linear" },
	{ id: "salesforce", name: "Salesforce" },
] as const;

export type OAuthIntegrationId = (typeof OAUTH_INTEGRATIONS)[number]["id"];

const MCP_SERVER_KEY =
	/^mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function integrationName(id: string): string {
	const oauth = OAUTH_INTEGRATIONS.find((entry) => entry.id === id);
	if (oauth) return oauth.name;
	if (MCP_SERVER_KEY.test(id)) return "MCP server";
	return serviceOfIntegration(id)?.name ?? id;
}

export const CONNECTION_STATUS_LABEL: Record<EndUserConnectionStatus, string> =
	{
		active: "Active",
		needs_reconnect: "Needs reconnecting",
		revoked: "Revoked",
	};

export function redirectUrlProblem(value: string): string | null {
	const text = value.trim();
	if (!text) return "Enter a URL.";
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "Enter a full URL, such as https://app.example.com/settings.";
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		return "Use an https URL (http only for localhost).";
	}
	if (url.username || url.password) return "Leave out a user name or password.";
	if (url.search || text.includes("?")) return "Leave out the query string.";
	if (url.hash || text.includes("#")) return "Leave out the fragment.";
	return null;
}

export function normalizeRedirectUrl(value: string): string {
	const url = new URL(value.trim());
	const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
	return `${url.origin}${path}`;
}

export function matchesRedirectUrl(
	candidate: string,
	allowed: string,
): boolean {
	let target: URL;
	let rule: URL;
	try {
		target = new URL(candidate);
		rule = new URL(allowed);
	} catch {
		return false;
	}
	if (target.origin !== rule.origin) return false;
	const prefix = rule.pathname.replace(/\/+$/, "");
	if (!prefix) return true;
	return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

export function isAllowedRedirect(
	candidate: string,
	allowed: readonly string[],
): boolean {
	return allowed.some((rule) => matchesRedirectUrl(candidate, rule));
}
