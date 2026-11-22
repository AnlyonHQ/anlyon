/**
 * Connected accounts. A connected account is a secret bound to one integration's API hosts. An
 * integration is connected one of two ways, named by its `auth.kind`:
 *
 * - `oauth`: you sign in at the provider (HubSpot, Slack, ...). The secret's value is an access
 *   token fetched at dispatch. Use `createSession` and `complete`.
 * - `api_key`: you create a key in the provider's own settings (GitHub, Notion, ...). Anlyon checks
 *   it with the provider and stores it. Use `connectWithApiKey`.
 *
 * Either way neither the agent nor this client ever reads the credential back: actions reference
 * it as `{{secret:NAME}}` like any secret.
 *
 * Listing and deleting a connected account is the same as for any secret: `connections.list()`, or
 * `secrets.delete(name)`, which for a signed-in account also revokes the access.
 *
 * Whether an account still works is one question for both kinds, answered in `secret.health`:
 * `check(name)` asks the provider now, and `reconnect(name)` makes a `needs_reauth` account work
 * again the way it was connected (a new key, or the consent page again), under the same name.
 */

import { BaseResource } from './base';
import type { HttpClient } from '../core/http-client';
import type { ApiResponse } from '../types/api';
import type { Secret } from '../types/agent';
import { AnlyonError } from '../core/errors';
import { ERROR_CODES, type ErrorFix } from '../types/errors';
import { EndUsersResource, type ConfirmedEndUserConnection } from './end-users';

/** How an integration is connected. */
export type ConnectionIntegrationAuth =
  | { kind: 'oauth' }
  | {
      kind: 'api_key';
      /** Where in the provider's settings the key is created, and with which permissions. */
      instructions: string;
      /** The provider's own page for creating the key. */
      instructionsUrl: string;
      /**
       * Present when the key is several values (an email and an API token) or the integration's host
       * differs per account (a subdomain). Ask for each, in order, and send them as `fields`.
       */
      fields?: ConnectionField[];
    };

/** One value a connect form asks for. */
export interface ConnectionField {
  /** The key in `fields`. */
  name: string;
  label: string;
  /** Mask it in a form. Every field is stored encrypted and never returned, secret or not. */
  secret: boolean;
  /** `account`: names the account's own host (see `hostTemplate`). `credential`: part of the key. */
  kind: 'account' | 'credential';
  hint?: string;
}

export interface ConnectionIntegration {
  /** Stable id used in sessions and pack manifests, e.g. `hubspot`. */
  id: string;
  name: string;
  /** `oauth`: start a session and sign in. `api_key`: send a key with `connectWithApiKey`. */
  auth: ConnectionIntegrationAuth;
  /** API hosts the credential may be sent to; null when the host is the account's own. */
  hosts: string[] | null;
  hostsFromAccount: boolean;
  /** For a per-account host: where the key goes, e.g. `{subdomain}.zendesk.com`. */
  hostTemplate?: string;
  /** Scopes requested at the provider's consent page. Empty for an `api_key` integration. */
  scopes: string[];
  /** The pack whose actions are this integration's operations, or null. */
  operationsPack: string | null;
  /** Workflow packs that use this integration together with others. */
  workflowPacks: string[];
  /**
   * Present (true) when this deployment has no OAuth app of its own for the integration: a sign-in
   * needs the environment's own app, and a session answers `400 OWN_OAUTH_APP_REQUIRED` until it is set.
   */
  ownOAuthAppRequired?: true;
}

export interface CreateConnectSessionRequest {
  integrationId: string;
  /** The secret the account becomes. ^[A-Z0-9_]+$ */
  secretName: string;
  description?: string;
}

export interface ConnectWithApiKeyRequest {
  /** An integration whose `auth.kind` is `api_key`. */
  integrationId: string;
  /** The secret the key is stored as. ^[A-Z0-9_]+$ */
  secretName: string;
  /** The key alone, with no spaces or line breaks. Stored encrypted and never returned. */
  apiKey?: string;
  /**
   * In place of `apiKey`, for an integration whose `auth.fields` is set: every field by name, e.g.
   * `{ site: 'acme', email: 'ana@acme.com', apiToken: '…' }`. Stored encrypted and never returned.
   */
  fields?: Record<string, string>;
  description?: string;
}

export interface ConnectSession {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  /**
   * Open in a browser to run the consent flow: an Anlyon page that sends the person to the
   * provider's consent page. Anlyon records the account when the provider sends them back.
   */
  connectUrl: string;
  integration: ConnectionIntegration;
}

export type ConnectSessionCompletion =
  | { status: 'pending'; secret: null }
  | { status: 'completed'; secret: Secret };

export interface ReconnectConnectionRequest {
  /** For an `api_key` integration: the new key alone, with no spaces or line breaks. Omit for an `oauth` integration. */
  apiKey?: string;
  /** For an integration with `auth.fields`: the fields again. The account (its host) must be the same one. */
  fields?: Record<string, string>;
}

/**
 * How a reconnect went. `completed`: the new key was accepted and stored, and `secret` is the account
 * as it now stands. `pending`: a consent session was started for a signed-in account; open its
 * `connectUrl` and call `complete` as for a first connect.
 */
export type ConnectionReconnect =
  | { status: 'completed'; secret: Secret; session: null }
  | { status: 'pending'; secret: null; session: ConnectSession };

