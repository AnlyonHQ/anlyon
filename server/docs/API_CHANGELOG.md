# API changelog

This changelog records externally visible changes to the canonical `/api/v2`
contract. Dates are UTC. Additive changes are listed alongside deprecations so
SDK and integration owners can assess upgrade impact.

Changes to operations that only Anlyon's hosted service serves are recorded with that service,
not here. Every entry below applies to this server.

## 2026-11-23

### Security

- `POST /api/v2/workspaces/{workspaceId}/members` is retired and answers `410 USE_INVITATIONS` for
  every request. Adding a person by user ID skipped their consent: an admin could put any account
  in a workspace, and with enforced SSO lock it out of sign-in. Invite people with
  `POST /api/v2/workspaces/{workspaceId}/invitations`.

## 2026-11-19 (unreleased)

Fixes before the first release.

### Added

- `McpUpstream.endUserKey.integration`: what an end user's key for that server is stored under, the
  `integration` of `PUT /api/v2/end-users/{endUserId}/connections/{integration}`. Until now it could
  only be read from a `409 END_USER_NOT_CONNECTED`.

### Changed

- An `operationKey` is one operation for one end user. Sent again with the same request for a
  different end user (or for none), it answers `409 OPERATION_KEY_REUSE` instead of replaying the
  first end user's result.
- `400 INVALID_SCOPE` keeps `error.details.invalidScopes` in production, as documented.

## 2026-11-16 (unreleased)

Private network destinations become an instance setting on self-hosted installs.

### Added

- Instance setting `network.private_destinations` (environment `PRIVATE_NETWORK_DESTINATIONS`) in
  the new instance-settings group `network`: `workspace` (the default) leaves it to each workspace's
  admins whether its audit sinks and secret stores may reach private network addresses, as before;
  `off` refuses it in every workspace, whatever the workspace chose. `InstanceSetting.group` gains
  the value `network` (acknowledged in `contracts/breaking-change-acknowledgements.json`).

### Changed

- With `network.private_destinations` set to `off`: `AuditSettings.privateDestinationsAvailable` and
  `SecretStoreSettings.available` are `false`; `PUT /api/v2/workspaces/{workspaceId}/audit/settings` with
  `allowPrivateDestinations: true` and `PUT /api/v2/secret-store-settings` with
  `allowPrivateNetwork: true` answer `400`; turning either off is still accepted; deliveries and
  store reads no longer reach private addresses. A workspace's stored choice is kept and applies
  again if the instance admins go back to `workspace`. Nothing changes where the setting is left at
  its default, and nothing changes on cloud, which never allows private destinations.

## 2026-11-15 (unreleased)

### Added

- The dead-letter queue (`/api/v2/dlq`) and the first-run sandbox (`POST /api/v2/sandbox/token`,
  `POST /api/v2/public/sandbox/echo`) are served by every edition, the self-hosted ones included.
  The dead-letter queue is how a failed event-webhook delivery is listed and replayed; the sandbox
  is the destination of the console's first-run tour. Their behaviour is unchanged.

## 2026-10-24 (unreleased)

One Admin role. Owner and admin merge into admin; former owners become admins with
emergency access.

### Added

- `PUT /api/v2/workspaces/{workspaceId}/members/{userId}/emergency-access` (`{ enabled: boolean }`).
  Only an admin with emergency access may call it; `409 EMERGENCY_ACCESS_LIMIT` past two,
  `409 LAST_EMERGENCY_ACCESS_ADMIN` for the last one, `409` for a non-admin target.
- `WorkspaceMember.emergencyAccess` and `WorkspacePermissions.emergencyAccess`.
- `409 LAST_ADMIN` on demoting, removing or leaving as the last admin.
- `400 OWNER_ROLE_RETIRED` when a request body sends `role: "owner"` (add member, change role,
  invite). Clients send `admin`.
- Audit events `member.emergency_access_granted` and `member.emergency_access_removed`.

### Changed

- `workspace.delete` and `environments.delete` are held by admins.
- Changing SSO enforcement, and removing a required provider, need emergency access instead of the
  owner role. SSO enforcement and SCIM exempt emergency-access admins instead of the owner.
- Responses never return `role: "owner"`; the value stays in the `WorkspaceRole` enum. The permission
  `ownership.transfer` is granted to no one and stays in the enum.

### Deprecated

