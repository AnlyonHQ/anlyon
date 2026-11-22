import { type FeatureKey, isFeatureEnabled } from "@anlyon/feature-flags";
import {
	Activity,
	BarChart3,
	Bell,
	Blocks,
	Bot,
	Boxes,
	Building2,
	FileText,
	Flag,
	FolderLock,
	FolderSync,
	Gauge,
	History,
	Home,
	KeyRound,
	Link2,
	LogIn,
	type LucideIcon,
	Plug,
	Radio,
	ReceiptText,
	ScanSearch,
	ScrollText,
	Server,
	Settings,
	ShieldCheck,
	ShieldQuestion,
	Signature,
	SlidersHorizontal,
	SquareFunction,
	UserRound,
	Users,
	UsersRound,
	Waypoints,
	Webhook,
	Wrench,
} from "lucide-react";
import type { ExtensionPage } from "@/lib/extensions";

export type AreaId =
	| "home"
	| "build"
	| "integrations"
	| "users"
	| "controls"
	| "activity"
	| "settings";

export interface NavPage {
	title: string;
	href: string;
	icon: LucideIcon;
	feature?: FeatureKey;
	match?: string[];
	badge?: number;
	alert?: boolean;
}

export interface NavGroup {
	label?: string;
	pages: NavPage[];
}

export interface NavArea {
	id: AreaId;
	label: string;
	description: string;
	icon: LucideIcon;
	groups: NavGroup[];
	placement: "top" | "bottom";
	badge?: number;
	alert?: boolean;
}

export interface NavOptions {
	pendingApprovals?: number;
	pendingSignOffs?: number;
	anyHalted?: boolean;
	showGetStarted?: boolean;
	selfHosted?: boolean;
	functions?: boolean;
	extensionPages?: readonly ExtensionPage[];
}

const visible = (page: NavPage) =>
	!page.feature || isFeatureEnabled(page.feature);

export function navAreas({
	pendingApprovals = 0,
	pendingSignOffs = 0,
	anyHalted = false,
	showGetStarted = false,
	selfHosted = false,
	functions = false,
	extensionPages = [],
}: NavOptions = {}): NavArea[] {
	const areas: NavArea[] = [
		{
			id: "home",
			label: "Home",
			description:
				"Where to start, then what your agents did and what needs you.",
			icon: Home,
			placement: "top",
			groups: [
				{
					pages: [
						{
							title: "Overview",
							href: "/analytics",
							icon: BarChart3,
							feature: "analytics",
							match: ["/dashboard"],
						},
						...(showGetStarted
							? [{ title: "Get started", href: "/get-started", icon: Flag }]
							: []),
					],
				},
			],
		},
		{
			id: "build",
			label: "Agents & actions",
			description:
				"What your agent can do in other apps, and the credentials it uses.",
			icon: Wrench,
			placement: "top",
			groups: [
				{
					pages: [
						{
							title: "Actions",
							href: "/actions",
							icon: Wrench,
							feature: "actions",
						},
						{
							title: "Functions",
							href: "/functions",
							icon: SquareFunction,
							feature: "functions",
						},
						{
							title: "Secrets",
							href: "/actions/secrets",
							icon: FolderLock,
							feature: "actions",
						},
						{ title: "Agents", href: "/agents", icon: Bot, feature: "agents" },
					],
				},
			],
		},
		{
			id: "integrations",
			label: "Integrations",
			description:
				"The services your agent acts in, every way to connect to them, and the MCP servers you added.",
			icon: Plug,
			placement: "top",
			groups: [
				{
					pages: [
						{
							title: "Integrations",
							href: "/integrations",
							icon: Plug,
							feature: "connected-accounts",
							match: ["/actions/connections", "/mcp-servers"],
						},
						{
							title: "Connect settings",
							href: "/integrations/settings",
							icon: Link2,
							feature: "connected-accounts",
							match: ["/connect-settings", "/settings/connections"],
						},
					],
				},
			],
		},
		{
			id: "users",
			label: "Users",
			description:
				"The people using your product. Your agent acts in their own accounts.",
			icon: UsersRound,
			placement: "top",
			groups: [
				{
					pages: [
						{
							title: "Users",
							href: "/users",
							icon: UsersRound,
							feature: "connected-accounts",
							match: ["/end-users"],
						},
					],
				},
			],
		},
		{
			id: "controls",
			label: "Controls",
			description:
				"The rules your agent runs under, for your workspace and for each user, and the approvals they hold.",
			icon: ShieldCheck,
			placement: "top",
			groups: [
				{
					pages: [
						{
							title: "Policies",
							href: "/approval-policies",
							icon: ShieldCheck,
							feature: "approval-policies",
						},
						{
							title: "Limits",
							href: "/actions/limits",
							icon: Gauge,
							feature: "actions",
						},
						{
							title: "Approvals",
							href: "/approvals",
							icon: ShieldQuestion,
							feature: "approvals",
							badge: pendingApprovals,
						},
						{
							title: "Sign-offs",
							href: "/sign-offs",
							icon: Signature,
							badge: pendingSignOffs,
						},
					],
				},
			],
		},
		{
			id: "activity",
			label: "Activity",
			description:
				"What your agents did, call by call, with a receipt for each change.",
			icon: Activity,
			placement: "top",
			groups: [
				{
					pages: [
						{
							title: "Invocations",
							href: "/actions/invocations",
							icon: FileText,
							feature: "actions",
						},
						{
							title: "Receipts",
							href: "/actions/effects",
							icon: ReceiptText,
							feature: "actions",
						},
						{
							title: "Agent runs",
							href: "/recent-runs",
							icon: History,
							feature: "runs",
						},
						{
							title: "Events",
							href: "/events/recent",
							icon: Radio,
							feature: "events",
						},
						{
							title: "Event topics",
							href: "/events",
							icon: Waypoints,
							feature: "events",
						},
					],
				},
			],
		},
		{
			id: "settings",
			label: "Settings",
			description:
				"Set once by an admin: keys, environments, members, billing and your account.",
			icon: Settings,
			placement: "bottom",
			groups: [
				{
					label: "Workspace",
					pages: [
						{ title: "General", href: "/settings/general", icon: Building2 },
						{
							title: "Defaults",
							href: "/settings/defaults",
							icon: SlidersHorizontal,
						},
						{
							title: "Environments",
							href: "/environments",
							icon: Boxes,
							feature: "environments",
							alert: anyHalted,
						},
						{ title: "API keys", href: "/settings/api-keys", icon: KeyRound },
						{ title: "Webhooks", href: "/settings/webhooks", icon: Webhook },
						{
							title: "Notifications",
							href: "/settings/notifications",
							icon: Bell,
						},
						{
							title: "Notification channels",
							href: "/settings/integrations",
							icon: Blocks,
						},
						{
							title: "Vigil",
							href: "/settings/assistant",
							icon: ScanSearch,
							feature: "ai-assistant",
						},
					],
				},
				{
					label: "Access and audit",
					pages: [
						{ title: "Team", href: "/settings/team", icon: Users },
						{ title: "Single sign-on", href: "/settings/sso", icon: LogIn },
						{
							title: "Directory sync",
							href: "/settings/scim",
							icon: FolderSync,
						},
						{
							title: "Audit streaming",
							href: "/settings/audit",
							icon: ScrollText,
						},
					],
				},
				{
					label: "Billing",
					pages: [{ title: "Usage", href: "/settings/usage", icon: Gauge }],
				},
				{
					label: "Server",
					pages: selfHosted
						? [{ title: "Instance", href: "/settings/instance", icon: Server }]
						: [],
				},
				{
					label: "Your account",
					pages: [
						{ title: "Profile", href: "/settings/profile", icon: UserRound },
						{
							title: "Security",
							href: "/settings/security",
							icon: ShieldCheck,
						},
						{
							title: "Authorized apps",
							href: "/settings/connected-apps",
							icon: Plug,
						},
					],
				},
			],
		},
	];

	for (const page of extensionPages) {
		if (!page.nav || (page.hostedOnly && selfHosted)) continue;
		const { area: areaId, group: label, title, icon, at = "start" } = page.nav;
		const area = areas.find((candidate) => candidate.id === areaId);
		if (!area) continue;
		const entry: NavPage = { title, href: page.path, icon };
		const group = area.groups.find((candidate) => candidate.label === label);
		if (!group) area.groups.push({ label, pages: [entry] });
		else if (at === "start") group.pages.unshift(entry);
		else group.pages.push(entry);
	}

	return areas
		.map((area) => {
			const groups = area.groups
				.map((group) => ({
					...group,
					pages: group.pages.filter(
						(page) =>
							visible(page) && (page.feature !== "functions" || functions),
					),
				}))
				.filter((group) => group.pages.length > 0);
			const pages = groups.flatMap((group) => group.pages);
			return {
				...area,
				groups,
				badge: pages.reduce((sum, page) => sum + (page.badge ?? 0), 0),
				alert: pages.some((page) => page.alert),
			};
		})
		.filter((area) => area.groups.length > 0);
}

