/**
 * MCP upstreams resource: put a remote MCP server behind Anlyon and adopt its tools as governed actions.
 *
 * A credential can register a server and list its tools, and no agent can call anything until a tool
 * is adopted. Adopting always waits for a person: `adopt` throws `SignOffRequiredError` with the link
 * for a workspace admin, for a first adoption and for a re-adoption after a tool changed. Connecting an
 * operator's account to an OAuth server is a person's consent and happens in the console.
 *
 * Remote Streamable HTTP servers only. A tool's class is a suggestion from what the server says, and
 * server text is untrusted. Receipts for adopted tools grade `acknowledged`, never `confirmed`.
 *
 * Reading needs `actions:read`; the rest needs `actions:write`. Naming a stored secret in `headers`
 * also needs `secrets:read`.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type {
  McpAdoptResult,
  McpToolChoice,
  McpUpstream,
  McpUpstreamConnectLink,
  McpUpstreamInspection,
  RegisterMcpUpstreamRequest,
} from '../types/mcp-upstreams';

export class McpUpstreamsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/mcp-upstreams');
  }

  /** The environment's registered servers, with their last listing and what was adopted from them. */
  async list(): Promise<ApiResponse<McpUpstream[]>> {
    return this._get<McpUpstream[]>('');
  }

  async get(upstreamId: string): Promise<ApiResponse<McpUpstream>> {
    return this._get<McpUpstream>(`/${encodeURIComponent(upstreamId)}`);
  }

  /** What a server is before you register it. Stores nothing and sends no credential. */
  async inspect(url: string): Promise<ApiResponse<McpUpstreamInspection>> {
    return this._post<McpUpstreamInspection>('/inspect', { url });
  }

  /**
   * Register a server and list its tools. Nothing is adopted.
   *
   * @example
   * ```typescript
   * const { data } = await client.mcpUpstreams.register({
   *   name: 'tracker',
   *   url: 'https://mcp.example.com/mcp',
   *   headers: { Authorization: 'Bearer {{secret:TRACKER_TOKEN}}' },
   * });
   * ```
   *
   * @throws {SignOffRequiredError} When it would send a secret that may go to any host, or the server signs people in with OAuth. Nothing was registered; a human approves it at `error.signOffUrl`.
   */
  async register(request: RegisterMcpUpstreamRequest): Promise<ApiResponse<McpUpstream>> {
    return this._post<McpUpstream>('', request);
  }

  /** List the server again. Adopted tools are never changed here: one that changed shows as `changed`. */
  async refresh(upstreamId: string): Promise<ApiResponse<McpUpstream>> {
    return this._post<McpUpstream>(`/${encodeURIComponent(upstreamId)}/refresh`, {});
  }

  /**
   * Adopt tools from the last listing as governed actions named `<upstream>-<tool>`.
   *
   * @example
   * ```typescript
   * await client.mcpUpstreams.adopt(id, { create_issue: { requiresApproval: true }, list_issues: {} });
   * ```
   *
   * @throws {SignOffRequiredError} Always, from an API key or a CLI login, unless every named tool is already adopted and unchanged. Nothing was adopted; a human approves it at `error.signOffUrl`.
   */
  async adopt(upstreamId: string, tools: Record<string, McpToolChoice>): Promise<ApiResponse<McpAdoptResult>> {
    return this._post<McpAdoptResult>(`/${encodeURIComponent(upstreamId)}/adopt`, { tools });
  }

  /** Archive the server and every action adopted from it. They leave the actions list; their call history stays. */
  async archive(upstreamId: string): Promise<ApiResponse<McpUpstream>> {
    return this._post<McpUpstream>(`/${encodeURIComponent(upstreamId)}/archive`, {});
  }

  /**
   * A link for one of your end users to connect their own account: a sign-in for an OAuth server, a
   * form for their own key for a server registered with `endUserKey`. Needs `end-users:write`, which
   * your server holds and an agent does not.
   */
  async createConnectLink(upstreamId: string, request: { endUserId: string; redirectUrl?: string | null }): Promise<ApiResponse<McpUpstreamConnectLink>> {
    return this._post<McpUpstreamConnectLink>(`/${encodeURIComponent(upstreamId)}/connect-links`, request);
  }
}
