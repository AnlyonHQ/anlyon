# @anlyonhq/sdk

## 3.0.0

### Major Changes

- f5ef431: Removed the client namespaces of the retired features, whose API endpoints no longer exist: `client.messages`, `client.schedules`, `client.queues`, `client.workflows`, `client.memory`, `client.cache`, `client.files`, `client.sessions`, `client.context` and the URL groups and flow control namespaces, with their resource classes, the `@anlyonhq/sdk/workflows` and `@anlyonhq/sdk/nextjs/workflows` entry points (`serveWorkflow`, `WorkflowCancelledError`, `StepExecutionError`, `parseDuration` and the workflow types), the `PublishMessageBuilder` and `ScheduleBuilder` helpers, and the request and response types only they used (memory, files, cache, session, context, schedule, URL group, queue, flow control and publish types). `logs.forMessage()` and `logs.forSchedule()`, the `scheduleId` log filter and the `schedule` log type are gone, and so are `analytics.getScheduleStats()` and `analytics.getScheduleExecutions()`. `BudgetDimension` drops `cacheLookups` and `memoryOps`. `Message`, the failed delivery `dlq` returns, drops the retired features' routing key, which the API no longer returns. `dlq.retry()` is typed as `DLQRetryResult`, which adds the `messageId` the API has always returned. The billing and analytics types follow the API: `BillingPublicFeatures`, `BillingRawPricing`, `BillingPlanLimits`, `CurrentUsage`, `AnalyticsOverview` and `DeliveryAnalytics` lose the fields of the retired features. `BetaAllowances` drops the retired memory allowances: `storedMemories`, `memoryStorageMb` and `memoryProcessingAllowanceCents`. Webhook verification (`Receiver`, `verifyWebhookSignature`, every `serve()` adapter), `events`, `dlq`, the rest of `logs` and `analytics`, and every governed-execution resource are unchanged.

### Minor Changes

- 74ce096: `mcpUpstreams.register` takes `endUserKey: { header }`, for a header-authenticated MCP server each end user brings their own key to, and `McpUpstream` reports it. `mcpUpstreams.createConnectLink` now also makes a key link for such a server.

## 2.5.0

### Minor Changes

- 54d5961: `anlyon integrations find <name>` and `client.connections.findRoute(name)`: the best way for your agent to act in an app, why, and the next command or link, for any name. `anlyon connections add` refuses a name with no integration before asking anything, with that route as `fix`.
- dc5ace0: `client.mcpUpstreams`: register a remote MCP server, list its tools and adopt them as governed actions. `adopt` raises `SignOffRequiredError` with the link a person approves at.

### Patch Changes

- 3ed1bd4: An end user's connect-required error names what to connect. `EndUserConnectionRequiredError` gains `displayName`, the name the API gives: an integration's, or an MCP server's own for a tool adopted from one. `<ConnectPrompt>` shows it on the card, and the MCP server's `connect_required` result carries it and uses it in its message.

## 2.4.0

### Minor Changes

