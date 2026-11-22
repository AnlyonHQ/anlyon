import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAnlyon } from '../provider';
import type { QueryState } from '../core/store';

const SERVER_STATE: QueryState<never> = Object.freeze({ data: undefined, error: null, loading: true, fetching: false });

/** A focus within this long of the last fetch does not fetch again. */
const FOCUS_THROTTLE_MS = 5_000;

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Read `key` from the provider's cache, fetch it on mount, again when the page comes back into view
 * (an account connected in another tab, an approval decided elsewhere), and every `pollMs` while the
 * page is visible.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, pollMs = 0): QueryState<T> & { refresh: () => Promise<void> } {
  const { store } = useAnlyon();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const lastFetch = useRef(0);

  const subscribe = useCallback((listener: () => void) => (key ? store.subscribe(key, listener) : () => {}), [store, key]);
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? store.get<T>(key) : (SERVER_STATE as QueryState<T>)),
    () => SERVER_STATE as QueryState<T>,
  );

  const refresh = useCallback(() => {
    if (!key) return Promise.resolve();
    lastFetch.current = Date.now();
    return store.fetch(key, () => fetcherRef.current());
  }, [store, key]);

  useEffect(() => {
    if (!key) return;
    void refresh();
    const onReturn = () => {
      if (visible() && Date.now() - lastFetch.current > FOCUS_THROTTLE_MS) void refresh();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    const timer = pollMs > 0 ? setInterval(() => visible() && void refresh(), pollMs) : undefined;
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      if (timer) clearInterval(timer);
    };
  }, [key, refresh, pollMs]);

  return { ...state, refresh };
}

/** The current time, updated every `intervalMs`, for countdowns. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
