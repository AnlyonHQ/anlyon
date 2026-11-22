/**
 * The connect popup and how it reports back. The developer's callback route
 * (`createConnectCallbackHandler` in `@anlyonhq/react/server`) finishes the flow on the server, then
 * answers the popup with a page that posts the outcome on a BroadcastChannel and to its opener, and
 * closes. Both are same-origin only.
 */

export const CONNECT_CHANNEL = 'anlyon-connect';
export const CONNECT_MESSAGE = 'anlyon:connect';
/** Added to the redirect URL so the callback route knows it runs in a popup. */
export const POPUP_PARAM = 'anlyon_popup';

export interface ConnectOutcome {
  /** `connected`, `declined` or `error`. */
  status: string;
  integration: string | null;
}

/** Whole-tab navigation, behind an object so tests can replace it. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

const WIDTH = 520;
const HEIGHT = 720;

/**
 * Open an empty popup. Call it inside the click handler, before any await, or the browser blocks it.
 * Null when it was blocked anyway.
 */
export function openBlankPopup(): Window | null {
  if (typeof window === 'undefined') return null;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - WIDTH) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - HEIGHT) / 2));
  try {
    return window.open('about:blank', 'anlyon-connect', `popup=yes,width=${WIDTH},height=${HEIGHT},left=${left},top=${top}`);
  } catch {
    return null;
  }
}

/** The redirect URL with the popup marker, or undefined when there is none to mark. */
export function markPopup(redirectUrl: string | undefined): string | undefined {
  if (!redirectUrl) return undefined;
  try {
    const url = new URL(redirectUrl, typeof window === 'undefined' ? undefined : window.location.href);
    url.searchParams.set(POPUP_PARAM, '1');
    return url.toString();
  } catch {
    return redirectUrl;
  }
}

function outcomeOf(data: unknown): ConnectOutcome | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; status?: unknown; integration?: unknown };
  if (message.type !== CONNECT_MESSAGE || typeof message.status !== 'string') return null;
  return { status: message.status, integration: typeof message.integration === 'string' ? message.integration : null };
}

/** Call `onOutcome` for each outcome a callback page reports. Returns the unsubscribe. */
export function listenForConnect(onOutcome: (outcome: ConnectOutcome) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const outcome = outcomeOf(event.data);
    if (outcome) onOutcome(outcome);
  };
  window.addEventListener('message', onMessage);
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CONNECT_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const outcome = outcomeOf(event.data);
      if (outcome) onOutcome(outcome);
    };
  }
  return () => {
    window.removeEventListener('message', onMessage);
    channel?.close();
  };
}
