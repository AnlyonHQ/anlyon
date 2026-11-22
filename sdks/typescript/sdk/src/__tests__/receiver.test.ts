import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Receiver, SignatureVerificationError } from '../receiver';
import { WebCryptoReceiver } from '../crypto/web-crypto';

const secret = 'whsec_test';
const production = 'env_production';
const staging = 'env_staging';
const timestamp = 1_800_000_000;

function mac(value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function v1(body: string): string {
  return mac(`${timestamp}.${body}`);
}

function v2(body: string, environmentId = production): string {
  return mac(`anlyon-delivery-v2.${timestamp}.${environmentId}.${body}`);
}

function header(body: string, environmentId = production): string {
  return `t=${timestamp},v1=${v1(body)},env=${environmentId},v2=${v2(body, environmentId)}`;
}

describe.each([
  ['Node Receiver', (expectedEnvironmentId?: string) => new Receiver({ signingSecret: secret, expectedEnvironmentId })],
  ['Web Crypto Receiver', (expectedEnvironmentId?: string) => new WebCryptoReceiver({ signingSecret: secret, expectedEnvironmentId })],
] as const)('%s', (_name, makeReceiver) => {
  it('accepts an environment-bound UTF-8 raw body', async () => {
    const body = '{"message":"héllo 🌍","spacing": true}';
    await expect(Promise.resolve(makeReceiver(production).verify({ signature: header(body), body }))).resolves.toBe(true);
  });

  it('rejects cross-environment attribution and body or env tampering', async () => {
    const body = '{"ok":true}';
    const receiver = makeReceiver(production);
    await expect(Promise.resolve(receiver.verify({ signature: header(body, staging), body }))).resolves.toBe(false);
    await expect(Promise.resolve(receiver.verify({ signature: header(body), body: `${body}\n` }))).resolves.toBe(false);
    await expect(Promise.resolve(receiver.verify({ signature: header(body).replace(`env=${production}`, `env=${staging}`), body }))).resolves.toBe(false);
  });

  it('accepts any valid v2 during secret rotation', async () => {
    const body = '{}';
    const signature = `${header(body)},v2=${'0'.repeat(64)}`;
    await expect(Promise.resolve(makeReceiver(production).verify({ signature, body }))).resolves.toBe(true);
  });

  it('requires exactly one canonical timestamp and environment', async () => {
    const body = '{}';
    const valid = header(body);
    for (const signature of [
      `${valid},t=${timestamp}`,
      valid.replace(`t=${timestamp}`, `t=0${timestamp}`),
      `${valid},env=${production}`,
      valid.replace(`env=${production}`, `env=${production}.nested`),
    ]) {
      await expect(Promise.resolve(makeReceiver(production).verify({ signature, body }))).resolves.toBe(false);
    }
  });

  it('rejects malformed hex and missing signed attribution', async () => {
    const body = '{}';
    await expect(Promise.resolve(makeReceiver(production).verify({ signature: header(body).replace(v2(body), 'zz'), body }))).resolves.toBe(false);
    await expect(Promise.resolve(makeReceiver(production).verify({ signature: `t=${timestamp},v1=${v1(body)}`, body }))).resolves.toBe(false);
    await expect((async () => makeReceiver(production).verifyOrThrow({ signature: `t=${timestamp},v1=${v1(body)}`, body }))())
      .rejects.toThrow('Missing signed environment attribution');
  });

  it('does not accept the legacy signing-oracle forgery as v2', async () => {
    const body = '{"task":"deploy"}';
    const forged = v1(`${production}.${body}`);
    const signature = `t=${timestamp},v1=${v1(body)},env=${production},v2=${forged}`;
    await expect(Promise.resolve(makeReceiver(production).verify({ signature, body }))).resolves.toBe(false);
  });

  it('preserves legacy v1 verification when no environment is configured', async () => {
    const body = '{\n  "legacy": true\n}';
    await expect(Promise.resolve(makeReceiver().verify({ signature: `t=${timestamp},v1=${v1(body)}`, body }))).resolves.toBe(true);
  });

  it('verifies signed empty bodies for URL-only deliveries', async () => {
    const emptyV1 = `t=${timestamp},v1=${v1('')}`;
    const emptyV2 = `t=${timestamp},v1=${v1('')},env=${production},v2=${v2('')}`;
    await expect(Promise.resolve(makeReceiver().verify({ signature: emptyV1, body: '' }))).resolves.toBe(true);
    await expect(Promise.resolve(makeReceiver(production).verify({ signature: emptyV2, body: '' }))).resolves.toBe(true);
  });
});

describe('Receiver errors', () => {
  it('rejects an empty expected environment identifier', () => {
    expect(() => new Receiver({ signingSecret: secret, expectedEnvironmentId: '' })).toThrow(
      'expectedEnvironmentId must be a canonical environment identifier'
    );
  });

  it('reports malformed headers', () => {
    const receiver = new Receiver({ signingSecret: secret, expectedEnvironmentId: production });
    expect(() => receiver.verifyOrThrow({ signature: `t=${timestamp},v2=xyz`, body: '{}' }))
      .toThrow(SignatureVerificationError);
  });
});

beforeAll(() => {
  vi.spyOn(Date, 'now').mockReturnValue(timestamp * 1000);
});
