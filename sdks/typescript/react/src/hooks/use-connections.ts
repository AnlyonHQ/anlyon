import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnlyon, type ConnectMode } from '../provider';
import type { AnlyonUIError } from '../core/client';
import { integrationName } from '../core/integrations';
import { listenForConnect, markPopup, navigation, openBlankPopup } from '../core/popup';
import { safeUrl } from '../core/safe-url';
import { toUIError } from '../core/store';
import type { Connection } from '../core/types';
import { useQuery } from './shared';

const CONNECTIONS = 'connections';

export interface UseConnectionsResult {
  connections: Connection[];
  loading: boolean;
  error: AnlyonUIError | null;
  refresh: () => Promise<void>;
  /** Revoke at the provider where it can, then delete. Throws an `AnlyonUIError` when it fails. */
  disconnect: (integration: string) => Promise<void>;
}

/** The end user's connected accounts. Never a token. Checked again when the page comes back into view. */
export function useConnections(): UseConnectionsResult {
  const { client, store } = useAnlyon();
  const query = useQuery(CONNECTIONS, () => client.listConnections());

  const disconnect = useCallback(
    async (integration: string) => {
      try {
        await client.deleteConnection(integration);
      } catch (error) {
        throw toUIError(error);
      }
      store.set<Connection[]>(CONNECTIONS, (list) => list?.filter((c) => c.integration !== integration));
      void store.fetch(CONNECTIONS, () => client.listConnections());
    },
    [client, store],
  );

  return { connections: query.data ?? [], loading: query.loading, error: query.error, refresh: query.refresh, disconnect };
}

/** Where the end user stands with one integration. */
export type ConnectState = 'loading' | 'not_connected' | 'connected' | 'needs_reconnect';

/** `starting` while the link is made; `waiting` while the popup is open. */
export type ConnectPhase = 'idle' | 'starting' | 'waiting';

export interface UseConnectOptions {
  mode?: ConnectMode;
  redirectUrl?: string;
  /** Called once the account is connected, in popup mode. */
  onConnected?: (integration: string) => void;
}

export interface UseConnectResult {
  status: ConnectState;
  phase: ConnectPhase;
  connection: Connection | null;
  error: AnlyonUIError | null;
  /** Start connecting. Call it from a click: the popup opens before anything is awaited. */
  connect: () => Promise<void>;
  /** Stop waiting for the popup. */
  cancel: () => void;
}

/** Connect, or reconnect, one integration for the end user. */
export function useConnect(integration: string, options: UseConnectOptions = {}): UseConnectResult {
  const context = useAnlyon();
  const { connections, loading, error: listError, refresh } = useConnections();
  const [phase, setPhase] = useState<ConnectPhase>('idle');
  const [error, setError] = useState<AnlyonUIError | null>(null);
  const onConnected = useRef(options.onConnected);
  onConnected.current = options.onConnected;

  const connection = connections.find((c) => c.integration === integration && c.status !== 'revoked') ?? null;
  const status: ConnectState =
    loading && !listError ? 'loading' : !connection ? 'not_connected' : connection.status === 'active' ? 'connected' : 'needs_reconnect';

  useEffect(() => {
    if (phase !== 'waiting') return;
    return listenForConnect((outcome) => {
      if (outcome.integration && outcome.integration !== integration) return;
      setPhase('idle');
      void refresh();
      if (outcome.status === 'connected') onConnected.current?.(integration);
      else if (outcome.status !== 'declined') {
        setError(toUIError(new Error(`Connecting ${integrationName(integration)} didn't finish. Try again.`)));
      }
    });
  }, [phase, integration, refresh]);

  useEffect(() => {
    if (phase === 'waiting' && status === 'connected') {
      setPhase('idle');
      onConnected.current?.(integration);
    }
  }, [phase, status, integration]);

  const mode = options.mode ?? context.connect.mode;
  const redirectUrl = options.redirectUrl ?? context.connect.redirectUrl;

  const connect = useCallback(async () => {
    const popup = mode === 'popup' ? openBlankPopup() : null;
    setError(null);
    setPhase('starting');
    try {
      const link = await context.client.createConnectLink(integration, popup ? markPopup(redirectUrl) : redirectUrl);
      const url = safeUrl(link.url);
      if (!url) throw new Error(`The connect link for ${integrationName(integration)} is not a safe https URL.`);
      if (popup && !popup.closed) {
        popup.location.href = url;
        popup.focus();
        setPhase('waiting');
      } else {
        navigation.assign(url);
      }
    } catch (cause) {
      popup?.close();
      setError(toUIError(cause));
      setPhase('idle');
    }
  }, [context.client, integration, mode, redirectUrl]);

  const cancel = useCallback(() => setPhase('idle'), []);

  return { status, phase, connection, error: error ?? (status === 'loading' ? null : listError), connect, cancel };
}
