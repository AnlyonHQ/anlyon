/**
 * Auth  resolves the Anlyon API key.
 *
 * For stdio: reads ANLYON_API_KEY from the environment.
 * For HTTP: the transport wraps each request in requestContext.run({ apiKey })
 * so resolveApiKey() reads the per-request key via AsyncLocalStorage  no
 * process.env mutation, no concurrency race.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

interface RequestContext {
  apiKey: string;
  /**
   * API origin selected by an in-process host.
   *
   * Hosted MCP servers authenticate against their own Anlyon instance, so
   * forwarding tools to the SDK's public default would cross environments.
   * stdio callers leave this unset and use ANLYON_BASE_URL instead.
   */
  apiBaseUrl?: string;
  /**
   * Stable identity for per-caller caches, when the host knows one.
   *
   * The credential itself is a poor cache key for an OAuth deployment: access
   * tokens rotate every few minutes, so caching under them both churns and, with
   * two tokens of identical length and near-identical shape, invites collisions
   * between tenants. A host that has already authenticated the caller (the
   * scheduler's /mcp route) passes something stable instead  user + client,
   * which maps 1:1 to a workspace. stdio callers leave it unset and fall back to
   * a hash of the API key, which does not rotate.
   */
  cacheScope?: string;
  /**
   * The end user every call in this request acts for, sent as `Anlyon-End-User`.
   *
   * Set by the host from what the developer's server stated (the hosted route reads
   * the header of an API-key connection), never from a tool argument, so nothing a
   * model writes can choose or switch it. Absent: the workspace's own accounts.
   */
  endUserId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Key for anything cached per caller. Never the raw credential.
 *
 * SHA-256 rather than a cheap non-cryptographic hash: the fallback path keys on
 * a secret, and a 32-bit hash collides often enough that one tenant could be
 * served another tenant's tools.
 */
export function resolveCacheScope(apiKey: string): string {
  const scope = requestContext.getStore()?.cacheScope;
  const caller = scope ? `id:${scope}` : `key:${createHash('sha256').update(apiKey).digest('hex')}`;
  const endUser = resolveEndUserId();
  return endUser ? `${caller}|eu:${endUser}` : caller;
}

/**
 * The end user set for this process with `--end-user` (index.ts). Read before
 * ANLYON_END_USER, and only outside a hosted request.
 */
let processEndUser: string | undefined;

/** `--end-user <id>` or `--end-user=<id>` from the command line; undefined when absent. */
export function endUserFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--end-user') return argv[i + 1] ?? '';
    if (arg.startsWith('--end-user=')) return arg.slice('--end-user='.length);
  }
  return undefined;
}

/** Fix the end user for every call this process makes. stdio only. */
export function setProcessEndUser(endUserId: string | undefined): void {
  processEndUser = endUserId;
}

/**
 * The end user the current call acts for, or null for the workspace's own accounts.
 * - HTTP path: the request's own, from AsyncLocalStorage. The process setting never applies.
 * - stdio path: `--end-user`, then ANLYON_END_USER.
 */
export function resolveEndUserId(): string | null {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.endUserId ?? null;
  return processEndUser ?? (process.env.ANLYON_END_USER || null);
}

/**
 * Resolve the API key for the current request context.
 * - HTTP path: reads from AsyncLocalStorage (per-request, race-free).
 * - stdio path: falls through to process.env.ANLYON_API_KEY.
 */
export function resolveApiKey(): string | null {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.apiKey;
  return process.env.ANLYON_API_KEY ?? null;
}

/** Resolve the API origin for both hosted and stdio transports. */
export function resolveApiBaseUrl(): string | undefined {
  return requestContext.getStore()?.apiBaseUrl ?? process.env.ANLYON_BASE_URL;
}

/**
 * Extract the API key from an Authorization: Bearer <key> header.
 * Returns null if absent or malformed.
 */
export function extractBearerKey(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
