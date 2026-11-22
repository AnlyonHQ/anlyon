import type { VaultSecretStoreConfig } from "../../db/schema/secret-stores.ts";
import { cacheDelete, cacheGet, cacheSet } from "./cache.ts";
import { StoreReadError, discard, pickValue, storeJson, storeRequest } from "./http.ts";
import type { ExternalLocation, StoreClientContext } from "./types.ts";

export type VaultStoreCredential = { token: string } | { roleId: string; secretId: string };

export function vaultPathIsValid(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/[\x00-\x1f?#]/.test(segment));
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function baseHeaders(config: VaultSecretStoreConfig): Record<string, string> {
  return {
    "x-vault-request": "true",
    ...(config.namespace ? { "x-vault-namespace": config.namespace } : {}),
  };
}

function classify(status: number, what: string): StoreReadError {
  if (status === 401 || status === 403) return new StoreReadError("store_denied", `Vault refused ${what} (${status}).`);
  if (status === 404) return new StoreReadError("reference_not_found", `Vault has nothing at ${what} (404).`);
  if (status === 400) return new StoreReadError("store_denied", `Vault refused ${what} as malformed (400).`);
  return new StoreReadError("store_unreachable", `Vault answered ${status} to ${what}.`);
}

function address(config: VaultSecretStoreConfig): string {
  return config.address.replace(/\/+$/, "");
}

async function vaultToken(config: VaultSecretStoreConfig, credential: VaultStoreCredential, ctx: StoreClientContext, now: number): Promise<string> {
  if ("token" in credential) return credential.token;
  const key = `${ctx.cacheKey}|vault-approle`;
  const cached = cacheGet<string>(key, now);
  if (cached) return cached;
  const mount = config.authMount || "approle";
  const response = await storeRequest(`${address(config)}/v1/auth/${encodePath(mount)}/login`, {
    method: "POST",
    privateNetwork: ctx.privateNetwork,
    headers: { ...baseHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({ role_id: credential.roleId, secret_id: credential.secretId }),
  });
  if (!response.ok) {
    await discard(response);
    throw new StoreReadError("store_denied", `Vault refused the AppRole login (${response.status}).`);
  }
  const body = await storeJson(response);
  const auth = body.auth as { client_token?: unknown; lease_duration?: unknown } | undefined;
  if (!auth || typeof auth.client_token !== "string" || auth.client_token.length === 0) {
    throw new StoreReadError("store_unreachable", "Vault answered the AppRole login without a token.");
  }
  const leaseSeconds = typeof auth.lease_duration === "number" && auth.lease_duration > 0 ? auth.lease_duration : 300;
  cacheSet(key, auth.client_token, Math.max(0, leaseSeconds * 1000 - 30_000), now);
  return auth.client_token;
}

async function withToken(
  config: VaultSecretStoreConfig, credential: VaultStoreCredential, ctx: StoreClientContext, now: number,
  call: (token: string) => Promise<Response>,
): Promise<Response> {
  const response = await call(await vaultToken(config, credential, ctx, now));
  if (response.status !== 403 || "token" in credential) return response;
  await discard(response);
  cacheDelete(`${ctx.cacheKey}|vault-approle`);
  return call(await vaultToken(config, credential, ctx, now));
}

export async function vaultRead(
  config: VaultSecretStoreConfig, credential: VaultStoreCredential, location: ExternalLocation, ctx: StoreClientContext, now = Date.now(),
): Promise<string> {
  const query = location.version ? `?version=${encodeURIComponent(location.version)}` : "";
  const url = `${address(config)}/v1/${encodePath(config.mount || "secret")}/data/${encodePath(location.path)}${query}`;
  const response = await withToken(config, credential, ctx, now, (token) =>
    storeRequest(url, { method: "GET", privateNetwork: ctx.privateNetwork, headers: { ...baseHeaders(config), "x-vault-token": token } }));
  if (!response.ok) {
    await discard(response);
    throw classify(response.status, "the secret path");
  }
  const body = await storeJson(response);
  const data = (body.data as { data?: unknown } | undefined)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StoreReadError("reference_not_found", "Vault has no data at that version.");
  }
  return pickValue(data as Record<string, unknown>, location.key);
}

export async function vaultCheck(
  config: VaultSecretStoreConfig, credential: VaultStoreCredential, ctx: StoreClientContext, now = Date.now(),
): Promise<void> {
  const url = `${address(config)}/v1/auth/token/lookup-self`;
  const response = await withToken(config, credential, ctx, now, (token) =>
    storeRequest(url, { method: "GET", privateNetwork: ctx.privateNetwork, headers: { ...baseHeaders(config), "x-vault-token": token } }));
  await discard(response);
  if (response.status === 404) throw new StoreReadError("store_unreachable", "The address answered 404 to a token lookup, so it is not a Vault API.");
  if (!response.ok) throw classify(response.status, "the token lookup");
}
