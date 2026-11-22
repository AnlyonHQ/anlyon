/**
 * Client factory  creates and caches @anlyonhq/sdk Client instances.
 *
 * One Client per API key (the Client holds a connection pool + retry config).
 * The cache is bounded so a hosted HTTP deployment serving many keys cannot
 * grow memory without limit; eviction is oldest-inserted-first, and a Map
 * re-insert on hit keeps active keys fresh (LRU-ish).
 */

import { Client } from '@anlyonhq/sdk';
import { resolveApiBaseUrl, resolveCacheScope, resolveEndUserId } from './auth.ts';

const MAX_CACHED_CLIENTS = 1000;

interface CachedClient {
  client: Client;
  /** The credential this Client sends. Rotates under OAuth; fixed for API keys. */
  apiKey: string;
  /** Prevent reusing a connection pool after a host/API-origin change. */
  baseUrl?: string;
  /** The end user the Client is bound to. Part of the cache key too; checked again here. */
  endUserId: string | null;
}

const clientCache = new Map<string, CachedClient>();

export function getClient(apiKey: string): Client {
  const key = resolveCacheScope(apiKey);
  const baseUrl = resolveApiBaseUrl();
  const endUserId = resolveEndUserId();

  const hit = clientCache.get(key);
  if (hit) {
    clientCache.delete(key);
    if (hit.apiKey === apiKey && hit.baseUrl === baseUrl && hit.endUserId === endUserId) {
      clientCache.set(key, hit);
      return hit.client;
    }
  }

  if (clientCache.size >= MAX_CACHED_CLIENTS) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  const base = new Client({ apiKey, baseUrl });
  const client = endUserId ? base.forUser(endUserId) : base;
  clientCache.set(key, { client, apiKey, baseUrl, endUserId });
  return client;
}