- `POST /api/v2/workspaces/{workspaceId}/transfer-ownership` hands the caller's emergency access to
  `newOwnerId` (who becomes an admin). Replacement: the emergency-access endpoint above. Removal:
  2027-04-24.

## 2026-10-19 (unreleased)

### Added

- `POST /api/v2/actions/import` suggests, for every imported operation, a risk class (`read`,
  `write`, `irreversible` or `destructive`), whether to require approval, and an impact declaration,
  in `created[].suggestion` with the `reasons` that produced them. The suggestion is read from the
  spec alone: the method, the path, the operation's words, the request fields (an integer amount
  next to a currency, a `to` or `recipients` field) and the vendor extensions `x-anlyon-risk`,
  `x-anlyon-impact`, `x-destructive`, `x-irreversible`, `x-read-only` and MCP's `readOnlyHint` and
  `destructiveHint`. It is never applied by itself.
- The request accepts `operations`, a map from operationId or `METHOD /path` to
  `{ requiresApproval?, impact? }`, to accept or override a suggestion per operation. `impact: null`
  imports that operation ungoverned. A key that names no operation, an operation named twice, or an
  impact an action would not accept answers `400` before anything is created.
- Each `created[]` entry also returns `requiresApproval` and `customized`, and the result returns
  `suggestedAllowedHosts`: the hosts the credential could be limited to, from the base URL and the
  spec's servers. Set them as the secret's `allowedHosts` to apply them.
- SDKs: `ImportActionsOptions.operations` and the new result fields (TypeScript), and
  `operations=` on `actions.import_openapi` (Python).

### Changed

- `created[].impact` is no longer always `{ dimension: "resource_mutations", amount: "1", bound:
  "exact" }`: an operation named in `operations` returns the impact chosen for it, which may carry a
  `unit`. An import that names no operation returns exactly what it did before.

## 2026-10-03 (unreleased)

### Breaking

- The notifications routes no longer accept `notifications:read` for writes. Three levels replace it.
  - `notifications:read`: the `GET` operations, unchanged.
  - `notifications:write` (new): `PATCH /api/v2/notifications/{id}/read`,
    `PATCH /api/v2/notifications/read-all`, `DELETE /api/v2/notifications/{id}` and the new
    `PATCH /api/v2/notifications/preferences/me`. It is an ordinary scope. It is in the default
    API-key set and in the `anlyon:observability` consent group.
  - `notifications:manage` (new, privileged): `PATCH /api/v2/notifications/preferences` and
    `POST /api/v2/notifications/preferences/test-webhook`. No key receives it by default. The
    sensitive consent group `anlyon:integrations` (Notification channels) alone grants it.
    A console session or an OAuth connection also needs the admin role for these two.
  Without the scope a call answers `403`.
- OAuth tokens issued before 2026-10-03 do not carry `notifications:write` or
  `notifications:manage`. An existing OAuth client must re-consent before it can mark notifications
  read, dismiss them, or change notification settings. API keys created before that date that
  changed notification settings with `notifications:read` need the new scope. A key stored with an
  explicit scope list keeps that list, so it needs `notifications:write` added to mark read or
  dismiss.
- `ApiKeyScope` gains `notifications:write` and `notifications:manage`. A client that validates
  scopes against a closed list must accept both.

### Added

- Your own notification preferences: `GET /api/v2/notifications/preferences/me`
  (`notifications:read`) and `PATCH /api/v2/notifications/preferences/me` (`notifications:write`,
  no role needed). The body is `{ mutedTypes }`, at most 12 notification types. Both need a user,
  so a console session or an OAuth connection. An API key answers `403` `USER_IDENTITY_REQUIRED`.
- For a caller with a user, `GET /api/v2/notifications` and `GET /api/v2/notifications/unread-count`
  leave out the types that user muted. Nothing changes for other members or for an API key. Delivery
  to email, Slack, Discord and the webhook is unaffected.
- SDKs: `notifications.getMyPreferences()` and `notifications.updateMyPreferences({ mutedTypes })`
  in TypeScript, `notifications.my_preferences()` and
  `notifications.update_my_preferences(muted_types=...)` in Python, sync and async.
