import { readBodyLimited } from "../../lib/read-body.ts";
import { safeFetch } from "../../lib/safe-http.ts";
import type { SecretStoreFailure } from "../../db/schema/secret-stores.ts";

export const STORE_TIMEOUT_MS = 5_000;

export interface StoreRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  privateNetwork?: boolean;
}

export type StoreFetch = (url: string, init: StoreRequestInit) => Promise<Response>;

export async function defaultStoreFetch(url: string, init: StoreRequestInit): Promise<Response> {
  const { privateNetwork, ...request } = init;
  return safeFetch(url, request, { allowPrivateNetwork: privateNetwork === true });
}

export const storeHttp: { fetch: StoreFetch } = { fetch: defaultStoreFetch };

export class StoreReadError extends Error {
  constructor(public readonly reason: SecretStoreFailure, message: string) {
    super(message);
    this.name = "StoreReadError";
  }
}

export async function storeRequest(url: string, init: Omit<StoreRequestInit, "signal">): Promise<Response> {
  try {
    return await storeHttp.fetch(url, { ...init, signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
  } catch (error) {
    const kind = error instanceof Error ? error.name : "error";
    throw new StoreReadError("store_unreachable", `The store did not answer (${kind}).`);
  }
}

export const STORE_RESPONSE_MAX_BYTES = 256 * 1024;

export async function storeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const { text, truncated } = await readBodyLimited(response, STORE_RESPONSE_MAX_BYTES);
    if (truncated) throw new Error("response too large");
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new StoreReadError("store_unreachable", `The store answered ${response.status} with an unreadable body.`);
  }
}

export async function storeText(response: Response): Promise<string> {
  const { text, truncated } = await readBodyLimited(response, STORE_RESPONSE_MAX_BYTES);
  if (truncated) throw new StoreReadError("store_unreachable", `The store answered ${response.status} with a body too large to be a secret.`);
  return text;
}

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function pickValue(fields: Record<string, unknown> | string, key: string | null): string {
  if (key === null) {
    if (typeof fields !== "string") {
      throw new StoreReadError("reference_not_found", "The secret holds several fields, and no key was named.");
    }
    if (fields.length === 0) throw new StoreReadError("reference_not_found", "The secret is empty.");
    return fields;
  }
  let map: Record<string, unknown>;
  if (typeof fields === "string") {
    try {
      const parsed = JSON.parse(fields) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      map = parsed as Record<string, unknown>;
    } catch {
      throw new StoreReadError("reference_not_found", "The secret is not a JSON object, so it has no keys.");
    }
  } else {
    map = fields;
  }
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    throw new StoreReadError("reference_not_found", "The secret has no such key.");
  }
  const value = map[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new StoreReadError("reference_not_found", "The key does not hold a usable value.");
}
