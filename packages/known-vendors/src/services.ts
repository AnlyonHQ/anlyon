import type { KnownVendor } from "./index.ts";

export type ServiceCategory =
	| "crm"
	| "support"
	| "email"
	| "messaging"
	| "calendar"
	| "projects"
	| "engineering"
	| "knowledge"
	| "payments"
	| "data"
	| "design"
	| "automation"
	| "other";

export const SERVICE_CATEGORIES: Readonly<Record<ServiceCategory, string>> = {
	crm: "CRM and sales",
	support: "Customer support",
	email: "Email",
	messaging: "Messaging and meetings",
	calendar: "Calendar and scheduling",
	projects: "Projects and issues",
	engineering: "Engineering",
	knowledge: "Docs and knowledge",
	payments: "Payments",
	data: "Data, search and AI",
	design: "Design and websites",
	automation: "Automation",
	other: "Other",
};

export type ConnectWay =
	| { kind: "sign_in"; integration: string }
	| { kind: "api_key"; integration: string }
	| { kind: "mcp"; vendor: string };

export type ConnectWayKind = ConnectWay["kind"];

export type ServiceDepth = "full_toolset" | "via_mcp";

export const DEPTH_LABEL: Readonly<Record<ServiceDepth, string>> = {
	full_toolset: "Full toolset",
	via_mcp: "Via MCP",
};

export const WAY_LABEL: Readonly<Record<ConnectWayKind, string>> = {
	sign_in: "Sign in",
	api_key: "API key",
	mcp: "MCP server",
};

export interface Service {
	slug: string;
	name: string;
	category: ServiceCategory;
	ways: readonly ConnectWay[];
}

const signIn = (integration: string): ConnectWay => ({
	kind: "sign_in",
	integration,
});
const apiKey = (integration: string): ConnectWay => ({
	kind: "api_key",
	integration,
});
const mcp = (vendor: string): ConnectWay => ({ kind: "mcp", vendor });

export const SERVICES: readonly Service[] = [
	{
		slug: "hubspot",
		name: "HubSpot",
		category: "crm",
		ways: [signIn("hubspot")],
	},
	{
		slug: "salesforce",
		name: "Salesforce",
		category: "crm",
		ways: [signIn("salesforce")],
	},
	{
		slug: "pipedrive",
		name: "Pipedrive",
		category: "crm",
		ways: [apiKey("pipedrive")],
	},
	{ slug: "attio", name: "Attio", category: "crm", ways: [apiKey("attio")] },
	{ slug: "close", name: "Close", category: "crm", ways: [apiKey("close")] },
	{
		slug: "intercom",
		name: "Intercom",
		category: "support",
		ways: [apiKey("intercom")],
	},
	{
		slug: "zendesk",
		name: "Zendesk",
		category: "support",
		ways: [apiKey("zendesk")],
	},
	{
		slug: "front",
		name: "Front",
		category: "support",
		ways: [apiKey("front")],
	},
	{ slug: "gmail", name: "Gmail", category: "email", ways: [signIn("gmail")] },
	{
		slug: "resend",
		name: "Resend",
		category: "email",
		ways: [apiKey("resend")],
	},
	{
		slug: "sendgrid",
		name: "SendGrid",
		category: "email",
		ways: [apiKey("sendgrid")],
	},
	{
		slug: "postmark",
		name: "Postmark",
		category: "email",
		ways: [apiKey("postmark")],
	},
	{
		slug: "mailchimp",
		name: "Mailchimp",
		category: "email",
		ways: [apiKey("mailchimp")],
	},
	{
		slug: "slack",
		name: "Slack",
		category: "messaging",
		ways: [signIn("slack")],
	},
	{
		slug: "discord",
		name: "Discord",
		category: "messaging",
		ways: [apiKey("discord")],
	},
	{
		slug: "twilio",
		name: "Twilio",
		category: "messaging",
		ways: [apiKey("twilio")],
	},
	{ slug: "zoom", name: "Zoom", category: "messaging", ways: [mcp("zoom")] },
	{
		slug: "google-calendar",
		name: "Google Calendar",
		category: "calendar",
		ways: [signIn("google-calendar")],
	},
	{
		slug: "calendly",
		name: "Calendly",
		category: "calendar",
		ways: [apiKey("calendly")],
	},
	{
		slug: "calcom",
		name: "Cal.com",
		category: "calendar",
		ways: [apiKey("calcom")],
	},
	{
		slug: "linear",
		name: "Linear",
		category: "projects",
		ways: [signIn("linear"), apiKey("linear-key"), mcp("linear")],
	},
	{
		slug: "jira",
		name: "Jira",
		category: "projects",
		ways: [apiKey("jira"), mcp("atlassian")],
	},
	{
		slug: "asana",
		name: "Asana",
		category: "projects",
		ways: [apiKey("asana")],
	},
	{
		slug: "clickup",
		name: "ClickUp",
		category: "projects",
		ways: [apiKey("clickup")],
	},
	{
		slug: "monday",
		name: "monday.com",
		category: "projects",
		ways: [apiKey("monday"), mcp("monday-com")],
	},
	{
		slug: "trello",
		name: "Trello",
		category: "projects",
		ways: [apiKey("trello")],
	},
	{
		slug: "todoist",
		name: "Todoist",
		category: "projects",
		ways: [apiKey("todoist"), mcp("todoist")],
	},
	{
		slug: "github",
		name: "GitHub",
		category: "engineering",
		ways: [signIn("github"), apiKey("github"), mcp("github")],
	},
	{
		slug: "gitlab",
		name: "GitLab",
		category: "engineering",
		ways: [apiKey("gitlab"), mcp("gitlab")],
	},
	{
		slug: "sentry",
		name: "Sentry",
		category: "engineering",
		ways: [apiKey("sentry"), mcp("sentry")],
	},
	{
		slug: "vercel",
		name: "Vercel",
		category: "engineering",
		ways: [apiKey("vercel"), mcp("vercel")],
	},
	{
		slug: "pagerduty",
		name: "PagerDuty",
		category: "engineering",
		ways: [apiKey("pagerduty")],
	},
	{
		slug: "circleci",
		name: "CircleCI",
		category: "engineering",
		ways: [mcp("circleci")],
	},
	{
		slug: "grafana",
		name: "Grafana",
		category: "engineering",
		ways: [mcp("grafana")],
	},
	{ slug: "neon", name: "Neon", category: "engineering", ways: [mcp("neon")] },
	{
		slug: "new-relic",
		name: "New Relic",
		category: "engineering",
		ways: [mcp("new-relic")],
	},
	{
		slug: "postman",
		name: "Postman",
		category: "engineering",
		ways: [mcp("postman")],
	},
	{
		slug: "prisma",
		name: "Prisma",
		category: "engineering",
		ways: [mcp("prisma")],
	},
	{
		slug: "supabase",
		name: "Supabase",
		category: "engineering",
		ways: [mcp("supabase")],
	},
	{
		slug: "notion",
		name: "Notion",
		category: "knowledge",
		ways: [signIn("notion"), apiKey("notion"), mcp("notion")],
	},
	{
		slug: "airtable",
		name: "Airtable",
		category: "knowledge",
		ways: [apiKey("airtable"), mcp("airtable")],
	},
	{
		slug: "confluence",
		name: "Confluence",
		category: "knowledge",
		ways: [mcp("atlassian")],
	},
	{
		slug: "stripe",
		name: "Stripe",
		category: "payments",
		ways: [apiKey("stripe"), mcp("stripe")],
	},
	{
		slug: "paypal",
		name: "PayPal",
		category: "payments",
		ways: [mcp("paypal")],
	},
	{
		slug: "algolia",
		name: "Algolia",
		category: "data",
		ways: [mcp("algolia")],
	},
	{
		slug: "amplitude",
		name: "Amplitude",
		category: "data",
		ways: [mcp("amplitude")],
	},
	{ slug: "apify", name: "Apify", category: "data", ways: [mcp("apify")] },
	{
		slug: "elevenlabs",
		name: "ElevenLabs",
		category: "data",
		ways: [mcp("elevenlabs")],
	},
	{ slug: "exa", name: "Exa", category: "data", ways: [mcp("exa")] },
	{
		slug: "firecrawl",
		name: "Firecrawl",
		category: "data",
		ways: [mcp("firecrawl")],
	},
	{
		slug: "hugging-face",
		name: "Hugging Face",
		category: "data",
		ways: [mcp("hugging-face")],
	},
	{ slug: "canva", name: "Canva", category: "design", ways: [mcp("canva")] },
	{ slug: "figma", name: "Figma", category: "design", ways: [mcp("figma")] },
	{
		slug: "webflow",
		name: "Webflow",
		category: "design",
		ways: [mcp("webflow")],
	},
	{ slug: "wix", name: "Wix", category: "design", ways: [mcp("wix")] },
	{ slug: "sanity", name: "Sanity", category: "design", ways: [mcp("sanity")] },
	{
		slug: "zapier",
		name: "Zapier",
		category: "automation",
		ways: [mcp("zapier")],
	},
];

