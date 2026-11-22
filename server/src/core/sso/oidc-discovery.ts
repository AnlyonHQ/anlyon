import { readBodyLimited } from "../../lib/read-body.ts";
import { safeFetch } from "../../lib/safe-http.ts";
import { ValidationError } from "../../utils/errors.ts";

export interface DiscoveredOidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  discoveryEndpoint: string;
  tokenEndpointAuthentication: "client_secret_basic" | "client_secret_post";
}

const DISCOVERY_TIMEOUT_MS = 10_000;

function httpsUrl(name: string, value: unknown): string {
  if (typeof value !== "string" || !value) throw new ValidationError(`The identity provider's discovery document has no ${name}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`The identity provider's ${name} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new ValidationError(`The identity provider's ${name} must use https`);
  return url.toString();
}

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export async function discoverOidcEndpoints(issuerInput: string): Promise<DiscoveredOidcEndpoints> {
  const issuer = trimSlash(httpsUrl("issuer", issuerInput));
  const discoveryEndpoint = `${issuer}/.well-known/openid-configuration`;

  let response: Response;
  try {
    response = await safeFetch(discoveryEndpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    throw new ValidationError(
      `Could not fetch ${discoveryEndpoint}. Check the issuer URL and that it is reachable from the internet.`,
    );
  }
  if (!response.ok) {
    throw new ValidationError(`${discoveryEndpoint} answered ${response.status}. Check the issuer URL.`);
  }

  let doc: Record<string, unknown>;
  try {
    const { text, truncated } = await readBodyLimited(response, 256 * 1024);
    if (truncated) throw new Error("too large");
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ValidationError(`${discoveryEndpoint} did not return JSON`);
  }

  if (typeof doc.issuer !== "string" || trimSlash(doc.issuer) !== issuer) {
    throw new ValidationError(
      `The discovery document names issuer "${String(doc.issuer)}", not "${issuer}". Use the issuer exactly as your identity provider shows it.`,
    );
  }

  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? (doc.token_endpoint_auth_methods_supported as unknown[])
    : [];
  const tokenEndpointAuthentication =
    methods.length > 0 && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")
      ? "client_secret_post"
      : "client_secret_basic";

  return {
    issuer: doc.issuer as string,
    authorizationEndpoint: httpsUrl("authorization_endpoint", doc.authorization_endpoint),
    tokenEndpoint: httpsUrl("token_endpoint", doc.token_endpoint),
    jwksEndpoint: httpsUrl("jwks_uri", doc.jwks_uri),
    userInfoEndpoint: doc.userinfo_endpoint ? httpsUrl("userinfo_endpoint", doc.userinfo_endpoint) : undefined,
    discoveryEndpoint,
    tokenEndpointAuthentication,
  };
}
