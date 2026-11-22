import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { EXIT } from '../src/exit-codes';
import { parseConfig } from '../src/config-file/model';
import { clearRegisteredSecrets } from '../src/redact';
import { startFakeAnlyon, type FakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const KEY = 'anlyon_test_xxxconfigascode0000000';
const KEY_ID = '44444444-4444-4444-8444-444444444444';
const SCOPES = ['actions:read', 'actions:write', 'actions:invoke', 'secrets:read', 'policies:read', 'policies:write', 'impact-limits:read', 'impact-limits:write', 'budgets:read', 'budgets:write'];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

const limit = (id: string, name: string, amount: number) => ({ id, name, dimension: 'emails', currency: null, unit: 'emails', scope: { environmentId: 'x', actionName: null, resourcePrefix: null, kind: 'environment' }, period: 'day', limit: amount, archived: false });

async function setup(options: Parameters<typeof startFakeAnlyon>[0] = {}): Promise<{ server: FakeAnlyon; h: Harness; project: string; run: (argv: string[]) => ReturnType<Harness['run']> }> {
  const server = await startFakeAnlyon({
    apiKeys: { [KEY]: { scopes: SCOPES } },
    actions: [{ id: 'act_1', name: 'send-receipt', method: 'POST', urlTemplate: 'https://api.postmark.example/email', enabled: true, requiresApproval: false, secrets: ['POSTMARK'] }],
    impactLimits: [limit('lim_1', 'Emails per day', 500), limit('lim_2', 'Old limit', 10)],
    secrets: [{ id: 'sec_p', name: 'POSTMARK' }],
    ...options,
  });
  cleanups.push(server.close);
  const config = await tempDir();
  const project = await tempDir();
  cleanups.push(config.cleanup, project.cleanup);
  const h = harness(config.path, { ANLYON_API_KEY: KEY, ANLYON_API_URL: server.origin });
  return { server, h, project: project.path, run: (argv) => h.run(argv, { cwd: project.path }) };
}

const FILE = `version: 1
environments:
  production:
    secrets: [POSTMARK, SLACK]
    actions:
      send-receipt:
        description: Email a receipt
        method: POST
        url: https://api.postmark.example/email
        headers: { X-Postmark-Server-Token: "{{secret:POSTMARK}}" }
        requiresApproval: true
    policies:
      big-refunds:
        name: Big refunds need two approvers
        target: { action: refund }
        when: input.amount >= 50000
        approvals: 2
    limits:
      Emails per day: { dimension: emails, amount: 200, period: day }
      Old limit: null
    budgets:
      ${KEY_ID}: { monthlyCostCentsCap: 5000 }
`;

describe('anlyon.yaml', () => {
  it('refuses a credential in the file, naming where it is', () => {
    expect(() => parseConfig('version: 1\nenvironments:\n  production:\n    actions:\n      x:\n        url: https://a.example\n        headers: { Authorization: "Bearer sk_live_xxxxxxxxxxxxxxxxxxxxxxxx" }\n')).toThrow(/headers\.Authorization: carries a credential in the clear/);
    expect(() => parseConfig('version: 1\nenvironments:\n  production:\n    actions:\n      x:\n        url: https://a.example\n        body: { token: ghp_abcdefghijklmnopqrstuvwxyz0123 }\n')).toThrow(/body\.token: looks like a credential/);
    expect(() => parseConfig('version: 1\nenvironments:\n  production:\n    secrets: [lowercase]\n')).toThrow(/secret names/);
    expect(parseConfig(FILE).environments.production!.actions!['send-receipt']!.headers).toEqual({ 'X-Postmark-Server-Token': '{{secret:POSTMARK}}' });
  });

  it('reports every problem at once, with where it is', () => {
    expect(() => parseConfig('version: 2\nenvironments:\n  production:\n    limits:\n      a: { dimension: emails, amount: -1, period: week }\n    nonsense: true\n')).toThrow(/4 problems/);
  });
});

describe('anlyon.yaml mcp section', () => {
  const file = (body: string) => `version: 1\nenvironments:\n  production:\n    mcp:\n${body}`;

  it('refuses a credential, a bad name and an unknown field', () => {
    expect(() => parseConfig(file('      tracker:\n        url: https://a.example/mcp\n        headers: { Authorization: "Bearer abc" }\n'))).toThrow(/carries a credential in the clear/);
    expect(() => parseConfig(file('      Not_Valid: { url: "https://a.example/mcp" }\n'))).toThrow(/a server name is/);
    expect(() => parseConfig(file('      tracker: { url: "http://a.example/mcp" }\n'))).toThrow(/https/);
    expect(() => parseConfig(file('      tracker:\n        url: https://a.example/mcp\n        adopt: { x: { enabled: true } }\n'))).toThrow(/unknown field "enabled"/);
    expect(() => parseConfig(file('      tracker:\n        url: https://a.example/mcp\n        oauth: { clientSecret: abc }\n'))).toThrow(/reference to a stored secret/);
  });

  const SERVER = file(`      tracker:
        url: https://mcp.tracker.example/mcp
        adopt:
          list_issues:
          delete_issue: { description: Delete an issue }
`);

  it('plans registering as neutral and adopting as loosening, and sends no write', async () => {
    const { server, project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), SERVER);
    const result = await run(['plan', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const by = Object.fromEntries(JSON.parse(result.stdout).data.changes.map((c: { key: string }) => [c.key, c]));
    expect(by.tracker).toMatchObject({ section: 'mcp', op: 'create', direction: 'neutral' });
    expect(by['tracker/list_issues']).toMatchObject({ op: 'create', direction: 'loosening' });
    expect(server.state.mcpUpstreams).toEqual([]);
  });

  it('apply registers the server, then asks once for its tools: a person signs that off', async () => {
    const { server, project, run } = await setup({ signOff: true });
    await writeFile(join(project, 'anlyon.yaml'), SERVER);
    const result = await run(['apply', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
    expect(server.state.mcpUpstreams[0]).toMatchObject({ name: 'tracker', adopted: [] });
    expect(server.state.lastMcpAdoption).toEqual({ tools: { list_issues: { requiresApproval: false }, delete_issue: { requiresApproval: true, description: 'Delete an issue' } } });
    const pending = server.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/adopt'));
    expect(pending).toHaveLength(1);
  });

  it('adopted and unchanged plans clean; a changed tool needs adopting again; a stated approval is applied', async () => {
    const { server, project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), SERVER);
    expect((await run(['apply', '--yes', '--json'])).code).toBe(EXIT.OK);
    expect(JSON.parse((await run(['plan', '--json'])).stdout).data.changes).toEqual([]);

    await writeFile(join(project, 'anlyon.yaml'), SERVER.replace('list_issues:', 'list_issues: { requiresApproval: true }'));
    const tighter = JSON.parse((await run(['plan', '--json'])).stdout).data.changes;
    expect(tighter).toMatchObject([{ key: 'tracker/list_issues', op: 'update', direction: 'tightening', fields: ['requiresApproval'] }]);
    expect((await run(['apply', '--yes', '--json'])).code).toBe(EXIT.OK);
    expect(server.state.actions.find((a) => a.name === 'tracker-list_issues')).toMatchObject({ requiresApproval: true });
    server.state.mcpUpstreams[0].adopted.find((entry: { tool: string }) => entry.tool === 'list_issues').requiresApproval = true;

    server.state.mcpUpstreams[0].adopted.find((entry: { tool: string }) => entry.tool === 'delete_issue').state = 'changed';
    const changed = JSON.parse((await run(['plan', '--json'])).stdout).data.changes;
    expect(changed).toMatchObject([{ key: 'tracker/delete_issue', op: 'update', direction: 'loosening' }]);
    expect(changed[0].reason).toContain('signs off adopting it again');
  });

  it('a tool the server does not list, and a url that cannot change, say so', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), SERVER);
    await run(['apply', '--yes', '--json']);
    await writeFile(join(project, 'anlyon.yaml'), SERVER.replace('list_issues:', 'no_such_tool:'));
    const missing = JSON.parse((await run(['plan', '--json'])).stdout).data.changes;
    expect(missing).toMatchObject([{ key: 'tracker/no_such_tool', op: 'missing', direction: 'needs-person' }]);
    await writeFile(join(project, 'anlyon.yaml'), SERVER.replace('mcp.tracker.example', 'elsewhere.example'));
    const moved = await run(['plan']);
    expect(moved.code).toBe(EXIT.REJECTED);
    expect(moved.stdout).toContain('neither can change');
  });

  it('null archives the server at once', async () => {
    const { server, project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), SERVER);
    await run(['apply', '--yes', '--json']);
    await writeFile(join(project, 'anlyon.yaml'), file('      tracker: null\n'));
    const result = await run(['apply', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(server.state.mcpUpstreams[0].archivedAt).toBeTruthy();
  });

  it('pull writes adopted tools under mcp, not as actions, and that plans clean', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), SERVER);
    await run(['apply', '--yes', '--json']);
    expect((await run(['pull', '--yes'])).code).toBe(EXIT.OK);
    const written = parse(await readFile(join(project, 'anlyon.yaml'), 'utf8')).environments.production;
    expect(Object.keys(written.actions)).toEqual(['send-receipt']);
    expect(written.mcp.tracker).toEqual({ url: 'https://mcp.tracker.example/mcp', adopt: { delete_issue: { requiresApproval: true }, list_issues: { requiresApproval: false } } });
    expect(JSON.parse((await run(['plan', '--json'])).stdout).data.changes.filter((c: { section: string }) => c.section === 'mcp')).toEqual([]);
  });
});

