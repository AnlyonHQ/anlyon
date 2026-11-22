import { describe, expect, it, vi } from 'vitest';
import { Client } from '../client';
import { PackError, validatePackManifest, type PackManifest } from '../resources/packs';

function fakeApi(seed: { secrets?: Record<string, unknown>[]; actions?: Record<string, unknown>[] } = {}) {
  const state = {
    secrets: [...(seed.secrets ?? [])] as Record<string, unknown>[],
    actions: [...(seed.actions ?? [])] as Record<string, unknown>[],
    policies: [] as Record<string, unknown>[],
    limits: [] as Record<string, unknown>[],
    calls: [] as string[],
    bodies: [] as unknown[],
  };
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    state.calls.push(`${method} ${u.pathname}${u.search}`);
    if (body !== undefined) state.bodies.push(body);
    const secret = /^\/api\/v2\/secrets\/([A-Z0-9_]+)$/.exec(u.pathname);
    if (secret) {
      const found = state.secrets.find((s) => s.name === secret[1]);
      if (method === 'GET') return found ? ok(found) : notFound();
      const created = { name: secret[1], kind: 'static', connection: null, allowedHosts: body.allowedHosts, allowedPlacements: body.allowedPlacements };
      state.secrets.push(created);
      return ok(created);
    }
    const action = /^\/api\/v2\/actions\/([^/]+)$/.exec(u.pathname);
    if (action) {
      const found = state.actions.find((a) => a.name === action[1]);
      if (method === 'GET') return found ? ok(found) : notFound();
      Object.assign(found!, body);
      return ok(found);
    }
    if (u.pathname === '/api/v2/actions' && method === 'POST') { state.actions.push(body); return ok(body, 201); }
    if (u.pathname === '/api/v2/approval-policies') {
      if (method === 'POST') { state.policies.push(body); return ok(body, 201); }
      return ok(state.policies.filter((p) => p.matchActionName === u.searchParams.get('actionName')));
    }
    if (u.pathname === '/api/v2/impact-limits') {
      if (method === 'POST') { state.limits.push(body); return ok(body, 201); }
      return ok(state.limits);
    }
    return notFound();
  });
  const client = new Client({ apiKey: 'k', baseUrl: 'https://api.test', fetch: fetchFn as unknown as typeof fetch, retry: { maxAttempts: 1 } });
  return { client, state };
}

const hubspotConnection = { name: 'HUBSPOT', kind: 'connection', connection: { integrationId: 'hubspot', status: 'active' }, allowedHosts: ['api.hubapi.com'] };

function manifest(): PackManifest {
  return {
    format: 'anlyon-pack/v1',
    pack: 'acme/crm',
    version: '0.1.0',
    description: 'Test pack.',
    secrets: [
      { name: 'HUBSPOT', kind: 'connection', integrationId: 'hubspot', hosts: ['api.hubapi.com'] },
      { name: 'MAILER', kind: 'static', hosts: ['api.mailer.example'], description: 'Mailer key' },
    ],
    actions: [
      {
        name: 'update-contact',
        description: 'Update a contact.',
        method: 'PATCH',
        urlTemplate: 'https://api.hubapi.com/crm/v3/objects/contacts/{{input.id}}',
        headers: { Authorization: 'Bearer {{secret:HUBSPOT}}' },
        bodyTemplate: { properties: { stage: '{{input.stage}}' } },
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, stage: { type: 'string' } } },
        impact: { dimension: 'resource_mutations', amount: '1', bound: 'exact' },
        verify: { url: 'https://api.hubapi.com/crm/v3/objects/contacts/{{input.id}}', status: 200, match: [{ path: 'properties.stage', equals: '{{input.stage}}' }] },
      },
    ],
    policies: [{ name: 'crm: approve customer', matchKind: 'action', matchActionName: 'update-contact', condition: "input.stage == 'customer'", effect: 'require_approval', enabled: true }],
    limits: [{ name: 'crm: updates per day', dimension: 'resource_mutations', period: 'day', amount: 100, actionName: 'update-contact' }],
  };
}

