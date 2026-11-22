import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../src/auth.ts';

const constructed: Array<{ apiKey: string; baseUrl?: string }> = [];

vi.mock('@anlyonhq/sdk', () => ({
  Client: class {
    apiKey: string;
    baseUrl?: string;
    constructor(options: { apiKey: string; baseUrl?: string }) {
      this.apiKey = options.apiKey;
      this.baseUrl = options.baseUrl;
      constructed.push({ apiKey: options.apiKey, baseUrl: options.baseUrl });
    }
  },
}));

const { getClient } = await import('../src/client-factory.ts');

beforeEach(() => {
  constructed.length = 0;
});

describe('getClient', () => {
  it('reuses one client for a repeated API key', () => {
    const first = getClient('anlyon_live_reuse');
    const second = getClient('anlyon_live_reuse');

    expect(second).toBe(first);
    expect(constructed).toHaveLength(1);
  });

  it('never shares a client between two API keys', () => {
    const first = getClient('anlyon_live_alpha');
    const second = getClient('anlyon_live_beta');

    expect(second).not.toBe(first);
  });

  it('reuses one client across an OAuth token rotation', () => {
    const first = requestContext.run({ apiKey: 'jwt.first.sig', cacheScope: 'user_a:client_1' }, () =>
      getClient('jwt.first.sig'),
    );
    const second = requestContext.run({ apiKey: 'jwt.first.sig', cacheScope: 'user_a:client_1' }, () =>
      getClient('jwt.first.sig'),
    );

    expect(second).toBe(first);
    expect(constructed).toHaveLength(1);
  });

  it('rebuilds rather than send a stale token after rotation', () => {
    requestContext.run({ apiKey: 'jwt.old.sig', cacheScope: 'user_a:client_1' }, () => getClient('jwt.old.sig'));
    requestContext.run({ apiKey: 'jwt.new.sig', cacheScope: 'user_a:client_1' }, () => getClient('jwt.new.sig'));

    expect(constructed).toHaveLength(2);
    expect(constructed[1].apiKey).toBe('jwt.new.sig');
  });

  it('keeps two callers apart even on an identical credential', () => {
    const alpha = requestContext.run({ apiKey: 'same.token.sig', cacheScope: 'user_a:client_1' }, () =>
      getClient('same.token.sig'),
    );
    const beta = requestContext.run({ apiKey: 'same.token.sig', cacheScope: 'user_b:client_1' }, () =>
      getClient('same.token.sig'),
    );

    expect(beta).not.toBe(alpha);
  });

  it('points at the API named by ANLYON_BASE_URL', () => {
    const previous = process.env.ANLYON_BASE_URL;
    process.env.ANLYON_BASE_URL = 'http://localhost:4000';
    try {
      getClient('anlyon_live_baseurl');
      expect(constructed[0].baseUrl).toBe('http://localhost:4000');
    } finally {
      if (previous === undefined) delete process.env.ANLYON_BASE_URL;
      else process.env.ANLYON_BASE_URL = previous;
    }
  });

  it('points hosted requests at the API origin in their request context', () => {
    requestContext.run(
      {
        apiKey: 'jwt.hosted.sig',
        cacheScope: 'user_hosted:client_1',
        apiBaseUrl: 'http://localhost:4000',
      },
      () => getClient('jwt.hosted.sig'),
    );

    expect(constructed[0].baseUrl).toBe('http://localhost:4000');
  });

  it('does not reuse a client created for a different API origin', () => {
    const first = requestContext.run(
      { apiKey: 'same.token.sig', cacheScope: 'user_a:client_1', apiBaseUrl: 'http://api-one.test' },
      () => getClient('same.token.sig'),
    );
    const second = requestContext.run(
      { apiKey: 'same.token.sig', cacheScope: 'user_a:client_1', apiBaseUrl: 'http://api-two.test' },
      () => getClient('same.token.sig'),
    );

    expect(second).not.toBe(first);
    expect(constructed.at(-1)?.baseUrl).toBe('http://api-two.test');
  });
});
