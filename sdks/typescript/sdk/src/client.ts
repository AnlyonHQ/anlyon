/**
 * Anlyon SDK Client
 */

import type { AnlyonClientConfig } from './types/config';
import { HttpClient } from './core/http-client';
import { DlqResource } from './resources/dlq';
import { AnalyticsResource } from './resources/analytics';
import { EventsResource } from './resources/events';
import { RunsResource } from './resources/runs';
import type { StreamEvent, StreamOptions } from './types/stream';
import { SecretsResource } from './resources/secrets';
import { SecretStoresResource } from './resources/secret-stores';
import { ConnectionsResource } from './resources/connections';
import { PacksResource } from './resources/packs';
import { ActionsResource } from './resources/actions';
import { EnvironmentResource } from './resources/environment';
import { ApprovalsResource } from './resources/approvals';
import { BudgetsResource } from './resources/budgets';
import { ImpactLimitsResource } from './resources/impact-limits';
import { SignOffsResource } from './resources/sign-offs';
import { McpUpstreamsResource } from './resources/mcp-upstreams';
import { AuditResource } from './resources/audit';
import { ApprovalPoliciesResource } from './resources/approval-policies';
import { AuthResource } from './resources/auth';
import { BillingResource } from './resources/billing';
import { NotificationsResource } from './resources/notifications';
import { IntegrationsResource } from './resources/integrations';
import { LogsResource } from './resources/logs';
import { EndUsersResource } from './resources/end-users';
import { FunctionsResource } from './resources/functions';
import { assertEndUserId } from './core/end-user';
import { AnlyonError } from './core/errors';
import { ERROR_CODES } from './types/errors';
import { verifyWebhookSignature } from './webhooks';
import type { WebhookVerificationResult } from './webhooks';

/** Carries the end user from `forUser()` into the new client. Not exported, so only it can set it. */
const END_USER_BINDING = Symbol('anlyon.endUser');
type BoundConfig = AnlyonClientConfig & { [END_USER_BINDING]?: string };

/**
 * Anlyon SDK Client
 *
 * The main entry point for interacting with the Anlyon API. The governed
 * execution path is `actions`, `secrets`, `approvals`, `approvalPolicies`,
 * `impactLimits`, `environment` and `runs`. The other namespaces below remain
 * supported on the same client.
 *
 * @example
 * ```typescript
 * import { Client } from '@anlyonhq/sdk';
 *
 * const client = new Client({
 *   apiKey: 'your-api-key',
 * });
 *
 * // Invoke a named action. Anlyon holds the credential and makes the call.
 * const { data } = await client.actions.invoke('refund-order', { charge: 'ch_1' });
 *
 * if (data!.pendingApproval) {
 *   await client.approvals.waitForDecision(data!.approvalId!);
 * }
 * ```
 */
export class Client {
  private readonly httpClient: HttpClient;
  private readonly config: AnlyonClientConfig;

  private _dlq?: DlqResource;
  private _analytics?: AnalyticsResource;
  private _events?: EventsResource;
  private _runs?: RunsResource;
  private _secrets?: SecretsResource;
  private _secretStores?: SecretStoresResource;
  private _connections?: ConnectionsResource;
  private _packs?: PacksResource;
  private _actions?: ActionsResource;
  private _environment?: EnvironmentResource;
  private _approvals?: ApprovalsResource;
  private _budgets?: BudgetsResource;
  private _impactLimits?: ImpactLimitsResource;
  private _signOffs?: SignOffsResource;
  private _mcpUpstreams?: McpUpstreamsResource;
  private _audit?: AuditResource;
  private _approvalPolicies?: ApprovalPoliciesResource;
  private _auth?: AuthResource;
  private _billing?: BillingResource;
  private _notifications?: NotificationsResource;
  private _integrations?: IntegrationsResource;
  private _logs?: LogsResource;
  private _endUsers?: EndUsersResource;
  private _functions?: FunctionsResource;

  /**
   * Create a new Anlyon client
   *
   * @param config - Client configuration
   *
   * @example
   * ```typescript
   * // Basic usage
   * const client = new Client({
   *   apiKey: process.env.ANLYON_API_KEY!,
   * });
   *
   * // With all options
   * const client = new Client({
   *   apiKey: process.env.ANLYON_API_KEY!,
   *   baseUrl: 'https://api.anlyon.com',
   *   timeout: 30000,
   *   retry: {
   *     maxAttempts: 5,
   *     initialDelay: 100,
   *     maxDelay: 10000,
   *   },
   *   logging: {
   *     enabled: true,
   *     level: 'debug',
   *   },
   * });
   * ```
   */
  constructor(config: AnlyonClientConfig) {
    if (!config.apiKey) {
      throw new Error('API key is required');
    }
    const { [END_USER_BINDING]: endUserId, ...rest } = config as BoundConfig;
    this.config = rest;
    this.httpClient = new HttpClient(rest, endUserId);
  }

