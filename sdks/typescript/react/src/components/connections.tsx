import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AnlyonUIError } from '../core/client';
import { formatAgo, formatDateTime } from '../core/format';
import { integrationName } from '../core/integrations';
import type { Connection } from '../core/types';
import { useNow } from '../hooks/shared';
import { useConnect, useConnections, type UseConnectOptions } from '../hooks/use-connections';
import { useAnlyon } from '../provider';
import { AlertIcon, LiveRegion, SkeletonRows, Spinner, monogram, rootClass, useAnnouncer, type StyleProps } from './shared';

export interface ConnectionsProps extends StyleProps, Pick<UseConnectOptions, 'mode' | 'redirectUrl'> {
  /** Integrations to offer even before they are connected, e.g. `['github', 'slack']`. */
  integrations?: string[];
  /** The heading. Default `Connected accounts`; null hides the header. */
  title?: ReactNode;
  /** Shown when there is nothing to list. */
  empty?: ReactNode;
}

interface RowProps extends Pick<UseConnectOptions, 'mode' | 'redirectUrl'> {
  integration: string;
  connection: Connection | null;
  now: number;
  locale?: string;
  disconnect: (integration: string) => Promise<void>;
  announce: (message: string) => void;
}

function ConnectionRow({ integration, connection, now, locale, disconnect, announce, mode, redirectUrl }: RowProps) {
  const name = connection?.displayName ?? integrationName(integration);
  const { phase, error: connectError, connect, cancel } = useConnect(integration, {
    mode,
    redirectUrl,
    onConnected: () => announce(`${name} connected`),
  });
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<AnlyonUIError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const promptId = useId();
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (returnFocus.current) disconnectRef.current?.focus();
    returnFocus.current = false;
  }, [confirming]);

  const status = !connection ? 'not_connected' : connection.status === 'active' ? 'active' : 'needs_reconnect';
  const busy = phase !== 'idle';
  const shownError = error ?? connectError;

  const stopConfirming = () => {
    returnFocus.current = true;
    setConfirming(false);
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await disconnect(integration);
      announce(`${name} disconnected`);
    } catch (cause) {
      setError(cause as AnlyonUIError);
      setRemoving(false);
      stopConfirming();
    }
  };

  let meta: ReactNode;
  if (!connection) meta = 'Not connected';
  else if (status === 'needs_reconnect') meta = <span className="anlyon-warning-text">Stopped working. Reconnect to keep using it.</span>;
  else
    meta = (
      <span title={formatDateTime(connection.connectedAt, locale)}>
        {connection.kind === 'api_key' ? 'API key · ' : ''}Connected {formatAgo(connection.connectedAt, now)}
      </span>
    );

  return (
    <li className="anlyon-connection" data-status={status}>
      <div className="anlyon-connection-main">
        <span className="anlyon-monogram" aria-hidden="true">
          {monogram(name)}
        </span>
        <span className="anlyon-connection-text">
          <span className="anlyon-connection-name">{name}</span>
          <span className="anlyon-connection-meta">{meta}</span>
        </span>
        <span className="anlyon-connection-actions">
          {confirming ? (
            <span className="anlyon-confirm" role="group" aria-labelledby={promptId}>
              <span className="anlyon-confirm-text" id={promptId}>
                Disconnect {name}?
              </span>
              <button
                ref={cancelRef}
                type="button"
                className="anlyon-button"
                data-variant="ghost"
                data-size="sm"
                disabled={removing}
                onClick={stopConfirming}
                onKeyDown={(event) => event.key === 'Escape' && stopConfirming()}
              >
                Cancel
              </button>
              <button
                type="button"
                className="anlyon-button"
                data-variant="destructive"
                data-size="sm"
                aria-busy={removing || undefined}
                disabled={removing}
                onClick={() => void remove()}
                onKeyDown={(event) => event.key === 'Escape' && !removing && stopConfirming()}
              >
                {removing ? <Spinner /> : null}
                {removing ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </span>
          ) : (
            <>
              {status !== 'active' ? (
                <button
                  type="button"
                  className="anlyon-button"
                  data-variant={status === 'needs_reconnect' ? 'primary' : 'secondary'}
                  data-size="sm"
                  aria-disabled={busy || undefined}
                  aria-busy={busy || undefined}
                  aria-label={busy ? undefined : `${status === 'needs_reconnect' ? 'Reconnect' : 'Connect'} ${name}`}
                  onClick={() => !busy && void connect()}
                >
                  {busy ? <Spinner /> : null}
                  {phase === 'starting' ? 'Connecting…' : phase === 'waiting' ? 'Waiting…' : status === 'needs_reconnect' ? 'Reconnect' : 'Connect'}
                </button>
              ) : null}
              {phase === 'waiting' ? (
                <button type="button" className="anlyon-link" onClick={cancel}>
                  Cancel
                </button>
              ) : null}
              {connection && !busy ? (
                <button
                  ref={disconnectRef}
                  type="button"
                  className="anlyon-button"
                  data-variant="ghost"
                  data-size="sm"
                  aria-label={`Disconnect ${name}`}
                  onClick={() => setConfirming(true)}
                >
                  Disconnect
                </button>
              ) : null}
            </>
          )}
        </span>
      </div>
      {confirming ? <p className="anlyon-connection-note">Agents lose access to your {name} account. You can connect it again later.</p> : null}
      {shownError && !confirming ? (
        <p className="anlyon-error" role="alert">
          <AlertIcon />
          <span>{shownError.message}</span>
        </p>
      ) : null}
    </li>
  );
}

