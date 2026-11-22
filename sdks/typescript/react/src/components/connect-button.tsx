import type { ReactNode } from 'react';
import { integrationName } from '../core/integrations';
import { useConnect, type UseConnectOptions } from '../hooks/use-connections';
import { AlertIcon, CheckIcon, Spinner, cx, rootClass, type StyleProps } from './shared';

export interface ConnectButtonProps extends StyleProps, UseConnectOptions {
  /** The catalogue id, e.g. `github`. */
  integration: string;
  /** The name in labels. Defaults to the catalogue's, e.g. `GitHub`. */
  name?: string;
  /** Replaces the `Connect GitHub` label. */
  children?: ReactNode;
  /** Once connected, show `GitHub connected` (default) or nothing. */
  showConnected?: boolean;
}

/** Connect one integration, or reconnect it when it stopped working. Popup by default. */
export function ConnectButton({
  integration,
  name,
  children,
  showConnected = true,
  mode,
  redirectUrl,
  onConnected,
  className,
  unstyled,
}: ConnectButtonProps) {
  const label = name ?? integrationName(integration);
  const { status, phase, error, connect, cancel } = useConnect(integration, { mode, redirectUrl, onConnected });
  const state = phase !== 'idle' ? phase : status;
  const root = rootClass('anlyon-connect', { className, unstyled });

  if (status === 'connected' && phase === 'idle') {
    if (!showConnected) return null;
    return (
      <span className={root} data-state="connected">
        <span className="anlyon-connected" role="status">
          <CheckIcon />
          {label} connected
        </span>
      </span>
    );
  }

  const reconnect = status === 'needs_reconnect';
  const busy = phase !== 'idle' || status === 'loading';
  return (
    <span className={root} data-state={state}>
      <span className="anlyon-connect-row">
        <button
          type="button"
          className={cx('anlyon-button', 'anlyon-connect-button')}
          data-variant="primary"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => {
            if (!busy) void connect();
          }}
        >
          {phase !== 'idle' ? <Spinner /> : reconnect ? <AlertIcon /> : null}
          {phase === 'starting'
            ? 'Connecting…'
            : phase === 'waiting'
              ? `Waiting for ${label}…`
              : (children ?? (reconnect ? `Reconnect ${label}` : `Connect ${label}`))}
        </button>
        {phase === 'waiting' ? (
          <button type="button" className="anlyon-link" onClick={cancel}>
            Cancel
          </button>
        ) : null}
      </span>
      {phase === 'waiting' ? (
        <span className="anlyon-hint" role="status">
          Finish in the window that opened.
        </span>
      ) : null}
      {error && phase === 'idle' ? (
        <span className="anlyon-error" role="alert">
          <AlertIcon />
          <span>{error.message}</span>
        </span>
      ) : null}
    </span>
  );
}
