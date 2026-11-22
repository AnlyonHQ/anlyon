import { describe, expect, it } from "vitest";
import {
	CHECKED_ON,
	KNOWN_VENDORS,
	type KnownVendor,
	publicVendors,
	publisherVerdict,
	SIGN_IN_RECORD,
	SLUG_PATTERN,
	slugify,
	underDomain,
	vendorByProductSlug,
	vendorBySlug,
} from "./index.ts";

describe("slugs", () => {
	it("every vendor has one, in the link format", () => {
		for (const vendor of KNOWN_VENDORS) {
			expect(vendor.slug, vendor.name).toMatch(SLUG_PATTERN);
		}
	});

	it("no two vendors share one", () => {
		const slugs = KNOWN_VENDORS.map((vendor) => vendor.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	it("each was made from the name by the shared rule", () => {
		for (const vendor of KNOWN_VENDORS) {
			expect(slugify(vendor.name), vendor.name).toBe(vendor.slug);
		}
	});

	it("the rule", () => {
		expect(slugify("monday.com")).toBe("monday-com");
		expect(slugify("Hugging Face")).toBe("hugging-face");
		expect(slugify("  CircleCI  ")).toBe("circleci");
		expect(slugify("A -- B")).toBe("a-b");
	});

	it("these are the slugs links already use", () => {
		expect(KNOWN_VENDORS.map((vendor) => vendor.slug)).toEqual(
			expect.arrayContaining([
				"linear",
				"monday-com",
				"hugging-face",
				"github",
				"notion",
				"stripe",
			]),
		);
	});
});

describe("looking a vendor up by slug", () => {
	it("finds an exact slug", () => {
		expect(vendorBySlug("linear")?.server.url).toBe(
			"https://mcp.linear.app/mcp",
		);
		expect(vendorBySlug("monday-com")?.name).toBe("monday.com");
	});

	it.each([
		["an unknown slug", "linear-clone"],
		["another case", "Linear"],
		["padding", " linear"],
		["a URL", "https://evil.example/mcp"],
		["a host", "mcp.linear.app"],
		["an encoded slug", "linear%00"],
		["a prototype key", "__proto__"],
		["a name", "monday.com"],
		["an empty string", ""],
	])("finds nothing for %s", (_label, slug) => {
		expect(vendorBySlug(slug)).toBeUndefined();
	});

	it("finds nothing for no value", () => {
		expect(vendorBySlug(undefined)).toBeUndefined();
		expect(vendorBySlug(null)).toBeUndefined();
	});
});

describe("publisherVerdict", () => {
	const vendor = (
		fields: Partial<KnownVendor> & { server: KnownVendor["server"] },
	): KnownVendor => ({
		name: "Stripe",
		slug: "stripe",
		domains: ["stripe.com"],
		...fields,
	});

	it("every vendor checked into the repo passes on its own terms", () => {
		for (const known of KNOWN_VENDORS) {
			expect(publisherVerdict(known), known.name).toMatchObject({
				verified: true,
			});
		}
	});

	it("gives no vendor a hosting platform's domain", () => {
		const shared = [
			"railway.app",
			"vercel.app",
			"workers.dev",
			"pages.dev",
			"netlify.app",
			"onrender.com",
			"fly.dev",
			"herokuapp.com",
			"github.io",
		];
		for (const known of KNOWN_VENDORS) {
			for (const domain of known.domains)
				expect(shared, known.name).not.toContain(domain);
		}
	});

	it("passes by domain and by GitHub organisation", () => {
		expect(
			publisherVerdict(
				vendor({
					server: {
						registryName: "com.stripe/mcp",
						url: "https://mcp.stripe.com",
					},
				}),
			),
		).toMatchObject({
			verified: true,
			verifiedBy: "domain",
			host: "mcp.stripe.com",
		});
		expect(
			publisherVerdict(
				vendor({
					githubOrgs: ["stripe"],
					server: {
						registryName: "io.github.Stripe/mcp",
						url: "https://mcp.stripe.com",
					},
				}),
			),
		).toMatchObject({ verified: true, verifiedBy: "github" });
	});

	it.each([
		[
			"a GitHub account that is not the vendor's",
			"io.github.codespar/mcp-stripe",
			"https://mcp.stripe.com",
		],
		[
			"a look-alike domain",
			"com.stripe-mcp/mcp",
			"https://mcp.stripe-mcp.com/mcp",
		],
		[
			"a domain ending in the vendor's name",
			"com.evilstripe/mcp",
			"https://mcp.evilstripe.com/mcp",
		],
		[
			"an endpoint elsewhere",
			"com.stripe/mcp",
			"https://mcp.stripe.com.evil.example/mcp",
		],
		[
			"credentials hiding the real host",
			"com.stripe/mcp",
			"https://mcp.stripe.com@evil.example/mcp",
		],
		["plain http", "com.stripe/mcp", "http://mcp.stripe.com/mcp"],
		["another port", "com.stripe/mcp", "https://mcp.stripe.com:8443/mcp"],
		["not a URL", "com.stripe/mcp", "mcp.stripe.com"],
	])("refuses %s", (_label, registryName, url) => {
		expect(
			publisherVerdict(vendor({ server: { registryName, url } })).verified,
		).toBe(false);
	});

	it("underDomain is a suffix on a label boundary", () => {
		expect(underDomain("mcp.stripe.com", ["stripe.com"])).toBe(true);
		expect(underDomain("stripe.com", ["stripe.com"])).toBe(true);
		expect(underDomain("evilstripe.com", ["stripe.com"])).toBe(false);
	});
});

describe("the public list", () => {
	it("carries every vendor, with every field filled", () => {
		const list = publicVendors();
		expect(list).toHaveLength(KNOWN_VENDORS.length);
		for (const entry of list) {
			expect(Object.keys(entry).sort()).toEqual(
				[
					"aliases",
					"checkedOn",
					"domains",
					"githubOrgs",
					"name",
					"proven",
					"registryName",
					"slug",
					"url",
				].sort(),
			);
			expect(entry.checkedOn).toBe(CHECKED_ON);
			expect(typeof entry.proven).toBe("boolean");
		}
	});

	it("leaves out an entry that fails its own check", () => {
		const bad: KnownVendor = {
			name: "Stripe",
			slug: "stripe",
			domains: ["stripe.com"],
			server: {
				registryName: "com.evilstripe/mcp",
				url: "https://mcp.evilstripe.com/mcp",
			},
		};
		expect(publicVendors([bad])).toEqual([]);
	});

	it("names only the vendors whose live proof row passed", () => {
		expect(
			publicVendors()
				.filter((entry) => entry.proven)
				.map((entry) => entry.slug),
		).toEqual(["linear"]);
	});
});

describe("sign-in", () => {
	it("every sign-in has a source: the record, or a page on the vendor's own domain", () => {
		for (const vendor of KNOWN_VENDORS) {
			if (vendor.signIn === undefined) {
				expect(vendor.signInSource, vendor.slug).toBeUndefined();
				expect(vendor.oauthClient, vendor.slug).toBeUndefined();
				continue;
			}
			const source = vendor.signInSource ?? "";
			if (source === SIGN_IN_RECORD) continue;
			const url = new URL(source);
			expect(url.protocol, vendor.slug).toBe("https:");
			expect(underDomain(url.hostname, vendor.domains), source).toBe(true);
		}
	});

	it("the six from the endpoints' own recorded answers", () => {
		expect(
			KNOWN_VENDORS.filter((vendor) => vendor.signInSource === SIGN_IN_RECORD)
				.map((vendor) => `${vendor.slug}:${vendor.signIn}`)
				.sort(),
		).toEqual([
			"atlassian:oauth",
			"github:oauth",
			"linear:oauth",
			"notion:oauth",
			"stripe:oauth",
			"supabase:oauth",
		]);
	});

	it("the ones whose own documentation states it, and the ones it does not", () => {
		const fromDocs = KNOWN_VENDORS.filter(
			(vendor) => vendor.signIn && vendor.signInSource !== SIGN_IN_RECORD,
		);
		expect(
			fromDocs.filter((v) => v.signIn === "key").map((v) => v.slug),
		).toEqual(["firecrawl"]);
		expect(fromDocs.filter((v) => v.signIn === "oauth")).toHaveLength(19);
		expect(
			KNOWN_VENDORS.filter((vendor) => vendor.signIn === undefined)
				.map((vendor) => vendor.slug)
				.sort(),
		).toEqual([
			"canva",
			"exa",
			"figma",
			"hugging-face",
			"paypal",
			"prisma",
			"wix",
		]);
	});

	it("a client cannot register itself with GitHub or Zoom", () => {
		expect(
			KNOWN_VENDORS.filter((vendor) => vendor.oauthClient).map(
				(vendor) => `${vendor.slug}:${vendor.signIn}:${vendor.oauthClient}`,
			),
		).toEqual(["github:oauth:preregistered", "zoom:oauth:preregistered"]);
	});
});

describe("products", () => {
	it("only Atlassian names any, and none collides with a vendor's slug", () => {
		expect(
			KNOWN_VENDORS.filter((vendor) => vendor.products).map(
				(vendor) => `${vendor.slug}:${vendor.products?.join(",")}`,
			),
		).toEqual(["atlassian:Jira,Confluence"]);
		const slugs = new Set(KNOWN_VENDORS.map((vendor) => vendor.slug));
		const seen = new Set<string>();
		for (const vendor of KNOWN_VENDORS) {
			for (const product of vendor.products ?? []) {
				const slug = slugify(product);
				expect(slug).toMatch(SLUG_PATTERN);
				expect(slugs.has(slug), product).toBe(false);
				expect(seen.has(slug), product).toBe(false);
				seen.add(slug);
			}
		}
	});

	it("vendorByProductSlug finds the one vendor, by exact slug only", () => {
		expect(vendorByProductSlug("jira")?.slug).toBe("atlassian");
		expect(vendorByProductSlug("confluence")?.slug).toBe("atlassian");
		expect(vendorByProductSlug("Jira")).toBeUndefined();
		expect(vendorByProductSlug("atlassian")).toBeUndefined();
		expect(vendorByProductSlug("__proto__")).toBeUndefined();
		expect(vendorByProductSlug(null)).toBeUndefined();
	});
});
