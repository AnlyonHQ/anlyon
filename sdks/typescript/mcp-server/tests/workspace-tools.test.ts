import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceTools } from '../src/tools/workspace.ts';
import { requestContext } from '../src/auth.ts';
import type { Client } from '@anlyonhq/sdk';

const tool = (name: string) => workspaceTools.find((candidate) => candidate.name === name)!;
const client = {} as Client;

const WORKSPACES = {
  workspaces: [
    {
      id: 'ws_one',
      name: 'Recipes',
      slug: 'recipes',
      role: 'admin',
      environments: [
        { id: 'env_prod', name: 'Production', slug: 'production', isDefault: true },
        { id: 'env_stg', name: 'Staging', slug: 'staging', isDefault: false },
      ],
    },
    { id: 'ws_two', name: 'Other', slug: 'other', role: 'member', environments: [] },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.ANLYON_BASE_URL = 'http://api.test';
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/workspaces') ? { success: true, data: WORKSPACES } : { success: true, data: {} }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANLYON_BASE_URL;
});

const run = (name: string, args: Record<string, unknown> = {}) =>
  requestContext.run({ apiKey: 'jwt.token.sig', cacheScope: 'user_a:client_1' }, () =>
    tool(name).handler(client, args),
  );

describe('list_workspaces', () => {
  it('reports what the user can act in', async () => {
    const result = (await run('list_workspaces')) as { workspaces: Array<{ name: string }> };
    expect(result.workspaces.map((w) => w.name)).toEqual(['Recipes', 'Other']);
  });

  it("authenticates with the caller's own credential", async () => {
    await run('list_workspaces');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer jwt.token.sig');
  });

  it('uses the host API origin from the request context', async () => {
    await requestContext.run(
      {
        apiKey: 'jwt.token.sig',
        cacheScope: 'user_a:client_1',
        apiBaseUrl: 'http://host-api.test',
      },
      () => tool('list_workspaces').handler(client, {}),
    );

    expect(fetchMock.mock.calls[0][0]).toBe('http://host-api.test/api/oauth/workspaces');
  });
});

describe('select_workspace', () => {
  it('switches and reports the resulting workspace', async () => {
    const result = (await run('select_workspace', { workspaceId: 'ws_one' })) as {
      selected: { workspace: string; environment: string };
    };
    expect(result.selected.workspace).toBe('Recipes');
    expect(result.selected.environment).toBe('Production');
  });

  it('honours an explicit environment', async () => {
    const result = (await run('select_workspace', { workspaceId: 'ws_one', environmentId: 'env_stg' })) as {
      selected: { environment: string };
    };
    expect(result.selected.environment).toBe('Staging');
  });

  it('never sends a client id  the server takes it from the token', async () => {
    await run('select_workspace', { workspaceId: 'ws_one' });
    const post = fetchMock.mock.calls.find(([, init]: [string, RequestInit]) => init?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({ workspaceId: 'ws_one', environmentId: 'env_prod' });
  });

  it('refuses a workspace the user is not a member of', async () => {
    await expect(run('select_workspace', { workspaceId: 'ws_not_mine' })).rejects.toThrow(/not a member/i);
  });

  it('refuses an environment from a different workspace', async () => {
    await expect(run('select_workspace', { workspaceId: 'ws_one', environmentId: 'env_elsewhere' })).rejects.toThrow(
      /does not belong/i,
    );
  });

  it('reports a workspace with no environments rather than binding to nothing', async () => {
    await expect(run('select_workspace', { workspaceId: 'ws_two' })).rejects.toThrow(/no environments/i);
  });
});