  /**
   * A client that acts for one of your users. Every request it makes carries
   * `Anlyon-End-User: <endUserId>`, so actions use that end user's own connections and count
   * against their limits, and their approvals and receipts carry the id.
   *
   * Your server states the end user, and the model never does: build this client from your own
   * session, and hand it to the tool adapter. The binding is fixed. This client cannot be switched
   * to another end user, and the client you call it on stays a workspace client.
   *
   * @param endUserId - Your id for the user: 1 to 128 characters from `A-Z a-z 0-9 . _ : @ -`.
   *   Checked here, before anything is sent.
   *
   * @example
   * ```typescript
   * const anlyon = new Client({ apiKey: process.env.ANLYON_API_KEY! });
   * const forUser = anlyon.forUser(session.user.id);
   *
   * try {
   *   await forUser.actions.invoke('gmail.send', { to, subject, body });
   * } catch (error) {
   *   if (error instanceof EndUserNotConnectedError) return { connectUrl: error.connectUrl };
   *   throw error;
   * }
   * ```
   */
  forUser(endUserId: string): Client {
    assertEndUserId(endUserId);
    const bound = this.httpClient.endUserId;
    if (bound !== undefined) {
      if (bound === endUserId) return this;
      throw new AnlyonError({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'This client already acts for an end user and cannot be switched. Call forUser() on the client it was built from.',
      });
    }
    return new Client({ ...this.config, [END_USER_BINDING]: endUserId } as BoundConfig);
  }

  /** The end user this client acts for, or `undefined` for a workspace client. */
  get endUserId(): string | undefined {
    return this.httpClient.endUserId;
  }

  /**
   * Dead Letter Queue: event-webhook deliveries that ran out of retries. List, inspect,
   * replay or delete them.
   *
   * @example
   * ```typescript
   * // List failed messages
   * const failed = await client.dlq.list();
   *
   * // Retry a message
   * await client.dlq.retry('msg_id');
   *
   * // Retry all failed messages
   * await client.dlq.retryAll();
   *
   * // Get DLQ stats
   * const stats = await client.dlq.getStats();
   * ```
   */
  get dlq(): DlqResource {
    return (this._dlq ??= new DlqResource(this.httpClient));
  }

  /**
   * Analytics resource for accessing usage and performance data
   *
   * @example
   * ```typescript
   * // Get message statistics
   * const stats = await client.analytics.getMessageStats({
   *   startDate: new Date('2024-01-01'),
   *   endDate: new Date('2024-01-31'),
   * });
   *
   * // Get time series data
   * const series = await client.analytics.getTimeSeries({ granularity: 'day' });
   * ```
   */
  get analytics(): AnalyticsResource {
    return (this._analytics ??= new AnalyticsResource(this.httpClient));
  }

  /**
   * Events resource  pub/sub topics, subscriptions, and publish.
   *
   * @example
   * ```typescript
   * await client.events.createTopic({ name: 'orders' });
   * await client.events.createSubscription('orders', {
   *   url: 'https://example.com/hooks',
   *   eventTypes: ['order.*'],
   * });
   * await client.events.publish({
   *   topic: 'orders',
   *   type: 'order.created',
   *   data: { orderId: '123' },
   * });
   * ```
   */
  get events(): EventsResource {
    return (this._events ??= new EventsResource(this.httpClient));
  }

  /** Runs  the agent trace model (runs and spans). */
  get runs(): RunsResource {
    return (this._runs ??= new RunsResource(this.httpClient));
  }

  /**
   * Subscribe to the realtime event stream (runs, approvals, messages, …),
   * scoped to this key's workspace and environment. Reconnects automatically
   * with a resume cursor, so a dropped connection resumes without a gap.
   *
   * @example
   * ```typescript
   * const ac = new AbortController();
   * for await (const event of client.stream({ signal: ac.signal })) {
   *   if (event.type === 'run.started') console.log(event.data.runId);
   * }
   * ```
   */
  async *stream(options: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    for await (const message of this.httpClient.stream('/api/v2/stream', {
      signal: options.signal,
      lastEventId: options.cursor,
    })) {
      try {
        yield JSON.parse(message.data) as StreamEvent;
      } catch {
      }
    }
  }

  /**
   * The environment this key is bound to, and its kill switch.
   *
   * `halt` and `resume` need the `environments:halt` scope, which is not
   * granted by default  put an operator key holding it behind your runbook.
   *
   * @example
   * ```typescript
   * await operatorClient.environment.halt({ reason: 'runaway refund loop' });
   * ```
   */
  get environment(): EnvironmentResource {
    return (this._environment ??= new EnvironmentResource(this.httpClient));
  }

