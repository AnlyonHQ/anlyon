# @anlyonhq/ai-sdk

## 3.0.0

### Major Changes

- f5ef431: Removed the memory, files, semantic cache and context tools (`anlyonRecallTool`, `anlyonRememberTool`, `anlyonListFilesTool`, `anlyonGetDownloadUrlTool`, `anlyonCacheLookupTool`, `anlyonCacheStoreTool`, `anlyonGetContextTool`) and the cache and session middleware (`anlyonCacheMiddleware`, `anlyonSessionMiddleware` and their option types), whose API no longer exists. `createAnlyonTools(client, { legacy: true })` now adds only `publishEvent` and `listEvents`, and `LEGACY_TOOL_NAMES` lists those two. The default tools are unchanged.

### Patch Changes

- Updated dependencies [74ce096]
- Updated dependencies [f5ef431]
  - @anlyonhq/sdk@3.0.0

## 2.2.1

### Patch Changes

- Updated dependencies [3ed1bd4]
- Updated dependencies [54d5961]
- Updated dependencies [dc5ace0]
  - @anlyonhq/sdk@2.5.0

## 2.2.0

### Minor Changes

- 5611ee7: `anlyonTools({ client, actions })`: one tool per Anlyon action, with the action's own input schema, for any client including one from `anlyon.forUser(endUserId)`. When the end user has to connect, or connect again, a tool returns `{ status: 'connect_required' | 'reconnect_required', integration, connectUrl, message }` instead of throwing, so the model can tell the user and the app can render a Connect button. `invokeAction` does the same. No tool schema has an end-user field.
- 55a351c: The agent can now learn what happened after an approval, and tool results carry structured fields.
  
  - `anlyonTools()` adds `anlyon_check_request`, which reads a call and its approval with the same client (including a `forUser()` client) and reports approved and succeeded, declined, expired, still waiting, unknown (do not retry) or failed. A `pending_approval` result's message tells the model to call it with the `invocationId`. Pass `checkTool: false` to leave the tool out, or a string to rename it. `anlyonCheckRequestTool(client)` builds it on its own.
  - Action tool results add `effectId`, `endUserId`, `requestId` (when the API sends one), `code` and `limits`. A refusal is machine-readable: `code` is `impact_limit_exceeded` (with `limits: [{ name, requested, available }]`), `policy_denied`, `approval_denied` or `approval_expired`, and the message says nothing was sent and not to retry. `status` is unchanged, and errors that threw before still throw.
  - `body` is cut at 8,000 characters with a `…[truncated: N more characters]` marker and `bodyTruncated: true`; set `maxBodyChars` to change it. `invokeAction`'s sentence is capped the same way.
  - A connect-required result names the integration for people (`Gmail`, not `gmail`) and adds `displayName` and `endUserId`.
  - README: AI SDK v7's async `convertToModelMessages`, `zod` in the install line, `baseUrl` for staging and self-hosted, and Anthropic examples.

### Patch Changes

- Updated dependencies [a8cdc7f]
- Updated dependencies [da84924]
- Updated dependencies [44704cc]
- Updated dependencies [548c75b]
- Updated dependencies [adb58b2]
- Updated dependencies [56eb83b]
- Updated dependencies [4c51e37]
- Updated dependencies [4beb7b6]
- Updated dependencies [5611ee7]
- Updated dependencies [cc566a6]
- Updated dependencies [d203033]
- Updated dependencies [10e8285]
- Updated dependencies [208524b]
- Updated dependencies [1da452b]
- Updated dependencies [6551187]
- Updated dependencies [6dd796d]
- Updated dependencies [1fc0f36]
- Updated dependencies [7cce32e]
- Updated dependencies [86b16b2]
  - @anlyonhq/sdk@2.4.0

## 2.1.1

### Patch Changes

- Updated dependencies [1199529]
  - @anlyonhq/sdk@2.3.0

## 2.1.0

### Minor Changes

- bfd0f08: The default tools changed. `createAnlyonTools(client)` now returns the governed tools only: `listActions`, `invokeAction`, `requestApproval`, `checkApproval` and `waitForApproval`. It used to return 14 tools, including nine over the legacy namespaces.
  
  The legacy tools are `recall`, `remember`, `publishEvent`, `listEvents`, `listFiles`, `getDownloadUrl`, `cacheLookup`, `cacheStore` and `getContext`. They stay in the package and keep working, and they are off by default. To get them back, pass the opt-in:
  
  ```ts
  const tools = createAnlyonTools(client, { legacy: true });
  ```
  
  With the opt-in the governed tools come first, then the legacy ones. Each legacy tool is still exported on its own (`anlyonRecallTool` and the rest), and `anlyonCacheMiddleware` and `anlyonSessionMiddleware` are unchanged. No export was removed. This follows `@anlyonhq/mcp-server` 2.1.0, which hid its legacy tools behind `ANLYON_MCP_LEGACY_TOOLS=1`.
  
  If your prompts or code name a legacy tool from the default set, add `{ legacy: true }` when you upgrade.
  
  `invokeAction` no longer reports an `unknown` outcome as failed. It says the outcome is unknown, that the request may have reached the destination, and that the model must not invoke the action again. A `running` invocation is reported as running. The result text carries the receipt grade when the action is governed.
  
  New exports: `GOVERNED_TOOL_NAMES`, `LEGACY_TOOL_NAMES`, `CreateAnlyonToolsOptions`, `AnlyonGovernedTools` and `AnlyonLegacyTools`.

