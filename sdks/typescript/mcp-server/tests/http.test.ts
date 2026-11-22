import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHttp } from '../src/transports/http.ts';

let server: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  server = await startHttp(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe('HTTP transport', () => {
  it('serves server info on GET /mcp', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('anlyon-mcp');
    expect(body.transport).toBe('streamable-http');
  });

  it('404s unknown paths', async () => {
    const res = await fetch(`${baseUrl}/other`);
    expect(res.status).toBe(404);
  });

  it('rejects non-JSON content types with 415', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer test-key' },
      body: 'hello',
    });
    expect(res.status).toBe(415);
  });

  it('rejects requests without a bearer key with 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024 + 1024) } }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('handles an MCP initialize request end-to-end', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer test-key',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('serverInfo');
    expect(text).toContain('anlyon-mcp');
  });

  it('keeps annotations and security schemes on the wire', async () => {
    process.env.ANLYON_MCP_DYNAMIC_ACTIONS = '0';
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer test-key',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const json = raw.startsWith('{') ? raw : raw.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
      const decide = JSON.parse(json).result.tools.find((t: { name: string }) => t.name === 'decide_approval');
      expect(decide.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
      expect(decide.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['anlyon:approvals.decide'] }]);
    } finally {
      delete process.env.ANLYON_MCP_DYNAMIC_ACTIONS;
    }
  });

  it('refuses a malformed Anlyon-End-User header with 400 INVALID_END_USER', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer test-key',
        'Anlyon-End-User': 'not a valid id',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_END_USER');
  });

  it('serves a request that names a well-formed end user', async () => {
    process.env.ANLYON_MCP_DYNAMIC_ACTIONS = '0';
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer test-key',
          'Anlyon-End-User': 'user_42',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(200);
    } finally {
      delete process.env.ANLYON_MCP_DYNAMIC_ACTIONS;
    }
  });
});
