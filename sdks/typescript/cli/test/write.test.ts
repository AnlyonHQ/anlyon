import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../src/exit-codes';
import { GRADE_MEANINGS } from '../src/governed';
import { clearRegisteredSecrets } from '../src/redact';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const OPERATOR = 'anlyon_test_xxxoperator0000000000';
const RUNTIME = 'anlyon_test_xxxruntime00000000000';
const BUILDER = 'anlyon_test_xxxbuilder00000000000';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(): Promise<{ server: FakeAnlyon; h: Harness; as: (key: string) => Record<string, string> }> {
  const server = await startFakeAnlyon({
    apiKeys: {
      [OPERATOR]: { scopes: ['actions:read', 'actions:invoke', 'approvals:read', 'approvals:decide'] },
      [RUNTIME]: { scopes: ['actions:read', 'actions:invoke', 'approvals:read'] },
      [BUILDER]: { scopes: ['actions:read', 'actions:write', 'impact-limits:read'] },
    },
  });
  cleanups.push(server.close);
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  const h = harness(dir.path);
  return { server, h, as: (key) => ({ ANLYON_API_KEY: key, ANLYON_API_URL: server.origin }) };
}

const json = (text: string) => JSON.parse(text);

describe('anlyon actions invoke', () => {
  it('invokes with a generated idempotency key and reports success (exit 0)', async () => {
    const { server, h, as } = await setup();
    const result = await h.run(['actions', 'invoke', 'send_email', '--data', '{"to":"a@b.co"}', '--yes', '--json'], { env: as(RUNTIME) });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const out = json(result.stdout);
    expect(out.data.status).toBe('succeeded');
    expect(out.idempotencyKey).toMatch(/^cli_[0-9a-f-]{36}$/);
    const call = server.state.requests.find((r) => r.path === '/api/v2/actions/send_email/invoke')!;
    expect(call.headers['idempotency-key']).toBe(out.idempotencyKey);
    expect(server.state.dispatches).toBe(1);
  });

  it('re-running with the same key returns the recorded result and dispatches nothing new', async () => {
    const { server, h, as } = await setup();
    const argv = ['actions', 'invoke', 'refund', '--data', '{"amount":1200}', '--idempotency-key', 'order-9921-refund', '--yes', '--json'];
    const first = json((await h.run(argv, { env: as(RUNTIME) })).stdout);
    const second = json((await h.run(argv, { env: as(RUNTIME) })).stdout);
    expect(second.data.id).toBe(first.data.id);
    expect(server.state.dispatches).toBe(1);
    const changed = await h.run(['actions', 'invoke', 'refund', '--data', '{"amount":9999}', '--idempotency-key', 'order-9921-refund', '--yes'], { env: as(RUNTIME) });
    expect(changed.code).toBe(EXIT.REJECTED);
    expect(server.state.dispatches).toBe(1);
  });

  it('maps outcomes to distinct exit codes, and never calls an uncertain outcome a failure', async () => {
    const { h, as } = await setup();
    const run = (ref: string) => h.run(['actions', 'invoke', ref, '--yes', '--json'], { env: as(RUNTIME) });

    const gated = await run('gated_refund');
    expect(gated.code).toBe(EXIT.ACTION_PENDING);
    expect(json(gated.stdout).data.status).toBe('pending_approval');

    const flaky = await run('flaky_refund');
    expect(flaky.code).toBe(EXIT.ACTION_UNKNOWN);
    const unknown = json(flaky.stdout);
    expect(unknown.data.status).toBe('unknown');
    expect(unknown.nextStep).toMatch(/Do not retry with a new key/);

    const broken = await run('broken_refund');
    expect(broken.code).toBe(EXIT.ACTION_NOT_SUCCEEDED);
    expect(json(broken.stdout).data.status).toBe('failed');
  });

  it('never writes without confirmation when not interactive', async () => {
    const { server, h, as } = await setup();
    const result = await h.run(['actions', 'invoke', 'send_email'], { env: as(RUNTIME) });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toContain('--yes');
    expect(server.state.requests.some((r) => r.path.endsWith('/invoke'))).toBe(false);
  });

  it('takes the action input from --input <file|->, and refuses non-object input or both sources', async () => {
    const { server, h, as } = await setup();
    const file = join(h.configDir, 'input.json');
    await writeFile(file, JSON.stringify({ to: 'x@y.co' }));
    expect((await h.run(['actions', 'invoke', 'send_email', '--input', file, '--yes'], { env: as(RUNTIME) })).code).toBe(EXIT.OK);
    expect((await h.run(['actions', 'invoke', 'send_email', '--input', '-', '--yes'], { env: as(RUNTIME), stdin: '{"to":"z@y.co"}' })).code).toBe(EXIT.OK);
    expect((await h.run(['actions', 'invoke', 'send_email', '--data', '[1]', '--yes'], { env: as(RUNTIME) })).code).toBe(EXIT.USAGE);
    expect((await h.run(['actions', 'invoke', 'send_email', '--data', '{}', '--input', file, '--yes'], { env: as(RUNTIME) })).code).toBe(EXIT.USAGE);
    expect((await h.run(['actions', 'invoke', 'x', '--idempotency-key', 'bad key!', '--yes'], { env: as(RUNTIME) })).code).toBe(EXIT.USAGE);
    expect(server.state.dispatches).toBe(2);
  });

  it('--wait follows a gated action through approval to its outcome', async () => {
    const { server, h, as } = await setup();
    const pending = h.run(['actions', 'invoke', 'gated_refund', '--wait', '30s', '--yes', '--json'], { env: as(RUNTIME) });
    const deadline = Date.now() + 10_000;
    while (server.state.approvals.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const [approval] = [...server.state.approvals.values()];
    const approved = await h.run(['approvals', 'approve', approval!.id, '--note', 'ok', '--yes', '--json'], { env: as(OPERATOR) });
    expect(approved.code, approved.stderr).toBe(EXIT.OK);
    const result = await pending;
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(json(result.stdout).data.status).toBe('succeeded');
  }, 30_000);
});

describe('anlyon approvals approve|deny', () => {
  it('denies, after which the action never runs; a decided approval cannot be decided again', async () => {
    const { server, h, as } = await setup();
    const gated = json((await h.run(['actions', 'invoke', 'gated_wire', '--yes', '--json'], { env: as(RUNTIME) })).stdout);
    const denied = await h.run(['approvals', 'deny', gated.data.approvalId, '--note', 'wrong account', '--yes', '--json'], { env: as(OPERATOR) });
    expect(denied.code).toBe(EXIT.OK);
    expect(json(denied.stdout).data).toMatchObject({ approval: { status: 'denied' }, invocation: { status: 'denied' } });
    expect(server.state.dispatches).toBe(0);
    const again = await h.run(['approvals', 'approve', gated.data.approvalId, '--yes'], { env: as(OPERATOR) });
    expect(again.code).toBe(EXIT.REJECTED);
    expect(server.state.dispatches).toBe(0);
  });

  it('a credential without approvals:decide is refused with exit 4', async () => {
    const { h, as } = await setup();
    const gated = json((await h.run(['actions', 'invoke', 'gated_wire', '--yes', '--json'], { env: as(RUNTIME) })).stdout);
    const refused = await h.run(['approvals', 'approve', gated.data.approvalId, '--yes', '--json'], { env: as(RUNTIME) });
    expect(refused.code).toBe(EXIT.PERMISSION_DENIED);
    expect(json(refused.stderr).error.message).toContain('approvals:decide');
  });
});

describe('anlyon actions declare', () => {
  it('sets an impact and a read-back, sending only the declarations that were given', async () => {
    const { server, h, as } = await setup();
    const result = await h.run(
      [
        'actions', 'declare', 'action-1',
        '--dimension', 'emails', '--amount', 'count(input.to)', '--bound', 'exact',
        '--verify-url', 'https://api.example.com/v1/messages/{{response.id}}', '--verify-status', '200',
        '--verify-match', 'data.status=sent', '--verify-match', 'data.attempts=1', '--verify-match', 'data.id="42"',
        '--yes', '--json',
      ],
      { env: as(BUILDER) },
    );
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const sent = server.state.declared.at(-1)!;
    expect(sent).toEqual({
      ref: 'action-1',
      body: {
        impact: { dimension: 'emails', amount: 'count(input.to)', bound: 'exact' },
        verify: {
          url: 'https://api.example.com/v1/messages/{{response.id}}',
          status: 200,
          match: [{ path: 'data.status', equals: 'sent' }, { path: 'data.attempts', equals: 1 }, { path: 'data.id', equals: '42' }],
        },
      },
    });
    const call = server.state.requests.find((r) => r.method === 'PATCH' && r.path === '/api/v2/actions/action-1')!;
    const out = json(result.stdout);
    expect(call.headers['idempotency-key']).toBe(out.idempotencyKey);
    expect(out.data).toMatchObject({ name: 'action-1', governed: true, impact: { dimension: 'emails', unit: 'emails' }, verify: { status: 200 } });
  });

  it('declares money with its currency, and prints the declarations for a person', async () => {
    const { server, h, as } = await setup();
    const result = await h.run(
      ['actions', 'declare', 'action-1', '--dimension', 'money', '--unit', 'usd', '--amount', 'input.amount', '--bound', 'upper_bound', '--yes'],
      { env: as(BUILDER) },
    );
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(server.state.declared.at(-1)!.body).toEqual({ impact: { dimension: 'money', unit: 'usd', amount: 'input.amount', bound: 'upper_bound' } });
    expect(result.stdout).toMatch(/governed\s+true/);
    expect(result.stdout).toMatch(/impact\s+money \(usd\): input\.amount, upper_bound/);
    expect(result.stderr).toContain('The action is governed.');

    const shown = await h.run(['actions', 'get', 'action-1'], { env: as(BUILDER) });
    expect(shown.stdout).toMatch(/governed\s+true/);
    expect(shown.stdout).toMatch(/impact\s+money \(usd\): input\.amount, upper_bound/);
    expect(shown.stdout).toMatch(/verify\s+-/);
  });

  it('removes one declaration with null, every declaration with governed false, and governs alone', async () => {
    const { server, h, as } = await setup();
    const run = (...flags: string[]) => h.run(['actions', 'declare', 'action-1', ...flags, '--yes', '--json'], { env: as(BUILDER) });
    expect((await run('--governed')).code).toBe(EXIT.OK);
    expect(server.state.declared.at(-1)!.body).toEqual({ governed: true });
    expect((await run('--no-verify')).code).toBe(EXIT.OK);
    expect(server.state.declared.at(-1)!.body).toEqual({ verify: null });
    expect((await run('--no-impact', '--verify-url', 'https://api.example.com/x', '--verify-status', '204')).code).toBe(EXIT.OK);
    expect(server.state.declared.at(-1)!.body).toEqual({ impact: null, verify: { url: 'https://api.example.com/x', status: 204 } });
    const removed = await run('--ungoverned');
    expect(server.state.declared.at(-1)!.body).toEqual({ governed: false });
    expect(json(removed.stdout).data).toMatchObject({ governed: false, impact: null, verify: null });
  });

  it('refuses contradictory or incomplete flags before anything is sent', async () => {
    const { server, h, as } = await setup();
    const cases = [
      [],
      ['--dimension', 'emails'],
      ['--dimension', 'money', '--amount', '1', '--bound', 'exact'],
      ['--dimension', 'emails', '--amount', '1', '--bound', 'roughly'],
      ['--no-impact', '--amount', '1'],
      ['--verify-url', 'https://api.example.com/x'],
      ['--verify-url', 'https://api.example.com/x', '--verify-status', 'ok'],
      ['--verify-url', 'https://api.example.com/x', '--verify-status', '200', '--verify-match', 'no-equals-sign'],
      ['--no-verify', '--verify-match', 'a=b'],
      ['--ungoverned', '--governed'],
    ];
    for (const flags of cases) {
      const result = await h.run(['actions', 'declare', 'action-1', ...flags, '--yes'], { env: as(BUILDER) });
      expect(result.code, flags.join(' ')).toBe(EXIT.USAGE);
    }
    expect((await h.run(['actions', 'declare', 'action-1', '--governed'], { env: as(BUILDER) })).code).toBe(EXIT.USAGE);
    expect(server.state.declared).toHaveLength(0);
    expect(server.state.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('reads the flags from --input, with a list for the repeatable one, and needs actions:write', async () => {
    const { server, h, as } = await setup();
    const input = JSON.stringify({ 'verify-url': 'https://api.example.com/x', 'verify-status': 200, 'verify-match': ['ok=true', 'state=done'], yes: true });
    const result = await h.run(['actions', 'declare', 'action-1', '--input', '-', '--json'], { env: as(BUILDER), stdin: input });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(server.state.declared.at(-1)!.body).toEqual({
      verify: { url: 'https://api.example.com/x', status: 200, match: [{ path: 'ok', equals: true }, { path: 'state', equals: 'done' }] },
    });
    const refused = await h.run(['actions', 'declare', 'action-1', '--governed', '--yes', '--json'], { env: as(RUNTIME) });
    expect(refused.code).toBe(EXIT.PERMISSION_DENIED);
    expect(json(refused.stderr).error.message).toContain('actions:write');
  });

  it('documents every flag in --help', async () => {
    const { h } = await setup();
    const help = await h.run(['actions', 'declare', '--help']);
    expect(help.code).toBe(EXIT.OK);
    for (const flag of ['--dimension', '--unit', '--amount', '--bound', '--verify-url', '--verify-status', '--verify-match', '--governed', '--no-impact', '--no-verify', '--ungoverned', '--yes']) {
      expect(help.stdout, flag).toContain(`${flag} `);
    }
    expect(help.stdout).toContain('(exact|upper_bound)');
    expect(help.stdout).toContain('Repeatable.');
    expect(help.stdout).not.toMatch(/[—;]/);
  });
});

describe('receipt grades and declared units', () => {
  it('effects list shows the grade and filters by it', async () => {
    const { server, h, as } = await setup();
    const all = await h.run(['effects', 'list'], { env: as(BUILDER) });
    expect(all.stdout.split('\n')[0]).toMatch(/^ID\s+ACTION\s+STAGE\s+GRADE\s+OUTCOME/);
    expect(all.stdout).toMatch(/eff_2\s+action-0\s+completed\s+acknowledged/);

    const filtered = await h.run(['effects', 'list', '--grade', 'unknown', '--json'], { env: as(BUILDER) });
    expect(server.state.requests.filter((r) => r.path === '/api/v2/actions/effects').at(-1)!.query).toMatchObject({ grade: 'unknown' });
    expect(json(filtered.stdout).data.map((effect: { id: string; grade: string }) => [effect.id, effect.grade])).toEqual([['eff_3', 'unknown']]);
    expect((await h.run(['effects', 'list', '--grade', 'excellent'], { env: as(BUILDER) })).code).toBe(EXIT.USAGE);
  });

  it('effects get says what the grade means, and --json carries the grade unchanged', async () => {
    const { h, as } = await setup();
    const human = await h.run(['effects', 'get', 'eff_2'], { env: as(BUILDER) });
    expect(human.stdout).toMatch(/grade\s+acknowledged: The provider accepted the request\. Nothing read it back\./);
    expect(json((await h.run(['effects', 'get', 'eff_1', '--json'], { env: as(BUILDER) })).stdout).data.grade).toBe('confirmed');
    expect(Object.keys(GRADE_MEANINGS)).toEqual(['confirmed', 'acknowledged', 'unknown', 'failed', 'refused', 'denied', 'pending']);
    expect((await h.run(['effects', 'list', '--help'], { env: as(BUILDER) })).stdout).toContain('(confirmed|acknowledged|unknown|failed|refused|denied|pending)');
  });

  it('impact limits show the unit they count, money or declared', async () => {
    const { h, as } = await setup();
    const list = await h.run(['impact-limits', 'list'], { env: as(BUILDER) });
    expect(list.stdout.split('\n')[0]).toMatch(/^ID\s+NAME\s+DIMENSION\s+UNIT\s+PERIOD/);
    expect(list.stdout).toMatch(/lim_1\s+Refunds per day\s+money\s+usd/);
    expect(list.stdout).toMatch(/lim_2\s+Emails per day\s+emails\s+emails/);
    const one = await h.run(['impact-limits', 'get', 'lim_2'], { env: as(BUILDER) });
    expect(one.stdout).toMatch(/dimension\s+emails/);
    expect(one.stdout).toMatch(/unit\s+emails/);
  });
});
