export const MCP_SESSION_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 1_000;

export interface CachedSession {
  sessionId: string | null;
  protocolVersion: string;
}

interface Entry extends CachedSession {
  expiresAt: number;
}

const entries = new Map<string, Entry>();

export interface SessionKey {
  workspaceId: string | null;
  environmentId: string;
  upstreamId: string;
  endUserId?: string | null;
}

export function sessionKey(key: SessionKey): string {
  return JSON.stringify([key.workspaceId ?? null, key.environmentId, key.upstreamId, key.endUserId ?? null]);
}

export function getCachedSession(key: string, now = Date.now()): CachedSession | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return null;
  }
  return { sessionId: entry.sessionId, protocolVersion: entry.protocolVersion };
}

export function cacheSession(key: string, session: CachedSession, now = Date.now()): void {
  entries.delete(key);
  entries.set(key, { ...session, expiresAt: now + MCP_SESSION_TTL_MS });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function dropCachedSession(key: string): void {
  entries.delete(key);
}

export function clearSessionCache(): void {
  entries.clear();
}
