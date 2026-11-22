type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

let current: FetchLike | null = null;
const byHost = new Map<string, FetchLike>();

export function setProviderFetch(fetch: FetchLike | null) {
  current = fetch;
}

export function setProviderFetchForHost(host: string, fetch: FetchLike) {
  byHost.set(host, fetch);
}

export function clearProviderFetch() {
  current = null;
  byHost.clear();
}

export async function providerFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) {
  const host = new URL(url).hostname;
  const target = byHost.get(host) ?? current;
  if (!target) throw new Error(`No provider simulator installed for ${host}`);
  return target(url, { method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body });
}
