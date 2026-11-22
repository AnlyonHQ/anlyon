import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { createSessionClient, DEFAULT_BASE_URL, type SessionClient } from './core/client';
import { Store } from './core/store';
import { createTokenSource, type SessionTokenResult } from './core/token';

export type ConnectMode = 'popup' | 'redirect';

export interface ConnectOptions {
  /** `popup` (default) keeps your page open. `redirect` sends the whole tab. */
  mode?: ConnectMode;
  /**
   * Your callback route, under one of the environment's allowed redirect URLs. It must call
   * `createConnectCallbackHandler` from `@anlyonhq/react/server`. Without it, the environment's
   * default redirect URL is used.
   */
  redirectUrl?: string;
}

export interface AnlyonProviderProps {
  /**
   * Fetch an end-user session token from your server. Return the JSON that `createSessionHandler`
   * answers with (`{ token, expiresAt }`), or the token. Called again shortly before it expires.
   */
  getToken: () => Promise<SessionTokenResult>;
  /** The Anlyon API. Defaults to `https://api.anlyon.com`. */
  baseUrl?: string;
  connect?: ConnectOptions;
  /** How often open approvals are checked while the page is visible, in ms. Default 30000; 0 turns it off. */
  pollInterval?: number;
  /** Locale for amounts and dates. Defaults to the browser's. */
  locale?: string;
  children?: ReactNode;
}

export interface AnlyonContextValue {
  client: SessionClient;
  store: Store;
  connect: Required<Pick<ConnectOptions, 'mode'>> & Pick<ConnectOptions, 'redirectUrl'>;
  pollInterval: number;
  locale: string | undefined;
}

const AnlyonContext = createContext<AnlyonContextValue | null>(null);

/**
 * Gives the components below it a session for one end user. The token lives in memory only and is
 * fetched again before it expires.
 */
export function AnlyonProvider({ getToken, baseUrl, connect, pollInterval = 30_000, locale, children }: AnlyonProviderProps) {
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const core = useMemo(() => {
    const tokens = createTokenSource(() => getTokenRef.current());
    return { client: createSessionClient({ baseUrl: baseUrl ?? DEFAULT_BASE_URL, tokens }), store: new Store() };
  }, [baseUrl]);

  const mode = connect?.mode ?? 'popup';
  const redirectUrl = connect?.redirectUrl;
  const value = useMemo<AnlyonContextValue>(
    () => ({ ...core, connect: { mode, redirectUrl }, pollInterval, locale }),
    [core, mode, redirectUrl, pollInterval, locale],
  );

  return <AnlyonContext.Provider value={value}>{children}</AnlyonContext.Provider>;
}

/** The provider's session. Throws outside an `<AnlyonProvider>`. */
export function useAnlyon(): AnlyonContextValue {
  const value = useContext(AnlyonContext);
  if (!value) throw new Error('Anlyon components and hooks must be used inside <AnlyonProvider>.');
  return value;
}

/** The provider's session, or null outside one. */
export function useOptionalAnlyon(): AnlyonContextValue | null {
  return useContext(AnlyonContext);
}
