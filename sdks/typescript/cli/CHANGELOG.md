# @anlyonhq/cli

## 0.6.0

### Minor Changes

- f5ef431: `anlyon.yaml` budgets accept the API's three dimensions in `dimensionCaps`: `messages`, `eventPublishes` and `actionInvokes`. The `cacheLookups` and `memoryOps` dimensions went with the retired memory and semantic cache APIs, and the API now ignores them (a cap on either does nothing); `anlyon plan` and `anlyon apply` now report them as unknown fields before anything is sent.
- 74ce096: `anlyon mcp add --end-user-key-header <name>` registers an MCP server each end user brings their own key to: your key in that header lists the tools and is used for calls made for no end user, and a call made for an end user sends their key in its place.

## 0.5.0

### Minor Changes

- dc5ace0: `anlyon mcp add`, `list`, `tools`, `adopt` and `archive` put a remote MCP server behind Anlyon, and `anlyon.yaml` gains an `mcp` section. Adopting a tool prints a sign-off link and exits 15 until a person approves it. `anlyon pull` writes adopted tools under `mcp`.
- 864712c: `anlyon setup claude-code` and `anlyon setup cursor` point a coding agent at Anlyon: they write its MCP config with no secret in it, send nothing, and list the servers the agent can still reach directly, with how to remove each.
- 54d5961: `anlyon integrations find <name>` and `client.connections.findRoute(name)`: the best way for your agent to act in an app, why, and the next command or link, for any name. `anlyon connections add` refuses a name with no integration before asking anything, with that route as `fix`.

## 0.4.0

### Minor Changes

- 29bdd06: Agent-native setup from the terminal.
  
  - `anlyon init` sets Anlyon up in the current project: signs you in (or up) in the browser, creates an agent key with the standard scopes and writes it to `.env` (`.env.local` for Next.js) without printing it, adds `.env*` to `.gitignore` first, installs `@anlyonhq/sdk` or `anlyon` with the project's package manager, adds the hosted MCP server to `.mcp.json`, `.cursor/mcp.json` and `.codex/config.toml` without touching other servers, and makes one governed read with a receipt. `--pack <name>` installs a catalogue pack (bundled) and connects its account; `--wait` follows a sign-off or a consent page. Idempotent, with `--yes` and `--json`.
  - `anlyon plan`, `anlyon apply` and `anlyon pull` keep an environment's actions, packs, approval policies, impact limits and budgets in `anlyon.yaml`. Each change is marked tightening or loosening; `apply` applies tightening at once and prints a sign-off link for each loosening change (`--wait` follows them). `plan --markdown` prints a pull-request comment. Secret values are refused in the file.
  - `anlyon billing status` and `anlyon billing upgrade --plan starter|production|growth` (opens the checkout page).
  - New exit code 15: waiting for a person's sign-off.
  - `policies list|get|versions` now name the `anlyon:guardrails` consent group in `auth scopes`.
- 9031cf3: `anlyon self-host init`: writes a self-hosted install's `deploy/self-host/.env` with a fresh root key, setup token and database password (owner-only permissions, never printed, never overwritten without `--force`), optionally runs `docker compose up -d --build` (`--up`), and prints the one-time setup URL. Asks only for the public domain; `--domain` and `--yes` run it without prompts.
- 56eb83b: Packs can send a connected account as `{{connection:<integration>}}`, declared by the manifest's one `connection` secret for that integration. Installed as it is, such an action needs no workspace secret: a call made for an end user (`Anlyon-End-User`) uses that end user's own account, and any other call uses the environment's connected account. `client.packs.install(manifest, { credential: 'secret' })` (CLI `--credential secret`) binds it to the named workspace secret instead, as before, and a secret renamed with `secretNames` is always used by name. A plan lists each such account as a `connection` step that writes nothing. The first-party catalogue and workflow packs use it from this version; an older installer refuses them without writing anything.
- 86b16b2: Workspaces have two new roles, `approver` (reads everything and decides approvals) and `viewer` (only reads). The SDK exports `WorkspaceRole`, and `auth.identity()` returns `role`: the person's role in the environment for a session or OAuth login, `null` for an API key. `anlyon whoami` shows it.

## 0.3.0

### Minor Changes

- 1199529: `anlyon connections integrations | list | add | check | reconnect`: connect an integration with an API key (asked for without echo, or `--api-key-stdin`) or by signing in, and check or renew it.
  
  `anlyon packs plan | install | exercise`: preview and install an Action Pack, and `exercise` runs every action of an installed pack once against the connected account, carrying ids from step to step, and prints each outcome, receipt grade and effect id.
  
  A read-back check that must be absent prints as `path != value`.

## 0.2.0

### Minor Changes

- f0e1202: Declared actions and receipt grades in the CLI.
  
  `anlyon actions declare <ref>` sets what an action declares. `--dimension`, `--unit`, `--amount` and `--bound` set its impact. `--verify-url`, `--verify-status` and a repeatable `--verify-match path=value` set its read-back. `--governed` governs an action that declares neither. `--no-impact` and `--no-verify` remove one declaration, and `--ungoverned` removes them all. A flag you leave out keeps what the action declares. It is a write like the others: it confirms first, or takes `--yes`, and carries an idempotency key. `anlyon actions get` shows `governed`, `impact` and `verify`.
  
  `anlyon effects list` shows each effect's `grade` and takes `--grade` with `confirmed`, `acknowledged`, `unknown`, `failed`, `refused`, `denied` or `pending`. `anlyon effects get` prints the grade with what it means.
  
  `anlyon impact-limits list` and `anlyon impact-limits get` show the `unit` a limit counts, so a limit in a declared unit such as `emails` reads correctly. The list's `CURRENCY` column is now `UNIT`, and the detail view prints `unit` in place of `currency`. `--json` output is unchanged apart from the fields the API adds.
  
  `--input` accepts a list of strings for a repeatable flag.

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

## 0.1.1

### Patch Changes

- efdd37f: Ship the standalone executables. The 0.1.0 GitHub release was created while the repository had immutable releases enabled, so the linux, macOS and Windows binaries and `SHA256SUMS` could not be attached to it; this release carries them. No code change.

## 0.1.0

### Minor Changes

- dfa1fa8: First beta of the `anlyon` CLI: operate Anlyon from a terminal with the same permissions and execution guarantees as the API and dashboard.
  
  - `anlyon auth login`: browser login (OAuth 2.1 for native apps: PKCE, loopback redirect, no embedded secret), or an API key piped to `--api-key-stdin`. `ANLYON_API_KEY` for automation.
  - Credentials in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service); refreshes are serialised across processes.
  - Every command resolves profile, API origin, credential, workspace and environment before it acts; `--environment` asserts and never overrides the credential's binding.
  - `auth status | logout | scopes`, `profile list | use`, `whoami`, `doctor`.
  - Read: `actions`, `invocations`, `runs`, `approvals`, `policies`.
  - Write: `actions invoke` (always idempotent; `--wait` follows an approval to its outcome) and `approvals approve | deny`. Writes need confirmation, or `--yes` when not interactive.
  - `--json`, stable exit codes (including 12 pending, 13 outcome unknown, 14 did not succeed), redacted errors, pagination, `--timeout`, Ctrl-C.
  - Standalone executables for Linux, macOS and Windows are attached to each GitHub release.

Release notes are generated from changesets (`.changeset/`) when a version is published.
The first release, 0.1.0, is described in `.changeset/cli-first-beta.md` until then.
