import { afterEach, describe, expect, it } from 'vitest';
import { nameFromUrl, parseHeader } from '../src/commands/mcp';
import { EXIT } from '../src/exit-codes';
import { clearRegisteredSecrets } from '../src/redact';
import { startFakeAnlyon } from './fixtures/fake-anlyon.mjs';
import { harness, tempDir, type Harness } from './helpers';

const BUILDER = 'anlyon_test_xxxbuilder00000000000';
const URL_ = 'https://mcp.tracker.example/mcp';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearRegisteredSecrets();
  while (cleanups.length) await cleanups.pop()!();
});

type FakeOptions = NonNullable<Parameters<typeof startFakeAnlyon>[0]>;

async function setup(options: Partial<FakeOptions> = {}) {
  const server = await startFakeAnlyon({
    apiKeys: { [BUILDER]: { scopes: ['actions:read', 'actions:write', 'secrets:read'] } },
    ...options,
  });
  cleanups.push(server.close);
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  const h: Harness = harness(dir.path, { ANLYON_API_KEY: BUILDER, ANLYON_API_URL: server.origin });
  return { server, h };
}

describe('anlyon mcp add', () => {
  it('registers a server, names it from the host, lists its tools and adopts nothing', async () => {
    const { server, h } = await setup();
    const result = await h.run(['mcp', 'add', URL_, '--header', 'Authorization: Bearer {{secret:TRACKER}}']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout).toContain('Registered tracker: 2 tools listed, none adopted.');
    expect(result.stdout).toContain('delete_issue');
    expect(result.stdout).toContain('destructive');
    expect(result.stderr).toContain('anlyon mcp adopt tracker <tool...>');
    const [upstream] = server.state.mcpUpstreams;
    expect(upstream).toMatchObject({ name: 'tracker', url: URL_, headers: { Authorization: 'Bearer {{secret:TRACKER}}' }, adopted: [] });
  });

  it('takes --name, and refuses a bad one or a bad header before anything is sent', async () => {
    const { server, h } = await setup();
    expect((await h.run(['mcp', 'add', URL_, '--name', 'Not Valid'])).code).toBe(EXIT.USAGE);
    expect((await h.run(['mcp', 'add', URL_, '--header', 'no colon here'])).code).toBe(EXIT.USAGE);
    expect((await h.run(['mcp', 'add', URL_, '--client-id', 'abc'])).code).toBe(EXIT.USAGE);
    expect(server.state.requests.filter((r: { path: string }) => r.path.includes('mcp-upstreams'))).toEqual([]);
    expect((await h.run(['mcp', 'add', URL_, '--name', 'other'])).code).toBe(EXIT.OK);
    expect(server.state.mcpUpstreams[0].name).toBe('other');
  });

  it('with --oauth sends the OAuth settings, and a sign-off comes back as exit 15 with the link', async () => {
    const { server, h } = await setup({ signOff: true });
    const result = await h.run(['mcp', 'add', URL_, '--oauth', '--client-id', 'abc', '--scope', 'read', '--scope', 'write']);
    expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
    expect(result.stderr).toMatch(/\/sign-offs\/sor_/);
    expect(result.stderr).toContain('neither can any API key or CLI login');
    expect(server.state.mcpUpstreams).toEqual([]);
    expect(server.state.lastMcpRegistration).toMatchObject({ oauth: { clientId: 'abc', scopes: ['read', 'write'] } });
  });

  it('reports a credential without secrets:read with the fix the API gives', async () => {
    const { h } = await setup({ apiKeys: { [BUILDER]: { scopes: ['actions:read', 'actions:write'] } } });
    const result = await h.run(['mcp', 'add', URL_, '--header', 'Authorization: Bearer {{secret:TRACKER}}', '--json']);
    expect(result.code).toBe(EXIT.PERMISSION_DENIED);
    expect(JSON.parse(result.stderr).error).toMatchObject({ fix: { summary: expect.stringContaining('secrets:read') } });
  });
});

