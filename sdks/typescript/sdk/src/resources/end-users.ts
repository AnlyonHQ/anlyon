/**
 * End users: the people using your product, and the accounts they connect.
 *
 * Your server names the end user. Anlyon stores the id as given and never runs their login. Each
 * end user connects their own Gmail, HubSpot or Slack, and every action your agent takes in those
 * accounts is limited, approved and receipted for that end user.
 *
 * - **Connect:** `createConnectLink` for any integration (send the end user to `url`, then
 *   `confirmConnection` when they come back), or `setConnection` when your app already holds the end
 *   user's own key for an API-key integration.
 * - **Act:** invoke actions with a client from `anlyon.forUser(endUserId)`. An end user with no
 *   connection gets `EndUserNotConnectedError`, which carries a fresh `connectUrl`.
 * - **Approve:** an approval policy decided by the end user puts its approvals here, not in your
 *   team's inbox. List them with `approvals.list` and decide with `approvals.decide` in your app.
 * - **Front end:** `createSession` mints a short-lived token for one end user, for the prebuilt
 *   components in `@anlyonhq/react`.
 * - **Erase:** `erase` removes every connection, limit counter and pending approval of an end user.
 *
 * Needs the `end-users:read`, `end-users:write` or `end-users:approvals` scope.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import { AnlyonError } from '../core/errors';
import { assertEndUserId } from '../core/end-user';
import { ERROR_CODES } from '../types/errors';
import type { ApiResponse } from '../types/api';
import type { Approval, ApprovalStatus, Invocation } from '../types/agent';

/** `active` works. `needs_reconnect` was revoked or failed to refresh. `revoked` was removed. */
export type EndUserConnectionStatus = 'active' | 'needs_reconnect' | 'revoked';

/** One end user's connection to one integration. Tokens are never returned. */
export interface EndUserConnection {
  /** The integration, e.g. `gmail`. */
  integration: string;
  status: EndUserConnectionStatus;
  /** Scopes the provider granted. Empty for an API-key integration. */
  scopes: string[];
  /** When the end user connected (ISO 8601). */
  connectedAt: string;
  /** When the connection last changed (ISO 8601). */
  updatedAt: string;
}

export interface CreateConnectLinkRequest {
  /** Your id for the end user: 1 to 128 characters from `A-Z a-z 0-9 . _ : @ -`. */
  endUserId: string;
  /**
   * Any integration an end user can connect, by catalogue id (e.g. `gmail`, `hubspot`, `linear`).
   * For an OAuth integration the link opens the provider's consent; for an API-key integration it
   * opens Anlyon's own page, where the end user types their key, so your app never handles it.
   * Either way the connection is confirmed by your server afterwards. List the available
   * integrations with `connections.integrations()`.
   */
  integration: string;
  /**
   * Where the end user lands afterwards: your server, which confirms the connection. Anlyon adds
   * `anlyon_status` (`pending_confirmation`, `declined` or `error`), `anlyon_flow` and
   * `integration` to the query; read them with `parseConnectRedirect`. It must match one of the
   * environment's allowed redirect URLs. Without it the environment's default redirect URL is
   * used, and without that the call fails with `RedirectUrlRequiredError`.
   */
  redirectUrl?: string;
}

/** A connect link. Send the end user to `url`. It works once, for ten minutes. */
export interface EndUserConnectLink {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
  /** The integration the link connects, by catalogue id. Absent from older servers. */
  integration?: string;
}

/** What `erase()` did. */
export interface EndUserErasure {
  /** Connections revoked at the provider where it supports that, and deleted. */
  connectionsDeleted: number;
  /** Pending approvals cancelled. */
  approvalsCancelled: number;
  /** Settled per-end-user limit counters cleared. */
  countersCleared: number;
  /**
   * The keyed one-way hash the kept records (invocations, receipts, approvals, audit) now carry in
   * place of the end-user id.
   */
  erasedAs: string;
}

/** A connection the end user's consent created, once your server has confirmed it. */
export interface ConfirmedEndUserConnection {
  integration: string;
  status: 'active';
}

/**
 * The end user's own key for an API-key integration. Stored encrypted and never returned. Send
 * `token` for a one-value key, or `fields` for an integration whose key is several values or has a
 * per-account host (Jira: `{ site, email, apiToken }`), by the names its catalogue entry lists in
 * `auth.fields`.
 */
export type SetEndUserConnectionRequest =
  | { token: string; fields?: never }
  | { fields: Record<string, string>; token?: never };

/** An end user that has connections or activity in this environment. */
export interface EndUserSummary {
  endUserId: string;
  /** Connections the end user holds. */
  connections: number;
  /** Invocations made for the end user in this environment. */
  invocations: number;
  /** Approvals waiting for the end user's decision. */
  pendingApprovals: number;
}

export interface ListEndUsersParams {
  /** The previous page's `pagination.nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface EndUserPage {
  success: boolean;
  data: EndUserSummary[];
  /** Pass `nextCursor` as `cursor` for the next page. Null on the last page. */
  pagination: { nextCursor: string | null };
}