describe('anlyon plan', () => {
  it('marks each change tightening or loosening, and sends no write', async () => {
    const { server, project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), FILE);
    const result = await run(['plan', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    const plan = JSON.parse(result.stdout).data;
    const by = Object.fromEntries(plan.changes.map((c: { section: string; key: string }) => [`${c.section}.${c.key}`, c]));
    expect(by['secrets.SLACK']).toMatchObject({ op: 'missing', direction: 'needs-person' });
    expect(by['actions.send-receipt']).toMatchObject({ op: 'update', direction: 'loosening', fields: ['description', 'headers', 'requiresApproval'] });
    expect(by['actions.send-receipt'].reason).toContain('requires approval');
    expect(by['policies.big-refunds']).toMatchObject({ op: 'create', direction: 'tightening' });
    expect(by['limits.Emails per day']).toMatchObject({ op: 'update', direction: 'tightening', reason: 'lowers the limit from 500 to 200' });
    expect(by['limits.Old limit']).toMatchObject({ op: 'delete', direction: 'loosening' });
    expect(by['budgets.' + KEY_ID]).toMatchObject({ op: 'create', direction: 'tightening' });
    expect(plan.summary.unchanged).toBe(1);
    expect(server.state.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/files/plan'))).toEqual([]);
  });

  it('prints a Markdown table for a pull-request comment', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), FILE);
    const result = await run(['plan', '--markdown']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain('### anlyon plan: `production`');
    expect(result.stdout).toContain('| - | `limits.Old limit` | **loosening** |');
  });

  it('says which environments the file has when this credential is bound to another', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), 'version: 1\nenvironments:\n  staging: {}\n');
    const result = await run(['plan']);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toContain('It declares: staging');
  });

  it('a 403 points at the guardrails consent group', async () => {
    const { project, h } = await setup({ apiKeys: { [KEY]: { scopes: ['actions:read'] } } });
    await writeFile(join(project, 'anlyon.yaml'), 'version: 1\nenvironments:\n  production:\n    policies: {}\n');
    const result = await h.run(['plan'], { cwd: project });
    expect(result.code).toBe(EXIT.PERMISSION_DENIED);
    expect(result.stderr).toContain('anlyon auth login --scope anlyon:guardrails');
  });
});