describe('anlyon mcp list and tools', () => {
  it('lists servers, and the tools of one by name', async () => {
    const { h } = await setup();
    expect((await h.run(['mcp', 'list'])).stderr).toContain('anlyon mcp add <url>');
    await h.run(['mcp', 'add', URL_]);
    const listed = await h.run(['mcp', 'list', '--json']);
    expect(JSON.parse(listed.stdout).data).toMatchObject([{ name: 'tracker', url: URL_ }]);
    const tools = await h.run(['mcp', 'tools', 'tracker']);
    expect(tools.code, tools.stderr).toBe(EXIT.OK);
    expect(tools.stdout).toContain('list_issues');
    expect(tools.stdout).toContain('not adopted');
    expect(tools.stderr).toContain('untrusted');
  });

  it('a server not registered is a stable code with a machine-readable fix', async () => {
    const { h } = await setup();
    const result = await h.run(['mcp', 'tools', 'nope', '--json']);
    expect(result.code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'MCP_SERVER_NOT_FOUND', fix: { command: 'anlyon mcp add <url>' } });
  });

  it('--refresh lists the server again and shows a tool that changed', async () => {
    const { server, h } = await setup();
    await h.run(['mcp', 'add', URL_]);
    await h.run(['mcp', 'adopt', 'tracker', 'list_issues']);
    server.state.changeMcpTool('list_issues');
    const stale = await h.run(['mcp', 'tools', 'tracker', '--json']);
    expect(JSON.parse(stale.stdout).data.adopted[0].state).toBe('current');
    const fresh = await h.run(['mcp', 'tools', 'tracker', '--refresh']);
    expect(fresh.stdout).toContain('changed: re-adopt');
  });
});