- `adapter.type` on `POST /api/v2/actions` and `PATCH /api/v2/actions/{ref}` accepts
  `resend.email_send` (config `domain`, optional `fromAddresses`). Its impact dimension is `emails`,
  one per recipient across `to`, `cc` and `bcc`. `succeeded` means Resend accepted the send. A
  matched read-back of the email id grades the effect `confirmed`. It offers same-key replay within
  Resend's 24-hour idempotency window. Additive: a client that switches on `adapter.type` must
  handle the new value.

## 2026-09-29 (unreleased)

### Behaviour

- `POST .../effects/{id}/replay` passes the same controls as a first dispatch (preview binding and
  expiry, approval, current action version, halt, requesting credential, current policy,
  dependencies). Every refusal, including an unsupported adapter, an effect that is not
  `unknown`, a passed idempotency window, a released allowance and a write in flight, is `409`
  `REPLAY_REFUSED` with `details.reason` and `details.outcome`, recorded in the effect's evidence.
  Only adapters with a provider idempotency key offer replay; `github.file_update` does not.
- After the first dispatch, only the provider's own record of the operation in a failed state
  settles an effect `failed`. A lookup that finds nothing (for `stripe.refund`, including a refund
  whose `anlyon_effect` metadata was removed) and a replay that fails or never sends leave it
  `unknown` with its allowance held, until the provider shows the result or an operator resolves it.
- `POST /api/v2/actions/invocations/{id}/resolve` refuses an invocation governed by an effect with
  `409` `EFFECT_RESOLUTION_REQUIRED` (`details.effectId`); resolve the effect instead.

## 2026-09-28 (unreleased)

### Added

- Governed effects (additive). `POST /api/v2/actions` and `PATCH /api/v2/actions/{ref}` accept an
  `adapter` (`stripe.refund`, `github.file_update`); an adapter action needs no `urlTemplate`.
  `Action` and `ActionVersion` return `adapter` (null for template actions); `Invocation` returns
  `effectId` (null for template actions).
- `POST /api/v2/actions/{ref}/invoke` accepts, for adapter actions only, `operationKey`,
  `previewId`, `dependsOn` and `compensates`. New `409` codes: `OPERATION_KEY_REUSE`,
  `PREVIEW_MISMATCH`, `PREVIEW_EXPIRED`, `PREVIEW_ALREADY_USED`, `DEPENDENCY_UNRESOLVED`.
- Effects: `GET /api/v2/actions/effects`, `GET /api/v2/actions/effects/{id}`,
  `POST .../effects/{id}/reconcile` (read-only), `POST .../effects/{id}/notes`,
  `POST .../effects/{id}/resolve` (manual, labelled `verification: manual`) and
  `POST .../effects/{id}/replay` (a governed same-identity write). Reconcile, notes and resolve
  remain available while the environment is halted.
- Previews: `POST /api/v2/actions/{ref}/previews`, `GET /api/v2/actions/previews/{id}`,
  `POST /api/v2/actions/previews/{id}/refresh`.
- Impact limits: `GET|POST /api/v2/impact-limits`, `GET|PATCH|DELETE /api/v2/impact-limits/{id}`.
- Scopes `impact-limits:read` (default set; `anlyon:actions` consent group) and
  `impact-limits:write` (privileged, never granted by default).

### Behaviour

- For adapter actions, a gated approval can expire no later than the preview it approves, and a
  dispatch refused by a control records the invocation as `failed` with `Dispatch refused (<reason>)`.
  Template actions are unchanged.

## 2026-09-27 (unreleased)

- Gated invocations now reserve their durable idempotency identity atomically with
  approval admission and linkage. Quota refusal or an approval-write failure leaves
  no stranded invocation/key; concurrent duplicates replay the accepted invocation.
- Approval policies accept a CEL `condition`, with save-time schema checks, trusted
  `environment.id`, and bounded isolated evaluation. Missing fields, timeouts and runtime
  failures require approval. Conditions use JavaScript regular-expression syntax for `matches`.
- Added policy-only evaluation and immutable policy-version history, including deletion
  evidence and actor/change-note provenance. Policy files support read-only plan, atomic apply with ownership and stale-plan checks,
  and policy-only fixture testing through the API, both SDKs and the TypeScript CLI.
- Invocation idempotency records identity durably and returns current state, including when
  Redis still has an older result. Cached pre-migration effects without durable identity are
  preserved to prevent duplicate dispatch; their response may remain a historical snapshot.