export interface ListEndUserApprovalsParams {
  /** Defaults to every status. Pass `pending` for what still needs the end user's decision. */
  status?: ApprovalStatus;
}

export interface DecideEndUserApprovalRequest {
  decision: 'approve' | 'deny';
  /** Recorded with the decision and shown on the receipt. */
  reason?: string;
}

export interface EndUserApprovalDecision {
  approval: Approval;
  /** Present when approving an action's approval: the invocation that then ran. */
  invocation?: Invocation;
}

export interface CreateEndUserSessionOptions {
  /** How long the token lasts: 60 to 3600 seconds. Defaults to 900 (15 minutes). Never past the key's own expiry. */
  ttlSeconds?: number;
}

/** What an end-user session token may do. `approvals` only when the key has `end-users:approvals`. */
export type EndUserSessionCapability = 'connections' | 'approvals';

/**
 * A short-lived token for one end user, for your own front end (`@anlyonhq/react`). Hand it only to
 * the browser of the end user it names. Never put it in a URL or in storage.
 */
export interface EndUserSession {
  /** `eus_...`. Sent as `Authorization: Bearer <token>` to `/api/v2/end-user-session`. */
  token: string;
  /** ISO 8601. */
  expiresAt: string;
  endUserId: string;
  capabilities: EndUserSessionCapability[];
}

/** The end-user path segment, after checking the id. */
function segment(endUserId: string): string {
  assertEndUserId(endUserId);
  return encodeURIComponent(endUserId);
}

function required(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AnlyonError({ code: ERROR_CODES.VALIDATION_ERROR, message: `${what} is required.` });
  }
  return value;
}

/**
 * Approvals that belong to an end user: those a policy with `decidedBy: "end_user"` created. They
 * are not shown in your team's inbox. Show them in your app, and let the end user decide. Each
 * call names the end user, and an approval of another end user answers `404`.
 */
export class EndUserApprovalsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/end-users');
  }

  /**
   * The end user's approvals.
   *
   * @example
   * ```typescript
   * const { data } = await anlyon.endUsers.approvals.list(user.id, { status: 'pending' });
   * ```
   */
  async list(endUserId: string, params?: ListEndUserApprovalsParams): Promise<ApiResponse<Approval[]>> {
    return this._get<Approval[]>(`/${segment(endUserId)}/approvals`, params as Record<string, unknown> | undefined, {
      endUserId,
    });
  }

  /**
   * Record the end user's decision. Approving an action's approval runs the parked invocation.
   *
   * @example
   * ```typescript
   * await anlyon.endUsers.approvals.decide(user.id, approvalId, { decision: 'approve' });
   * ```
   */
  async decide(
    endUserId: string,
    approvalId: string,
    request: DecideEndUserApprovalRequest
  ): Promise<ApiResponse<EndUserApprovalDecision>> {
    const path = `/${segment(endUserId)}/approvals/${encodeURIComponent(required(approvalId, 'approvalId'))}/decide`;
    if (request?.decision !== 'approve' && request?.decision !== 'deny') {
      throw new AnlyonError({ code: ERROR_CODES.VALIDATION_ERROR, message: 'decision is "approve" or "deny".' });
    }
    const body = request.reason === undefined
      ? { decision: request.decision }
      : { decision: request.decision, reason: request.reason };
    return this._post<EndUserApprovalDecision>(path, body, { endUserId });
  }
}

export class EndUsersResource extends BaseResource {
  private _approvals?: EndUserApprovalsResource;

  constructor(http: HttpClient) {
    super(http, '/api/v2/end-users');
  }

  /** Approvals the end user decides in your app. */
  get approvals(): EndUserApprovalsResource {
    return (this._approvals ??= new EndUserApprovalsResource(this.http));
  }

  /**
   * A connect link for any integration. Send the end user to `url`: Anlyon's consent page, which
   * names your workspace, then the provider's sign-in, or, for an API-key integration, a hosted form
   * where they paste their own key (checked before it is kept). They come back to `redirectUrl`,
   * where your server calls `confirmConnection` to finish.
   *
   * Throws `RedirectUrlRequiredError` when there is neither a `redirectUrl` nor a default, unless the
   * environment's connect confirmation is off.
   *
   * @example
   * ```typescript
   * const { data } = await anlyon.endUsers.createConnectLink({
   *   endUserId: user.id,
   *   integration: 'gmail',
   *   redirectUrl: 'https://app.example.com/settings/connections',
   * });
   * return redirect(data!.url);
   * ```
   */
  async createConnectLink(request: CreateConnectLinkRequest): Promise<ApiResponse<EndUserConnectLink>> {
    const { endUserId, redirectUrl } = request;
    const path = `/${segment(endUserId)}/connect-links`;
    const integration = required(request.integration, 'integration');
    const body = redirectUrl === undefined ? { integration } : { integration, redirectUrl };
    return this._post<EndUserConnectLink>(path, body, { endUserId });
  }

