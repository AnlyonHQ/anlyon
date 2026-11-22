import { Boxes, Gauge, Home, Radio, ShieldCheck, Wrench } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { ExtensionPage } from "@/lib/extensions";
import {
	areaHref,
	areaPages,
	locate,
	type NavSearchEntry,
	navAreas,
	searchNavigation,
	toSearchEntries,
} from "./nav-config";

const entries: NavSearchEntry[] = [
	{ title: "Overview", href: "/analytics", icon: Home, section: "Home" },
	{
		title: "Actions",
		href: "/actions",
		icon: Wrench,
		section: "Agents & actions",
	},
	{
		title: "Policies",
		href: "/approval-policies",
		icon: ShieldCheck,
		section: "Controls",
	},
	{
		title: "Environments",
		href: "/environments",
		icon: Boxes,
		section: "Settings",
		parent: "Workspace",
	},
	{
		title: "Event topics",
		href: "/events",
		icon: Radio,
		section: "Activity",
	},
	{
		title: "Events",
		href: "/events/recent",
		icon: Radio,
		section: "Activity",
	},
];

const UNLISTED_ROUTES = ["/dlq", "/logs-explorer"];

describe("areas", () => {
	const all = navAreas({
		pendingApprovals: 3,
		pendingSignOffs: 2,
		anyHalted: true,
		showGetStarted: true,
	});
	const pages = all.flatMap(areaPages);
	const titles = [
		...all.map((area) => area.label),
		...all.flatMap((area) => area.groups.map((group) => group.label ?? "")),
		...pages.map((page) => page.title),
	];
	const hrefs = pages.map((page) => page.href);

	it("has the seven areas, Settings at the foot of the rail", () => {
		expect(all.map((area) => area.label)).toEqual([
			"Home",
			"Agents & actions",
			"Integrations",
			"Users",
			"Controls",
			"Activity",
			"Settings",
		]);
		expect(
			all.filter((area) => area.placement === "bottom").map((a) => a.id),
		).toEqual(["settings"]);
	});

	it("puts the rules first in Controls, then the approvals and sign-offs they hold", () => {
		const controls = all.find((area) => area.id === "controls");
		if (!controls) throw new Error("no Controls area");
		expect(areaPages(controls).map((page) => page.title)).toEqual([
			"Policies",
			"Limits",
			"Approvals",
			"Sign-offs",
		]);
		expect(areaHref(controls)).toBe("/approval-policies");
		expect(controls.badge).toBe(5);
	});

	it("puts each page in one place, once", () => {
		expect(new Set(hrefs).size).toBe(hrefs.length);
		expect(new Set(pages.map((page) => page.title)).size).toBe(pages.length);
	});

	it("uses the glossary's names, never the retired ones", () => {
		for (const title of titles) {
			expect(title).not.toMatch(/legacy|delivery/i);
			expect(title).not.toMatch(/end user|end-user/i);
			expect(title).not.toMatch(/^(Effects|Invocation logs|Analytics|Runs)$/);
			expect(title).not.toMatch(/^Connected apps$/);
		}
		expect(pages.filter((page) => page.href === "/analytics")).toHaveLength(1);
	});

	it("links to none of the unlisted routes, and keeps them out of search", () => {
		for (const route of UNLISTED_ROUTES) expect(hrefs).not.toContain(route);
		const index = toSearchEntries(all);
		for (const entry of index) {
			expect(UNLISTED_ROUTES).not.toContain(entry.href);
		}
		for (const query of [
			"legacy",
			"delivery",
			"logs",
			"dead letter",
			"messages",
		]) {
			expect(searchNavigation(index, query)).toEqual([]);
		}
	});

	it("still lists the governed path", () => {
		expect(hrefs).toEqual(
			expect.arrayContaining([
				"/analytics",
				"/get-started",
				"/actions",
				"/integrations",
				"/actions/secrets",
				"/agents",
				"/users",
				"/integrations/settings",
				"/approvals",
				"/sign-offs",
				"/approval-policies",
				"/actions/limits",
				"/actions/invocations",
				"/actions/effects",
				"/recent-runs",
				"/events/recent",
				"/events",
				"/environments",
				"/settings/api-keys",
			]),
		);
	});

	it("carries the approvals count and the halted dot up to the rail", () => {
		const byId = Object.fromEntries(all.map((area) => [area.id, area]));
		expect(byId.controls.badge).toBe(5);
		expect(byId.settings.alert).toBe(true);
		expect(byId.home.badge).toBe(0);
		const quiet = navAreas();
		expect(quiet.every((area) => !area.badge && !area.alert)).toBe(true);
	});

	it("hides Functions, and claims no path for it, while its stage is unavailable", () => {
		expect(hrefs).not.toContain("/functions");
		expect(locate(all, "/functions")).toBeNull();
		expect(searchNavigation(toSearchEntries(all), "functions")).toEqual([]);
	});

	it("offers Get started only until it is hidden", () => {
		const hidden = navAreas({ showGetStarted: false }).flatMap(areaPages);
		expect(hidden.map((page) => page.href)).not.toContain("/get-started");
	});

	it("hides a hosted-only extension page and shows Instance on a self-hosted install", () => {
		const extensionPages: ExtensionPage[] = [
			{
				path: "/settings/plan",
				hostedOnly: true,
				nav: {
					area: "settings",
					group: "Billing",
					title: "Plan",
					icon: Gauge,
				},
			},
		];
		const cloud = navAreas({ selfHosted: false, extensionPages }).flatMap(
			areaPages,
		);
		const self = navAreas({ selfHosted: true, extensionPages }).flatMap(
			areaPages,
		);
		expect(cloud.map((p) => p.href)).toContain("/settings/plan");
		expect(cloud.map((p) => p.href)).not.toContain("/settings/instance");
		expect(self.map((p) => p.href)).not.toContain("/settings/plan");
		expect(self.map((p) => p.href)).toContain("/settings/instance");
		expect(self.map((p) => p.href)).toContain("/settings/usage");
	});

	it("puts an extension page first in its group, or last when it asks", () => {
		const page = (path: string, at?: "start" | "end"): ExtensionPage => ({
			path,
			nav: { area: "settings", group: "Billing", title: path, icon: Gauge, at },
		});
		const billing = navAreas({
			extensionPages: [page("/first"), page("/last", "end")],
		})
			.find((area) => area.id === "settings")
			?.groups.find((group) => group.label === "Billing");
		expect(billing?.pages.map((p) => p.href)).toEqual([
			"/first",
			"/settings/usage",
			"/last",
		]);
	});

	it("opens an area at its first page", () => {
		const href = (id: string) =>
			areaHref(all.find((area) => area.id === id) ?? all[0]);
		expect(href("home")).toBe("/analytics");
		expect(href("build")).toBe("/actions");
		expect(href("integrations")).toBe("/integrations");
		expect(href("users")).toBe("/users");
		expect(href("controls")).toBe("/approval-policies");
		expect(href("activity")).toBe("/actions/invocations");
		expect(href("settings")).toBe("/settings/general");
	});
});

