import { isFeatureEnabled } from "@anlyon/feature-flags";
import { type PublisherVerdict, publisherVerdict } from "@anlyon/known-vendors";
import type { ErrorFix } from "../../utils/errors.ts";
import { type IntegrationEntry, listedIntegrations } from "./catalogue.ts";
import { type KnownVendor, knownVendors } from "./known-vendors.ts";

export { type PublisherVerdict, publisherVerdict };

export type IntegrationRouteKind = "integration" | "mcp" | "openapi" | "mcp_address" | "custom_action";

export interface IntegrationRoute {
  kind: IntegrationRouteKind;
  why: string;
  next: ErrorFix;
  integration?: { id: string; connect: "sign_in" | "api_key" };
  mcp?: {
    registryName: string;
    url: string;
    host: string;
    publisher: { verifiedBy: "domain" | "github"; namespace: string };
    report: string;
  };
}

export interface IntegrationRouteResult {
  query: string;
  name: string;
  route: IntegrationRoute;
  alternatives: IntegrationRoute[];
  tellUs: string;
}

export interface RouteOptions {
  consoleUrl: string;
  mcpEnabled?: boolean;
  catalogue?: readonly IntegrationEntry[];
  vendors?: readonly KnownVendor[];
}

const DOCS = "https://docs.anlyon.com";
const MAX_NAME = 80;
const ANLYON_DEV = "https://anlyon.dev";

const mcpAddCommand = (url: string) => `anlyon mcp add ${url}`;

const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function cleanName(input: string): string {
  return input.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
}

function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+(mcp server|mcp|api)$/, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function isVerifiedVendorEndpoint(endpoint: string, vendors: readonly KnownVendor[] = knownVendors()): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return vendors.some((vendor) => {
    const verdict = publisherVerdict(vendor);
    return verdict.verified && verdict.host === url.hostname;
  });
}

function consoleLink(consoleUrl: string, path: string, search: Record<string, string> = {}): string {
  const query = new URLSearchParams(search).toString();
  return `${consoleUrl.replace(/\/$/, "")}${path}${query ? `?${query}` : ""}`;
}

function integrationRoute(entry: IntegrationEntry, consoleUrl: string): IntegrationRoute {
  const signsIn = entry.auth.kind === "oauth";
  return {
    kind: "integration",
    why: `Anlyon has a governed pack for ${entry.displayName}, so your agent gets its actions and never holds the ${signsIn ? "token" : "key"}.`,
    next: {
      summary: signsIn ? `Connect a ${entry.displayName} account by signing in.` : `Connect a ${entry.displayName} account with a key you create there.`,
      command: `anlyon connections add ${entry.id}`,
      url: consoleLink(consoleUrl, "/integrations", { integration: entry.id }),
      docs: `${DOCS}/execution/connected-accounts`,
    },
    integration: { id: entry.id, connect: signsIn ? "sign_in" : "api_key" },
  };
}

function mcpRoute(vendor: KnownVendor, verdict: Extract<PublisherVerdict, { verified: true }>, consoleUrl: string): IntegrationRoute {
  return {
    kind: "mcp",
    why: `${vendor.name} publishes its own MCP server and the publisher is verified as ${vendor.name}, so you can govern it with MCP: your agent reaches only the tools you adopt.`,
    next: {
      summary: `Add ${verdict.host} as an MCP server, which lists its tools and adopts none until a person signs off.`,
      command: mcpAddCommand(verdict.url),
      url: consoleLink(consoleUrl, "/mcp-servers/new", { server: vendor.slug }),
    },
    mcp: {
      registryName: vendor.server.registryName,
      url: verdict.url,
      host: verdict.host,
      publisher: { verifiedBy: verdict.verifiedBy, namespace: verdict.namespace },
      report: `${ANLYON_DEV}/servers/${vendor.server.registryName.split("/").map(encodeURIComponent).join("/")}`,
    },
  };
}

