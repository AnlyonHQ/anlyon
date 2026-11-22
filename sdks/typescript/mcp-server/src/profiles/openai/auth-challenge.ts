/**
 * Auth failures inside tool results, the way ChatGPT asks for them.
 *
 * When a call is refused because of the credential, the result carries
 * `_meta["mcp/www_authenticate"]` so ChatGPT can send the person back through
 * OAuth (401) or ask for the missing permission (403), instead of showing the
 * model an error it cannot act on. The transport-level 401 that starts OAuth
 * is unchanged and shared by every client.
 */

import { AnlyonError } from '@anlyonhq/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A header parameter value: quotes and backslashes escaped, line breaks removed. */
const quoted = (value: string) => `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;

export function withAuthChallenge(
  error: unknown,
  result: CallToolResult,
  scopes: readonly string[],
  resourceMetadataUrl: string,
): CallToolResult {
  const status = error instanceof AnlyonError ? error.status : undefined;
  if (status !== 401 && status !== 403) return result;

  const message = error instanceof Error ? error.message : String(error);
  const params = [
    `resource_metadata=${quoted(resourceMetadataUrl)}`,
    `error=${quoted(status === 401 ? 'invalid_token' : 'insufficient_scope')}`,
    `error_description=${quoted(message)}`,
    ...(status === 403 && scopes.length > 0 ? [`scope=${quoted(scopes.join(' '))}`] : []),
  ];
  return { ...result, _meta: { ...result._meta, 'mcp/www_authenticate': [`Bearer ${params.join(', ')}`] } };
}