- Added operator resolution of unknown invocations with immutable evidence and the opt-in
  `actions:resolve` scope; deliberate retries require a new key and a `retryOf` link. The
  requesting key cannot resolve its own invocation.
- Approval detail responses include votes and final-decider attribution. Console admins can
  request a reviewed CEL draft within complimentary per-plan monthly allowances.
- Destination 5xx responses (recorded as `unknown`) no longer bill at dispatch. Their
  action-invoke quota and budget are held until the invocation is resolved: `succeeded`
  bills once, `failed` releases the quota and refunds the budget. 2xx and 4xx still bill
  immediately. Resolution stamps a missing `completedAt` from the database clock.
- `GET /api/v2/actions/invocations` and `GET /api/v2/actions/{ref}/invocations` accept
  `status=denied` and `status=expired`, which previously returned 400. Additive.
- Vigil audit verdicts (`POST /api/v2/workspaces/{workspaceId}/approvals/{approvalId}/advice/audit`)
  require the workspace admin role (members get 403) and can be recorded once, only on a
  decision sampled for audit; otherwise 409 `CONFLICT`. Previously any member could record
  or overwrite a verdict.
- Added `POST /api/v2/sandbox/token` (dashboard session only): mints a throwaway token signed
  for the calling workspace, which the first-run tour seals as `DEMO_API_TOKEN`. It authorizes
  nothing and stores nothing. `POST /api/v2/public/sandbox/echo` calls bearing a verified
  token are rate limited per workspace instead of by IP, since the executor sends every
  tour call from one egress IP. Anonymous and unverifiable callers stay IP-limited.

## 2026-09-25

### Added

- `POST /api/v2/public/sandbox/echo`: an unauthenticated, stateless echo used
  as the destination of the dashboard's first-run tour. It answers with the
  method, Authorization header, content type and body it received; called
  through an action, the echoed secret is redacted by Anlyon before the
  invocation is stored or returned. Bodies over 16 KB are refused; rate limited
  by IP with the other public routes.

## 2026-09-24

### Added

- Anlyon Vigil, the approval assistant (Beta, opt-in, dashboard sessions only):
  `GET`/`PUT /workspaces/{workspaceId}/assistant`,
  `GET /workspaces/{workspaceId}/assistant/policy-suggestions`,
  `POST /workspaces/{workspaceId}/assistant/policy-suggestions/{key}/accept`, and
  `POST /workspaces/{workspaceId}/approvals/{approvalId}/advice/audit`, and
  `GET /workspaces/{workspaceId}/assistant/audit-queue` (Vigil approvals
  picked for audit that no one has checked yet).
- `Approval.advice` on session responses for opted-in workspaces. API-key
  callers never receive it.
- `decisionOrigin` value `assistant` (also accepted by the `decisionOrigin`
  list filter and included in `automated`), and invocation decision
  `source: assistant` with `code: ASSISTANT_APPROVED`. Additive: clients that
  switch on these enums should handle the new value.

### Changed

- Action invocations: a received `5xx` from the destination is now recorded as
  `unknown` (previously `failed`), with `responseStatus` kept and an
  instruction to reconcile before retrying. A server error does not establish
  that the change was not applied. A `4xx` remains `failed`.
- Action invocations: a `2xx` whose response body cannot be read after the
  status arrived is recorded as `succeeded` with `body` noting the body was
  unavailable (previously `failed`).
- Actions whose headers declare `Content-Type: application/x-www-form-urlencoded`
  now send a form-encoded body (bracket notation for nested values) instead of
  JSON under that content type. OpenAPI import accepts form-encoded request
  bodies and sets the header.

## 2026-07-13

### Added

- Completed canonical coverage for all 215 backend operations and explicitly
  classified the 174 API-key-accessible operations supported by both SDKs.
- Added request IDs, scopes, standard errors, idempotency policy, deterministic
  request/response examples, SDK support snapshots, and docs drift checks.

### Changed

- Authentication is documented as `Authorization: Bearer <api-key>`.
- Tenant-internal and provider identifiers are removed from public resources;
  credentials and notification/log secrets are redacted or write-only.
- Pagination uses the documented `OffsetPagination` shape with `hasMore`.
- Python successful responses now expose `ApiResponse.success`, `.data`,
  `.pagination`, `.stats`, and `.request_id`. Legacy direct-data access remains
  compatible until the next major Python SDK release.