  /**
   * Secrets resource  a write-only vault. Values go in and are never returned;
   * actions use them without the agent ever seeing them.
   *
   * @example
   * ```typescript
   * await client.secrets.put('STRIPE_KEY', {
   *   value: process.env.STRIPE_KEY!,
   *   allowedHosts: ['api.stripe.com'],
   * });
   * ```
   */
  get secrets(): SecretsResource {
    return (this._secrets ??= new SecretsResource(this.httpClient));
  }

  /**
   * Secret stores (Enterprise): your own AWS Secrets Manager or HashiCorp Vault. A secret created
   * with `secrets.putExternal` is read from one at dispatch, and Anlyon does not store its value.
   */
  get secretStores(): SecretStoresResource {
    return (this._secretStores ??= new SecretStoresResource(this.httpClient));
  }

  /**
   * Connected accounts  secrets whose access token is fetched at dispatch from an account
   * connected at a provider. The token is never returned.
   *
   * @example
   * ```typescript
   * const { data: session } = await client.connections.createSession({ integrationId: 'hubspot', secretName: 'HUBSPOT' });
   * // open session.connectUrl in a browser, then:
   * const { data } = await client.connections.complete(session.sessionId);
   * ```
   */
  get connections(): ConnectionsResource {
    return (this._connections ??= new ConnectionsResource(this.httpClient));
  }

  /**
   * Action Packs  install a governed workflow (secrets, declared actions, disabled approval
   * policies, suggested limits) from an `anlyon-pack/v1` manifest. `plan` sends nothing.
   *
   * @example
   * ```typescript
   * const manifest = JSON.parse(await readFile('packs/outbound-sales/pack.json', 'utf8'));
   * const plan = await client.packs.plan(manifest);
   * const result = await client.packs.install(manifest, { withLimits: true });
   * ```
   */
  get packs(): PacksResource {
    return (this._packs ??= new PacksResource(this.httpClient));
  }

  /**
   * Actions resource  hosted tools the agent invokes by name.
   *
   * @example
   * ```typescript
   * const { data } = await client.actions.invoke('refund-customer', { charge: 'ch_1' });
   * ```
   */
  get actions(): ActionsResource {
    return (this._actions ??= new ActionsResource(this.httpClient));
  }

  /**
   * Approvals resource  human-in-the-loop gates.
   *
   * @example
   * ```typescript
   * const { data } = await client.approvals.request({ title: 'Send the contract?' });
   * ```
   */
  get approvals(): ApprovalsResource {
    return (this._approvals ??= new ApprovalsResource(this.httpClient));
  }

  /**
   * Budgets resource  per-API-key spend caps, alerts and hard stops.
   *
   * @example
   * ```typescript
   * await client.budgets.put(agentKeyId, { monthlyCostCentsCap: 500 });
   * ```
   */
  get budgets(): BudgetsResource {
    return (this._budgets ??= new BudgetsResource(this.httpClient));
  }

  /**
   * Impact limits resource  shared caps on money and resource mutations that governed effects
   * reserve before dispatch. Separate from budgets, which cap Anlyon usage.
   *
   * @example
   * ```typescript
   * const { data } = await client.impactLimits.list();
   * ```
   */
  get impactLimits(): ImpactLimitsResource {
    return (this._impactLimits ??= new ImpactLimitsResource(this.httpClient));
  }

  /**
   * Sign-off requests: loosening governance changes this credential asked for, which a human must
   * approve before they apply. A loosening write throws `SignOffRequiredError`; follow it here.
   *
   * @example
   * ```typescript
   * const decided = await client.signOffs.wait(error.signOffId);
   * ```
   */
  get signOffs(): SignOffsResource {
    return (this._signOffs ??= new SignOffsResource(this.httpClient));
  }

  /**
   * Remote MCP servers behind Anlyon: register one, list its tools, and adopt tools as governed
   * actions. Adopting always waits for a person's sign-off.
   *
   * @example
   * ```typescript
   * const { data } = await client.mcpUpstreams.list();
   * ```
   */
  get mcpUpstreams(): McpUpstreamsResource {
    return (this._mcpUpstreams ??= new McpUpstreamsResource(this.httpClient));
  }

  /**
   * Audit records and the evidence export (Enterprise edition and Team plan). Needs an operator
   * key holding `audit:read`; returns only the key's own environment's records.
   *
   * @example
   * ```typescript
   * const { data } = await client.audit.listEvents({ type: ['approval.*'] });
   * const csv = await client.audit.export({ from: '2026-10-01', to: '2026-11-01', format: 'csv' });
   * ```
   */
  get audit(): AuditResource {
    return (this._audit ??= new AuditResource(this.httpClient));
  }