  /**
   * Finish a connect flow. Call it from the route `redirectUrl` points at, with the end user from
   * your own session and the `flowId` from `parseConnectRedirect`. Until then the connection does
   * not exist. A flow started for a different end user throws `EndUserMismatchError` and connects
   * nothing, so a link forwarded to someone else cannot attach their account to your user.
   *
   * @example
   * ```typescript
   * const user = await requireSession();
   * const result = parseConnectRedirect(request.url);
   * if (result?.status === 'pending_confirmation' && result.flowId) {
   *   await anlyon.endUsers.confirmConnection(user.id, result.flowId);
   * }
   * ```
   */
  async confirmConnection(endUserId: string, flowId: string): Promise<ApiResponse<ConfirmedEndUserConnection>> {
    const path = `/${segment(endUserId)}/connections/confirm`;
    return this._post<ConfirmedEndUserConnection>(path, { flowId: required(flowId, 'flowId') }, { endUserId });
  }

  /**
   * Store the end user's own key for an API-key integration. Anlyon checks it with the provider
   * when the catalogue can, and stores it encrypted. It is never returned.
   *
   * @example
   * ```typescript
   * await anlyon.endUsers.setConnection(user.id, 'notion', { token: keyFromYourForm });
   * await anlyon.endUsers.setConnection(user.id, 'jira', { fields: { site: 'acme', email, apiToken } });
   * ```
   */
  async setConnection(
    endUserId: string,
    integration: string,
    request: SetEndUserConnectionRequest
  ): Promise<ApiResponse<EndUserConnection>> {
    const path = `/${segment(endUserId)}/connections/${encodeURIComponent(required(integration, 'integration'))}`;
    if (request?.fields !== undefined) {
      return this._put<EndUserConnection>(path, { fields: request.fields }, { endUserId });
    }
    const token = required(request?.token, 'token');
    return this._put<EndUserConnection>(path, { token }, { endUserId });
  }

  /** The end user's connections: integration, status, scopes and timestamps. Never a token. */
  async listConnections(endUserId: string): Promise<ApiResponse<EndUserConnection[]>> {
    return this._get<EndUserConnection[]>(`/${segment(endUserId)}/connections`, undefined, { endUserId });
  }

  /** Revoke the connection at the provider when the provider supports it, then delete it. */
  async deleteConnection(endUserId: string, integration: string): Promise<ApiResponse<{ deleted: boolean }>> {
    const path = `/${segment(endUserId)}/connections/${encodeURIComponent(required(integration, 'integration'))}`;
    return this._delete<{ deleted: boolean }>(path, { endUserId });
  }

  /**
   * A short-lived session token for this end user, for your own front end. With it, the browser can
   * list, connect and disconnect the end user's accounts and, when this key has
   * `end-users:approvals`, list and decide their own approvals. Nothing else: no action call, no
   * secret, no other end user, and it cannot confirm a connection. Call it from a route that knows
   * who is signed in, and only for that user. API keys only.
   *
   * @example
   * ```typescript
   * // app/api/anlyon/session/route.ts
   * const user = await requireSession();
   * const { data } = await anlyon.endUsers.createSession(user.id);
   * return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
   * ```
   */
  async createSession(endUserId: string, options: CreateEndUserSessionOptions = {}): Promise<ApiResponse<EndUserSession>> {
    const path = `/${segment(endUserId)}/sessions`;
    const { ttlSeconds } = options;
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)) {
      throw new AnlyonError({ code: ERROR_CODES.VALIDATION_ERROR, message: 'ttlSeconds is a whole number from 60 to 3600.' });
    }
    return this._post<EndUserSession>(path, ttlSeconds === undefined ? {} : { ttlSeconds }, { endUserId });
  }

  /**
   * Erase the end user: every connection, their limit counters and their pending approvals (those
   * are cancelled). Receipts are kept, with the id replaced by a one-way hash (`erasedAs`).
   */
  async erase(endUserId: string): Promise<ApiResponse<EndUserErasure>> {
    return this._delete<EndUserErasure>(`/${segment(endUserId)}`, { endUserId });
  }

  /**
   * End users with connections or activity in this environment, with counts. A client from
   * `forUser()` acts for one end user and cannot list the others.
   *
   * @example
   * ```typescript
   * let cursor: string | undefined;
   * do {
   *   const page = await anlyon.endUsers.list({ cursor });
   *   for (const user of page.data) console.log(user.endUserId, user.connections);
   *   cursor = page.pagination.nextCursor ?? undefined;
   * } while (cursor);
   * ```
   */
  async list(params: ListEndUsersParams = {}): Promise<EndUserPage> {
    if (this.http.endUserId !== undefined) {
      throw new AnlyonError({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'This client acts for one end user and cannot list the others. Use the client it was built from.',
      });
    }
    return this._get<EndUserSummary[]>('', params as Record<string, unknown>) as unknown as Promise<EndUserPage>;
  }
}