describe('validatePackManifest', () => {
  it('accepts a valid manifest', () => {
    expect(validatePackManifest(manifest()).pack).toBe('acme/crm');
  });

  it("refuses an action whose host is not among its secret's hosts, before any call", async () => {
    const m = manifest();
    (m.actions[0] as { urlTemplate: string }).urlTemplate = 'https://evil.example/x';
    (m.actions[0] as { verify: { url: string } }).verify.url = 'https://evil.example/x';
    const { client, state } = fakeApi();
    const error = await client.packs.install(m).catch((e) => e);
    expect(error).toBeInstanceOf(PackError);
    expect(error.code).toBe('PACK_INVALID');
    expect(error.message).toMatch(/sends HUBSPOT to evil\.example, which is not one of its hosts/);
    expect(state.calls).toEqual([]);
  });

  it('refuses an auto_approve policy outright', () => {
    const m = manifest();
    (m.policies![0] as { effect: string }).effect = 'auto_approve';
    expect(() => validatePackManifest(m)).toThrow(expect.objectContaining({ code: 'PACK_AUTO_APPROVE_REFUSED' }));
  });

  it('refuses a templated host, a write with no impact, an undeclared secret, a secret outside a header, and customer-owned apps', () => {
    const m = manifest() as unknown as { actions: Record<string, unknown>[]; secrets: Record<string, unknown>[] };
    m.actions[0]!.urlTemplate = 'https://{{input.host}}/x';
    m.actions.push({ name: 'no-impact', description: 'x', method: 'POST', urlTemplate: 'https://api.hubapi.com/x?k={{secret:OTHER}}', inputSchema: {} });
    m.secrets[0]!.needsCustomerApp = true;
    const error = (() => { try { validatePackManifest(m); return undefined; } catch (e) { return e as PackError; } })()!;
    expect(error.problems.join('\n')).toMatch(/fixed host/);
    expect(error.problems.join('\n')).toMatch(/Action no-impact: impact is required; every write declares one/);
    expect(error.problems.join('\n')).toMatch(/\{\{secret:OTHER\}\} is not declared/);
    expect(error.problems.join('\n')).toMatch(/only appear in a header/);
    expect(error.problems.join('\n')).toMatch(/needsCustomerApp is not supported/);
  });

  it('accepts a read with no impact and no read-back, and a write with no read-back', () => {
    const m = manifest();
    m.actions.push(
      { name: 'search-contacts', kind: 'read', description: 'Search contacts. Changes nothing.', method: 'POST', urlTemplate: 'https://api.hubapi.com/crm/v3/objects/contacts/search', headers: { Authorization: 'Bearer {{secret:HUBSPOT}}' }, bodyTemplate: { query: '{{input.query}}', limit: 20 }, inputSchema: { type: 'object' } },
      { name: 'send-note', kind: 'write', description: 'No read-back: the provider has no GET for it.', method: 'POST', urlTemplate: 'https://api.hubapi.com/x', headers: { Authorization: 'Bearer {{secret:HUBSPOT}}' }, inputSchema: { type: 'object' }, impact: { dimension: 'resource_mutations', amount: '1', bound: 'exact' } },
    );
    expect(validatePackManifest(m).actions.map((a) => a.name)).toEqual(['update-contact', 'search-contacts', 'send-note']);
  });

  it('refuses a read that declares an impact or a read-back, writes with its method, or is an adapter', () => {
    const m = manifest() as unknown as { actions: Record<string, unknown>[]; secrets: Record<string, unknown>[] };
    m.secrets.push({ name: 'STRIPE_KEY', kind: 'static', hosts: ['api.stripe.com'] });
    const base = { description: 'x', urlTemplate: 'https://api.hubapi.com/x', headers: { Authorization: 'Bearer {{secret:HUBSPOT}}' }, inputSchema: {} };
    m.actions.push(
      { ...base, name: 'counted', kind: 'read', method: 'GET', impact: { dimension: 'resource_mutations', amount: '1', bound: 'exact' } },
      { ...base, name: 'read-back', kind: 'read', method: 'GET', verify: { url: 'https://api.hubapi.com/x', status: 200, match: [] } },
      { ...base, name: 'deletes', kind: 'read', method: 'DELETE' },
      { ...base, name: 'odd', kind: 'peek', method: 'GET' },
      { name: 'refund', kind: 'read', description: 'x', adapter: { type: 'stripe.refund', config: {}, credentialSecret: 'STRIPE_KEY' } },
    );
    const problems = (() => { try { validatePackManifest(m); return []; } catch (e) { return (e as PackError).problems; } })().join('\n');
    expect(problems).toMatch(/Action counted: a read changes nothing, so it declares no impact/);
    expect(problems).toMatch(/Action read-back: a read has no read-back/);
    expect(problems).toMatch(/Action deletes: a read must be GET, or POST/);
    expect(problems).toMatch(/Action odd: kind must be "read" or "write"/);
    expect(problems).toMatch(/Action refund: an adapter action writes/);
  });

  it('refuses an adapter the installer does not know, and a parameter that is not declared', () => {
    const m = manifest() as unknown as { actions: Record<string, unknown>[]; secrets: Record<string, unknown>[] };
    m.secrets.push({ name: 'STRIPE_KEY', kind: 'static', hosts: ['api.stripe.com'] });
    m.actions.push({ name: 'refund', description: 'x', adapter: { type: 'stripe.refund', config: { account: '{{param:acct}}' }, credentialSecret: 'STRIPE_KEY' } });
    m.actions.push({ name: 'mystery', description: 'x', adapter: { type: 'acme.thing', config: {}, credentialSecret: 'STRIPE_KEY' } });
    const error = (() => { try { validatePackManifest(m); return undefined; } catch (e) { return e as PackError; } })()!;
    expect(error.problems.join('\n')).toMatch(/\{\{param:acct\}\} is not a declared parameter/);
    expect(error.problems.join('\n')).toMatch(/adapter acme\.thing cannot be used/);
  });
});

