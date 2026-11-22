import { type KnownVendor, vendorBySlug } from "@anlyon/known-vendors";
import { knownVendors } from "@/lib/extensions";
import { SERVER_NAME } from "@/lib/mcp-servers";

export type AddServerSearch = {
	server?: string;
	ref?: AddServerRef;
	utm_source?: string;
};

export const ADD_SERVER_REFS = ["anlyon-com", "anlyon-dev"] as const;
export type AddServerRef = (typeof ADD_SERVER_REFS)[number];

const MAX_PARAM = 64;

const shortString = (value: unknown): string | undefined =>
	typeof value === "string" && value && value.length <= MAX_PARAM
		? value
		: undefined;

export function addServerSearch(
	search: Record<string, unknown>,
): AddServerSearch {
	const server = shortString(search.server);
	const ref = ADD_SERVER_REFS.find((candidate) => candidate === search.ref);
	const utm = shortString(search.utm_source);
	return {
		...(server ? { server } : {}),
		...(ref ? { ref } : {}),
		...(utm ? { utm_source: utm } : {}),
	};
}

export type LinkedServer =
	| { kind: "vendor"; vendor: KnownVendor }
	| { kind: "unknown" }
	| null;

export function linkedServer(
	slug: string | undefined,
	vendors: readonly KnownVendor[] = knownVendors(),
): LinkedServer {
	if (slug === undefined) return null;
	const vendor = vendorBySlug(slug, vendors);
	return vendor ? { kind: "vendor", vendor } : { kind: "unknown" };
}

export function nameFromSlug(slug: string, taken: readonly string[]): string {
	const base = SERVER_NAME.test(slug) && slug !== "new" ? slug : "server";
	if (!taken.includes(base)) return base;
	for (let n = 2; n < 100; n++) {
		const candidate = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
		if (!taken.includes(candidate)) return candidate;
	}
	return base;
}