  /**
   * Approval policies: configure which requests need approval, are auto-approved, or are auto-denied.
   * Needs an operator credential (`policies:read` / `policies:write`); an agent runtime key cannot
   * change the policy that governs it.
   *
   * @example
   * ```typescript
   * await operator.approvalPolicies.create({
   *   name: 'refund_order_denied', matchKind: 'action', matchActionName: 'refund_order', effect: 'auto_deny',
   * });
   * ```
   */
  get approvalPolicies(): ApprovalPoliciesResource {
    return (this._approvalPolicies ??= new ApprovalPoliciesResource(this.httpClient));
  }

  /** Inspect the credential this client uses: type, environment, effective scopes, expiry. */
  get auth(): AuthResource {
    return (this._auth ??= new AuthResource(this.httpClient));
  }

  /** Public plan, quota, usage, invoice, and browser-safe Stripe configuration. */
  get billing(): BillingResource {
    return (this._billing ??= new BillingResource(this.httpClient));
  }

  /** Workspace notifications and secret-safe delivery preferences. */
  get notifications(): NotificationsResource {
    return (this._notifications ??= new NotificationsResource(this.httpClient));
  }

  /** Slack and Discord notification integrations available to API-key clients. */
  get integrations(): IntegrationsResource {
    return (this._integrations ??= new IntegrationsResource(this.httpClient));
  }

  /** Redacted unified execution logs, statistics, and exports. */
  get logs(): LogsResource {
    return (this._logs ??= new LogsResource(this.httpClient));
  }

  /**
   * End users: connect your users' own accounts, list and remove their connections, decide the
   * approvals that belong to them, and erase them. To act for one, use {@link Client.forUser}.
   *
   * @example
   * ```typescript
   * const { data } = await anlyon.endUsers.createConnectLink({ endUserId: user.id, integration: 'gmail' });
   * // Send the user to data.url. Afterwards:
   * const { data: connections } = await anlyon.endUsers.listConnections(user.id);
   * ```
   */
  get endUsers(): EndUsersResource {
    return (this._endUsers ??= new EndUsersResource(this.httpClient));
  }

  /**
   * Functions: your code, hosted by Anlyon, calling your actions. A run plans its writes for
   * approval, then applies the approved plan. On a client from {@link Client.forUser}, every run
   * acts for that end user. Function runs are read with `functions.runs.get`, not `runs`.
   *
   * @example
   * ```typescript
   * const { data: plan } = await anlyon.functions.run('refund-with-checks', { input: { order: 'ord_123' } });
   * // Once plan.plan.approval is approved:
   * await anlyon.functions.run('refund-with-checks', { input: { order: 'ord_123' }, mode: 'apply', planRunId: plan!.id });
   * ```
   */
  get functions(): FunctionsResource {
    return (this._functions ??= new FunctionsResource(this.httpClient));
  }

  /**
   * Verify webhook signature
   *
   * Static method to verify message delivery webhook signatures.
   * Can also be imported directly: `import { verifyWebhookSignature } from '@anlyonhq/sdk'`
   *
   * @param payload - Raw request body as string
   * @param signatureHeader - Signature header value (format: "t=timestamp,v1=signature")
   * @param secret - Delivery secret configured for your workspace
   * @param toleranceSeconds - Maximum allowed time difference in seconds (default: 300 = 5 minutes)
   * @returns Verification result with `verified` boolean and optional error message
   *
   * @deprecated Use the `Receiver` class instead for a cleaner API
   *
   * @example
   * ```typescript
   * // Using static method
   * const result = Client.verifyWebhookSignature(
   *   JSON.stringify(req.body),
   *   req.headers['anlyon-signature'],
   *   process.env.ANLYON_SIGNING_SECRET!
   * );
   *
   * // Or use Receiver class (recommended)
   * import { Receiver } from '@anlyonhq/sdk';
   * const receiver = new Receiver({ signingSecret: process.env.ANLYON_SIGNING_SECRET! });
   * const isValid = receiver.verify({ signature, body });
   * ```
   */
  static verifyWebhookSignature(
    payload: string,
    signatureHeader: string,
    secret: string,
    toleranceSeconds: number = 300
  ): WebhookVerificationResult {
    return verifyWebhookSignature(payload, signatureHeader, secret, toleranceSeconds);
  }
}

/**
 * @deprecated Use `Client` instead. `AnlyonScheduler` is provided for backward compatibility.
 *
 * @example
 * ```typescript
 * // Old (deprecated)
 * import { AnlyonScheduler } from '@anlyonhq/sdk';
 * const client = new AnlyonScheduler({ apiKey: '...' });
 *
 * // New (recommended)
 * import { Client } from '@anlyonhq/sdk';
 * const client = new Client({ apiKey: '...' });
 * ```
 */
export const AnlyonScheduler = Client;