/** One way to act in an app. */
export interface IntegrationRoute {
  /**
   * `integration`: connect an account for a catalogue integration. `mcp`: add the vendor's own MCP
   * server, whose publisher is verified as the vendor. `openapi`: import an OpenAPI spec.
   * `mcp_address`: add a server by an address you bring. `custom_action`: declare an action.
   */
  kind: 'integration' | 'mcp' | 'openapi' | 'mcp_address' | 'custom_action' | (string & {});
  /** One sentence on why this route. */
  why: string;
  /** The next step, in the shape of `error.fix`. */
  next: ErrorFix;
  integration?: { id: string; connect: 'sign_in' | 'api_key' };
  mcp?: {
    registryName: string;
    url: string;
    host: string;
    publisher: { verifiedBy: 'domain' | 'github'; namespace: string };
    report: string;
  };
}

/** The best way to act in an app, and the others. */
export interface IntegrationRouteResult {
  /** The name as it was asked for. Untrusted: show it as text. */
  query: string;
  name: string;
  route: IntegrationRoute;
  alternatives: IntegrationRoute[];
  tellUs: string;
}

export class ConnectionsResource extends BaseResource {
  constructor(http: HttpClient) {
    super(http, '/api/v2/connections');
  }

  /** The integrations an account can be connected for. */
  async integrations(): Promise<ApiResponse<ConnectionIntegration[]>> {
    return this._get<ConnectionIntegration[]>('/integrations');
  }

  /**
   * The best way to act in an app, whether or not Anlyon has an integration for it: a catalogue
   * integration, the vendor's own MCP server when its publisher is verified, an OpenAPI import, or a
   * custom action. It only suggests, and any credential may ask.
   */
  async findRoute(name: string): Promise<ApiResponse<IntegrationRouteResult>> {
    return this._get<IntegrationRouteResult>(`/integrations/find?name=${encodeURIComponent(name)}`);
  }

  /** Connected accounts in the key's environment: every secret with an `integrationId`. */
  async list(): Promise<ApiResponse<Secret[]>> {
    return this._get<Secret[]>('');
  }

  /**
   * Connect an `api_key` integration. Anlyon checks the key with the provider first: a key the
   * provider refuses is not stored (`CONNECTION_KEY_REJECTED`), and neither is one that could not
   * be checked (`CONNECTION_KEY_CHECK_FAILED`). The stored secret is bound to the integration's
   * hosts and to request headers.
   */
  async connectWithApiKey(request: ConnectWithApiKeyRequest): Promise<ApiResponse<Secret>> {
    return this._post<Secret>('/keys', request);
  }

  /**
   * Start a consent flow for an `oauth` integration. Open `connectUrl` in a browser, then call `complete` until it reports
   * `completed`. The session expires after 15 minutes.
   */
  async createSession(request: CreateConnectSessionRequest): Promise<ApiResponse<ConnectSession>> {
    return this._post<ConnectSession>('/sessions', request);
  }

  /**
   * Ask the provider whether a connected account still works, and record the answer in the secret's
   * `health`. The same call for a pasted key and a signed-in account. An account that does not work
   * is an answer, not an error: `health.status` is `needs_reauth` with a `reason`. Only a check that
   * could not be made throws (`CONNECTION_KEY_CHECK_FAILED`, `CONNECTION_PROVIDER_ERROR`).
   */
  async check(secretName: string): Promise<ApiResponse<Secret>> {
    return this._post<Secret>(`/${encodeURIComponent(secretName)}/check`, {});
  }

  /**
   * Make a connected account work again, the way it was connected, under the same name. For an
   * `api_key` integration pass the new key; the call checks it with the provider and answers
   * `completed`. For an `oauth` integration pass nothing; the call answers `pending` with a consent
   * session to open and `complete`, exactly as for a first connect.
   */
  async reconnect(secretName: string, request: ReconnectConnectionRequest = {}): Promise<ApiResponse<ConnectionReconnect>> {
    return this._post<ConnectionReconnect>(
      `/${encodeURIComponent(secretName)}/reconnect`,
      request.fields ? { fields: request.fields } : request.apiKey ? { apiKey: request.apiKey } : {},
    );
  }

  /**
   * Finish an end user's connect flow, on a client from `anlyon.forUser(endUserId)`. The same as
   * `endUsers.confirmConnection(endUserId, flowId)` for the bound end user. A workspace client has
   * no end user to confirm for, and throws.
   */
  async confirm(flowId: string): Promise<ApiResponse<ConfirmedEndUserConnection>> {
    const endUserId = this.http.endUserId;
    if (endUserId === undefined) {
      throw new AnlyonError({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'connections.confirm() confirms for the end user of a forUser() client. Use endUsers.confirmConnection(endUserId, flowId) here.',
      });
    }
    return new EndUsersResource(this.http).confirmConnection(endUserId, flowId);
  }

  /**
   * Ask whether the consent finished. Answers `pending` until Anlyon has recorded the account,
   * then `completed` with the secret; poll it after opening `connectUrl`. Idempotent.
   * `reference` is deprecated: Anlyon records the account itself, and a reference that is not the
   * one it recorded is refused.
   */
  async complete(sessionId: string, options: { reference?: string } = {}): Promise<ApiResponse<ConnectSessionCompletion>> {
    return this._post<ConnectSessionCompletion>(
      `/sessions/${encodeURIComponent(sessionId)}/complete`,
      options.reference ? { reference: options.reference } : {},
    );
  }
}
