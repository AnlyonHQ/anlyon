import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectButton } from '../src/components/connect-button';
import { ConnectPrompt } from '../src/components/connect-prompt';
import { Connections } from '../src/components/connections';
import { CONNECT_CHANNEL, CONNECT_MESSAGE, navigation } from '../src/core/popup';
import { AnlyonProvider } from '../src/provider';
import { BASE, connection, fakeApi, renderWithApi } from './helpers';

const focused = () => document.activeElement;

async function statusReads(text: string) {
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(text), { timeout: 4000 });
}

class InstantBroadcastChannel {
  static open = new Set<InstantBroadcastChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    InstantBroadcastChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const other of InstantBroadcastChannel.open) {
      if (other !== this && other.name === this.name) other.onmessage?.(new MessageEvent('message', { data }));
    }
  }
  close() {
    InstantBroadcastChannel.open.delete(this);
  }
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  InstantBroadcastChannel.open.clear();
  vi.stubGlobal('BroadcastChannel', InstantBroadcastChannel);
});
afterEach(() => vi.unstubAllGlobals());

function fakePopup() {
  return { closed: false, location: { href: 'about:blank' }, focus: vi.fn(), close: vi.fn() };
}

async function report(status: string, integration: string) {
  await waitFor(() =>
    expect([...InstantBroadcastChannel.open].some((channel) => channel.name === CONNECT_CHANNEL)).toBe(true),
  );
  act(() => {
    const channel = new BroadcastChannel(CONNECT_CHANNEL);
    channel.postMessage({ type: CONNECT_MESSAGE, status, integration });
    channel.close();
  });
}

afterEach(() => vi.restoreAllMocks());

