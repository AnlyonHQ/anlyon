# @anlyonhq/mcp-server

## 3.0.0

### Major Changes

- f5ef431: Removed the memory, queue, files, semantic cache, session and context tools (`memory_*`, `queue_publish`, `queue_publish_batch`, `list_files`, `get_file`, `get_download_url`, `presign_upload`, `delete_file`, `cache_*`, `get_context`, `create_session`, `append_to_session`, `get_session_context`), whose API no longer exists. `ANLYON_MCP_LEGACY_TOOLS=1` now turns on only the events tools, which stay hidden by default; `LEGACY_TOOL_NAMES` lists those nine. `ConsentScope` drops `anlyon:memory` and `anlyon:files`, and the ChatGPT presentation drops its descriptions for the removed tools. The default tool list is unchanged.

### Patch Changes

- Updated dependencies [74ce096]
- Updated dependencies [f5ef431]
  - @anlyonhq/sdk@3.0.0

## 2.4.0

### Minor Changes

- 864712c: Work properly from a coding agent. `action_<name>` tools fit in 51 characters, what Claude Code and Cursor accept under the server key `anlyon`: a longer name ends in a hash of the action's name, so two long names no longer collide and one name always means one action. `wait_for_approval` and `wait_for_sign_off` default to 45 seconds, under the MCP TypeScript client's 60-second request timeout. `wait_for_approval` and `check_approval` return a gated action's outcome as `invocation`, and the new `get_invocation` tool reads any call.

### Patch Changes

- 3ed1bd4: An end user's connect-required error names what to connect. `EndUserConnectionRequiredError` gains `displayName`, the name the API gives: an integration's, or an MCP server's own for a tool adopted from one. `<ConnectPrompt>` shows it on the card, and the MCP server's `connect_required` result carries it and uses it in its message.
- Updated dependencies [3ed1bd4]
- Updated dependencies [54d5961]
- Updated dependencies [dc5ace0]
  - @anlyonhq/sdk@2.5.0

## 2.3.0

### Minor Changes

- 4a3d26d: Act for one of your users. `--end-user <id>` or `ANLYON_END_USER` (stdio), or the `Anlyon-End-User` header (HTTP), makes every call carry `Anlyon-End-User`, so actions use that user's own connected accounts. The user is bound when the client is built; no tool has an end-user argument. When the user has to connect, or connect again, a tool returns `{ status: 'connect_required' | 'reconnect_required', integration, connectUrl, message }` as a result, not an error, with the same fields in `structuredContent`. `ServerOptions.actions` limits which actions a host serves as tools.
- 208524b: Hosted functions as tools. Each published function is served as `function_<name>` beside the action tools, taking `input` and, to carry out an approved plan, `planRunId`. Called without `planRunId` it plans: reads run, writes are recorded and nothing is sent, and the result names the approval to wait on. An integration's own server does not serve them.

### Patch Changes

- a8cdc7f: `decide_approval` keeps `selfApproved` in the OpenAI profile's trimmed result, so a decision made by the only approver in an environment on their own agent's request says so.
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

## 2.2.1

### Patch Changes

- Updated dependencies [1199529]
  - @anlyonhq/sdk@2.3.0

## 2.2.0

### Minor Changes

- 6c34454: Governed actions in the tool list. The descriptions of `invoke_action`, `request_approval`, `check_approval` and `wait_for_approval` now say what a governed action adds: any limit is shared by every agent, session and key in the environment, an approval is bound to the exact request, and the result carries a grade.
  
  Each `action_<name>` tool for an action that declares `impact` says what one call counts, for example "Each call counts emails toward any shared limit set for this environment (amount: count(input.to), exact)." An adapter action with no declared impact gets a general sentence. The sentence describes the declaration and does not claim that a limit is configured.
  
  Invoke results carry the receipt `grade` when the server returns one: `confirmed`, `acknowledged`, `unknown`, `failed`, `refused`, `denied` or `pending`. The ChatGPT presentation keeps `grade` on its trimmed invocation output.
  
  The default tool list is unchanged. The legacy tools stay hidden unless `ANLYON_MCP_LEGACY_TOOLS=1` is set.

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