- a8cdc7f: `Approval.votes[].selfApproved` and `DecisionResult.selfApproved`: true when the decider's own app or API key requested the approval and they decided it as the only member who can decide approvals in its environment. With a second such member, deciding answers `403 SELF_APPROVAL_NOT_ALLOWED`.
- da84924: Removed `billing.getStripeConfig()` and the `StripeConfig` type. Anlyon's own plans no longer use Stripe and the console no longer reads a Stripe key, so `GET /api/v2/billing/stripe-config` is gone. Governing your own Stripe calls through Anlyon is unchanged.
- adb58b2: `actions.importFromOpenApi()` returns, for every imported operation, a `suggestion`: a risk class (`read`, `write`, `irreversible`, `destructive`), whether to require approval, and an impact declaration, with the reasons the spec gave for each. It is never applied by itself: pass `operations`, keyed by operationId or `"METHOD /path"`, to accept or override it per operation. Each imported action also reports `requiresApproval` and `customized`, the result reports `suggestedAllowedHosts`, and `ImportedAction.impact` is now any impact declaration rather than only one resource mutation. The import types are exported from the package root.
- 56eb83b: Packs can send a connected account as `{{connection:<integration>}}`, declared by the manifest's one `connection` secret for that integration. Installed as it is, such an action needs no workspace secret: a call made for an end user (`Anlyon-End-User`) uses that end user's own account, and any other call uses the environment's connected account. `client.packs.install(manifest, { credential: 'secret' })` (CLI `--credential secret`) binds it to the named workspace secret instead, as before, and a secret renamed with `secretNames` is always used by name. A plan lists each such account as a `connection` step that writes nothing. The first-party catalogue and workflow packs use it from this version; an older installer refuses them without writing anything.
- 4c51e37: New `client.audit` resource for audit records and the evidence export (Enterprise edition and Team plan): `listEvents(filter)` returns stored records newest first with a `nextBefore` cursor, `export({ from, to, format })` returns every record in a range as the JSON export document or CSV text, and `schema()` returns the JSON Schema of an `anlyon.audit.v1` record. Needs an operator key holding `audit:read`, which no key receives by default; a key sees only its own environment's records. Deduplicate records on `id`.
- 4beb7b6: `endUsers.createSession(endUserId, { ttlSeconds? })` mints a short-lived session token for one end user's browser, for the prebuilt components in `@anlyonhq/react`. It lasts 15 minutes by default (60 to 3600 seconds). The token can list, connect and disconnect that end user's accounts and, when the key has `end-users:approvals`, list and decide their own approvals. Nothing else. API keys only.
- 5611ee7: Act for your users. `client.forUser(endUserId)` returns a client bound to one of your users: every request carries `Anlyon-End-User`, the id is checked before anything is sent (1 to 128 of `A-Z a-z 0-9 . _ : @ -`), and the binding cannot be switched or leak to the parent client. `client.endUsers` adds `createConnectLink`, `confirmConnection` (the required server-side step after consent), `setConnection`, `listConnections`, `deleteConnection`, `erase`, `list({ cursor })`, and `approvals.list` / `approvals.decide`; `connections.confirm(flowId)` works on a bound client. `parseConnectRedirect(url)` reads `{ status, flowId, integration }` from the redirect. New typed errors: `EndUserNotConnectedError` and `EndUserReconnectRequiredError` (both `EndUserConnectionRequiredError`, with `integration`, `endUserId`, `connectUrl`, `expiresAt`), `EndUserRequiredError`, `EndUserMismatchError` and `RedirectUrlRequiredError`. `Approval` and `Invocation` gain `endUserId`, and their list params an `endUserId` filter.
- cc566a6: `client.functions.delete(name)` deletes a function: it leaves the list and refuses new runs, its versions and runs stay, and its name is free to use again. `impactLimits.create` takes `scope: 'end_user'` to give each end user the whole amount to themselves, and `ImpactLimit.scope` carries `kind`. New type: `ImpactLimitScope`.
- d203033: Function history. `client.functions` adds `listVersions(name)`, `getVersion(name, version | 'current')` (with the version's `source`) and `listRuns(name, { limit?, endUserId? })`. New types: `FunctionVersionListItem`, `FunctionVersionDetail`, `FunctionRunListItem`, `ListFunctionRunsOptions`.
- 208524b: Hosted functions. `client.functions` adds `create`, `list`, `publish(name, { language, source, allowedActions, inputSchema?, budgets?, straightThrough? })`, `run(name, { input?, mode?, planRunId? })` and `runs.get(id)`. A plan run with writes ends `awaiting_approval` with `plan.approval`; `run(name, { mode: 'apply', planRunId })` carries out the approved plan. On a `forUser()` client, runs and run reads carry `Anlyon-End-User`. `ApprovalKind` gains `function_plan`. New types: `HostedFunction`, `FunctionVersion`, `FunctionRun`, `FunctionRunPlan`, `FunctionRunReceipt`, `FunctionPlanApprovalPayload` and related.
- 7cce32e: Enterprise: `client.secretStores` (list, get, create, update, check, delete) configures your own AWS Secrets Manager or HashiCorp Vault for an environment, and `client.secrets.putExternal(name, { external: { store, path, key, version } })` creates a secret whose value is read from that store at dispatch and is not stored by Anlyon. If the store cannot produce it yet, the secret is still saved as `unreachable` and the response carries a `warning`. Managing stores needs the new privileged scopes `secret-stores:read` and `secret-stores:write`. `client.secrets.check(name)` records whether an external secret can be read now. `Secret.kind` can be `external`, `Secret.health.status` can be `unreachable`, and `Secret.external` names the store and path.
- 86b16b2: Workspaces have two new roles, `approver` (reads everything and decides approvals) and `viewer` (only reads). The SDK exports `WorkspaceRole`, and `auth.identity()` returns `role`: the person's role in the environment for a session or OAuth login, `null` for an API key. `anlyon whoami` shows it.

### Patch Changes

- 44704cc: `endUsers.createConnectLink()` works for API-key integrations too: the link opens a hosted form where the end user pastes their own key, which Anlyon checks before keeping it, and your server confirms the connection as for OAuth. When the environment's connect confirmation is off, a link needs no redirect URL.
- 548c75b: `ConnectSession` no longer carries `consent`. Open `connectUrl` in a browser and poll `connections.complete(sessionId)` until it answers `completed`; Anlyon records the account itself when the provider sends the person back, so `complete` no longer needs a `reference`.
- 10e8285: `functions.getVersion` encodes the version in the path, as the Python SDK does. Every value it already accepted builds the same URL.
- 1da452b: `Invocation` gains `actionVersionId`, the immutable action version the call ran, and `DecisionCode` gains `END_USER_ERASED`, the decision on a call whose end user was erased while its approval was pending. Both are what the API already returns. Types only.
- 6551187: `ConnectionIntegration` gains `ownOAuthAppRequired`: present when the deployment has no OAuth app of its own for a listed sign-in integration, so a sign-in needs the environment's own app (`400 OWN_OAUTH_APP_REQUIRED` until it is set).
- 6dd796d: Types that match what the API returns and accepts. All additive: no call changes shape.
  
  - `actions.invocations()`, `actions.invocationsFor()`, `actions.effects()` and `approvals.list()` take `actingFor: 'workspace' | 'end_users'`. `actions.effects()` also takes `endUserId`, `invocationsFor()` takes the same filters as `invocations()`, and `approvals.list()` takes `decider: 'team' | 'end_user'`.
  - `endUsers.erase()` is typed as what it returns: `{ connectionsDeleted, approvalsCancelled, countersCleared, erasedAs }` (`EndUserErasure`). It was typed `{ erased: boolean }`, which the API never sent.
  - Approval policies carry `decidedBy: 'team' | 'end_user'`, and create and update take it. An `Approval` carries `decider`.
  - A successful response carries `requestId`, read from `X-Request-Id`, for support and logs. It is non-enumerable, so `JSON.stringify` and equality checks are unchanged.
  - `createConnectLink()`'s `integration` docs no longer say OAuth only: an API-key integration opens Anlyon's own key page. `EndUserConnectLink` carries `integration`.
- 1fc0f36: The SDK now depends on Zod 4 (`^4.6.6`), which fixes GHSA-mrhx-c7xc-m3w5: a Zod release before 4.6.6 can exhaust memory validating an oversized constrained collection. Your own schemas keep working with Zod 3 or 4: the `schema` option of a workflow is typed by its `safeParse` (the new `PayloadSchema` type) rather than by one Zod version, and the optional `zod` peer range is now `^3.20.0 || ^4.0.0`.

## 2.3.0

### Minor Changes

- 1199529: Connected accounts, Action Packs, governed OpenAPI import and list read-backs.
  
  `client.connections` connects an integration's account and keeps it working: `integrations()`, `list()`, `connectWithApiKey({ integrationId, secretName, apiKey })` for an integration that connects with a key, `createSession()` for one you sign in to, `check(name)` and `reconnect(name, { apiKey? })`. A connected account is a secret bound to the integration's API hosts; `Secret` gains `integrationId` and `health`.
  
  `client.packs.plan()` and `client.packs.install()` install an `anlyon-pack/v1` manifest: secrets, actions, approval policies (installed disabled) and suggested limits. A pack action is a `read` (no impact, no read-back) or a `write` (governed; its read-back is optional where the provider has none). `packActionKind`, `validatePackManifest`, action filters, secret renames and references between packs are exported.
  
  `client.actions.importFromOpenApi(spec, { governed })` brings writes in as governed actions and reports a `proposedVerify` read-back to accept.
  
  A read-back match path may use a `*` segment for any item of a list, and `absent: true` holds only when no value there equals the expected one (`ActionVerifyMatch.absent`).

## 2.2.0

### Minor Changes

- a22f4eb: Declared actions and receipt grades. `client.actions.create()` and `client.actions.update()` accept `impact`, `verify` and `governed`, and the new `client.actions.declare(ref, { impact, verify, governed })` sets them on an existing action. On update and on `declare()`, `null` removes a declaration, a field you leave out keeps what the action declares, and `governed: false` removes them all. `Action` and `ActionVersion` return `governed`, `impact` and `verify`.
  
  Every effect now carries a `grade`: `confirmed`, `acknowledged`, `unknown`, `failed`, `refused`, `denied` or `pending`. Invoke responses and single invocation reads carry it too when the invocation created an effect. `client.actions.effects({ grade })` filters the list by grade.
  
  Impact limits accept a workspace-declared unit such as `emails` as their `dimension`, and each limit returns its `unit`.
  
  New exported types: `ActionImpactDeclaration`, `ActionVerifyDeclaration`, `ActionImpactDeclarationInput`, `ActionVerifyDeclarationInput`, `ActionVerifyMatch`, `ActionDeclarationsInput`, `EffectGrade`, `ImpactDimension`, `ImpactBound` and `DeclaredImpactQuantity`.
  
  Type change: `ImpactQuantity` gains a third member for declared units, and `dimension` on `ImpactLimit`, `CreateImpactLimitRequest` and effect reservations widens from two literals to any declared unit. Code that switches on `dimension` should handle a unit it does not know. After narrowing a quantity to `money`, `currency` now reads as `string | undefined` under strict TypeScript.
- 3ef1b1e: A plan allows a total number of environments, of any kind. `BillingPlanLimits.maxEnvironments` and `BetaAllowances.environments` are typed `number | 'unlimited'`. They were objects keyed by `development`, `staging` and `production`. Code that read `limits.maxEnvironments.production` reads `limits.maxEnvironments`.
  
  The API behind them changed on 2026-10-05. A new workspace starts with a protected Production environment on every plan, and Early Beta Access allows 3 environments. Environment protection, promotion between environments and the email notification channel are included during Early Beta Access, so `features.protectedProduction` and `features.controlledPromotion` come back `true` there.
  
  The `stripe.refund` adapter accepts a live or a test key. The action config names `mode: 'live'` or `mode: 'test'`, and the key must match it.

### Patch Changes

- bfd0f08: Package text corrected. No API change.
  
  `@anlyonhq/sdk` and `@anlyonhq/mcp-server`: the README no longer says releases carry npm provenance. The SDK README now says the client retries its own HTTP request on a timeout or a 429 or 5xx answer, and that every invoke carries an idempotency key. Both READMEs say that a tool your own code calls directly is not governed, and that a grade is a database record and is not signed. The package descriptions drop "production execution runtime".
  
  `@anlyonhq/mcp-server`: `server.json` describes `ANLYON_BASE_URL` as the base URL of the Anlyon API.
  
  `@anlyonhq/cli`: help text changes. `approvals approve` now reads "For a gated action, Anlyon runs the reviewed request once enough approvers agree" in place of "runs on the server immediately". The meaning printed for the `unknown` grade is now "No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it." The help banner and four other strings lose a dash or a semicolon. The package description drops "execution guarantees".
- 04c4c5d: Documentation and help-text corrections. No signature changes.
  
  `@anlyonhq/sdk`: a 409 `idempotency_request_in_progress` now names the Idempotency-Key the call sent, in the message and in `details.idempotencyKey`. A generated key was otherwise invisible, and only a call with that key reaches the original request. The SDK still does not resend a 409. The README quickstart now uses the `stripe.refund` adapter in test mode, in place of a template action against the Stripe API that got none of the shared limit, the bound approval or the grade. The README says a generated key is not returned in the response.
  
  `@anlyonhq/cli`: runtime messages lose prose semicolons and dashes. No meaning changes.
  
  `@anlyonhq/mcp-server`: the README names the scopes an agent key needs for the approval tools (`approvals:read` and `approvals:write`, beside `actions:read` and `actions:invoke`). In the OpenAI profile, `invoke_action` says not to run an unknown outcome again, and `decide_approval` says a gated action runs once enough approvers agree. The plugin listing and skill no longer say the plugin "does not move money". They say not to use it for that. The legacy `minSimilarity` description reads "0 to 1".
  
  `@anlyonhq/ai-sdk`: the legacy `minSimilarity` description reads "0 to 1". The README names the statuses the SDK resends: 429, 500, 502, 503 and 504.
- 3ef1b1e: Package text. The README status line is one sentence: "Anlyon is in early beta. The API contract can change before 1.0, and every change is announced in the changelog with a migration note." The Stripe example no longer says the adapter refuses a live key. It accepts a live or a test key that matches the action's `mode`.
- a604df7: An action invoke is never sent twice without an idempotency key.
  
  `@anlyonhq/sdk`: the client retries its own HTTP request on a timeout, a 429 or a 5xx. Until now `client.actions.invoke()` sent an `Idempotency-Key` only when you passed `idempotencyKey`, so a retry after a lost response could become a second invocation. The SDK now sends a key on every invoke. When you pass none it generates a UUID once per call and sends the same key on each transport retry of that call. The API answers a resend from the recorded invocation and does not run the action again. A key you pass is used unchanged. The same now holds for every other write on `client.actions` and for `client.approvals.request()`, `approve()` and `deny()`. Reads are unchanged, and retries are not disabled.
  
  A generated key covers one call. Two calls to `invoke` are two invocations, so pass your own `idempotencyKey` when your code may call `invoke` twice for the same business operation. If a retry arrives while the first request is still running, the API can answer 409 `idempotency_request_in_progress` where it would previously have started a second invocation.
  
  This is a patch because no signature or type changes. It fixes behaviour that contradicted the rule that Anlyon does not send an action twice.
  
  `@anlyonhq/mcp-server`: `invoke_action`, the per-action `action_<name>` tools, `request_approval` and `decide_approval` inherit the fix through the SDK. Tool text loses double spaces and semicolons in `request_approval`, `decide_approval`, `select_workspace`, the pending-approval reply of an action tool, the legacy `create_session`, `append_to_session`, `queue_publish` and `create_subscription` tools, and the OpenAI profile descriptions. No meaning changes.
  
  `@anlyonhq/cli`: the meaning printed for the `unknown` grade is now "No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it."
  
  `@anlyonhq/ai-sdk`: `invokeAction` and `requestApproval` inherit the fix through the SDK. The README no longer says `invokeAction` sends no idempotency key.
- 3103fe4: Your own notification preferences. `client.notifications.getMyPreferences()` returns the notification types you muted in the workspace, and `client.notifications.updateMyPreferences({ mutedTypes })` replaces them. A muted type is left out of your own list and unread count. It is still raised, still delivered to email, Slack, Discord and the webhook, and still shown to every other member. Both calls need a user, so an OAuth connection. An API key answers `403` `USER_IDENTITY_REQUIRED`.
  
  Scopes changed on the server. `markAsRead()`, `markAllAsRead()`, `delete()` and `updateMyPreferences()` need `notifications:write`, which is in the default set. `updatePreferences()` and `testWebhook()` need `notifications:manage`, which no key receives by default. A key that changed notification settings with `notifications:read` needs the new scope.
  
  New exported types: `MyNotificationPreferences` and `UpdateMyNotificationPreferencesRequest`.

## 2.1.0

### Minor Changes

- 66dcdbe: The README now leads with Actions, Secrets, Approvals and Receiving webhooks, and groups Memory, Sessions, Semantic cache, and Queues, schedules and workflows under a single "Legacy namespaces" heading at the end. The matching `Client` accessors carry a one-line JSDoc note saying they are supported but not part of the governed execution path. The npm keywords drop the memory, vector-search, message-queue and cron terms in favour of actions, approvals and secrets.
  
  Type change: `OnboardingStatus` and `OnboardingStep` follow the new server shape. The onboarding steps are now `api_key` and `first_invocation`, and the response carries `hasInvocations` and `totalInvocations` instead of `hasMessages`, `totalMessages` and `hasDeliverySecret`.

## 2.0.0

### Major Changes

- 483bd25: **Breaking:** remove the Connect resource (cross-agent messaging, presence and task handoff).
  
  `client.connect` and the `ConnectResource` class are gone, along with the exported types `ConnectHarness`, `ConnectMessageKind`, `ConnectTaskStatus`, `ConnectPeer`, `ConnectJoinRequest`, `ConnectJoinResult`, `ConnectDeliveryReceipt`, `ConnectMessage`, `ConnectSendRequest`, `ConnectInbox`, `ConnectCheckInboxParams`, `ConnectWaitForMessagesOptions`, `ConnectListMessagesParams`, `ConnectTask`, `ConnectCreateTaskRequest` and `ConnectListTasksParams`.
  
  Connect was never enabled for any workspace, so every call returned 404. No working code depended on it; code that references `client.connect` or these types stops compiling and should drop those calls.
  
  The Python SDK (`anlyon`) drops `Client.connect` and `AsyncClient.connect` (`ConnectResource`, `AsyncConnectResource`) in the same change.

## 1.4.1

### Patch Changes

- 56c1b4e: Fix the `anlyon-policy` CLI exiting 0 without doing anything when started through a symlink or a linked package directory (`node_modules/.bin` on POSIX, `npx`, `npm link`, pnpm and directory installs), which let a CI step such as `npx anlyon-policy apply` pass without applying. The bin now always runs, and exits 1 on unexpected errors.

## 1.4.0

### Minor Changes

- bc45eff: Add `client.approvalPolicies` and `client.auth`, and expose the persisted decision on invocations.
  
  `approvalPolicies` has `list`, `get`, `create`, `update`, `enable`, `disable` and `delete`, for deployment code that holds an operator credential with the privileged `policies:read` / `policies:write` scopes. Targeting is required on create (`matchKind`, plus `matchActionName` for one action). `update` follows the API's PATCH rules: a field you omit (or pass as `undefined`) is unchanged, and an explicit `null` clears a nullable matcher. The environment is the credential's own; there is no environment argument. An agent's runtime key does not hold these scopes and cannot change the policy that governs it.
  
  `auth.identity()` returns the caller's own credential: type, API key id (API keys only), workspace and environment, effective scopes and expiry. Use it at startup to check the key has what the application needs and nothing it should not.
  
  `Invocation.decision` carries why a request was allowed or refused (source, reason code, safe explanation, and the policy's name and version as they were), and stays the same after the policy is edited or deleted. `Approval.decisionOrigin` records whether a person, a policy or the system decided, and `approvals.list()` accepts `decisionOrigin`.
- bc45eff: Add Production and Growth plans, explicit billing allowances and usage policies, and an alert-only workspace budget read. Plan response validation accepts future plan identifiers. The prelaunch plan catalogue no longer exposes a purchasable Paygo entry; legacy workspace plan identifiers remain readable.

### Patch Changes

- bc45eff: Add `access` and `betaAllowances` to the billing plan types, for Early Beta Access.
  
  `GET /api/v2/billing/plan` and `GET /api/v2/billing/plans` now describe how a workspace is served: whether Early Beta Access allowances apply (`access.mode`), whether a paid plan can be bought at all (`access.paidPlansAvailable`), when monthly allowances reset (`access.usageResetsAt`), and the published allowances (`betaAllowances`). Both fields are optional and additive, so existing code keeps compiling.
  
  While paid plans are unavailable, the REST upgrade and card-setup endpoints fail with the machine-readable error code `PAID_PLANS_UNAVAILABLE` (HTTP 403) before any payment system is contacted. Check `access.paidPlansAvailable` rather than offering an upgrade unconditionally.

## 1.3.1

### Patch Changes

- 9f38c55: Package metadata points at the right repository, and support goes to support@anlyon.com.

## 1.3.0

### Minor Changes

- fbf2f97: Add the agent platform: Sessions + Context (state), Secrets + Actions + Approvals (trust), and Budgets (control).

  - `client.sessions` persistent conversation threads with automatic summarization.
  - `client.context` one call that assembles relevant memories plus the conversation tail into a token-budgeted, prompt-ready block.
  - `client.secrets` a write-only vault; values go in and are never returned.
  - `client.actions` hosted tools invoked by name; Anlyon holds the credentials, the agent never sees them.
  - `client.approvals` human-in-the-loop gates, including for gated actions.
  - `client.budgets` per-API-key spend caps with alerts and hard stops.

  MCP server gains `get_context`, `create_session`, `append_to_session`, `get_session_context`, `list_actions`, `invoke_action`, `request_approval` and `check_approval`. The AI SDK adapter gains the matching tools.

- fbf2f97: Wait for a human instead of polling, and turn Actions into real MCP tools.

  - `client.approvals.waitForDecision(id)` long-polls until the approval is approved, denied or expired. A timeout is not an error: you get the approval back still `pending`. `approvals.get(id, { waitSeconds })` exposes the underlying long-poll.
  - MCP: new `wait_for_approval` tool, so an agent's human-in-the-loop decision arrives inside the same turn.
  - MCP: every enabled Action in the workspace is now exposed as its own tool (`action_<name>`) with the action's real input schema define an action in the dashboard and it appears in the model's tool list. Gated actions return an instruction to call `wait_for_approval`. Opt out with `ANLYON_MCP_DYNAMIC_ACTIONS=0`.
  - AI SDK: new `anlyonWaitForApprovalTool`, included in `createAnlyonTools`.

- fbf2f97: Add Events, Files, and Semantic Cache resources
- fbf2f97: Import an API, edit a session, and wrap any model in Anlyon.

  - `client.actions.importFromOpenApi(spec, opts)` turn an OpenAPI 3.x spec into hosted tools in one call. Operations that cannot be expressed faithfully come back in `skipped` with a reason rather than becoming an action that looks right and isn't; constraints outside Anlyon's schema subset (`format`, `minimum`, …) are dropped and listed per-action in `warnings`. Supports `dryRun`, `auth` (a vaulted secret as a header), `requiresApproval` and `only`.
  - `client.sessions.popMessage(id)` / `clearMessages(id)` undo the last turn, or truncate a thread while keeping its id. Message indexes stay contiguous.
  - AI SDK: `anlyonCacheMiddleware(client, opts)` adds semantic caching to any model in one line a question already answered (or one close enough) skips the model entirely. `anlyonSessionMiddleware(client, { sessionId })` persists every turn to an Anlyon session.

  **Behaviour change:** a body template whose value is exactly `{{input.x}}` now sends the input's real type (`1200`, not `"1200"`), and omits the field entirely when the input is absent. Header templates are unchanged a header is always a string.
