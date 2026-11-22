/**
 * Anlyon MCP Server  entry point.
 *
 * Picks transport based on CLI args / env:
 *   npx @anlyonhq/mcp-server              → stdio (default)
 *   npx @anlyonhq/mcp-server --http       → streamable HTTP on PORT (default 3001)
 *   MCP_TRANSPORT=http node dist/index.js → HTTP
 *
 * Auth:
 *   stdio: ANLYON_API_KEY env var
 *   HTTP:  Authorization: Bearer <key> header per request
 *
 * Acting for one of your users (stdio):
 *   npx @anlyonhq/mcp-server --end-user user_123   (or ANLYON_END_USER=user_123)
 *   Every call carries `Anlyon-End-User: user_123`. Over HTTP, send that header
 *   on each request instead.
 */

import { isValidEndUserId } from '@anlyonhq/sdk';
import { endUserFlag, setProcessEndUser } from './auth.ts';
import { createServer } from './server.ts';
import { startStdio } from './transports/stdio.ts';
import { startHttp } from './transports/http.ts';

const useHttp = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

/**
 * The end user this process acts for, checked before anything starts: a typo
 * should stop the server, not reach the API on every call.
 */
function configureEndUser(): void {
  const endUser = endUserFlag(process.argv) ?? (process.env.ANLYON_END_USER || undefined);
  if (endUser === undefined) return;
  if (useHttp) {
    throw new Error('--end-user and ANLYON_END_USER apply to stdio. Over HTTP, send the Anlyon-End-User header on each request.');
  }
  if (!isValidEndUserId(endUser)) {
    throw new Error('The end user must be 1 to 128 characters: letters, digits, and . _ : @ -');
  }
  setProcessEndUser(endUser);
}

async function main() {
  configureEndUser();
  if (useHttp) {
    const port = parseInt(process.env.PORT ?? '3001', 10);
    await startHttp(port);
  } else {
    const server = createServer();
    await startStdio(server);
  }
}

main().catch((error) => {
  console.error('Fatal error starting Anlyon MCP server:', error);
  process.exit(1);
});
