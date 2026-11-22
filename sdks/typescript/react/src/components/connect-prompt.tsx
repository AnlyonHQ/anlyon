import { useState, type ReactNode } from 'react';
import { integrationName } from '../core/integrations';
import { safeUrl } from '../core/safe-url';
import { isConnectRequiredResult, type ConnectRequiredResult } from '../core/types';
import { useConnect, type UseConnectOptions } from '../hooks/use-connections';
import { useOptionalAnlyon } from '../provider';
import { AlertIcon, CheckIcon, ExternalIcon, Spinner, monogram, rootClass, type StyleProps } from './shared';

export interface ConnectPromptProps extends StyleProps, UseConnectOptions {
  /**
   * A tool result from `@anlyonhq/ai-sdk`. Renders only for `connect_required` and
   * `reconnect_required`; anything else renders nothing, so it can sit in every tool result's slot.
   */
  result: unknown;
  /** The name in labels. Defaults to the result's `displayName`, then the catalogue's, e.g. `GitHub`. */
  name?: string;
}

function copy(result: ConnectRequiredResult, name: string) {
  return result.status === 'reconnect_required'
    ? { title: `Reconnect ${name} to continue`, text: `Your ${name} connection stopped working, so nothing was done.`, action: `Reconnect ${name}` }
    : { title: `Connect ${name} to continue`, text: `This needs your ${name} account. Nothing was done yet.`, action: `Connect ${name}` };
}

function Frame({
  result,
  name,
  root,
  state,
  children,
}: {
  result: ConnectRequiredResult;
  name: string;
  root: string;
  state: string;
  children: ReactNode;
}) {
  const words = copy(result, name);
  return (
    <div className={root} data-state={state} data-status={result.status} role="group" aria-label={words.title}>
      <span className="anlyon-monogram" aria-hidden="true">
        {monogram(name)}
      </span>
      <div className="anlyon-connect-prompt-text">
        <p className="anlyon-connect-prompt-title">{words.title}</p>
        <p className="anlyon-muted">{words.text}</p>
      </div>
      <div className="anlyon-connect-prompt-action">{children}</div>
    </div>
  );
}

/** Inside a provider: a fresh link from the session, in a popup, with the live connection state. */
function WithSession({ result, name, root, mode, redirectUrl, onConnected }: { result: ConnectRequiredResult; name: string; root: string } & UseConnectOptions) {
  const [done, setDone] = useState(false);
  const { phase, error, connect, cancel } = useConnect(result.integration, {
    mode,
    redirectUrl,
    onConnected: (integration) => {
      setDone(true);
      onConnected?.(integration);
    },
  });
  const words = copy(result, name);
  const busy = phase !== 'idle';

  if (done) {
    return (
      <Frame result={result} name={name} root={root} state="connected">
        <span className="anlyon-connected" role="status">
          <CheckIcon />
          Connected. Try again.
        </span>
      </Frame>
    );
  }

  return (
    <Frame result={result} name={name} root={root} state={phase}>
      <span className="anlyon-connect-row">
        <button
          type="button"
          className="anlyon-button"
          data-variant="primary"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => !busy && void connect()}
        >
          {busy ? <Spinner /> : null}
          {phase === 'starting' ? 'Connecting…' : phase === 'waiting' ? `Waiting for ${name}…` : words.action}
        </button>
        {phase === 'waiting' ? (
          <button type="button" className="anlyon-link" onClick={cancel}>
            Cancel
          </button>
        ) : null}
      </span>
      {error && !busy ? (
        <span className="anlyon-error" role="alert">
          <AlertIcon />
          <span>{error.message}</span>
        </span>
      ) : null}
    </Frame>
  );
}

/**
 * The card for a tool result that says the end user has to connect, or reconnect, an account.
 * Inside an `<AnlyonProvider>` it opens a fresh link in a popup; outside one it links to the
 * result's `connectUrl`.
 */
export function ConnectPrompt({ result, name, mode, redirectUrl, onConnected, className, unstyled }: ConnectPromptProps) {
  const context = useOptionalAnlyon();
  if (!isConnectRequiredResult(result)) return null;
  const label = name ?? (typeof result.displayName === 'string' && result.displayName ? result.displayName : integrationName(result.integration));
  const root = rootClass('anlyon-connect-prompt', { className, unstyled });

  if (context) {
    return <WithSession result={result} name={label} root={root} mode={mode} redirectUrl={redirectUrl} onConnected={onConnected} />;
  }
  const words = copy(result, label);
  return (
    <Frame result={result} name={label} root={root} state="idle">
      {safeUrl(result.connectUrl) ? (
        <a className="anlyon-button" data-variant="primary" href={safeUrl(result.connectUrl) ?? undefined} target="_blank" rel="noopener noreferrer">
          {words.action}
          <ExternalIcon />
        </a>
      ) : (
        <span className="anlyon-muted">Connect it in your account settings.</span>
      )}
    </Frame>
  );
}