describe('validatePackManifest: per-account hosts and GraphQL', () => {
  function deskPack(action: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'anlyon-pack/v1',
      pack: 'acme/desk',
      version: '0.1.0',
      description: 'Test pack.',
      secrets: [{ name: 'DESK', kind: 'connection', integrationId: 'desk', hosts: [], accountHost: '{subdomain}.desk.example' }],
      actions: [{
        name: 'list-tickets', kind: 'read', description: 'Lists tickets.', method: 'GET',
        urlTemplate: 'https://{{connection.host}}/api/v2/tickets.json', headers: { Authorization: 'Basic {{connection:desk}}' }, inputSchema: { type: 'object' },
        ...action,
      }],
    };
  }

  it("accepts an action on {{connection.host}} that sends the account's own connection", () => {
    expect(() => validatePackManifest(deskPack())).not.toThrow();
  });

  it('refuses {{connection.host}} for a fixed-host secret, in a header, or partly in the host; and a literal host for a per-account secret', () => {
    const fixed = { ...deskPack(), secrets: [{ name: 'DESK', kind: 'connection', integrationId: 'desk', hosts: ['api.desk.example'] }] };
    expect(() => validatePackManifest(fixed)).toThrow(/not one of its hosts/);
    expect(() => validatePackManifest(deskPack({ headers: { Authorization: 'Basic {{connection:desk}}', 'X-Host': '{{connection.host}}' } }))).toThrow(/only be the URL's host/);
    expect(() => validatePackManifest(deskPack({ urlTemplate: 'https://{{connection.host}}.evil.test/x' }))).toThrow(/fixed host/);
    expect(() => validatePackManifest(deskPack({ urlTemplate: 'https://acme.desk.example/x' }))).toThrow(/not one of its hosts/);
    const bad = (accountHost: string, hosts: string[] = []) => ({ ...deskPack(), secrets: [{ name: 'DESK', kind: 'connection', integrationId: 'desk', hosts, accountHost }] });
    expect(() => validatePackManifest(bad('{subdomain}.com'))).toThrow(/accountHost/);
    expect(() => validatePackManifest(bad('evil.test'))).toThrow(/accountHost/);
    expect(() => validatePackManifest(bad('{subdomain}.desk.example', ['evil.test']))).toThrow(/hosts must be empty/);
  });

  it("refuses a GraphQL read whose query can write or takes a placeholder, and a mutation as a read-back", () => {
    const gql = (query: string, extra: Record<string, unknown> = {}) => deskPack({
      method: 'POST', graphql: true, description: 'Reads issues. Changes nothing.',
      bodyTemplate: { query, variables: { id: '{{input.id}}' } }, ...extra,
    });
    expect(() => validatePackManifest(gql('query($id: ID!) { issue(id: $id) { id } }'))).not.toThrow();
    expect(() => validatePackManifest(gql('mutation { issueDelete(id: "1") { success } }'))).toThrow(/read-only/);
    expect(() => validatePackManifest(gql('query { issue(id: "{{input.id}}") { id } }'))).toThrow(/fixed text/);
    expect(() => validatePackManifest(gql('query { a }', { method: 'GET' }))).toThrow(/POST/);
    const write = deskPack({
      kind: 'write', method: 'POST', graphql: true, description: 'Creates an issue.',
      bodyTemplate: { query: 'mutation($t: String!) { issueCreate(input: { title: $t }) { issue { id } } }', variables: { t: '{{input.title}}' } },
      impact: { dimension: 'resource_mutations', amount: '1', bound: 'exact' },
      verify: { url: 'https://{{connection.host}}/graphql', status: 200, graphql: { query: 'mutation { x }' } },
    });
    expect(() => validatePackManifest(write)).toThrow(/verify\.graphql\.query/);
  });
});

