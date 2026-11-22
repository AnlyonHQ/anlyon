/**
 * Stdio transport  the default for `npx @anlyonhq/mcp-server`.
 *
 * The user sets ANLYON_API_KEY in their environment, then configures their
 * MCP client (Claude Desktop, Cursor, etc.) to launch this process.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Anlyon MCP server running on stdio');
}