describe('anlyon mcp adopt', () => {
  it('asks for a sign-off, exits 15 and adopts nothing: no key or login can approve it', async () => {
    const { server, h } = await setup({ signOff: true });
    server.state.signOff = false;
    await h.run(['mcp', 'add', URL_]);
    server.state.signOff = true;
    const result = await h.run(['mcp', 'adopt', 'tracker', 'delete_issue', 'list_issues']);
    expect(result.code, result.stderr).toBe(EXIT.SIGN_OFF_REQUIRED);
    const [line0, line1] = result.stderr.split('\n');
    expect(line0).toBe("Needs a human's sign-off. A workspace admin must approve this change before it applies:");
    expect(line1).toMatch(/\/sign-offs\/sor_/);
    expect(result.stderr).toContain('neither can any API key or CLI login');
    expect(server.state.mcpUpstreams[0].adopted).toEqual([]);
  });

  it('with --json puts the request on stdout with its link', async () => {
    const { server, h } = await setup({ signOff: true });
    server.state.signOff = false;
    await h.run(['mcp', 'add', URL_]);
    server.state.signOff = true;
    const result = await h.run(['mcp', 'adopt', 'tracker', 'list_issues', '--json']);
    expect(result.code).toBe(EXIT.SIGN_OFF_REQUIRED);
    const out = JSON.parse(result.stdout);
    expect(out.data).toMatchObject({ object: 'sign_off_request', status: 'pending', operation: 'mcp_upstream.adopt' });
    expect(out.data.signOffUrl).toMatch(/\/sign-offs\/sor_/);
  });

  it('by default asks for approval on what the engine calls irreversible or destructive', async () => {
    const { server, h } = await setup();
    await h.run(['mcp', 'add', URL_]);
    await h.run(['mcp', 'adopt', 'tracker', 'delete_issue', 'list_issues']);
    expect(server.state.lastMcpAdoption).toEqual({ tools: { delete_issue: { requiresApproval: true }, list_issues: { requiresApproval: false } } });
  });

  it('--approval all and none say so in the request, which is what a person is shown', async () => {
    const { server, h } = await setup();
    await h.run(['mcp', 'add', URL_]);
    await h.run(['mcp', 'adopt', 'tracker', 'list_issues', '--approval', 'all']);
    expect(server.state.lastMcpAdoption.tools.list_issues.requiresApproval).toBe(true);
    await h.run(['mcp', 'adopt', 'tracker', 'delete_issue', '--approval', 'none']);
    expect(server.state.lastMcpAdoption.tools.delete_issue.requiresApproval).toBe(false);
    expect((await h.run(['mcp', 'adopt', 'tracker', 'x', '--approval', 'maybe'])).code).toBe(EXIT.USAGE);
  });

  it('a tool the server does not list is refused before anyone is asked', async () => {
    const { server, h } = await setup({ signOff: true });
    server.state.signOff = false;
    await h.run(['mcp', 'add', URL_]);
    server.state.signOff = true;
    const result = await h.run(['mcp', 'adopt', 'tracker', 'no_such_tool', '--json']);
    expect(result.code).toBe(EXIT.REJECTED);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'MCP_TOOL_NOT_LISTED', fix: { command: 'anlyon mcp tools tracker --refresh' } });
    expect(server.state.lastMcpAdoption).toBeUndefined();
  });

  it('needs a server and at least one tool', async () => {
    const { h } = await setup();
    expect((await h.run(['mcp', 'adopt', 'tracker'])).code).toBe(EXIT.USAGE);
  });

  it('with --wait follows the request and prints what was adopted once a person approves', async () => {
    const { server, h } = await setup({ signOff: true });
    server.state.signOff = false;
    await h.run(['mcp', 'add', URL_]);
    server.state.signOff = true;
    server.state.autoApproveGate = true;
    const result = await h.run(['mcp', 'adopt', 'tracker', 'list_issues', '--wait', '30s']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout).toContain('agents call it as action_tracker-list_issues');
  });

  it('says when a long name reaches agents shortened', async () => {
    const { server, h } = await setup();
    const long = 'list_every_comment_attached_to_a_draft_in_a_workspace';
    server.state.mcpListing = [{ ...server.state.mcpListing[0], name: long }];
    await h.run(['mcp', 'add', URL_]);
    const result = await h.run(['mcp', 'adopt', 'tracker', long]);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(result.stdout).toContain(`the action is tracker-${long}, and agents see a shortened tool name`);
  });

  it('with --wait and a sign-off, ends with what was adopted', async () => {
    const { server, h } = await setup({ signOff: true });
    server.state.signOff = false;
    await h.run(['mcp', 'add', URL_]);
    server.state.signOff = true;
    server.state.autoApproveGate = true;
    await h.run(['mcp', 'adopt', 'tracker', 'list_issues', '--wait', '30s']);
    expect(server.state.mcpUpstreams[0].adopted).toMatchObject([{ tool: 'list_issues', state: 'current' }]);
  });
});

describe('anlyon mcp archive', () => {
  it('asks first, then archives at once', async () => {
    const { server, h } = await setup();
    await h.run(['mcp', 'add', URL_]);
    expect((await h.run(['mcp', 'archive', 'tracker'])).code).toBe(EXIT.USAGE);
    const result = await h.run(['mcp', 'archive', 'tracker', '--yes']);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    expect(server.state.mcpUpstreams[0].archivedAt).toBeTruthy();
  });
});

describe('helpers', () => {
  it.each([
    ['https://mcp.tracker.example/mcp', 'tracker'],
    ['https://api.tracker.example.com/mcp', 'example'],
    ['https://tracker.example/mcp', 'tracker'],
    ['https://localhost/mcp', 'localhost'],
    ['not a url', undefined],
  ])('names %s as %s', (url, name) => {
    expect(nameFromUrl(url)).toBe(name);
  });

  it('parses a header with a colon in its value', () => {
    expect(parseHeader('X-Thing: a:b')).toEqual(['X-Thing', 'a:b']);
    expect(() => parseHeader('nope')).toThrow(/Name: value/);
  });
});
