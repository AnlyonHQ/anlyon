import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const KEY = 'anlyon_test_xxxpacks00000000000000';
const PACKS = resolve(__dirname, '../../../../packs');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

const hubspot = { id: 'sec_h', name: 'HUBSPOT', kind: 'connection', connection: { integrationId: 'hubspot', status: 'active' }, allowedHosts: ['api.hubapi.com'] };
const slack = { id: 'sec_s', name: 'SLACK', kind: 'connection', connection: { integrationId: 'slack', status: 'active' }, allowedHosts: ['slack.com'] };

async function setup(secrets: Record<string, unknown>[] = [], invokeBodies: Record<string, string> = {}): Promise<{ server: FakeAnlyon; h: Harness; env: Record<string, string>; dir: string }> {
  const server = await startFakeAnlyon({
    apiKeys: { [KEY]: { scopes: ['secrets:read', 'secrets:write', 'actions:read', 'actions:write', 'actions:invoke', 'policies:read', 'policies:write', 'impact-limits:read', 'impact-limits:write'] } },
    actions: [],
    secrets,
    invokeBodies,
  });
  cleanups.push(server.close);
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  return { server, h: harness(dir.path), env: { ANLYON_API_KEY: KEY, ANLYON_API_URL: server.origin }, dir: dir.path };
}

async function notesPack(dir: string, saveFrom = 'id'): Promise<string> {
  const root = join(dir, 'notes');
  await mkdir(root, { recursive: true });
  const header = { Authorization: 'Bearer {{secret:NOTES}}' };
  const schema = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, folder: { type: 'string' }, text: { type: 'string' } } };
  const impact = { dimension: 'resource_mutations', amount: '1', bound: 'exact' };
  await writeFile(join(root, 'pack.json'), JSON.stringify({
    format: 'anlyon-pack/v1', pack: 'acme/notes', version: '0.1.0', description: 'Notes.',
    secrets: [{ name: 'NOTES', kind: 'static', hosts: ['api.notes.example'] }],
    actions: [
      { name: 'list-notes', kind: 'read', description: 'List notes.', method: 'GET', urlTemplate: 'https://api.notes.example/notes?folder={{input.folder}}', headers: header, inputSchema: schema },
      { name: 'create-note', kind: 'write', description: 'Create a note.', method: 'POST', urlTemplate: 'https://api.notes.example/notes', headers: header, bodyTemplate: { text: '{{input.text}}' }, inputSchema: schema, impact, verify: { url: 'https://api.notes.example/notes/{{response.id}}', status: 200, match: [] } },
      { name: 'get-note', kind: 'read', description: 'Get a note.', method: 'GET', urlTemplate: 'https://api.notes.example/notes/{{input.id}}', headers: header, inputSchema: schema },
      { name: 'delete-note', kind: 'write', description: 'No read-back: deleted notes are not readable.', method: 'DELETE', urlTemplate: 'https://api.notes.example/notes/{{input.id}}', headers: header, inputSchema: schema, impact },
    ],
  }));
  await writeFile(join(root, 'exercise.json'), JSON.stringify({
    needs: { folder: 'A folder to write in' },
    steps: [
      { action: 'list-notes', input: { folder: '{{needs.folder}}' } },
      { action: 'create-note', input: { folder: '{{needs.folder}}', text: 'Anlyon exercise {{run}}' }, save: { note: saveFrom } },
      { action: 'get-note', input: { id: '{{saved.note}}' } },
      { action: 'delete-note', input: { id: '{{saved.note}}' } },
    ],
  }));
  return root;
}

const params = ['--param', 'stripe_account=acct_1PackTest00000000', '--param', 'slack_channel=C0123456789'];

