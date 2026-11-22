import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { startFakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const BUILDER = 'anlyon_test_xxxbuilder00000000000';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

type FakeOptions = NonNullable<Parameters<typeof startFakeAnlyon>[0]>;

async function setup(options: Partial<FakeOptions> = {}) {
  const server = await startFakeAnlyon({
    apiKeys: { [BUILDER]: { scopes: ['actions:read', 'actions:write'] } },
    actions: [{ id: 'act_1', name: 'send-email', method: 'POST', enabled: true, governed: true, impact: { dimension: 'emails', unit: 'emails', amount: '1', bound: 'exact' }, verify: null }],
    ...options,
  });
  cleanups.push(server.close);
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  const h: Harness = harness(dir.path, { ANLYON_API_KEY: BUILDER, ANLYON_API_URL: server.origin });
  return { server, h };
}

const loosen = ['actions', 'declare', 'send-email', '--ungoverned', '--yes'];

describe('a change that needs a human’s sign-off', () => {
  it('prints the link, the id and the diff, says no CLI login can approve it, and exits 15', async () => {
    const { server, h } = await setup({ signOff: {} });
    const result = await h.run(loosen);
    expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
    const [request] = [...server.state.signOffs.values()].map((entry) => entry.request);
    const lines = result.stderr.split('\n');
    expect(lines[0]).toBe("Needs a human's sign-off. A workspace admin must approve this change before it applies:");
    expect(lines[1]).toBe(`https://console.anlyon.test/sign-offs/${request!.id}`);
    expect(result.stderr).toContain(`id:      ${request!.id}`);
    expect(result.stderr).toContain('- governed: true');
    expect(result.stderr).toContain('+ governed: false');
    expect(result.stderr).toContain('This command cannot approve it, and neither can any API key or CLI login.');
    expect(result.stdout).toBe('');
    const action = (await h.run(['actions', 'get', 'send-email', '--json'])).stdout;
    expect(JSON.parse(action).data.governed).toBe(true);
  });

  it('with --json puts the request on stdout as {"data": ...}', async () => {
    const { h } = await setup({ signOff: {} });
    const result = await h.run([...loosen, '--json']);
    expect(result.code).toBe(EXIT.SIGN_OFF_REQUIRED);
    const out = JSON.parse(result.stdout);
    expect(out.data).toMatchObject({ object: 'sign_off_request', status: 'pending', operation: 'action.update' });
    expect(out.data.signOffUrl).toMatch(/^https:\/\/console\.anlyon\.test\/sign-offs\/sor_/);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'SIGN_OFF_REQUIRED', exitCode: EXIT.SIGN_OFF_REQUIRED });
  });

  it('a tightening change applies as before', async () => {
    const { h } = await setup({ signOff: {} });
    const result = await h.run(['actions', 'declare', 'send-email', '--verify-url', 'https://api.example.com/x', '--verify-status', '200', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout).data.verify).toMatchObject({ url: 'https://api.example.com/x' });
  });

  it('--wait follows it and prints the applied result (exit 0)', async () => {
    const { h } = await setup({ signOff: { decision: 'applied', afterPolls: 2 } });
    const result = await h.run([...loosen, '--wait', '30s', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const out = JSON.parse(result.stdout);
    expect(out.data).toMatchObject({ name: 'send-email', governed: false });
    expect(out.signOffId).toMatch(/^sor_/);
    expect(result.stderr).toContain('Waiting for a decision on sor_');
  });

  it('--wait exits 14 with the reason when an admin rejects it', async () => {
    const { h } = await setup({ signOff: { decision: 'rejected', note: 'Keep it governed.' } });
    const result = await h.run([...loosen, '--wait', '30s']);
    expect(result.code).toBe(EXIT.ACTION_NOT_SUCCEEDED);
    expect(result.stderr).toContain('A workspace admin rejected the change. Nothing changed.');
    expect(result.stderr).toContain('Keep it governed.');
  });

  it('--wait exits 14 when the approved change could not be applied', async () => {
    const { h } = await setup({ signOff: { decision: 'failed' } });
    const result = await h.run([...loosen, '--wait', '30s', '--json']);
    expect(result.code).toBe(EXIT.ACTION_NOT_SUCCEEDED);
    expect(JSON.parse(result.stdout).data.status).toBe('failed');
    expect(JSON.parse(result.stderr.trim().split('\n').at(-1)!).error.code).toBe('SIGN_OFF_FAILED');
  });

  it('--wait exits 9 when nobody decides in time', async () => {
    const { h } = await setup({ signOff: {} });
    const result = await h.run([...loosen, '--wait', '300ms']);
    expect(result.code).toBe(EXIT.TIMEOUT);
    expect(result.stderr).toContain('still pending');
  });
});

describe('anlyon sign-offs', () => {
  it('lists, gets and follows a request', async () => {
    const { h } = await setup({ signOff: { decision: 'applied', afterPolls: 3 } });
    const asked = JSON.parse((await h.run([...loosen, '--json'])).stdout).data;

    const listed = await h.run(['sign-offs', 'list', '--status', 'pending', '--json']);
    expect(listed.code, listed.stderr).toBe(EXIT.OK);
    expect(JSON.parse(listed.stdout).data.map((row: { id: string }) => row.id)).toEqual([asked.id]);

    const shown = await h.run(['sign-offs', 'get', asked.id]);
    expect(shown.code).toBe(EXIT.OK);
    expect(shown.stdout).toContain('pending');
    expect(shown.stdout).toContain(asked.signOffUrl);
    expect(shown.stdout).toContain('+ governed: false');

    const followed = await h.run(['sign-offs', 'get', asked.id, '--wait', '30s', '--json']);
    expect(followed.code, followed.stderr).toBe(EXIT.OK);
    expect(JSON.parse(followed.stdout).data.status).toBe('applied');
  });

  it('get --wait exits 14 on a rejection and 9 when the wait ends first', async () => {
    const rejected = await setup({ signOff: { decision: 'rejected', afterPolls: 2 } });
    const asked = JSON.parse((await rejected.h.run([...loosen, '--json'])).stdout).data;
    const result = await rejected.h.run(['sign-offs', 'get', asked.id, '--wait', '30s']);
    expect(result.code).toBe(EXIT.ACTION_NOT_SUCCEEDED);
    expect(result.stderr).toContain('rejected');

    const pending = await setup({ signOff: {} });
    const other = JSON.parse((await pending.h.run([...loosen, '--json'])).stdout).data;
    const timedOut = await pending.h.run(['sign-offs', 'get', other.id, '--wait', '200ms']);
    expect(timedOut.code).toBe(EXIT.TIMEOUT);
  });

  it('cancel withdraws a pending request and refuses one already withdrawn', async () => {
    const { h, server } = await setup({ signOff: {} });
    const asked = JSON.parse((await h.run([...loosen, '--json'])).stdout).data;
    expect((await h.run(['sign-offs', 'cancel', asked.id])).code).toBe(EXIT.USAGE);
    const cancelled = await h.run(['sign-offs', 'cancel', asked.id, '--yes', '--json']);
    expect(cancelled.code, cancelled.stderr).toBe(EXIT.OK);
    expect(JSON.parse(cancelled.stdout).data.status).toBe('cancelled');
    expect(server.state.signOffs.get(asked.id)!.request.status).toBe('cancelled');
    expect((await h.run(['sign-offs', 'cancel', asked.id, '--yes'])).code).toBe(EXIT.REJECTED);
  });

  it('a missing request is exit 5', async () => {
    const { h } = await setup();
    expect((await h.run(['sign-offs', 'get', 'sor_missing'])).code).toBe(EXIT.NOT_FOUND);
  });
});

describe('error.fix', () => {
  it('prints the API’s command as the hint and includes fix in --json', async () => {
    const { h } = await setup({ scopeFix: true, apiKeys: { [BUILDER]: { scopes: ['actions:read'] } } });
    const text = await h.run(loosen);
    expect(text.code).toBe(EXIT.PERMISSION_DENIED);
    expect(text.stderr).toContain('hint: Run: anlyon auth login --scope actions:write');

    const json = await h.run([...loosen, '--json']);
    expect(JSON.parse(json.stderr).error.fix).toEqual({
      summary: 'Log in again with the scope actions:write.',
      command: 'anlyon auth login --scope actions:write',
    });
  });
});
