import type { ServiceCategory } from "./services.ts";

export const CHECKED_ON = "2026-11-20";

export const SOURCE_URL =
	"https://github.com/AnlyonHQ/anlyon/blob/main/packages/known-vendors/src/index.ts";

export type VendorSignIn = "oauth" | "key";

export const SIGN_IN_RECORD =
	"server/tests/support/effects/mcp-vendor-metadata.2026-11-02.json";

export interface KnownVendor {
	name: string;
	slug: string;
	aliases?: readonly string[];
	domains: readonly string[];
	githubOrgs?: readonly string[];
	server: { registryName: string; url: string };
	proven?: boolean;
	signIn?: VendorSignIn;
	signInSource?: string;
	oauthClient?: "preregistered";
	products?: readonly string[];
	category?: ServiceCategory;
}

export type VendorIdentity = Pick<
	KnownVendor,
	"name" | "domains" | "githubOrgs" | "server"
>;

export const KNOWN_VENDORS: readonly KnownVendor[] = [
	{
		name: "Airtable",
		slug: "airtable",
		domains: ["airtable.com"],
		server: {
			registryName: "com.airtable/mcp",
			url: "https://mcp.airtable.com/mcp",
		},
		signIn: "oauth",
		signInSource: "https://airtable.com/developers/agents/mcp/getting-started",
	},
	{
		name: "GitHub",
		slug: "github",
		domains: ["github.com", "githubcopilot.com"],
		githubOrgs: ["github"],
		server: {
			registryName: "io.github.github/github-mcp-server",
			url: "https://api.githubcopilot.com/mcp/",
		},
		signIn: "oauth",
		signInSource: SIGN_IN_RECORD,
		oauthClient: "preregistered",
	},
	{
		name: "GitLab",
		slug: "gitlab",
		domains: ["gitlab.com"],
		server: {
			registryName: "com.gitlab/mcp",
			url: "https://gitlab.com/api/v4/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
	},
	{
		name: "Linear",
		slug: "linear",
		domains: ["linear.app"],
		server: {
			registryName: "app.linear/linear",
			url: "https://mcp.linear.app/mcp",
		},
		signIn: "oauth",
		signInSource: SIGN_IN_RECORD,
		proven: true,
	},
	{
		name: "monday.com",
		slug: "monday-com",
		aliases: ["monday"],
		domains: ["monday.com"],
		server: {
			registryName: "com.monday/monday.com",
			url: "https://mcp.monday.com/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp",
	},
	{
		name: "Notion",
		slug: "notion",
		domains: ["notion.com"],
		server: {
			registryName: "com.notion/mcp",
			url: "https://mcp.notion.com/mcp",
		},
		signIn: "oauth",
		signInSource: SIGN_IN_RECORD,
	},
	{
		name: "Sentry",
		slug: "sentry",
		domains: ["sentry.io", "sentry.dev"],
		githubOrgs: ["getsentry"],
		server: {
			registryName: "io.github.getsentry/sentry-mcp",
			url: "https://mcp.sentry.dev/mcp",
		},
		signIn: "oauth",
		signInSource: "https://mcp.sentry.dev/llms.txt",
	},
	{
		name: "Stripe",
		slug: "stripe",
		domains: ["stripe.com"],
		server: { registryName: "com.stripe/mcp", url: "https://mcp.stripe.com" },
		signIn: "oauth",
		signInSource: SIGN_IN_RECORD,
	},
	{
		name: "Todoist",
		slug: "todoist",
		domains: ["todoist.com", "todoist.net"],
		server: {
			registryName: "net.todoist/mcp",
			url: "https://ai.todoist.net/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://www.todoist.com/help/todoist/todoist-and-ai/connect-todoist-to-an-ai-assistant-xMSzFfHng",
	},
	{
		name: "Vercel",
		slug: "vercel",
		domains: ["vercel.com"],
		server: {
			registryName: "com.vercel/vercel-mcp",
			url: "https://mcp.vercel.com",
		},
		signIn: "oauth",
		signInSource: "https://vercel.com/docs/agent-resources/vercel-mcp",
	},
	{
		name: "Atlassian",
		slug: "atlassian",
		aliases: ["confluence", "jira"],
		products: ["Jira", "Confluence"],
		domains: ["atlassian.com"],
		server: {
			registryName: "com.atlassian/atlassian-mcp-server",
			url: "https://mcp.atlassian.com/v2/mcp",
		},
		signIn: "oauth",
		signInSource: SIGN_IN_RECORD,
	},

	{
		name: "Algolia",
		slug: "algolia",
		domains: ["algolia.com"],
		githubOrgs: ["algolia"],
		server: {
			registryName: "io.github.algolia/algolia-productivity",
			url: "https://mcp.algolia.com/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://www.algolia.com/doc/guides/model-context-protocol/productivity-mcp",
	},
	{
		name: "Amplitude",
		slug: "amplitude",
		domains: ["amplitude.com"],
		server: {
			registryName: "com.amplitude/mcp-server",
			url: "https://mcp.amplitude.com/mcp",
		},
		signIn: "oauth",
		signInSource: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
	},
	{
		name: "Apify",
		slug: "apify",
		domains: ["apify.com"],
		server: {
			registryName: "com.apify/apify-mcp-server",
			url: "https://mcp.apify.com/",
		},
		signIn: "oauth",
		signInSource: "https://docs.apify.com/mcp",
	},
	{
		name: "Canva",
		slug: "canva",
		domains: ["canva.com"],
		server: {
			registryName: "com.canva.mcp/mcp",
			url: "https://mcp.canva.com/mcp",
		},
	},
	{
		name: "CircleCI",
		slug: "circleci",
		domains: ["circleci.com"],
		server: {
			registryName: "com.circleci/mcp",
			url: "https://mcp.circleci.com/v1/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://circleci.com/docs/guides/toolkit/connecting-to-the-circleci-mcp-server/",
	},
	{
		name: "ElevenLabs",
		slug: "elevenlabs",
		domains: ["elevenlabs.io"],
		server: {
			registryName: "io.elevenlabs/mcp",
			url: "https://api.us.elevenlabs.io/v1/mcp",
		},
		signIn: "oauth",
		signInSource: "https://elevenlabs.io/mcp",
	},
	{
		name: "Exa",
		slug: "exa",
		domains: ["exa.ai"],
		server: { registryName: "ai.exa/exa", url: "https://mcp.exa.ai/mcp" },
	},
	{
		name: "Figma",
		slug: "figma",
		domains: ["figma.com"],
		server: {
			registryName: "com.figma.mcp/mcp",
			url: "https://mcp.figma.com/mcp",
		},
	},
	{
		name: "Firecrawl",
		slug: "firecrawl",
		domains: ["firecrawl.dev"],
		githubOrgs: ["firecrawl"],
		server: {
			registryName: "io.github.firecrawl/firecrawl-mcp-server",
			url: "https://mcp.firecrawl.dev/v2/mcp",
		},
		signIn: "key",
		signInSource: "https://docs.firecrawl.dev/mcp-server/connect",
	},
	{
		name: "Grafana",
		slug: "grafana",
		domains: ["grafana.com"],
		githubOrgs: ["grafana"],
		server: {
			registryName: "io.github.grafana/mcp-grafana",
			url: "https://mcp.grafana.com/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/",
	},
	{
		name: "Hugging Face",
		slug: "hugging-face",
		aliases: ["huggingface", "hf"],
		domains: ["huggingface.co"],
		server: {
			registryName: "co.huggingface/hf-mcp-server",
			url: "https://huggingface.co/mcp",
		},
	},
	{
		name: "Neon",
		slug: "neon",
		domains: ["neon.com", "neon.tech"],
		server: { registryName: "com.neon/mcp", url: "https://mcp.neon.tech/mcp" },
		signIn: "oauth",
		signInSource: "https://neon.com/docs/ai/neon-mcp-server",
	},
	{
		name: "New Relic",
		slug: "new-relic",
		aliases: ["newrelic"],
		domains: ["newrelic.com"],
		server: {
			registryName: "com.newrelic/mcp-server",
			url: "https://mcp.newrelic.com/mcp",
		},
		signIn: "oauth",
		signInSource: "https://docs.newrelic.com/docs/agentic-ai/mcp/setup/",
	},
	{
		name: "PayPal",
		slug: "paypal",
		domains: ["paypal.com"],
		server: {
			registryName: "com.paypal.mcp/mcp",
			url: "https://mcp.paypal.com/mcp",
		},
	},
	{
		name: "Postman",
		slug: "postman",
		domains: ["postman.com"],
		server: {
			registryName: "com.postman/postman-mcp-server",
			url: "https://mcp.postman.com/mcp",
		},
		signIn: "oauth",
		signInSource:
			"https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server/",
	},
	{
		name: "Prisma",
		slug: "prisma",
		domains: ["prisma.io"],
		server: { registryName: "io.prisma/mcp", url: "https://mcp.prisma.io/mcp" },
	},
	{
		name: "Sanity",
		slug: "sanity",
		domains: ["sanity.io"],
		server: { registryName: "io.sanity.www/mcp", url: "https://mcp.sanity.io" },
		signIn: "oauth",
		signInSource: "https://www.sanity.io/docs/ai/mcp-server",
	},
	{
		name: "Supabase",
		slug: "supabase",
		domains: ["supabase.com"],
		server: {
			registryName: "com.supabase/mcp",
			url: "https://mcp.supabase.com/mcp",
		},
		signIn: "oauth",
		signInSource: SIGN_IN_RECORD,
	},
	{
		name: "Webflow",
		slug: "webflow",
		domains: ["webflow.com"],
		server: {
			registryName: "com.webflow/mcp",
			url: "https://mcp.webflow.com/mcp",
		},
		signIn: "oauth",
		signInSource: "https://developers.webflow.com/mcp/reference/how-it-works",
	},
	{
		name: "Wix",
		slug: "wix",
		domains: ["wix.com"],
		server: { registryName: "com.wix/mcp", url: "https://mcp.wix.com/mcp" },
	},
	{
		name: "Zapier",
		slug: "zapier",
		domains: ["zapier.com"],
		server: {
			registryName: "com.zapier/mcp",
			url: "https://mcp.zapier.com/api/v1/connect",
		},
		signIn: "oauth",
		signInSource: "https://docs.zapier.com/mcp/get-started/connect",
	},
	{
		name: "Zoom",
		slug: "zoom",
		domains: ["zoom.us"],
		githubOrgs: ["zoom"],
		server: {
			registryName: "io.github.zoom/zoom-meetings",
			url: "https://mcp.zoom.us/mcp/meeting/streamable",
		},
		signIn: "oauth",
		signInSource:
			"https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		oauthClient: "preregistered",
	},
];

export function slugify(name: string): string {
	return name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function vendorBySlug(
	slug: string | null | undefined,
	vendors: readonly KnownVendor[] = KNOWN_VENDORS,
): KnownVendor | undefined {
	if (typeof slug !== "string" || slug.length > 64 || !SLUG_PATTERN.test(slug))
		return undefined;
	return vendors.find((vendor) => vendor.slug === slug);
}

export function underDomain(host: string, domains: readonly string[]): boolean {
	const name = host.toLowerCase();
	return domains.some(
		(domain) => name === domain || name.endsWith(`.${domain}`),
	);
}

export function vendorByProductSlug(
	slug: string | null | undefined,
	vendors: readonly KnownVendor[] = KNOWN_VENDORS,
): KnownVendor | undefined {
	if (typeof slug !== "string" || slug.length > 64 || !SLUG_PATTERN.test(slug))
		return undefined;
	return vendors.find((vendor) =>
		(vendor.products ?? []).some((product) => slugify(product) === slug),
	);
}

export type PublisherVerdict =
	| {
			verified: true;
			verifiedBy: "domain" | "github";
			namespace: string;
			host: string;
			url: string;
	  }
	| { verified: false; reason: string };

export function publisherVerdict(vendor: VendorIdentity): PublisherVerdict {
	const namespace = vendor.server.registryName.split("/")[0] ?? "";
	let verifiedBy: "domain" | "github";
	const github = /^io\.github\.(.+)$/i.exec(namespace);
	if (github) {
		const org = github[1] ?? "";
		if (
			!(vendor.githubOrgs ?? []).some(
				(candidate) => candidate.toLowerCase() === org.toLowerCase(),
			)
		) {
			return {
				verified: false,
				reason: `GitHub organisation ${org} is not ${vendor.name}'s`,
			};
		}
		verifiedBy = "github";
	} else {
		const domain = namespace.split(".").reverse().join(".").toLowerCase();
		if (!underDomain(domain, vendor.domains))
			return {
				verified: false,
				reason: `${domain} is not ${vendor.name}'s domain`,
			};
		verifiedBy = "domain";
	}
	let endpoint: URL;
	try {
		endpoint = new URL(vendor.server.url);
	} catch {
		return { verified: false, reason: "its endpoint is not a URL" };
	}
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.port ||
		endpoint.hash
	) {
		return { verified: false, reason: "its endpoint is not plain https" };
	}
	if (!underDomain(endpoint.hostname, vendor.domains))
		return {
			verified: false,
			reason: `${endpoint.hostname} is not ${vendor.name}'s host`,
		};
	return {
		verified: true,
		verifiedBy,
		namespace,
		host: endpoint.hostname,
		url: vendor.server.url,
	};
}

export interface PublicVendor {
	name: string;
	slug: string;
	aliases: string[];
	domains: string[];
	githubOrgs: string[];
	registryName: string;
	url: string;
	proven: boolean;
	checkedOn: string;
}

export function publicVendors(
	vendors: readonly KnownVendor[] = KNOWN_VENDORS,
): PublicVendor[] {
	return vendors
		.filter((vendor) => publisherVerdict(vendor).verified)
		.map((vendor) => ({
			name: vendor.name,
			slug: vendor.slug,
			aliases: [...(vendor.aliases ?? [])],
			domains: [...vendor.domains],
			githubOrgs: [...(vendor.githubOrgs ?? [])],
			registryName: vendor.server.registryName,
			url: vendor.server.url,
			proven: vendor.proven === true,
			checkedOn: CHECKED_ON,
		}));
}