function openApiRoute(name: string, consoleUrl: string): IntegrationRoute {
  return {
    kind: "openapi",
    why: `If ${name} publishes an OpenAPI spec, importing it is quick: each operation becomes an action, and its writes arrive governed.`,
    next: {
      summary: "Import the OpenAPI spec in the console, or POST it to /api/v2/actions/import, and choose which operations to keep.",
      url: consoleLink(consoleUrl, "/actions", { import: "openapi", vendor: name }),
      docs: `${DOCS}/execution/actions`,
    },
  };
}

function mcpAddressRoute(name: string, consoleUrl: string): IntegrationRoute {
  return {
    kind: "mcp_address",
    why: `If ${name} runs a remote MCP server you can add it by its address, but Anlyon has no server verified as ${name}'s, so check who publishes it first: a look-alike would collect your sign-ins.`,
    next: {
      summary: "Add the server by its address, which lists its tools and adopts none until a person signs off.",
      url: consoleLink(consoleUrl, "/mcp-servers/new"),
    },
  };
}

function mcpByUrlRoute(consoleUrl: string): IntegrationRoute {
  return {
    kind: "mcp_address",
    why: "You can add a remote MCP server by its URL and govern it with MCP: your agent reaches only the tools you adopt.",
    next: {
      summary: "Add the server by its URL, which lists its tools and adopts none until a person signs off.",
      url: consoleLink(consoleUrl, "/mcp-servers/new"),
    },
  };
}

function customActionRoute(name: string): IntegrationRoute {
  return {
    kind: "custom_action",
    why: `Any HTTPS API can be a governed action, so ${name} needs neither a spec nor a server.`,
    next: {
      summary: "Declare an action on its API with the SDK or POST /api/v2/actions, or tell us you need it.",
      docs: `${DOCS}/guides/any-http-api`,
    },
  };
}

function findVendor(key: string, vendors: readonly KnownVendor[]): KnownVendor | undefined {
  return vendors.find((vendor) => nameKey(vendor.name) === key || (vendor.aliases ?? []).some((alias) => nameKey(alias) === key));
}

export function findIntegrationRoute(input: string, options: RouteOptions): IntegrationRouteResult {
  const { consoleUrl, mcpEnabled = isFeatureEnabled("mcp-upstreams"), catalogue = listedIntegrations(), vendors = knownVendors() } = options;
  const query = cleanName(input);
  const key = nameKey(query);

  const entry = key ? catalogue.find((candidate) => candidate.operationsPack && (nameKey(candidate.id) === key || nameKey(candidate.displayName) === key)) : undefined;
  const vendor = key && mcpEnabled ? findVendor(key, vendors) : undefined;
  const verdict = vendor ? publisherVerdict(vendor) : undefined;
  const verified = vendor && verdict?.verified ? { vendor, verdict } : undefined;
  const proven = verified?.vendor.proven ? verified : undefined;

  const name = entry?.displayName ?? proven?.vendor.name ?? query;
  const routes: IntegrationRoute[] = [
    ...(entry ? [integrationRoute(entry, consoleUrl)] : []),
    ...(proven ? [mcpRoute(proven.vendor, proven.verdict, consoleUrl)] : []),
    openApiRoute(name, consoleUrl),
    ...(verified && !proven ? [mcpByUrlRoute(consoleUrl)] : []),
    ...(mcpEnabled && !verified ? [mcpAddressRoute(name, consoleUrl)] : []),
    customActionRoute(name),
  ];
  const [route, ...alternatives] = routes;
  return {
    query,
    name,
    route: route!,
    alternatives,
    tellUs: `mailto:support@anlyon.com?subject=${encodeURIComponent(`Integration request: ${name}`)}`,
  };
}

export function integrationRouteFix(input: string, consoleUrl: string): ErrorFix {
  return findIntegrationRoute(input, { consoleUrl }).route.next;
}
