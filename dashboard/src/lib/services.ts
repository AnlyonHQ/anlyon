import {
	type ConnectWay,
	SERVICE_CATEGORIES,
	SERVICES,
	type Service,
	type ServiceCategory,
	type ServiceDepth,
	serviceDepth,
	serviceIntegrations,
	serviceMatches,
	servicesWith,
} from "@anlyon/known-vendors/services";

export interface IntegrationLike {
	id: string;
	name: string;
}

export interface ServiceRow<E extends IntegrationLike> {
	key: string;
	name: string;
	category: string | null;
	depth: ServiceDepth;
	ways: ConnectWay[];
	entries: E[];
	vendor: string | null;
	keywords: string[];
}

const CATEGORY_ORDER = Object.keys(SERVICE_CATEGORIES) as ServiceCategory[];
const SERVICE_BY_SLUG = new Map(
	SERVICES.map((service) => [service.slug, service]),
);

export function serviceRows<E extends IntegrationLike>(
	entries: readonly E[],
	options: {
		vendors: readonly {
			name: string;
			slug: string;
			category?: ServiceCategory;
			aliases?: readonly string[];
			products?: readonly string[];
		}[];
		mcp: boolean;
		offers?: (entry: E, kind: "sign_in" | "api_key") => boolean;
	},
): ServiceRow<E>[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const vendorSlugs = new Set(options.vendors.map((vendor) => vendor.slug));
	const keywordsOf = (slug: string | null): string[] => {
		const vendor = options.vendors.find((candidate) => candidate.slug === slug);
		return vendor
			? [
					vendor.name,
					vendor.slug,
					...(vendor.aliases ?? []),
					...(vendor.products ?? []),
				]
			: [];
	};
	const available = (way: ConnectWay) =>
		way.kind === "mcp"
			? options.mcp && vendorSlugs.has(way.vendor)
			: (() => {
					const entry = byId.get(way.integration);
					return (
						entry !== undefined && (options.offers?.(entry, way.kind) ?? true)
					);
				})();
	const services = servicesWith({
		vendors: options.mcp ? options.vendors : [],
		available,
	});
	const claimed = new Set<string>();
	const rows: ServiceRow<E>[] = services
		.map((service, index) => ({ service, index }))
		.sort(
			(a, b) =>
				CATEGORY_ORDER.indexOf(a.service.category) -
					CATEGORY_ORDER.indexOf(b.service.category) || a.index - b.index,
		)
		.map(({ service }) => {
			const rowEntries: E[] = [];
			for (const way of service.ways) {
				if (way.kind === "mcp") continue;
				const entry = byId.get(way.integration);
				if (entry && !rowEntries.includes(entry)) rowEntries.push(entry);
			}
			for (const id of serviceIntegrations(
				SERVICE_BY_SLUG.get(service.slug) ?? service,
			))
				claimed.add(id);
			return {
				key: service.slug,
				name: service.name,
				category: SERVICE_CATEGORIES[service.category],
				depth: serviceDepth(service),
				ways: [...service.ways],
				entries: rowEntries,
				vendor: vendorOf(service),
				keywords: keywordsOf(vendorOf(service)),
			};
		});
	for (const entry of entries) {
		if (claimed.has(entry.id)) continue;
		rows.push({
			key: entry.id,
			name: entry.name,
			category: null,
			depth: "full_toolset",
			ways: [],
			entries: [entry],
			vendor: null,
			keywords: [],
		});
	}
	return rows;
}

function vendorOf(service: Service): string | null {
	for (const way of service.ways) if (way.kind === "mcp") return way.vendor;
	return null;
}

export function matchesServiceRow(
	row: ServiceRow<IntegrationLike>,
	query: string,
): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	if (
		row.category &&
		serviceMatches(
			{
				name: row.name,
				slug: row.key,
				category: categoryOf(row.category),
			},
			needle,
		)
	)
		return true;
	return [
		row.name,
		row.key,
		...row.keywords,
		...row.entries.flatMap((entry) => [entry.id, entry.name]),
	]
		.join(" ")
		.toLowerCase()
		.includes(needle);
}

function categoryOf(label: string): ServiceCategory {
	return (
		(CATEGORY_ORDER.find((key) => SERVICE_CATEGORIES[key] === label) as
			| ServiceCategory
			| undefined) ?? "other"
	);
}

export function wayKinds(ways: readonly ConnectWay[]): ConnectWay["kind"][] {
	const kinds: ConnectWay["kind"][] = [];
	for (const way of ways) if (!kinds.includes(way.kind)) kinds.push(way.kind);
	return kinds;
}