describe("locate", () => {
	const all = navAreas({ showGetStarted: true });
	const at = (path: string) => {
		const found = locate(all, path);
		return found ? [found.area.id, found.page.title, found.rest] : null;
	};

	it("finds the page by the longest matching URL, not the URL's first segment", () => {
		expect(at("/actions")).toEqual(["build", "Actions", ""]);
		expect(at("/actions/connections")).toEqual([
			"integrations",
			"Integrations",
			"",
		]);
		expect(at("/integrations/settings")).toEqual([
			"integrations",
			"Connect settings",
			"",
		]);
		expect(at("/actions/invocations")).toEqual(["activity", "Invocations", ""]);
		expect(at("/actions/effects")).toEqual(["activity", "Receipts", ""]);
		expect(at("/actions/limits")).toEqual(["controls", "Limits", ""]);
		expect(at("/events")).toEqual(["activity", "Event topics", ""]);
		expect(at("/events/recent")).toEqual(["activity", "Events", ""]);
		expect(at("/environments")).toEqual(["settings", "Environments", ""]);
		expect(at("/settings/api-keys")).toEqual(["settings", "API keys", ""]);
		expect(at("/sign-offs/sor_1")).toEqual(["controls", "Sign-offs", "sor_1"]);
	});

	it("keeps what is under a page, such as a user's id", () => {
		expect(at("/users/user_42")).toEqual(["users", "Users", "user_42"]);
		expect(at("/users/")).toEqual(["users", "Users", ""]);
	});

	it("claims old URLs for the page they redirect to", () => {
		expect(at("/dashboard")).toEqual(["home", "Overview", ""]);
		expect(at("/end-users")).toEqual(["users", "Users", ""]);
		expect(at("/end-users/user_42")).toEqual(["users", "Users", "user_42"]);
		expect(at("/settings/connections")).toEqual([
			"integrations",
			"Connect settings",
			"",
		]);
		expect(at("/connect-settings")).toEqual([
			"integrations",
			"Connect settings",
			"",
		]);
	});

	it("claims no legacy page, and no look-alike prefix", () => {
		for (const route of UNLISTED_ROUTES) expect(at(route)).toBeNull();
		expect(at("/users-export")).toBeNull();
		expect(at("/settings")).toBeNull();
	});
});

const titlesFor = (query: string) =>
	searchNavigation(entries, query).map((e) => e.title);

describe("searchNavigation", () => {
	it("returns nothing for an empty or blank query", () => {
		expect(titlesFor("")).toEqual([]);
		expect(titlesFor("   ")).toEqual([]);
	});

	it("matches titles case-insensitively", () => {
		expect(titlesFor("POLIC")).toEqual(["Policies"]);
	});

	it("ranks title prefixes before title substrings before group and area matches", () => {
		expect(titlesFor("en")).toEqual([
			"Environments",
			"Event topics",
			"Events",
			"Actions",
		]);
		expect(titlesFor("workspace")).toEqual(["Environments"]);
		expect(titlesFor("controls")).toEqual(["Policies"]);
	});

	it("matches an area name", () => {
		expect(titlesFor("activity")).toEqual(["Event topics", "Events"]);
	});

	it("keeps navigation order within the same rank", () => {
		expect(titlesFor("o")).toEqual([
			"Overview",
			"Actions",
			"Policies",
			"Environments",
			"Event topics",
		]);
	});
});
