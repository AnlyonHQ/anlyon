export const STORE_CACHE_MAX_ENTRIES = 1_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const entries = new Map<string, Entry<unknown>>();

export function cacheGet<T>(key: string, now = Date.now()): T | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number, now = Date.now()): void {
  if (ttlMs <= 0) return;
  entries.delete(key);
  while (entries.size >= STORE_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  entries.set(key, { value, expiresAt: now + ttlMs });
}

export function cacheDelete(key: string): void {
  entries.delete(key);
}

export function cacheDropStore(storeRowId: string): void {
  for (const key of entries.keys()) if (key.startsWith(`${storeRowId}|`)) entries.delete(key);
}

export function cacheClear(): void {
  entries.clear();
}

export function cacheSize(): number {
  return entries.size;
}
