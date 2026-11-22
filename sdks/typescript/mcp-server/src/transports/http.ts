/**
 * Streamable HTTP transport  for Anlyon-hosted remote MCP.
 *
 * Exposes POST /mcp. Each request carries Authorization: Bearer <key>, and
 * `Anlyon-End-User: <id>` when the call acts for one of the developer's users.
 * Both flow through AsyncLocalStorage (no process.env mutation) so concurrent
 * requests are isolated.
 *
 * Stateless mode: each request creates a fresh transport + server connect.
 * This is the documented MCP pattern for sessionIdGenerator: undefined.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isValidEndUserId } from '@anlyonhq/sdk';
import { extractBearerKey, requestContext } from '../auth.ts';
import { createServer } from '../server.ts';
import { SERVER_NAME, SERVER_VERSION } from '../pkg.ts';

/** Requests larger than this are rejected with 413. */
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function startHttp(port: number): Promise<HttpServer> {
  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/mcp') {
      sendJson(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, transport: 'streamable-http' });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/mcp') {
      sendJson(res, 404, { error: 'Not found. Use POST /mcp.' });
      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 415, { error: 'Content-Type must be application/json.' });
      return;
    }

    const authHeader = req.headers.authorization;
    const apiKey = extractBearerKey(authHeader);
    if (!apiKey) {
      sendJson(res, 401, { error: 'Missing Authorization header. Send Authorization: Bearer <your-anlyon-api-key>.' });
      return;
    }

    const endUserHeader = req.headers['anlyon-end-user'];
    const endUserId = Array.isArray(endUserHeader) ? endUserHeader[0] : endUserHeader;
    if (endUserId !== undefined && !isValidEndUserId(endUserId)) {
      sendJson(res, 400, {
        code: 'INVALID_END_USER',
        error: 'The Anlyon-End-User header must be 1 to 128 characters: letters, digits, and . _ : @ -',
      });
      return;
    }

    await requestContext.run({ apiKey, ...(endUserId ? { endUserId } : {}) }, async () => {
      let parsed: unknown;
      try {
        const body = await readBody(req, MAX_BODY_BYTES);
        parsed = JSON.parse(body);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes.` });
        } else {
          sendJson(res, 400, { error: 'Invalid JSON body.' });
        }
        return;
      }

      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createServer();
        await server.connect(transport);

        await transport.handleRequest(req, res, parsed);
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal server error' });
        }
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`Anlyon MCP server (HTTP) listening on port ${port}`);
      resolve(httpServer);
    });
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.removeListener('data', onData);
        req.on('data', () => {});
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
