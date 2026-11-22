import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

describe('MCP Registry metadata', () => {
  it('names the same server in package.json and server.json', () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it('points the npm entry at this package over stdio, with the key as a required secret', () => {
    const [npm] = server.packages;
    expect(npm).toMatchObject({ registryType: 'npm', identifier: pkg.name, transport: { type: 'stdio' } });
    expect(npm.environmentVariables.find((v: { name: string }) => v.name === 'ANLYON_API_KEY')).toMatchObject({
      isRequired: true,
      isSecret: true,
    });
  });

  it('publishes the hosted endpoint, whose URL is also the OAuth resource identifier', () => {
    expect(server.remotes).toEqual([{ type: 'streamable-http', url: 'https://api.anlyon.com/mcp' }]);
  });

  it('ships server.json in the npm package', () => {
    expect(pkg.files).toContain('server.json');
  });

  it('keeps the description within the registry limit', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