### Patch Changes

- 04c4c5d: Documentation and help-text corrections. No signature changes.
  
  `@anlyonhq/sdk`: a 409 `idempotency_request_in_progress` now names the Idempotency-Key the call sent, in the message and in `details.idempotencyKey`. A generated key was otherwise invisible, and only a call with that key reaches the original request. The SDK still does not resend a 409. The README quickstart now uses the `stripe.refund` adapter in test mode, in place of a template action against the Stripe API that got none of the shared limit, the bound approval or the grade. The README says a generated key is not returned in the response.
  
  `@anlyonhq/cli`: runtime messages lose prose semicolons and dashes. No meaning changes.
  
  `@anlyonhq/mcp-server`: the README names the scopes an agent key needs for the approval tools (`approvals:read` and `approvals:write`, beside `actions:read` and `actions:invoke`). In the OpenAI profile, `invoke_action` says not to run an unknown outcome again, and `decide_approval` says a gated action runs once enough approvers agree. The plugin listing and skill no longer say the plugin "does not move money". They say not to use it for that. The legacy `minSimilarity` description reads "0 to 1".
  
  `@anlyonhq/ai-sdk`: the legacy `minSimilarity` description reads "0 to 1". The README names the statuses the SDK resends: 429, 500, 502, 503 and 504.
- a604df7: An action invoke is never sent twice without an idempotency key.
  
  `@anlyonhq/sdk`: the client retries its own HTTP request on a timeout, a 429 or a 5xx. Until now `client.actions.invoke()` sent an `Idempotency-Key` only when you passed `idempotencyKey`, so a retry after a lost response could become a second invocation. The SDK now sends a key on every invoke. When you pass none it generates a UUID once per call and sends the same key on each transport retry of that call. The API answers a resend from the recorded invocation and does not run the action again. A key you pass is used unchanged. The same now holds for every other write on `client.actions` and for `client.approvals.request()`, `approve()` and `deny()`. Reads are unchanged, and retries are not disabled.
  
  A generated key covers one call. Two calls to `invoke` are two invocations, so pass your own `idempotencyKey` when your code may call `invoke` twice for the same business operation. If a retry arrives while the first request is still running, the API can answer 409 `idempotency_request_in_progress` where it would previously have started a second invocation.
  
  This is a patch because no signature or type changes. It fixes behaviour that contradicted the rule that Anlyon does not send an action twice.
  
  `@anlyonhq/mcp-server`: `invoke_action`, the per-action `action_<name>` tools, `request_approval` and `decide_approval` inherit the fix through the SDK. Tool text loses double spaces and semicolons in `request_approval`, `decide_approval`, `select_workspace`, the pending-approval reply of an action tool, the legacy `create_session`, `append_to_session`, `queue_publish` and `create_subscription` tools, and the OpenAI profile descriptions. No meaning changes.
  
  `@anlyonhq/cli`: the meaning printed for the `unknown` grade is now "No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it."
  
  `@anlyonhq/ai-sdk`: `invokeAction` and `requestApproval` inherit the fix through the SDK. The README no longer says `invokeAction` sends no idempotency key.
- Updated dependencies [bfd0f08]
- Updated dependencies [04c4c5d]
- Updated dependencies [3ef1b1e]
- Updated dependencies [a22f4eb]
- Updated dependencies [3ef1b1e]
- Updated dependencies [a604df7]
- Updated dependencies [3103fe4]
  - @anlyonhq/sdk@2.2.0

## 2.0.4

### Patch Changes

- 66dcdbe: Package description and README lead with hosted actions and approvals. The memory, semantic cache and session tools and middleware are unchanged and documented as legacy namespaces. The npm keywords drop the retired caching, memory, retrieval and middleware terms in favour of actions and approvals.
- Updated dependencies [66dcdbe]
  - @anlyonhq/sdk@2.1.0

## 2.0.3

### Patch Changes

- Updated dependencies [483bd25]
  - @anlyonhq/sdk@2.0.0

## 2.0.2

### Patch Changes

