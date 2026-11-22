import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { CAPABILITIES, DEFAULT_LOGIN_SCOPES } from '../src/capabilities';
import { COMMANDS } from '../src/commands';
import { startFakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, tempDir } from './helpers';

const SERVER = new URL('../../../../server/src/core/auth/', import.meta.url).href;
const { ALL_API_KEY_SCOPES } = (await import(/* @vite-ignore */ `${SERVER}api-key-scopes.ts`)) as { ALL_API_KEY_SCOPES: readonly string[] };
const { ALL_OAUTH_SCOPES, OAUTH_SCOPE_GROUPS } = (await import(/* @vite-ignore */ `${SERVER}oauth-scopes.ts`)) as {
  ALL_OAUTH_SCOPES: string[];
  OAUTH_SCOPE_GROUPS: Record<string, { sensitive: boolean; scopes: readonly string[] }>;
};

const SCHEDULER = new URL('../../../../server/', import.meta.url);
const EXTENSIONS = new URL('src/extensions/', SCHEDULER);
const shares = existsSync(EXTENSIONS)
  ? readdirSync(EXTENSIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/openapi.yaml`, EXTENSIONS)))
      .map((d) => readFileSync(new URL(`${d.name}/openapi.yaml`, EXTENSIONS), 'utf8'))
  : [];
const openapi = [readFileSync(new URL('openapi.yaml', SCHEDULER), 'utf8'), ...shares].join('\n');
const HOSTED_ONLY = new Set(['POST /api/v2/billing/checkout']);
const mayBeAbsent = (entry: string) => shares.length === 0 && HOSTED_ONLY.has(entry);

describe('capability table matches the server', () => {
  it('every scope a command needs is one the API enforces', () => {
    for (const capability of CAPABILITIES) {
      if (capability.scope) expect(ALL_API_KEY_SCOPES, capability.command).toContain(capability.scope);
    }
  });

  it('oauthGroup is exactly the consent group that grants the scope, or null if none does', () => {
    for (const capability of CAPABILITIES.filter((c) => c.scope)) {
      const groups = Object.entries(OAUTH_SCOPE_GROUPS)
        .filter(([, group]) => group.scopes.includes(capability.scope!))
        .map(([name]) => name);
      expect(groups.length, capability.command).toBeLessThanOrEqual(1);
      expect(capability.oauthGroup, capability.command).toBe(groups[0] ?? null);
    }
  });

  it('default login asks only for scopes the server issues, and nothing sensitive', () => {
    for (const scope of DEFAULT_LOGIN_SCOPES) expect(ALL_OAUTH_SCOPES).toContain(scope);
    for (const scope of DEFAULT_LOGIN_SCOPES) {
      const group = OAUTH_SCOPE_GROUPS[scope];
      if (group) expect(group.sensitive, scope).toBe(false);
    }
  });

  it('every read command has a capability entry', () => {
    const readCommands = COMMANDS.filter((c) => !['auth', 'profile', 'whoami', 'doctor', 'self-host'].includes(c.path[0]!)).map((c) => c.path.join(' '));
    expect(readCommands.sort()).toEqual(CAPABILITIES.map((c) => c.command).sort());
  });
});

describe('SDK calls hit endpoints that exist on this API', () => {
  it('each method and path the CLI requests exists in server/openapi.yaml', async () => {
    const server = await startFakeAnlyon({
      apiKeys: { anlyon_test_xxxcompat0000000000000: { scopes: ['actions:read', 'actions:write', 'actions:invoke', 'runs:read', 'approvals:read', 'approvals:decide', 'policies:read', 'impact-limits:read'] } },
    });
    const dir = await tempDir();
    try {
      const h = harness(dir.path, { ANLYON_API_KEY: 'anlyon_test_xxxcompat0000000000000', ANLYON_API_URL: server.origin });
      const argvs = [
        ['actions', 'list'], ['actions', 'get', 'send-email'], ['actions', 'versions', 'send-email'],
        ['invocations', 'list'], ['invocations', 'get', 'inv_1'],
        ['runs', 'list'], ['runs', 'get', 'run_1'],
        ['approvals', 'list'], ['approvals', 'get', 'apr_1'],
        ['policies', 'list'], ['policies', 'get', 'pol_1'], ['policies', 'versions', 'pol_1'],
        ['effects', 'list', '--grade', 'confirmed'], ['effects', 'get', 'eff_1'],
        ['impact-limits', 'list'], ['impact-limits', 'get', 'lim_1'],
      ];
      for (const argv of argvs) await h.run([...argv, '--json']);
      await h.run(['actions', 'invoke', 'gated_a', '--yes', '--json']);
      await h.run(['actions', 'invoke', 'gated_b', '--yes', '--json']);
      const [first, second] = [...server.state.approvals.keys()];
      await h.run(['approvals', 'approve', first!, '--yes', '--json']);
      await h.run(['approvals', 'deny', second!, '--yes', '--json']);
      await h.run(['actions', 'declare', 'action-0', '--governed', '--yes', '--json']);
      const templates = (path: string) =>
        path
          .replace(/^\/api\/v2\/actions\/invocations\/[^/]+$/, '/api/v2/actions/invocations/{id}')
          .replace(/^\/api\/v2\/actions\/effects\/[^/]+$/, '/api/v2/actions/effects/{id}')
          .replace(/^\/api\/v2\/impact-limits\/[^/]+$/, '/api/v2/impact-limits/{id}')
          .replace(/^\/api\/v2\/actions\/[^/]+\/invoke$/, '/api/v2/actions/{ref}/invoke')
          .replace(/^\/api\/v2\/approvals\/[^/]+\/(approve|deny)$/, '/api/v2/approvals/{id}/$1')
          .replace(/^\/api\/v2\/actions\/(?!invocations$|effects$)[^/]+\/versions$/, '/api/v2/actions/{ref}/versions')
          .replace(/^\/api\/v2\/actions\/(?!invocations$|effects$)[^/]+$/, '/api/v2/actions/{ref}')
          .replace(/^\/api\/v2\/runs\/[^/]+$/, '/api/v2/runs/{runId}')
          .replace(/^\/api\/v2\/approvals\/[^/]+$/, '/api/v2/approvals/{id}')
          .replace(/^\/api\/v2\/approval-policies\/[^/]+\/versions$/, '/api/v2/approval-policies/{policyId}/versions')
          .replace(/^\/api\/v2\/approval-policies\/[^/]+$/, '/api/v2/approval-policies/{policyId}');
      const requested = [...new Set(server.state.requests.filter((r) => r.path.startsWith('/api/v2/')).map((r) => `${r.method} ${templates(r.path)}`))];
      expect(requested).toEqual(expect.arrayContaining(['PATCH /api/v2/actions/{ref}', 'POST /api/v2/actions/{ref}/invoke', 'POST /api/v2/approvals/{id}/approve', 'POST /api/v2/approvals/{id}/deny']));
      expect(requested.length).toBeGreaterThanOrEqual(15);
      for (const entry of requested) {
        const [method, path] = entry.split(' ');
        const block = openapi.split(`\n  ${path}:\n`)[1];
        expect(block, `${path} missing from openapi.yaml`).toBeDefined();
        expect(block!.split(/\n  \/api/)[0], `${path} has no ${method}`).toMatch(new RegExp(`\\n    ${method!.toLowerCase()}:`));
      }
    } finally {
      await server.close();
      await dir.cleanup();
    }
  });

  it('init, plan, apply, pull and billing request only endpoints in server/openapi.yaml', async () => {
    const key = 'anlyon_test_xxxcompatcfg00000000000';
    const server = await startFakeAnlyon({
      actions: [{ id: 'act_0', name: 'action-0', method: 'POST', urlTemplate: 'https://a.example', enabled: true }],
      apiKeys: { [key]: { scopes: ['actions:read', 'actions:write', 'secrets:read', 'policies:read', 'policies:write', 'impact-limits:read', 'impact-limits:write', 'budgets:read', 'budgets:write', 'billing:read'] } },
      impactLimits: [{ id: 'lim_1', name: 'Old', dimension: 'emails', currency: null, unit: 'emails', scope: { environmentId: 'x', actionName: null, resourcePrefix: null, kind: 'environment' }, period: 'day', limit: 5, archived: false }],
    });
    const config = await tempDir();
    const project = await tempDir();
    try {
      const person = harness(config.path);
      expect((await person.run(['init', '--yes', '--api-url', server.origin, '--mcp', 'none', '--no-install'], { cwd: project.path })).code).toBe(0);
      expect((await person.run(['billing', 'status'])).code).toBe(0);
      expect((await person.run(['billing', 'upgrade', '--plan', 'starter', '--no-browser'])).code).toBe(0);
      const ci = harness(config.path, { ANLYON_API_KEY: key, ANLYON_API_URL: server.origin });
      const keyId = '55555555-5555-4555-8555-555555555555';
      await writeFile(join(project.path, 'anlyon.yaml'), [
        'version: 1',
        'environments:',
        '  production:',
        '    secrets: [X]',
        '    actions:',
        "      action-0: { url: 'https://a.example', description: changed }",
        '      a: { url: https://a.example }',
        '    policies:',
        '      p: { name: P, target: { action: a } }',
        '    limits:',
        '      New: { dimension: emails, amount: 1, period: day }',
        '      Old: null',
        '    budgets:',
        `      ${keyId}: { monthlyCostCentsCap: 10 }`,
        '',
      ].join('\n'));
      for (const argv of [['plan'], ['apply', '--yes'], ['pull', '--yes']]) { const r = await ci.run(argv, { cwd: project.path }); expect(r.code, `${argv.join(' ')}: ${r.stderr}`).toBe(0); }
      const templates = (path: string) =>
        path
          .replace(/^\/api\/v2\/actions\/invocations\/[^/]+$/, '/api/v2/actions/invocations/{id}')
          .replace(/^\/api\/v2\/actions\/[^/]+\/invoke$/, '/api/v2/actions/{ref}/invoke')
          .replace(/^\/api\/v2\/actions\/(?!invocations$|effects$)[^/]+$/, '/api/v2/actions/{ref}')
          .replace(/^\/api\/v2\/impact-limits\/[^/]+$/, '/api/v2/impact-limits/{id}')
          .replace(/^\/api\/v2\/budgets\/[^/]+$/, '/api/v2/budgets/{apiKeyId}')
          .replace(/^\/api\/v2\/approval-policies\/(?!files$)[^/]+$/, '/api/v2/approval-policies/{policyId}');
      const requested = [...new Set(server.state.requests.filter((r) => r.path.startsWith('/api/v2/')).map((r) => `${r.method} ${templates(r.path)}`))];
      expect(requested).toEqual(expect.arrayContaining([
        'POST /api/v2/api-keys', 'POST /api/v2/approval-policies/files/plan', 'POST /api/v2/approval-policies/files/apply',
        'PATCH /api/v2/actions/{ref}', 'POST /api/v2/impact-limits', 'DELETE /api/v2/impact-limits/{id}', 'PUT /api/v2/budgets/{apiKeyId}',
        'GET /api/v2/billing/plan', 'POST /api/v2/billing/checkout',
      ]));
      for (const entry of requested) {
        if (mayBeAbsent(entry)) continue;
        const [method, path] = entry.split(' ');
        const block = openapi.split(`\n  ${path}:\n`)[1];
        expect(block, `${path} missing from openapi.yaml`).toBeDefined();
        expect(`\n${block!.split(/\n  \/api/)[0]}`, `${path} has no ${method}`).toMatch(new RegExp(`\\n    ${method!.toLowerCase()}:`));
      }
    } finally {
      await server.close();
      await config.cleanup();
      await project.cleanup();
    }
  });

  it('the governed-effects resources the CLI reads are in this API contract', () => {
    expect(openapi).toMatch(/\n  \/api\/v2\/impact-limits/);
    expect(openapi).toMatch(/\n  \/api\/v2\/actions\/effects/);
  });
});
