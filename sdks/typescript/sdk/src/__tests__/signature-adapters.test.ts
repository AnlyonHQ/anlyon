import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifySignature as verifyNext } from '../nextjs/verify-signature';
import { verifySignature as verifySvelteKit } from '../sveltekit/verify-signature';
import { verifySignature as verifyCloudflare } from '../cloudflare-workers/verify-signature';
import { serve as serveCloudflare } from '../cloudflare-workers/serve';
import type { RequestEvent } from '../sveltekit/serve';

const secret = 'adapter-secret';
const environmentId = 'env_production';
const timestamp = 1_800_000_000;
const body = '{"message":"héllo 🌍"}';

function signature(): string {
  const legacy = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const environment = createHmac('sha256', secret)
    .update(`anlyon-delivery-v2.${timestamp}.${environmentId}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${legacy},env=${environmentId},v2=${environment}`;
}

function request(header = signature()): Request {
  return new Request('https://example.test/webhook', {
    method: 'POST',
    headers: { 'anlyon-signature': header },
    body,
  });
}

beforeAll(() => vi.spyOn(Date, 'now').mockReturnValue(timestamp * 1000));

describe('signature adapters', () => {
  it('forwards expectedEnvironmentId through Next.js', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = verifyNext(handler, { signingSecret: secret, expectedEnvironmentId: environmentId });
    expect((await wrapped(request())).status).toBe(200);
    expect((await wrapped(request(`t=${timestamp},v1=${'0'.repeat(64)}`))).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards expectedEnvironmentId through SvelteKit', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const wrapped = verifySvelteKit(handler, { signingSecret: secret, expectedEnvironmentId: environmentId });
    const event = { request: request() } as RequestEvent;
    expect((await wrapped(event)).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('resolves Cloudflare environment options per request', async () => {
    type Env = { ANLYON_SIGNING_SECRET: string; ENVIRONMENT_ID: string };
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = verifyCloudflare<Env>(handler, {
      signingSecret: (env) => env.ANLYON_SIGNING_SECRET,
      expectedEnvironmentId: (env) => env.ENVIRONMENT_ID,
    });
    const env = { ANLYON_SIGNING_SECRET: secret, ENVIRONMENT_ID: environmentId };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    expect((await wrapped(request(), env, ctx)).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails closed when a Cloudflare environment resolver is misconfigured', async () => {
    type Env = { ANLYON_SIGNING_SECRET: string };
    const env = { ANLYON_SIGNING_SECRET: secret };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const environmentResolver = (() => undefined) as unknown as (env: Env) => string;
    const handler = vi.fn(async () => Response.json({ ok: true }));

    const verified = verifyCloudflare<Env>(handler, {
      expectedEnvironmentId: environmentResolver,
    });
    await expect(verified(request(), env, ctx)).rejects.toThrow(
      'expectedEnvironmentId resolver must return an environment identifier'
    );

    const served = serveCloudflare<unknown, Env>(handler, {
      expectedEnvironmentId: environmentResolver,
    });
    await expect(served(request(), env, ctx)).rejects.toThrow(
      'expectedEnvironmentId resolver must return an environment identifier'
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