describe('anlyon packs', () => {
  it('plan prints what install would do and sends nothing', async () => {
    const { server, h, env } = await setup();
    const result = await h.run(['packs', 'plan', `${PACKS}/support-refunds`, ...params, '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const plan = JSON.parse(result.stdout).data;
    expect(plan.applied).toBe(false);
    expect(plan.steps.map((s: { kind: string; name: string; outcome: string }) => `${s.kind}:${s.name}:${s.outcome}`)).toEqual([
      'secret:STRIPE_KEY:create', 'connection:connection:hubspot:skip', 'connection:connection:slack:skip',
      'action:support-refunds-refund-payment:create', 'action:support-refunds-note-customer:create', 'action:support-refunds-post-to-support:create',
      'policy:support-refunds: approve refunds over 100.00:create',
      'limit:support-refunds: refunds per day:suggest', 'limit:support-refunds: customer notes per day:suggest', 'limit:support-refunds: support posts per day:suggest',
    ]);
    expect(server.state.requests.every((r) => r.method === 'GET')).toBe(true);

    const bound = await h.run(['packs', 'plan', `${PACKS}/support-refunds`, ...params, '--credential', 'secret', '--json'], { env });
    expect(bound.code, bound.stderr).toBe(EXIT.OK);
    expect(JSON.parse(bound.stdout).data.steps.filter((s: { kind: string }) => s.kind === 'secret').map((s: { name: string; outcome: string }) => `${s.name}:${s.outcome}`))
      .toEqual(['STRIPE_KEY:create', 'HUBSPOT:create', 'SLACK:create']);
    expect((await h.run(['packs', 'plan', `${PACKS}/support-refunds`, ...params, '--credential', 'vault'], { env })).code).toBe(EXIT.USAGE);
  });

  it('plan prints a readable table', async () => {
    const { h, env } = await setup();
    const result = await h.run(['packs', 'plan', `${PACKS}/outbound-sales`], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout).toMatch(/anlyon\/outbound-sales@0\.3\.0 \(plan: nothing sent\)/);
    expect(result.stdout).toMatch(/outbound-sales-announce-win\s+create/);
    expect(result.stderr).toMatch(/Suggested limits, not created/);
  });

  it("installs a catalogue pack with no account connected: each call chooses its end user's account, or the environment's", async () => {
    const { server, h, env } = await setup();
    const result = await h.run(['packs', 'install', `${PACKS}/hubspot`, '--action', 'create-company', '--yes', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const created = server.state.actions.filter((a) => a.name === 'hubspot-create-company');
    expect((created[0]!.headers as Record<string, string>).Authorization).toBe('Bearer {{connection:hubspot}}');
    expect(server.state.requests.filter((r) => r.path.includes('/secrets/'))).toEqual([]);
  });

  it('install bound to named secrets stops at a missing connected account, naming the command, with nothing written', async () => {
    const { server, h, env } = await setup();
    const result = await h.run(['packs', 'install', `${PACKS}/support-refunds`, ...params, '--secret', 'STRIPE_KEY=stripe-fixture-not-a-key', '--credential', 'secret', '--yes', '--json'], { env });
    expect(result.code).toBe(EXIT.REJECTED);
    const error = JSON.parse(result.stderr.trim().split('\n').at(-1)!).error;
    expect(error).toMatchObject({ code: 'PACK_CONNECTION_MISSING', hint: 'Run: anlyon connections add hubspot --secret HUBSPOT' });
    expect(server.state.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('installs with policies disabled and limits only with --with-limits, and never prints the secret value', async () => {
    const { server, h, env } = await setup([hubspot, slack]);
    const result = await h.run(['packs', 'install', `${PACKS}/support-refunds`, ...params, '--secret', 'STRIPE_KEY=stripe-fixture-value-must-not-print', '--with-limits', '--yes'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout + result.stderr).not.toContain('stripe-fixture-value-must-not-print');
    expect(result.stderr).toMatch(/Policies installed disabled/);
    expect(server.state.policies?.[0]).toMatchObject({ enabled: false, matchActionName: 'support-refunds-refund-payment' });
    expect(server.state.impactLimits.filter((l) => String(l.name).startsWith('support-refunds'))).toHaveLength(3);
  });

  it('refuses a missing static value when not interactive, and needs --yes', async () => {
    const { h, env } = await setup([hubspot, slack]);
    expect((await h.run(['packs', 'install', `${PACKS}/support-refunds`, ...params], { env })).code).toBe(EXIT.USAGE);
    const missing = await h.run(['packs', 'install', `${PACKS}/support-refunds`, ...params, '--yes'], { env });
    expect(missing.code).toBe(EXIT.REJECTED);
    expect(missing.stderr).toMatch(/PACK_SECRET_VALUE_MISSING|needs a value/);
  });

  it('installs one operation of a catalogue pack under another secret name', async () => {
    const { server, h, env } = await setup([{ ...hubspot, name: 'HUBSPOT_SALES' }]);
    const result = await h.run(['packs', 'install', `${PACKS}/hubspot`, '--action', 'create-company', '--secret-name', 'HUBSPOT=HUBSPOT_SALES', '--yes', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const created = server.state.actions.filter((a) => a.name === 'hubspot-create-company');
    expect(created).toHaveLength(1);
    expect((created[0]!.headers as Record<string, string>).Authorization).toBe('Bearer {{secret:HUBSPOT_SALES}}');
    expect(server.state.actions).toHaveLength(1);
  });

  it('exercise runs every step in order, carrying a saved id forward', async () => {
    const { server, h, env, dir } = await setup([], { 'notes-create-note': '{"id":42}' });
    const pack = await notesPack(dir);
    const result = await h.run(['packs', 'exercise', pack, '--need', 'folder=F1', '--yes', '--json'], { env });
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout).data;
    expect(report.steps.map((s: { action: string; kind: string; outcome: string }) => `${s.action}:${s.kind}:${s.outcome}`)).toEqual([
      'notes-list-notes:read:succeeded', 'notes-create-note:write:succeeded', 'notes-get-note:read:succeeded', 'notes-delete-note:write:succeeded',
    ]);
    const inputs = [...server.state.invocations.values()].map((i) => i.input);
    expect(inputs[1]).toEqual({ folder: 'F1', text: `Anlyon exercise ${report.run}` });
    expect(inputs[2]).toEqual({ id: '42' });
  });

  it('exercise names what it needs, and stops at the first step that fails', async () => {
    const { server, h, env, dir } = await setup();
    const pack = await notesPack(dir, 'missing.path');
    const missing = await h.run(['packs', 'exercise', pack, '--yes'], { env });
    expect(missing.code).toBe(EXIT.USAGE);
    expect(missing.stderr).toMatch(/needs: folder/);
    expect(missing.stderr).toMatch(/--need folder=\.\.\.  A folder to write in/);
    expect(server.state.invocations.size).toBe(0);

    const stopped = await h.run(['packs', 'exercise', pack, '--need', 'folder=F1', '--yes', '--json'], { env });
    expect(stopped.code).toBe(EXIT.ERROR);
    const outcomes = JSON.parse(stopped.stdout).data.steps.map((s: { outcome: string }) => s.outcome);
    expect(outcomes).toEqual(['succeeded', 'failed', 'not run', 'not run']);
    expect(server.state.invocations.size).toBe(2);
  });

  it('refuses a path that is not a pack, and a bad --param', async () => {
    const { h, env } = await setup();
    expect((await h.run(['packs', 'plan', '/nonexistent/pack'], { env })).code).toBe(EXIT.USAGE);
    expect((await h.run(['packs', 'plan', `${PACKS}/support-refunds`, '--param', 'BAD'], { env })).code).toBe(EXIT.USAGE);
  });
});