## 2.1.0

### Minor Changes

- 66dcdbe: Legacy tools are hidden by default. The server now lists and serves the governed execution tools only: `list_actions`, `invoke_action`, `request_approval`, `check_approval`, `wait_for_approval`, `list_pending_approvals`, `decide_approval`, `list_workspaces`, `select_workspace`, and one `action_<name>` tool per enabled action. The memory, queue, events, files, semantic cache and session tools stay in the package but are off: they do not appear in `tools/list` and a call to one answers as an unknown tool. Set `ANLYON_MCP_LEGACY_TOOLS=1` in the server's environment to restore them. A `hiddenTools` option passed by a host composes with this default rather than replacing it. The library also exports `DEFAULT_TOOLS`, `LEGACY_TOOL_NAMES`, `isLegacyTool` and `legacyToolsEnabled`.

### Patch Changes

- Updated dependencies [66dcdbe]
  - @anlyonhq/sdk@2.1.0

## 2.0.1

### Patch Changes

- b39d756: `cache_store` is annotated `destructiveHint: true`: an upsert replaces what the key held, which is a destructive update by the MCP meaning of the hint (OpenAI's tool scan flagged the previous `false`). In the OpenAI presentation, `create_session` and `append_to_session` describe a handoff as a summary the assistant writes, never the conversation itself, and name no other assistant.

## 2.0.0

### Major Changes

- 483bd25: **Breaking:** remove the Connect tools and bins.
  
  The `connect_*` tools are no longer registered. The feature they call is not available to customers, so every call answered 404; they are gone from the tool list rather than advertised and broken.
  
  The `anlyon-connect-hook`, `anlyon-connect-runner` and `anlyon-connect-channel` bins, which depended on the same feature, are no longer shipped. Remove them from any hook or runner configuration that referenced them.

### Minor Changes

- 55afe2d: Every tool now carries MCP `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) and `securitySchemes` naming the OAuth consent
  groups it needs. Both are additive fields on the tool definition; names,
  descriptions, input schemas and tool outputs are unchanged. Generated
  `action_<name>` tools derive their annotations from the action: only a plain
  `GET` without a governed-effect adapter is read-only.
  
  New reviewer tools `list_pending_approvals` and `decide_approval` (approve or deny
  with a reason recorded as the decision note). Deciding needs `approvals:decide`;
  N-of-M semantics are unchanged.
  
  New export `hiddenOutsideGrant(groups)` for OAuth hosts: hide every tool whose
  consent groups were not granted, so the tool list matches the consent screen.
- 2d3901d: New: presentation profiles. `createServer({ presentation })` accepts a pure
  rewrite of the tool list, tool results and failed calls; without one the
  server is exactly as before. The first profile, `@anlyonhq/mcp-server/profiles/openai`,
  is what the hosted endpoint shows ChatGPT: consumer-language descriptions for
  memory, session and reviewer tools (including never storing credentials,
  payment, health or government identifiers), trimmed outputs, security
  schemes mirrored under `_meta`, and `_meta["mcp/www_authenticate"]` on auth
  failures. No other client sees it.

### Patch Changes

- d3c06e2: Add `mcpName` (`com.anlyon/anlyon`) and ship `server.json` so the package can be listed in the official MCP Registry. No runtime change.
- Updated dependencies [483bd25]
  - @anlyonhq/sdk@2.0.0

## 1.0.3

### Patch Changes

- Updated dependencies [56c1b4e]
  - @anlyonhq/sdk@1.4.1

## 1.0.2

### Patch Changes

- Updated dependencies [bc45eff]
- Updated dependencies [bc45eff]
- Updated dependencies [bc45eff]
  - @anlyonhq/sdk@1.4.0

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

### Patch Changes

- Updated dependencies [fbf2f97]
- Updated dependencies [fbf2f97]
- Updated dependencies [fbf2f97]
- Updated dependencies [fbf2f97]
  - @anlyonhq/sdk@1.3.0
