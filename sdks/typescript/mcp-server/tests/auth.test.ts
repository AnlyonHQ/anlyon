import { afterEach, describe, expect, it } from 'vitest';
import {
  extractBearerKey,
  requestContext,
  resolveApiBaseUrl,
  resolveApiKey,
  resolveCacheScope,
} from '../src/auth.ts';

describe('extractBearerKey', () => {
  it('extracts a bearer token', () => {
    expect(extractBearerKey('Bearer anlyon_live_abc')).toBe('anlyon_live_abc');
  });

  it('is case-insensitive on the scheme and trims the key', () => {
    expect(extractBearerKey('bearer  anlyon_live_abc ')).toBe('anlyon_live_abc');
  });

  it('returns null for missing or malformed headers', () => {
    expect(extractBearerKey(undefined)).toBeNull();
    expect(extractBearerKey(null)).toBeNull();
    expect(extractBearerKey('')).toBeNull();
    expect(extractBearerKey('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerKey('Bearer')).toBeNull();
  });
});

describe('resolveApiKey', () => {
  const originalEnv = process.env.ANLYON_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ANLYON_API_KEY;
    else process.env.ANLYON_API_KEY = originalEnv;
  });

  it('prefers the request context over the environment', () => {
    process.env.ANLYON_API_KEY = 'env-key';
    requestContext.run({ apiKey: 'request-key' }, () => {
      expect(resolveApiKey()).toBe('request-key');
    });
  });

  it('falls back to ANLYON_API_KEY outside a request context', () => {
    process.env.ANLYON_API_KEY = 'env-key';
    expect(resolveApiKey()).toBe('env-key');
  });

  it('returns null when nothing is configured', () => {
    delete process.env.ANLYON_API_KEY;
    expect(resolveApiKey()).toBeNull();
  });
});

describe('resolveApiBaseUrl', () => {
  const originalEnv = process.env.ANLYON_BASE_URL;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ANLYON_BASE_URL;
    else process.env.ANLYON_BASE_URL = originalEnv;
  });

  it('prefers the host API origin carried by the request context', () => {
    process.env.ANLYON_BASE_URL = 'https://api.anlyon.com';
    requestContext.run({ apiKey: 'request-key', apiBaseUrl: 'http://localhost:4000' }, () => {
      expect(resolveApiBaseUrl()).toBe('http://localhost:4000');
    });
  });

  it('falls back to ANLYON_BASE_URL for stdio callers', () => {
    process.env.ANLYON_BASE_URL = 'http://localhost:4100';
    expect(resolveApiBaseUrl()).toBe('http://localhost:4100');
  });
});

describe('resolveCacheScope', () => {
  it('prefers the host-supplied identity over the credential', () => {
    requestContext.run({ apiKey: 'anlyon_live_abc', cacheScope: 'user_1:client_1' }, () => {
      expect(resolveCacheScope('anlyon_live_abc')).toBe('id:user_1:client_1');
    });
  });

  it('is stable across credential rotation for the same caller', () => {
    const first = requestContext.run({ apiKey: 'jwt.one.sig', cacheScope: 'user_1:client_1' }, () =>
      resolveCacheScope('jwt.one.sig')
    );
    const second = requestContext.run({ apiKey: 'jwt.two.sig', cacheScope: 'user_1:client_1' }, () =>
      resolveCacheScope('jwt.two.sig')
    );
    expect(second).toBe(first);
  });

  it('keeps different callers apart even on an identical credential', () => {
    const a = requestContext.run({ apiKey: 'same', cacheScope: 'user_1:client_1' }, () => resolveCacheScope('same'));
    const b = requestContext.run({ apiKey: 'same', cacheScope: 'user_2:client_1' }, () => resolveCacheScope('same'));
    expect(a).not.toBe(b);
  });

  it('falls back to a collision-resistant hash of the key, never the key itself', () => {
    const scope = resolveCacheScope('anlyon_live_secret');
    expect(scope).not.toContain('anlyon_live_secret');
    expect(scope).toMatch(/^key:[0-9a-f]{64}$/);
  });

  it('separates two keys of identical length', () => {
    const a = resolveCacheScope('anlyon_live_aaaaaaaa');
    const b = resolveCacheScope('anlyon_live_bbbbbbbb');
    expect(a).not.toBe(b);
  });
});
