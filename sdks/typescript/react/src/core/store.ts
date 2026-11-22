import { AnlyonUIError } from './client';

/** One cached read. `data` stays while a refetch runs, so nothing flickers. */
export interface QueryState<T> {
  data: T | undefined;
  error: AnlyonUIError | null;
  /** True until the first answer, success or failure. */
  loading: boolean;
  /** True while any fetch for this key runs. */
  fetching: boolean;
}

const EMPTY: QueryState<never> = Object.freeze({ data: undefined, error: null, loading: true, fetching: false });

interface Entry {
  state: QueryState<unknown>;
  listeners: Set<() => void>;
  inflight: Promise<void> | null;
}

export function toUIError(error: unknown): AnlyonUIError {
  if (error instanceof AnlyonUIError) return error;
  const message = error instanceof Error && error.message ? error.message : 'Something went wrong.';
  return new AnlyonUIError(0, 'UNKNOWN_ERROR', message);
}

/**
 * A small cache keyed by string, read with `useSyncExternalStore`. Every component under one
 * provider shares it, so an inbox and a prompt for the same approval agree.
 */
export class Store {
  private entries = new Map<string, Entry>();

  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: EMPTY, listeners: new Set(), inflight: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  get<T>(key: string): QueryState<T> {
    return this.entry(key).state as QueryState<T>;
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  private update(key: string, patch: Partial<QueryState<unknown>>): void {
    const entry = this.entry(key);
    entry.state = { ...entry.state, ...patch };
    for (const listener of [...entry.listeners]) listener();
  }

  /** Fetch `key`, or join the fetch already running. Never throws: the error lands in the state. */
  fetch<T>(key: string, fetcher: () => Promise<T>): Promise<void> {
    const entry = this.entry(key);
    if (entry.inflight) return entry.inflight;
    this.update(key, { fetching: true });
    const run = fetcher().then(
      (data) => this.update(key, { data, error: null, loading: false, fetching: false }),
      (error: unknown) => this.update(key, { error: toUIError(error), loading: false, fetching: false }),
    );
    entry.inflight = run.finally(() => {
      entry.inflight = null;
    });
    return entry.inflight;
  }

  /** Change cached data in place, e.g. after a decision. */
  set<T>(key: string, updater: (data: T | undefined) => T | undefined): void {
    const state = this.get<T>(key);
    this.update(key, { data: updater(state.data), loading: false });
  }
}