- Updated dependencies [56c1b4e]
  - @anlyonhq/sdk@1.4.1

## 2.0.1

### Patch Changes

- Updated dependencies [bc45eff]
- Updated dependencies [bc45eff]
- Updated dependencies [bc45eff]
  - @anlyonhq/sdk@1.4.0

## 2.0.0

### Major Changes

- 65f0571: Target Vercel AI SDK v7.

  The package was built against AI SDK v4, whose last release was 4.3.19 in July 2025 and which
  has no maintenance dist-tag. `peerDependencies.ai` was `>=4.0.0`, which npm happily satisfied
  with v5, v6 or v7 — so installing alongside a current `ai` succeeded silently and then failed
  at build time on a type this package exports.

  **Breaking:**

  - `peerDependencies.ai` is now `^7.0.0` (was `>=4.0.0`). Staying on `ai` v4? Stay on `1.x`.
  - The package is **ESM-only**. `ai` v7 publishes no `require` condition, so a CommonJS entry
    point here could never load its own peer. `main` and the `require` export are gone.
  - `peerDependencies.zod` is now `^3.25.76 || ^4.1.8`, matching what `ai` v7 itself accepts.
    The old `^3.20.0` floor declared support for versions v7 rejects.
  - `engines.node` is now `>=22`.
  - `anlyonCacheMiddleware` and `anlyonSessionMiddleware` return `LanguageModelMiddleware`
    instead of `LanguageModelV1Middleware`. Consumers who annotated with the old name should
    switch to `LanguageModelMiddleware` — the version-neutral alias, which tracks whichever
    provider spec the installed `ai` implements.
  - The tool factories now declare a return type rather than leaking an inferred one. Callers
    holding a single factory's result (`anlyonRecallTool(client)`) no longer get per-tool input
    narrowing; `createAnlyonTools(client)` passed to `generateText`/`streamText` is unaffected.

  **Fixed:**

  - Tool record schemas support both declared Zod majors. Zod 4 consumers can
    pass `createAnlyonTools()` to generation without a schema-conversion crash.
    Compatibility checks build, typecheck and test the minimum and newest
    supported AI SDK release with both Zod majors.
  - A cache hit now returns a result the SDK can actually read. Under the v4 spec it was built as
    `{ text, usage: { promptTokens, completionTokens }, rawCall }`; v7 reads text from a `content`
    part array and requires `warnings`, so on any modern `ai` a hit would have yielded no text.
  - Clears GHSA-866g-f22w-33x8, which reached the tree through `ai` v4's pinned
    `@ai-sdk/provider-utils@2.2.8` and had no fix on that line.

## 1.0.1

### Patch Changes

- 9f38c55: Package metadata points at the right repository, and support goes to support@anlyon.com.

- Updated dependencies [9f38c55]
  - @anlyonhq/sdk@1.3.1

## 1.0.0

### Major Changes

- cb38707: First stable release.

  Both packages ship at 1.0.0 rather than continuing the 0.x line. Neither has
  ever been published — the 0.1.0 in the manifest was a placeholder — and they are
  launching alongside `@anlyonhq/sdk`, against the same public API surface and the
  same support commitment. A 0.2.0 sitting next to a 1.3.0 in the same scope reads
  as "not finished yet", which is not what these are.

  No API changes accompany this bump.

### Minor Changes

- fbf2f97: Add Events, Files, and Semantic Cache tools
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

- fbf2f97: Import an API, edit a session, and wrap any model in Anlyon.

  - `client.actions.importFromOpenApi(spec, opts)` turn an OpenAPI 3.x spec into hosted tools in one call. Operations that cannot be expressed faithfully come back in `skipped` with a reason rather than becoming an action that looks right and isn't; constraints outside Anlyon's schema subset (`format`, `minimum`, …) are dropped and listed per-action in `warnings`. Supports `dryRun`, `auth` (a vaulted secret as a header), `requiresApproval` and `only`.
  - `client.sessions.popMessage(id)` / `clearMessages(id)` undo the last turn, or truncate a thread while keeping its id. Message indexes stay contiguous.
  - AI SDK: `anlyonCacheMiddleware(client, opts)` adds semantic caching to any model in one line a question already answered (or one close enough) skips the model entirely. `anlyonSessionMiddleware(client, { sessionId })` persists every turn to an Anlyon session.

  **Behaviour change:** a body template whose value is exactly `{{input.x}}` now sends the input's real type (`1200`, not `"1200"`), and omits the field entirely when the input is absent. Header templates are unchanged a header is always a string.

### Patch Changes

- Updated dependencies [fbf2f97]
- Updated dependencies [fbf2f97]
- Updated dependencies [fbf2f97]
- Updated dependencies [fbf2f97]
  - @anlyonhq/sdk@1.3.0