export function areaPages(area: NavArea): NavPage[] {
	return area.groups.flatMap((group) => group.pages);
}

export function areaHref(area: NavArea): string {
	return areaPages(area)[0]?.href ?? "/";
}

const under = (path: string, prefix: string) =>
	path === prefix || path.startsWith(`${prefix}/`);

export interface NavLocation {
	area: NavArea;
	page: NavPage;
	rest: string;
}

export function locate(areas: NavArea[], path: string): NavLocation | null {
	const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
	let best: { area: NavArea; page: NavPage; prefix: string } | null = null;
	for (const area of areas) {
		for (const page of areaPages(area)) {
			for (const prefix of [page.href, ...(page.match ?? [])]) {
				if (
					under(clean, prefix) &&
					(!best || prefix.length > best.prefix.length)
				) {
					best = { area, page, prefix };
				}
			}
		}
	}
	if (!best) return null;
	const rest = clean.slice(best.prefix.length).replace(/^\//, "");
	return { area: best.area, page: best.page, rest };
}

export interface NavSearchEntry {
	title: string;
	href: string;
	icon: LucideIcon;
	section: string;
	parent?: string;
}

export function toSearchEntries(areas: NavArea[]): NavSearchEntry[] {
	return areas.flatMap((area) =>
		area.groups.flatMap((group) =>
			group.pages.map((page) => ({
				title: page.title,
				href: page.href,
				icon: page.icon,
				section: area.label,
				parent: group.label,
			})),
		),
	);
}

export function searchNavigation(
	entries: NavSearchEntry[],
	query: string,
): NavSearchEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const rank = (entry: NavSearchEntry) => {
		const title = entry.title.toLowerCase();
		if (title.startsWith(q)) return 0;
		if (title.includes(q)) return 1;
		if (entry.parent?.toLowerCase().includes(q)) return 2;
		if (entry.section.toLowerCase().includes(q)) return 3;
		return -1;
	};
	return entries
		.map((entry, index) => ({ entry, index, score: rank(entry) }))
		.filter(({ score }) => score >= 0)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map(({ entry }) => entry);
}

export const UNLISTED_TITLES: Record<string, string> = {
	"/dlq": "Dead letter queue",
	"/logs-explorer": "Delivery logs",
	"/workspaces/new": "New workspace",
	"/workspaces/setup": "Workspace setup",
	"/workspaces/select": "Workspaces",
};
