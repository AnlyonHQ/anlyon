import { describe, expect, it } from "vitest";
import { KNOWN_VENDORS, SLUG_PATTERN } from "./index.ts";
import {
	type ConnectWay,
	SERVICE_CATEGORIES,
	SERVICES,
	serviceDepth,
	serviceIntegrations,
	serviceMatches,
	serviceOfIntegration,
	servicesWith,
	serviceVendor,
} from "./services.ts";

describe("services", () => {
	it("each has a slug in the link format, and no two share one", () => {
		for (const service of SERVICES)
			expect(service.slug, service.name).toMatch(SLUG_PATTERN);
		const slugs = SERVICES.map((service) => service.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	it("each has at least one way to connect, none twice, and a known category", () => {
		for (const service of SERVICES) {
			expect(service.ways.length, service.name).toBeGreaterThan(0);
			const keys = service.ways.map((way) => JSON.stringify(way));
			expect(new Set(keys).size, service.name).toBe(keys.length);
			expect(Object.keys(SERVICE_CATEGORIES)).toContain(service.category);
		}
	});

	it("names only vendors on the checked list", () => {
		const slugs = new Set(KNOWN_VENDORS.map((vendor) => vendor.slug));
		for (const service of SERVICES) {
			const vendor = serviceVendor(service);
			if (vendor)
				expect(slugs.has(vendor), `${service.name} -> ${vendor}`).toBe(true);
		}
	});

	it("gives every vendor on the checked list a named service", () => {
		const named = new Set(SERVICES.map(serviceVendor).filter(Boolean));
		for (const vendor of KNOWN_VENDORS)
			expect(named.has(vendor.slug), vendor.name).toBe(true);
	});

	it("puts each integration in exactly one service", () => {
		const seen = new Map<string, string>();
		for (const service of SERVICES) {
			for (const id of serviceIntegrations(service)) {
				expect(
					seen.get(id),
					`${id} in ${service.name} and ${seen.get(id)}`,
				).toBeUndefined();
				seen.set(id, service.name);
			}
		}
		expect(serviceOfIntegration("linear-key")?.slug).toBe("linear");
		expect(serviceOfIntegration("nonsense")).toBeNull();
	});

	it("is a full toolset when an integration reaches it, and via MCP otherwise", () => {
		expect(
			serviceDepth({
				ways: [
					{ kind: "api_key", integration: "stripe" },
					{ kind: "mcp", vendor: "stripe" },
				],
			}),
		).toBe("full_toolset");
		expect(serviceDepth({ ways: [{ kind: "mcp", vendor: "zapier" }] })).toBe(
			"via_mcp",
		);
	});
});

describe("servicesWith", () => {
	it("keeps only the ways a place offers, and drops a service left with none", () => {
		const onlyKeys = servicesWith({
			vendors: KNOWN_VENDORS,
			available: (way: ConnectWay) => way.kind === "api_key",
		});
		expect(
			onlyKeys.every((service) =>
				service.ways.every((way) => way.kind === "api_key"),
			),
		).toBe(true);
		expect(
			onlyKeys.find((service) => service.slug === "zapier"),
		).toBeUndefined();
		expect(onlyKeys.find((service) => service.slug === "linear")?.ways).toEqual(
			[{ kind: "api_key", integration: "linear-key" }],
		);
	});

	it("makes a vendor no service names into a service of its own", () => {
		const services = servicesWith({
			vendors: [...KNOWN_VENDORS, { name: "Example", slug: "example" }],
		});
		expect(services.find((service) => service.slug === "example")).toEqual({
			slug: "example",
			name: "Example",
			category: "other",
			ways: [{ kind: "mcp", vendor: "example" }],
		});
	});

	it("files such a vendor under the category it gives", () => {
		const services = servicesWith({
			vendors: [{ name: "Example", slug: "example", category: "data" }],
		});
		expect(
			services.find((service) => service.slug === "example")?.category,
		).toBe("data");
	});
});

describe("serviceMatches", () => {
	it("matches a name, a slug or a category, ignoring case", () => {
		const linear = SERVICES.find((service) => service.slug === "linear")!;
		expect(serviceMatches(linear, "LIN")).toBe(true);
		expect(serviceMatches(linear, "issues")).toBe(true);
		expect(serviceMatches(linear, "stripe")).toBe(false);
		expect(serviceMatches(linear, "  ")).toBe(true);
	});
});