describe('<ConnectButton />', () => {
  it('opens the link in a popup, waits, and shows the account once connected', async () => {
    const api = fakeApi({ connections: [] });
    const popup = fakePopup();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const onConnected = vi.fn();
    renderWithApi(<ConnectButton integration="github" onConnected={onConnected} />, api, {
      connect: { redirectUrl: 'https://app.test/api/anlyon/connected' },
    });

    const button = await screen.findByRole('button', { name: 'Connect GitHub' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
    button.focus();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith('about:blank', 'anlyon-connect', expect.stringContaining('popup=yes'));
    await screen.findByRole('button', { name: 'Waiting for GitHub…' });
    expect(popup.location.href).toBe('https://connect.test/github');
    expect(api.calls.find((c) => c.path === '/connect-links')?.body).toEqual({
      integration: 'github',
      redirectUrl: 'https://app.test/api/anlyon/connected?anlyon_popup=1',
    });
    screen.getByText('Finish in the window that opened.');
    expect(focused()).toBe(screen.getByRole('button', { name: 'Waiting for GitHub…' }));

    api.state.connections = [connection()];
    await report('connected', 'github');
    await statusReads('GitHub connected');
    expect(onConnected).toHaveBeenCalledWith('github');
  });

  it('can stop waiting', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window);
    renderWithApi(<ConnectButton integration="slack" />, fakeApi());
    const button = await screen.findByRole('button', { name: 'Connect Slack' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    screen.getByRole('button', { name: 'Connect Slack' });
  });

  it('sends the whole tab when the popup is blocked, or in redirect mode', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    renderWithApi(<ConnectButton integration="github" />, fakeApi());
    const button = await screen.findByRole('button', { name: 'Connect GitHub' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://connect.test/github'));
  });

  it('offers a reconnect when the connection stopped working', async () => {
    renderWithApi(<ConnectButton integration="github" mode="redirect" />, fakeApi({ connections: [connection({ status: 'needs_reconnect' })] }));
    await screen.findByRole('button', { name: 'Reconnect GitHub' });
  });

  it('is busy until it knows, and shows the API message when the link fails', async () => {
    const api = fakeApi();
    api.setOverride((call) =>
      call.path === '/connect-links'
        ? { status: 400, body: { error: { code: 'REDIRECT_URL_NOT_ALLOWED', message: "redirectUrl is not under one of this environment's allowed redirect URLs." } } }
        : undefined,
    );
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    renderWithApi(<ConnectButton integration="github" />, api);
    const button = screen.getByRole('button', { name: 'Connect GitHub' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('allowed redirect URLs');
    expect(popup.close).toHaveBeenCalled();
  });

  it.each([
    ['javascript:alert(document.cookie)', 'popup'],
    ['http://evil.test/connect', 'popup'],
    ['data:text/html,<script>1</script>', 'redirect'],
  ] as const)('never sends the browser to an unsafe link from the API (%s, %s)', async (badUrl, mode) => {
    const api = fakeApi();
    api.setOverride((call) =>
      call.path === '/connect-links' ? { status: 201, body: { success: true, data: { url: badUrl, expiresAt: new Date(Date.now() + 600_000).toISOString(), integration: 'github' } } } : undefined,
    );
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    renderWithApi(<ConnectButton integration="github" mode={mode} />, api);
    const button = await screen.findByRole('button', { name: 'Connect GitHub' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('not a safe https URL');
    expect(popup.location.href).toBe('about:blank');
    expect(assign).not.toHaveBeenCalled();
    if (mode === 'popup') expect(popup.close).toHaveBeenCalled();
  });

  it('reports a flow that did not finish', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window);
    renderWithApi(<ConnectButton integration="github" />, fakeApi());
    const button = await screen.findByRole('button', { name: 'Connect GitHub' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Waiting for GitHub…' });
    await report('error', 'github');
    expect((await screen.findByRole('alert')).textContent).toContain("Connecting GitHub didn't finish. Try again.");
  });

  it('renders nothing once connected when asked to', async () => {
    const { container } = renderWithApi(<ConnectButton integration="github" showConnected={false} />, fakeApi({ connections: [connection()] }));
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});

describe('<Connections />', () => {
  it('lists accounts with their state, and offers the ones not connected yet', async () => {
    const api = fakeApi({ connections: [connection(), connection({ integration: 'slack', displayName: 'Slack', status: 'needs_reconnect' })] });
    const { container } = renderWithApi(<Connections integrations={['github', 'notion']} />, api);
    await screen.findByText('GitHub');
    screen.getByText(/Connected 3 days ago/);
    screen.getByText('Stopped working. Reconnect to keep using it.');
    screen.getByRole('button', { name: 'Reconnect Slack' });
    screen.getByRole('button', { name: 'Connect Notion' });
    const states = Array.from(container.querySelectorAll('.anlyon-connection')).map((li) => li.getAttribute('data-status'));
    expect(states).toEqual(['active', 'needs_reconnect', 'not_connected']);
  });

  it('asks before disconnecting; Escape cancels and returns focus', async () => {
    renderWithApi(<Connections />, fakeApi({ connections: [connection()] }));
    const disconnect = await screen.findByRole('button', { name: 'Disconnect GitHub' });
    fireEvent.click(disconnect);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(focused()).toBe(cancel);
    screen.getByText('Disconnect GitHub?');
    screen.getByText(/Agents lose access to your GitHub account/);
    fireEvent.keyDown(cancel, { key: 'Escape' });
    await waitFor(() => expect(focused()).toBe(screen.getByRole('button', { name: 'Disconnect GitHub' })));
  });

  it('disconnects after the confirm and announces it', async () => {
    const api = fakeApi({ connections: [connection()] });
    const { container } = renderWithApi(<Connections />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByText('No connected accounts');
    expect(api.calls.find((c) => c.method === 'DELETE')?.path).toBe('/connections/github');
    await waitFor(() => expect(container.querySelector('[aria-live]')?.textContent).toBe('GitHub disconnected'));
  });

  it('keeps the row and shows why a disconnect failed', async () => {
    const api = fakeApi({ connections: [connection()] });
    api.setOverride((call) => (call.method === 'DELETE' ? { status: 502, body: { error: { code: 'PROVIDER_ERROR', message: 'GitHub did not answer. Try again.' } } } : undefined));
    renderWithApi(<Connections />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('GitHub did not answer. Try again.');
    screen.getByText('GitHub');
  });

  it('shows an error with a retry, and an empty state', async () => {
    const api = fakeApi();
    api.setOverride(() => ({ status: 401, body: { error: { code: 'END_USER_SESSION_INVALID', message: 'The API key that created this session was revoked or has expired.' } } }));
    renderWithApi(<Connections />, api);
    expect((await screen.findByRole('alert')).textContent).toContain('revoked or has expired');
    api.setOverride(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No connected accounts');
  });

  it('can be unstyled', async () => {
    const { container } = renderWithApi(<Connections unstyled />, fakeApi());
    await screen.findByText('No connected accounts');
    expect(container.firstElementChild?.className).toBe('anlyon-connections');
  });
});

describe('<AnlyonProvider />', () => {
  it('fetches a new token before the old one expires, and after the API refuses one', async () => {
    const api = fakeApi({ connections: [connection()] });
    let n = 0;
    const getToken = vi.fn(async () => ({ token: `eus_${++n}`, expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    api.setOverride((call) =>
      call.token === 'eus_1' ? { status: 401, body: { error: { code: 'END_USER_SESSION_EXPIRED', message: 'This session has expired.' } } } : undefined,
    );
    renderWithApi(<Connections />, api, { getToken });
    await screen.findByText('GitHub');
    expect(api.calls.map((c) => c.token)).toEqual(['eus_1', 'eus_2']);
  });

  it('shows a plain error when the session route fails', async () => {
    renderWithApi(<Connections />, fakeApi(), {
      getToken: async () => {
        throw new Error('401');
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't start a session. Sign in again, then reload the page.");
  });

  it('keeps its session when getToken changes identity', async () => {
    const api = fakeApi({ connections: [connection()] });
    const first = vi.fn(async () => 'eus_a');
    const { rerender } = renderWithApi(<Connections />, api, { getToken: first });
    await screen.findByText('GitHub');
    const second = vi.fn(async () => 'eus_b');
    rerender(
      <AnlyonProvider baseUrl={BASE} getToken={second}>
        <Connections />
      </AnlyonProvider>,
    );
    screen.getByText('GitHub');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('tells a developer when a component sits outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Connections />)).toThrow('inside <AnlyonProvider>');
  });
});

describe('<ConnectPrompt />', () => {
  const required = { status: 'connect_required', integration: 'github', connectUrl: 'https://connect.test/static', message: 'm' };

  it('renders nothing for other tool results', () => {
    const { container } = render(<ConnectPrompt result={{ status: 'succeeded', invocationId: 'inv_1' }} />);
    expect(container.innerHTML).toBe('');
  });

  it('links to the result without a provider, https only', () => {
    const { rerender } = render(<ConnectPrompt result={required} />);
    screen.getByText('Connect GitHub to continue');
    const link = screen.getByRole('link', { name: 'Connect GitHub' });
    expect(link.getAttribute('href')).toBe('https://connect.test/static');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    rerender(<ConnectPrompt result={{ ...required, connectUrl: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link')).toBeNull();
    screen.getByText('Connect it in your account settings.');
  });

  it("names an MCP server by the result's displayName, not its key", () => {
    render(<ConnectPrompt result={{ ...required, integration: 'mcp-3f2a0c1e-0000-4000-8000-000000000001', displayName: 'Tracker' }} />);
    screen.getByText('Connect Tracker to continue');
    screen.getByRole('link', { name: 'Connect Tracker' });
  });

  it('opens a fresh link from the session inside a provider', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const api = fakeApi();
    renderWithApi(<ConnectPrompt result={{ ...required, status: 'reconnect_required' }} />, api);
    screen.getByText('Reconnect GitHub to continue');
    screen.getByText('Your GitHub connection stopped working, so nothing was done.');
    const button = screen.getByRole('button', { name: 'Reconnect GitHub' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull(), { timeout: 5000 });
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Waiting for GitHub…' });
    expect(popup.location.href).toBe('https://connect.test/github');

    api.state.connections = [connection()];
    await report('connected', 'github');
    await statusReads('Connected. Try again.');
  });
});