export function serviceDepth(service: Pick<Service, "ways">): ServiceDepth {
	return service.ways.some((way) => way.kind !== "mcp")
		? "full_toolset"
		: "via_mcp";
}

export function serviceIntegrations(service: Pick<Service, "ways">): string[] {
	const ids: string[] = [];
	for (const way of service.ways) {
		if (way.kind !== "mcp" && !ids.includes(way.integration))
			ids.push(way.integration);
	}
	return ids;
}

export function serviceVendor(service: Pick<Service, "ways">): string | null {
	for (const way of service.ways) if (way.kind === "mcp") return way.vendor;
	return null;
}

export function serviceOfIntegration(
	integration: string,
	services: readonly Service[] = SERVICES,
): Service | null {
	return (
		services.find((service) =>
			service.ways.some(
				(way) => way.kind !== "mcp" && way.integration === integration,
			),
		) ?? null
	);
}

export function servicesWith(options: {
	vendors: readonly Pick<KnownVendor, "name" | "slug" | "category">[];
	available?: (way: ConnectWay) => boolean;
	services?: readonly Service[];
}): Service[] {
	const services = options.services ?? SERVICES;
	const available = options.available ?? (() => true);
	const named = new Set(
		services.flatMap((service) =>
			service.ways.flatMap((way) => (way.kind === "mcp" ? [way.vendor] : [])),
		),
	);
	const extra: Service[] = options.vendors
		.filter((vendor) => !named.has(vendor.slug))
		.map((vendor) => ({
			slug: vendor.slug,
			name: vendor.name,
			category: vendor.category ?? "other",
			ways: [mcp(vendor.slug)],
		}));
	return [...services, ...extra]
		.map((service) => ({ ...service, ways: service.ways.filter(available) }))
		.filter((service) => service.ways.length > 0);
}

export function serviceMatches(
	service: Pick<Service, "name" | "slug" | "category">,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return (
		service.name.toLowerCase().includes(q) ||
		service.slug.includes(q) ||
		SERVICE_CATEGORIES[service.category].toLowerCase().includes(q)
	);
}