describe('client.packs', () => {
  it('install sends exactly: reads, then secret, action, disabled policy, prefixed names', async () => {
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    const result = await client.packs.install(manifest(), { secrets: { MAILER: 'mlr_value' } });
    expect(state.calls).toEqual([
      'GET /api/v2/secrets/HUBSPOT',
      'GET /api/v2/secrets/MAILER',
      'GET /api/v2/actions/crm-update-contact',
      'PUT /api/v2/secrets/MAILER',
      'POST /api/v2/actions',
      'POST /api/v2/approval-policies',
    ]);
    expect(state.bodies[0]).toEqual({ value: 'mlr_value', description: 'Mailer key', allowedHosts: ['api.mailer.example'], allowedPlacements: ['header'] });
    expect(state.policies[0]).toMatchObject({ name: 'crm: approve customer', matchActionName: 'crm-update-contact', enabled: false, effect: 'require_approval' });
    expect(result.disabledPolicies).toEqual(['crm: approve customer']);
    expect(result.suggestedLimits).toEqual([{ ...manifest().limits![0], actionName: 'crm-update-contact' }]);
    expect(state.limits).toEqual([]);
  });

  it('creates limits only with withLimits, and a second install is a no-op', async () => {
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    await client.packs.install(manifest(), { secrets: { MAILER: 'v' }, withLimits: true });
    expect(state.limits).toEqual([{ name: 'crm: updates per day', dimension: 'resource_mutations', period: 'day', amount: 100, actionName: 'crm-update-contact' }]);
    const writesBefore = state.calls.filter((c) => !c.startsWith('GET')).length;
    const again = await client.packs.install(manifest(), { withLimits: true });
    expect(again.steps.every((s) => s.outcome === 'skip')).toBe(true);
    expect(state.calls.filter((c) => !c.startsWith('GET')).length).toBe(writesBefore);
  });

  it('a missing connected account stops the install with the command, and nothing is written', async () => {
    const { client, state } = fakeApi();
    const error = await client.packs.install(manifest(), { secrets: { MAILER: 'v' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'PACK_CONNECTION_MISSING', command: 'anlyon connections add hubspot --secret HUBSPOT' });
    expect(state.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('a static secret with no value is refused, unless resolveSecret supplies one', async () => {
    const { client } = fakeApi({ secrets: [hubspotConnection] });
    await expect(client.packs.install(manifest())).rejects.toMatchObject({ code: 'PACK_SECRET_VALUE_MISSING' });
    const resolveSecret = vi.fn(async () => 'prompted');
    await client.packs.install(manifest(), { resolveSecret });
    expect(resolveSecret).toHaveBeenCalledWith(expect.objectContaining({ name: 'MAILER' }));
  });

  it('a connected account bound to other hosts, or a static secret where a connection is expected, is refused', async () => {
    const wrongHosts = fakeApi({ secrets: [{ ...hubspotConnection, allowedHosts: ['other.example'] }] });
    await expect(wrongHosts.client.packs.install(manifest(), { secrets: { MAILER: 'v' } })).rejects.toMatchObject({ code: 'PACK_SECRET_MISMATCH' });
    const wrongKind = fakeApi({ secrets: [{ name: 'HUBSPOT', kind: 'static', allowedHosts: null }] });
    await expect(wrongKind.client.packs.install(manifest(), { secrets: { MAILER: 'v' } })).rejects.toMatchObject({ code: 'PACK_SECRET_MISMATCH' });
  });

  it('an account connected with an API key satisfies a pack that needs that integration', async () => {
    const keyed = { name: 'HUBSPOT', kind: 'static', connection: null, integrationId: 'hubspot', allowedHosts: ['api.hubapi.com'] };
    const { client } = fakeApi({ secrets: [keyed] });
    const result = await client.packs.install(manifest(), { secrets: { MAILER: 'v' } });
    expect(result.steps.find((s) => s.name === 'HUBSPOT')).toMatchObject({ outcome: 'skip' });
    const other = fakeApi({ secrets: [{ ...keyed, integrationId: 'github' }] });
    await expect(other.client.packs.install(manifest(), { secrets: { MAILER: 'v' } })).rejects.toMatchObject({ code: 'PACK_SECRET_MISMATCH' });
    const asStatic = manifest();
    asStatic.secrets = asStatic.secrets.map((s) => (s.name === 'HUBSPOT' ? { name: 'HUBSPOT', kind: 'static' as const, hosts: ['api.hubapi.com'] } : s));
    const taken = fakeApi({ secrets: [keyed] });
    await expect(taken.client.packs.install(asStatic, { secrets: { MAILER: 'v', HUBSPOT: 'v' } })).rejects.toMatchObject({ code: 'PACK_SECRET_MISMATCH' });
  });

  it('a different definition is refused without update, and patched with it', async () => {
    const { client, state } = fakeApi({ secrets: [hubspotConnection, { name: 'MAILER', kind: 'static', allowedHosts: ['api.mailer.example'] }], actions: [{ name: 'crm-update-contact', method: 'PUT' }] });
    await expect(client.packs.install(manifest())).rejects.toMatchObject({ code: 'PACK_ACTION_CONFLICT' });
    expect(state.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    const result = await client.packs.install(manifest(), { update: true });
    expect(state.calls).toContain('PATCH /api/v2/actions/crm-update-contact');
    expect(result.steps.find((s) => s.kind === 'action')!.outcome).toBe('updated');
  });

  it('installs a read as a plain action: no impact, no read-back', async () => {
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    const m = manifest();
    m.secrets = [m.secrets[0]!];
    m.actions = [{ name: 'get-contact', kind: 'read', description: 'Get one contact.', method: 'GET', urlTemplate: 'https://api.hubapi.com/crm/v3/objects/contacts/{{input.id}}', headers: { Authorization: 'Bearer {{secret:HUBSPOT}}' }, inputSchema: { type: 'object' } }];
    m.policies = [];
    m.limits = [];
    await client.packs.install(m);
    expect(state.actions).toEqual([{ name: 'crm-get-contact', description: 'Get one contact.', method: 'GET', urlTemplate: 'https://api.hubapi.com/crm/v3/objects/contacts/{{input.id}}', headers: { Authorization: 'Bearer {{secret:HUBSPOT}}' }, inputSchema: { type: 'object' }, requiresApproval: false }]);
  });

  it('noPrefix keeps the manifest names', async () => {
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    await client.packs.install(manifest(), { secrets: { MAILER: 'v' }, noPrefix: true });
    expect(state.actions[0]).toMatchObject({ name: 'update-contact' });
  });

  it('plan reads and sends nothing, and reports a missing connection as a step', async () => {
    const { client, state } = fakeApi();
    const plan = await client.packs.plan(manifest());
    expect(plan.applied).toBe(false);
    expect(state.calls.every((c) => c.startsWith('GET'))).toBe(true);
    expect(plan.steps.map((s) => `${s.kind}:${s.outcome}`)).toEqual(['secret:create', 'secret:create', 'action:create', 'policy:create', 'limit:suggest']);
  });

  it('substitutes parameters, refuses a missing one, and checks enum values', async () => {
    const m = manifest() as unknown as PackManifest & { parameters: unknown[] };
    m.parameters = [{ name: 'stage_field', description: 'Field', enum: ['stage', 'lifecyclestage'] }];
    (m.actions[0] as { bodyTemplate: unknown }).bodyTemplate = { properties: { '{{param:stage_field}}': 'x', v: '{{param:stage_field}}' } };
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    await expect(client.packs.install(m, { secrets: { MAILER: 'v' } })).rejects.toMatchObject({ code: 'PACK_PARAMETER_MISSING' });
    await expect(client.packs.install(m, { secrets: { MAILER: 'v' }, params: { stage_field: 'nope' } })).rejects.toMatchObject({ code: 'PACK_PARAMETER_MISSING' });
    await client.packs.install(m, { secrets: { MAILER: 'v' }, params: { stage_field: 'lifecyclestage' } });
    expect((state.actions[0] as { bodyTemplate: unknown }).bodyTemplate).toEqual({ properties: { '{{param:stage_field}}': 'x', v: 'lifecyclestage' } });
  });
});

describe('action filter, secret renames and references', () => {
  it('install with an action filter creates only those actions, with their policies and limits', async () => {
    const m = manifest() as unknown as { actions: Record<string, unknown>[]; policies: Record<string, unknown>[]; limits: Record<string, unknown>[] };
    m.actions.push({ ...m.actions[0], name: 'other' });
    m.policies.push({ name: 'other policy', matchKind: 'action', matchActionName: 'other', effect: 'require_approval' });
    m.limits.push({ name: 'other limit', dimension: 'resource_mutations', period: 'day', amount: 1, actionName: 'other' });
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    const result = await client.packs.install(m, { actions: ['other'], withLimits: true });
    expect(state.actions.map((a) => a.name)).toEqual(['crm-other']);
    expect(state.policies.map((p) => p.name)).toEqual(['other policy']);
    expect(state.limits.map((l) => l.name)).toEqual(['other limit']);
    expect(result.steps.filter((s) => s.kind === 'secret').map((s) => s.name)).toEqual(['HUBSPOT']);
    await expect(client.packs.install(m, { actions: ['nope'] })).rejects.toMatchObject({ code: 'PACK_INVALID' });
  });

  it('secretNames points the pack at the connected account under its own name', async () => {
    const { client, state } = fakeApi({ secrets: [{ ...hubspotConnection, name: 'HUBSPOT_SALES' }] });
    await client.packs.install(manifest(), { actions: ['update-contact'], secretNames: { HUBSPOT: 'HUBSPOT_SALES' } });
    expect(state.calls[0]).toBe('GET /api/v2/secrets/HUBSPOT_SALES');
    expect((state.actions[0] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer {{secret:HUBSPOT_SALES}}');
    await expect(client.packs.plan(manifest(), { secretNames: { NOPE: 'X' } })).rejects.toMatchObject({ code: 'PACK_INVALID' });
  });

  it('expands a reference to another pack\'s action, and refuses without a resolver', async () => {
    const catalogue = manifest();
    const workflow = { ...manifest(), pack: 'acme/workflow', actions: [{ name: 'qualify', ref: 'acme/crm#update-contact' }], policies: [], limits: [] };
    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    await expect(client.packs.plan(workflow)).rejects.toMatchObject({ code: 'PACK_INVALID' });
    await client.packs.install(workflow, { secrets: { MAILER: 'v' }, resolvePack: (id) => (id === 'acme/crm' ? catalogue : undefined) });
    expect(state.actions[0]).toMatchObject({ name: 'workflow-qualify', method: 'PATCH', urlTemplate: catalogue.actions[0]!.urlTemplate });
    await expect(client.packs.plan({ ...workflow, actions: [{ name: 'x', ref: 'acme/crm#missing' }] }, { resolvePack: () => catalogue }))
      .rejects.toMatchObject({ code: 'PACK_INVALID' });
  });
});

describe('{{connection:<integration>}}: the end user\'s account, or the workspace\'s', () => {
  function perCall(): PackManifest {
    const m = manifest();
    return JSON.parse(JSON.stringify(m).replaceAll('{{secret:HUBSPOT}}', '{{connection:hubspot}}')) as PackManifest;
  }

  it('validates against the connected-account secret declared for the integration', () => {
    expect(validatePackManifest(perCall()).pack).toBe('acme/crm');
    const problems = (m: unknown) => { try { validatePackManifest(m); return ''; } catch (e) { return (e as PackError).problems.join('\n'); } };

    const undeclared = perCall();
    undeclared.secrets = undeclared.secrets.filter((s) => s.name !== 'HUBSPOT');
    expect(problems(undeclared)).toMatch(/\{\{connection:hubspot\}\} needs a secret of kind "connection" with integrationId "hubspot"/);

    const twice = perCall();
    twice.secrets.push({ name: 'HUBSPOT_SALES', kind: 'connection', integrationId: 'hubspot', hosts: ['api.hubapi.com'] });
    expect(problems(twice)).toMatch(/is ambiguous: HUBSPOT and HUBSPOT_SALES/);

    const elsewhere = perCall();
    (elsewhere.actions[0] as { urlTemplate: string }).urlTemplate = 'https://evil.example/x';
    (elsewhere.actions[0] as { verify?: unknown }).verify = undefined;
    expect(problems(elsewhere)).toMatch(/sends the hubspot connection to evil\.example, which is not one of its hosts/);

    const inBody = perCall();
    (inBody.actions[0] as { bodyTemplate: unknown }).bodyTemplate = { token: '{{connection:hubspot}}' };
    expect(problems(inBody)).toMatch(/a secret may only appear in a header/);
  });

  it('installs as it is by default: no workspace account needed, no secret read or written for it', async () => {
    const { client, state } = fakeApi();
    const m = perCall();
    m.secrets = [m.secrets[0]!];
    const result = await client.packs.install(m);
    expect(state.calls).toEqual(['GET /api/v2/actions/crm-update-contact', 'POST /api/v2/actions', 'POST /api/v2/approval-policies']);
    expect((state.actions[0] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer {{connection:hubspot}}');
    expect(result.steps[0]).toMatchObject({ kind: 'connection', name: 'connection:hubspot', outcome: 'skip' });
    expect(result.steps[0]!.detail).toMatch(/the end user's own hubspot account/);

    const again = await client.packs.install(m);
    expect(again.steps.filter((s) => s.kind !== 'limit').every((s) => s.outcome === 'skip')).toBe(true);
  });

  it("credential: 'secret' binds it to the declared workspace secret, which must then exist", async () => {
    const missing = fakeApi();
    await expect(missing.client.packs.install(perCall(), { credential: 'secret', secrets: { MAILER: 'v' } }))
      .rejects.toMatchObject({ code: 'PACK_CONNECTION_MISSING', command: 'anlyon connections add hubspot --secret HUBSPOT' });
    expect(missing.state.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);

    const { client, state } = fakeApi({ secrets: [hubspotConnection] });
    const result = await client.packs.install(perCall(), { credential: 'secret', secrets: { MAILER: 'v' } });
    expect((state.actions[0] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer {{secret:HUBSPOT}}');
    expect(result.steps.map((s) => s.kind)).not.toContain('connection');

    await expect(client.packs.plan(perCall(), { credential: 'vault' as never })).rejects.toMatchObject({ code: 'PACK_INVALID' });
  });

  it('a renamed connected account is used by name', async () => {
    const { client, state } = fakeApi({ secrets: [{ ...hubspotConnection, name: 'HUBSPOT_SALES' }] });
    await client.packs.install(perCall(), { actions: ['update-contact'], secretNames: { HUBSPOT: 'HUBSPOT_SALES' } });
    expect(state.calls[0]).toBe('GET /api/v2/secrets/HUBSPOT_SALES');
    expect((state.actions[0] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer {{secret:HUBSPOT_SALES}}');
  });

  it('an adapter still names its workspace secret: only the actions that use it need it', async () => {
    const m = perCall() as unknown as { secrets: Record<string, unknown>[]; actions: Record<string, unknown>[] };
    m.secrets.push({ name: 'STRIPE', kind: 'connection', integrationId: 'stripe', hosts: ['api.stripe.com'] });
    m.actions.push(
      { name: 'get-balance', kind: 'read', description: 'Read the balance.', method: 'GET', urlTemplate: 'https://api.stripe.com/v1/balance', headers: { Authorization: 'Bearer {{connection:stripe}}' }, inputSchema: { type: 'object' } },
      { name: 'refund', description: 'Refund.', adapter: { type: 'stripe.refund', config: {}, credentialSecret: 'STRIPE' } },
    );
    const reads = fakeApi();
    const result = await reads.client.packs.install(m, { actions: ['get-balance'] });
    expect(result.steps.map((s) => `${s.kind}:${s.name}`)).toEqual(['connection:connection:stripe', 'action:crm-get-balance']);

    const refund = fakeApi();
    await expect(refund.client.packs.install(m, { actions: ['refund'] })).rejects.toMatchObject({ code: 'PACK_CONNECTION_MISSING', command: 'anlyon connections add stripe --secret STRIPE' });
  });

  it('a filter keeps the connected-account secret a kept action uses', async () => {
    const { client } = fakeApi();
    const plan = await client.packs.plan(perCall(), { actions: ['update-contact'] });
    expect(plan.steps.map((s) => `${s.kind}:${s.name}:${s.outcome}`)).toEqual([
      'connection:connection:hubspot:skip', 'action:crm-update-contact:create', 'policy:crm: approve customer:create', 'limit:crm: updates per day:suggest',
    ]);
  });
});
