import { KNOWN_VENDORS, type KnownVendor } from "@anlyon/known-vendors";
import { afterEach, describe, expect, it } from "vitest";
import {
	knownVendors,
	registerExtension,
	resetExtensions,
} from "@/lib/extensions";
import { addServerSearch, linkedServer, nameFromSlug } from "./mcp-server-link";

afterEach(() => {
	resetExtensions();
});

describe("what a link into the add flow may set", () => {
	it("keeps a server slug, a known ref and utm_source", () => {
		expect(
			addServerSearch({
				server: "linear",
				ref: "anlyon-com",
				utm_source: "producthunt",
			}),
		).toEqual({
			server: "linear",
			ref: "anlyon-com",
			utm_source: "producthunt",
		});
		expect(addServerSearch({ ref: "anlyon-dev" })).toEqual({
			ref: "anlyon-dev",
		});
	});

	it("never reads an address: ?url= and anything else are dropped", () => {
		expect(
			addServerSearch({
				url: "https://mcp.evil.example/mcp",
				host: "mcp.evil.example",
				name: "linear",
			}),
		).toEqual({});
		expect(
			addServerSearch({
				server: "linear",
				url: "https://mcp.evil.example/mcp",
			}),
		).toEqual({ server: "linear" });
	});

	it("drops a ref it does not know, and values that are not short strings", () => {
		expect(addServerSearch({ ref: "evil.example" })).toEqual({});
		expect(addServerSearch({ server: 42, ref: ["anlyon-com"] })).toEqual({});
		expect(addServerSearch({ server: "x".repeat(65) })).toEqual({});
	});
});

describe("what a ?server= value names", () => {
	it("a vendor on the checked-in list, by exact slug", () => {
		const linked = linkedServer("linear");
		expect(linked?.kind).toBe("vendor");
		expect(linked?.kind === "vendor" && linked.vendor.server.url).toBe(
			"https://mcp.linear.app/mcp",
		);
	});

	it("nothing for anything else", () => {
		expect(linkedServer(undefined)).toBeNull();
		for (const value of [
			"linear-clone",
			"https://mcp.linear.app/mcp",
			"LINEAR",
			"__proto__",
		]) {
			expect(linkedServer(value), value).toEqual({ kind: "unknown" });
		}
	});

	it("only from the list it is given: a vendor elsewhere is not found", () => {
		expect(linkedServer("linear", [])).toEqual({ kind: "unknown" });
	});

	it("a vendor a console extension adds, beside the checked-in list", () => {
		const acme: KnownVendor = {
			name: "Acme Tools",
			slug: "acme-tools",
			domains: ["acme.example"],
			server: {
				registryName: "example.acme/mcp",
				url: "https://mcp.acme.example/mcp",
			},
		};
		expect(knownVendors()).toBe(KNOWN_VENDORS);
		expect(linkedServer("acme-tools")).toEqual({ kind: "unknown" });
		registerExtension({ id: "test", vendors: [acme] });
		expect(knownVendors()).toEqual([...KNOWN_VENDORS, acme]);
		expect(linkedServer("acme-tools")).toEqual({
			kind: "vendor",
			vendor: acme,
		});
		expect(linkedServer("linear")?.kind).toBe("vendor");
		resetExtensions();
		expect(linkedServer("acme-tools")).toEqual({ kind: "unknown" });
	});

	it("every listed slug is a usable server name", () => {
		for (const vendor of KNOWN_VENDORS) {
			expect(nameFromSlug(vendor.slug, []), vendor.slug).toBe(vendor.slug);
		}
		expect(nameFromSlug("linear", ["linear", "linear-2"])).toBe("linear-3");
	});
});