describe('anlyon apply', () => {
  it('applies everything a person may apply, then plans clean', async () => {
    const { server, project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), FILE);
    const result = await run(['apply', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(server.state.impactLimits.find((l) => l.name === 'Emails per day')).toMatchObject({ limit: 200 });
    expect(server.state.impactLimits.find((l) => l.name === 'Old limit')).toMatchObject({ archived: true });
    expect(server.state.actions.find((a) => a.name === 'send-receipt')).toMatchObject({ requiresApproval: true, description: 'Email a receipt' });
    expect([...server.state.filePolicies.values()].map((p) => p.key)).toEqual(['big-refunds']);
    expect(server.state.budgets).toEqual([expect.objectContaining({ apiKeyId: KEY_ID, monthlyCostCentsCap: 5000 })]);
    const again = JSON.parse((await run(['plan', '--json'])).stdout).data;
    expect(again.changes.map((c: { section: string; key: string }) => `${c.section}.${c.key}`)).toEqual(['secrets.SLACK']);
  });

  it('applies tightening at once and leaves each loosening change waiting on a sign-off link (exit 15)', async () => {
    const { server, project, run } = await setup({ signOff: true, holdSignOffs: true });
    await writeFile(join(project, 'anlyon.yaml'), FILE);
    const result = await run(['apply', '--yes']);
    expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
    expect(server.state.impactLimits.find((l) => l.name === 'Emails per day')).toMatchObject({ limit: 200 });
    expect([...server.state.filePolicies.values()].map((p) => p.key)).toEqual(['big-refunds']);
    expect(server.state.impactLimits.find((l) => l.name === 'Old limit')!.archived).toBe(false);
    const requests = [...server.state.gateSignOffs.values()];
    expect(requests.map((r) => r.operation)).toEqual(['impact_limit.archive']);
    expect(result.stderr).toContain(requests[0]!.signOffUrl);
    expect(result.stdout).toContain('wait for a person');
  });

  it('a tightening policy is not held back by a loosening one in the same file', async () => {
    const { server, project, run } = await setup({ signOff: true, holdSignOffs: true });
    const policies = (two: string) => `version: 1\nenvironments:\n  production:\n    policies:\n${two}`;
    await writeFile(join(project, 'anlyon.yaml'), policies('      gate:\n        name: Gate refunds\n        target: { action: refund }\n      old:\n        name: Old gate\n        target: { action: payout }\n'));
    expect((await run(['apply', '--yes'])).code).toBe(EXIT.OK);
    await writeFile(join(project, 'anlyon.yaml'), policies('      gate:\n        name: Gate refunds\n        target: { action: refund }\n      deny:\n        name: Never delete repos\n        target: { action: delete-repo }\n        effect: auto_deny\n'));
    const result = await run(['apply', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
    expect([...server.state.filePolicies.values()].map((p) => p.key).sort()).toEqual(['deny', 'gate', 'old']);
    expect([...server.state.gateSignOffs.values()].map((r) => r.operation)).toEqual(['policy_file.apply']);
  });

  it('with --wait, follows the sign-offs until a person approves them', async () => {
    const { server, project, h } = await setup({ signOff: true });
    await writeFile(join(project, 'anlyon.yaml'), 'version: 1\nenvironments:\n  production:\n    limits:\n      Old limit: null\n');
    const admin = (async () => {
      while (!server.state.gateSignOffs.size) await new Promise((r) => setTimeout(r, 20));
      await fetch([...server.state.gateSignOffs.values()][0]!.signOffUrl);
    })();
    const result = await h.run(['apply', '--yes', '--wait', '1m'], { cwd: project });
    await admin;
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.browserUrls).toEqual([]);
    expect(server.state.impactLimits.find((l) => l.name === 'Old limit')).toMatchObject({ archived: true });
  });

  it('needs --yes in CI, and does nothing without it', async () => {
    const { server, project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), FILE);
    expect((await run(['apply'])).code).toBe(EXIT.USAGE);
    expect(server.state.impactLimits.find((l) => l.name === 'Emails per day')).toMatchObject({ limit: 500 });
  });
});

describe('anlyon pull', () => {
  it('writes the live environment, keeping other environments and comments, and secret names only', async () => {
    const { project, run, server } = await setup({ budgets: [{ apiKeyId: KEY_ID, monthlyCostCentsCap: 900, dimensionCaps: { actionInvokes: 100 }, alertThreshold: 0.8, enabled: true }] });
    await writeFile(join(project, 'anlyon.yaml'), '# our guardrails\r\nversion: 1\r\nenvironments:\r\n  staging: # keep me\r\n    secrets: [STAGING_ONLY]\r\n');
    const result = await run(['pull', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout).data).toMatchObject({ actions: 1, limits: 2, budgets: 1, secrets: 1 });
    const text = await readFile(join(project, 'anlyon.yaml'), 'utf8');
    expect(text).toContain('# our guardrails');
    expect(text).toContain('# keep me');
    expect(text).toContain('\r\n');
    const parsed = parse(text);
    expect(parsed.environments.staging.secrets).toEqual(['STAGING_ONLY']);
    expect(parsed.environments.production.secrets).toEqual(['POSTMARK']);
    expect(parsed.environments.production.actions['send-receipt']).toEqual({ url: 'https://api.postmark.example/email', method: 'POST' });
    expect(parsed.environments.production.limits['Emails per day']).toEqual({ dimension: 'emails', amount: 500, period: 'day' });
    expect(parsed.environments.production.budgets[KEY_ID]).toMatchObject({ monthlyCostCentsCap: 900, dimensionCaps: { actionInvokes: 100 } });
    const plan = JSON.parse((await run(['plan', '--json'])).stdout).data;
    expect(plan.changes).toEqual([]);
    expect(server.state.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/files/plan'))).toEqual([]);
  });

  it('writes policies the file owns and creates the file when there is none', async () => {
    const { project, run } = await setup();
    await writeFile(join(project, 'anlyon.yaml'), 'version: 1\nenvironments:\n  production:\n    policies:\n      gate:\n        name: Gate refunds\n        target: { action: refund }\n        approvals: 2\n');
    expect((await run(['apply', '--yes'])).code).toBe(EXIT.OK);
    await writeFile(join(project, 'anlyon.yaml'), '');
    expect((await run(['pull', '--yes'])).code).toBe(EXIT.OK);
    const parsed = parse(await readFile(join(project, 'anlyon.yaml'), 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.environments.production.policies.gate).toMatchObject({ name: 'Gate refunds', target: { action: 'refund' }, approvals: 2 });
  });
});
