import { describe, expect, it, vi } from 'vitest';
import { AnlyonUIError, createSessionClient } from '../src/core/client';
import { lineDiff } from '../src/core/diff';
import { approvalHeadline, formatImpact, formatMoney, formatValue, humanizeKey } from '../src/core/format';
import { REFRESH_MARGIN_MS, createTokenSource, tokenExpiry } from '../src/core/token';
import { BASE, fakeApi, fakeToken } from './helpers';

describe('token source', () => {
  it('reads the expiry from the token claims', () => {
    expect(tokenExpiry(fakeToken(1_900_000_000))).toBe(1_900_000_000_000);
    expect(tokenExpiry('not-a-token')).toBeNull();
  });

  it('keeps a token until the refresh margin, then fetches a new one', async () => {
    let now = 1_000_000;
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'eus_one', expiresAt: new Date(now + 15 * 60_000).toISOString() })
      .mockResolvedValueOnce({ token: 'eus_two', expiresAt: new Date(now + 30 * 60_000).toISOString() });
    const tokens = createTokenSource(getToken, () => now);

    expect(await tokens.get()).toBe('eus_one');
    now += 15 * 60_000 - REFRESH_MARGIN_MS - 1;
    expect(await tokens.get()).toBe('eus_one');
    now += 2;
    expect(await tokens.get()).toBe('eus_two');
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('fetches once for concurrent callers', async () => {
    const getToken = vi.fn(async () => fakeToken(Math.floor(Date.now() / 1000) + 900));
    const tokens = createTokenSource(getToken);
    const [a, b] = await Promise.all([tokens.get(), tokens.get()]);
    expect(a).toBe(b);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('drops a refused token', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('eus_old').mockResolvedValueOnce('eus_new');
    const tokens = createTokenSource(getToken);
    expect(await tokens.get()).toBe('eus_old');
    tokens.invalidate('eus_old');
    expect(await tokens.get()).toBe('eus_new');
  });

  it('refuses an empty answer from getToken', async () => {
    const tokens = createTokenSource(async () => ({ token: '' }));
    await expect(tokens.get()).rejects.toThrow(/returned no token/);
  });
});

describe('session client', () => {
  it('sends the token, never credentials, and reads the envelope', async () => {
    const api = fakeApi({ connections: [] });
    const spy = vi.fn(api.fetch);
    const client = createSessionClient({ baseUrl: `${BASE}/`, tokens: createTokenSource(async () => 'eus_x'), fetch: spy as typeof fetch });
    await expect(client.listConnections()).resolves.toEqual([]);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v2/end-user-session/connections`);
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    expect(api.calls[0].token).toBe('eus_x');
  });

  it('fetches a new token and retries once when the session expired', async () => {
    const api = fakeApi({ connections: [] });
    api.setOverride((call) =>
      call.token === 'eus_stale' ? { status: 401, body: { error: { code: 'END_USER_SESSION_EXPIRED', message: 'expired' } } } : undefined,
    );
    const getToken = vi.fn().mockResolvedValueOnce('eus_stale').mockResolvedValueOnce('eus_fresh');
    const client = createSessionClient({ baseUrl: BASE, tokens: createTokenSource(getToken), fetch: api.fetch as typeof fetch });
    await expect(client.listConnections()).resolves.toEqual([]);
    expect(api.calls.map((c) => c.token)).toEqual(['eus_stale', 'eus_fresh']);
  });

  it('does not retry twice', async () => {
    const api = fakeApi();
    api.setOverride(() => ({ status: 401, body: { error: { code: 'END_USER_SESSION_INVALID', message: 'This end-user session token is not valid.' } } }));
    const client = createSessionClient({ baseUrl: BASE, tokens: createTokenSource(async () => 'eus_bad'), fetch: api.fetch as typeof fetch });
    const error = await client.listConnections().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnlyonUIError);
    expect(error).toMatchObject({ status: 401, code: 'END_USER_SESSION_INVALID', message: 'This end-user session token is not valid.' });
    expect(api.calls).toHaveLength(2);
  });

  it('names a network failure and a failed session route', async () => {
    const offline = createSessionClient({
      baseUrl: BASE,
      tokens: createTokenSource(async () => 'eus_x'),
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    await expect(offline.listConnections()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const signedOut = createSessionClient({
      baseUrl: BASE,
      tokens: createTokenSource(async () => {
        throw new Error('401 from /api/anlyon/session');
      }),
      fetch: fakeApi().fetch as typeof fetch,
    });
    await expect(signedOut.listConnections()).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
  });

  it('sends a decision with its note, and a connect link with its redirect', async () => {
    const api = fakeApi({ approvals: [] });
    api.setOverride((call) => (call.path.includes('/decide') ? { status: 200, body: { success: true, data: { approval: {} } } } : undefined));
    const client = createSessionClient({ baseUrl: BASE, tokens: createTokenSource(async () => 'eus_x'), fetch: api.fetch as typeof fetch });
    await client.decideApproval('apr_1', 'deny', 'Wrong repo');
    await client.createConnectLink('github', 'https://app.test/connected?anlyon_popup=1');
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/approvals/apr_1/decide', body: { decision: 'deny', reason: 'Wrong repo' } });
    expect(api.calls[1]).toMatchObject({ body: { integration: 'github', redirectUrl: 'https://app.test/connected?anlyon_popup=1' } });
  });
});

describe('format', () => {
  it('names an action in words', () => {
    expect(approvalHeadline({ title: 'Run action "github-create-issue"', actionName: 'github-create-issue' })).toBe('GitHub: Create issue');
    expect(approvalHeadline({ title: 'x', actionName: 'google-calendar-create-event' })).toBe('Google Calendar: Create event');
    expect(approvalHeadline({ title: 'x', actionName: 'refund-order' })).toBe('Refund order');
    expect(approvalHeadline({ title: 'Ship the release', actionName: null })).toBe('Ship the release');
  });

  it('formats money in minor units and impact bounds', () => {
    expect(formatMoney(1250, 'usd', 'en-US')).toBe('$12.50');
    expect(formatMoney(500, 'jpy', 'en-US')).toBe('¥500');
    expect(formatImpact({ dimension: 'money', currency: 'eur', amount: 999, bound: 'upper_bound' }, 'en-US')).toBe('Up to €9.99');
    expect(formatImpact({ dimension: 'emails', amount: 1, bound: 'exact' }, 'en-US')).toBe('1 email');
    expect(formatImpact({ dimension: 'reminders', amount: 1, bound: 'exact' }, 'en-US')).toBe('1 reminder');
    expect(formatImpact({ dimension: 'reminders', amount: 2, bound: 'exact' }, 'en-US')).toBe('2 reminders');
    expect(formatImpact({ dimension: 'sms_messages', amount: 1, bound: 'exact' }, 'en-US')).toBe('1 sms message');
    expect(formatImpact({ dimension: 'access', amount: 1, bound: 'exact' }, 'en-US')).toBe('1 access');
    expect(formatImpact({ dimension: 'resource_mutations', amount: 3, bound: 'exact' }, 'en-US')).toBe('3 changes');
  });

  it('humanizes keys and values', () => {
    expect(humanizeKey('paymentIntent')).toBe('Payment intent');
    expect(humanizeKey('due_date')).toBe('Due date');
    expect(formatValue(true)).toBe('Yes');
    expect(formatValue(['bug', 'auth'])).toBe('bug, auth');
    expect(formatValue({ nested: 1 })).toBeNull();
  });

  it('diffs lines and folds unchanged runs', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h'].join('\n');
    expect(lineDiff(before, after)).toEqual([
      { kind: 'gap', count: 2 },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'del', text: 'e' },
      { kind: 'add', text: 'E' },
      { kind: 'same', text: 'f' },
      { kind: 'same', text: 'g' },
      { kind: 'gap', count: 1 },
    ]);
  });
});