/** The end user's connected accounts: status, reconnect, and disconnect with a confirm step. */
export function Connections({ integrations = [], title = 'Connected accounts', empty, mode, redirectUrl, className, unstyled }: ConnectionsProps) {
  const { locale } = useAnlyon();
  const { connections, loading, error, refresh, disconnect } = useConnections();
  const now = useNow(60_000);
  const headingId = useId();
  const [message, announce] = useAnnouncer();
  const root = rootClass('anlyon-connections', { className, unstyled });

  const live = connections.filter((c) => c.status !== 'revoked');
  const rows: Array<{ integration: string; connection: Connection | null }> = [
    ...live.map((c) => ({ integration: c.integration, connection: c })),
    ...integrations.filter((id) => !live.some((c) => c.integration === id)).map((id) => ({ integration: id, connection: null })),
  ];

  let body: ReactNode;
  if (loading) {
    body = <SkeletonRows count={Math.max(2, Math.min(integrations.length, 4))} />;
  } else if (error && connections.length === 0) {
    body = (
      <div className="anlyon-message" role="alert">
        <AlertIcon />
        <div>
          <p className="anlyon-message-title">Couldn't load your accounts</p>
          <p className="anlyon-muted">{error.message}</p>
        </div>
        <button type="button" className="anlyon-button" data-variant="secondary" data-size="sm" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="anlyon-empty">
        {empty ?? (
          <>
            <p className="anlyon-empty-title">No connected accounts</p>
            <p className="anlyon-muted">Accounts you connect show up here. You can disconnect them at any time.</p>
          </>
        )}
      </div>
    );
  } else {
    body = (
      <ul className="anlyon-list">
        {rows.map((row) => (
          <ConnectionRow
            key={row.integration}
            {...row}
            now={now}
            locale={locale}
            disconnect={disconnect}
            announce={announce}
            mode={mode}
            redirectUrl={redirectUrl}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className={root} aria-labelledby={title === null ? undefined : headingId} aria-label={title === null ? 'Connected accounts' : undefined} aria-busy={loading || undefined}>
      {title === null ? null : (
        <header className="anlyon-header">
          <h2 className="anlyon-title" id={headingId}>
            {title}
          </h2>
        </header>
      )}
      {body}
      <LiveRegion message={message} />
    </section>
  );
}
