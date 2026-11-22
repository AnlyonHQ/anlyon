# @anlyonhq/cli: `anlyon`

Operate Anlyon from a terminal with the same permissions as the API and the dashboard. The CLI
submits requests to Anlyon. Policy evaluation, approvals and provider execution stay on the
server. Commands are organised by resource.

> Anlyon is in early beta. The API contract can change before 1.0, and every change is announced in the [changelog](https://docs.anlyon.com/changelog) with a migration note.

The CLI covers setting a project up (`anlyon init`), authentication, profiles, read commands,
invoking actions, declaring what an action changes, deciding approvals, keeping an environment's
guardrails in `anlyon.yaml` (`anlyon plan`, `apply`, `pull`), and billing.

```sh
npx @anlyonhq/cli init --yes     # sign in, key in .env, SDK, MCP config, one governed read
```

## Install

### Standalone executable (no Node required)

Each GitHub release tagged `@anlyonhq/cli@<version>` has a single-file executable per platform
attached. It embeds its runtime, so it runs on a clean machine with nothing else installed.

| Platform | File |
| --- | --- |
| Linux x64 / arm64 | `anlyon-linux-x64`, `anlyon-linux-arm64` |
| macOS Intel / Apple silicon | `anlyon-darwin-x64`, `anlyon-darwin-arm64` |
| Windows x64 | `anlyon-windows-x64.exe` |

```sh
# macOS / Linux
chmod +x anlyon-darwin-arm64
sudo mv anlyon-darwin-arm64 /usr/local/bin/anlyon
anlyon --version
```

```powershell
# Windows: put anlyon-windows-x64.exe on your PATH as anlyon.exe
anlyon --version
```

Verify downloads against `SHA256SUMS`. macOS may quarantine an unsigned download. Code signing
and notarisation are not in place yet (`xattr -d com.apple.quarantine anlyon` clears it).

### npm (Node 20.3+)

```sh
npm install -g @anlyonhq/cli
anlyon --version
```

The npm package has no runtime dependencies. The SDK is bundled in.

### Build from source

```sh
pnpm --filter @anlyonhq/cli build                    # dist/anlyon.js (Node)
pnpm --filter @anlyonhq/cli build:binaries -- host   # dist/bin/anlyon-<os>-<arch> (needs Bun)
```

## Log in

```sh
anlyon auth login            # opens your browser, then approve on the Anlyon consent screen
anlyon whoami                # who, which workspace, which environment
anlyon auth scopes           # what this login allows, command by command
```

Browser login is OAuth 2.1 for a native app (RFC 8252): PKCE (S256), a one-shot listener on
`127.0.0.1` with a random port, a `state` check, and no embedded client secret. The CLI registers
itself as a public client for each login. The workspace and environment are chosen on the
server's consent screen and bound to that login server-side.

The refresh token is kept in the operating system's credential store:

| OS | Store |
| --- | --- |
| macOS | login Keychain (`security`) |
| Windows | Credential Manager |
| Linux | Secret Service (gnome-keyring, KWallet) via `secret-tool` (package `libsecret-tools`) |

Where no OS store is available (a headless server), use an API key (below). As an explicit
opt-in, `ANLYON_CREDENTIAL_STORE=file` keeps credentials in a `0600` file in the config
directory. That file is not encrypted, and `auth status` and `doctor` say so.

Sessions last while they are used: an access token lives 15 minutes and the CLI refreshes it.
An unused login expires after 7 days. `anlyon auth logout` revokes the refresh token and deletes
the local copy (an access token already issued remains valid until it expires, at most 15 minutes).

### Automation

Set `ANLYON_API_KEY` (and `ANLYON_API_URL` for a non-default API). Profiles are then ignored,
and naming a profile as well is an error rather than a guess. To keep a key in the credential
store under a profile instead, pipe it in (it is never read from a terminal, argv or shell history):

```sh
printf %s "$KEY" | anlyon auth login --api-key-stdin --profile ci
```

`anlyon policies …`, `plan`, `apply` and `pull` need `policies:read`: log in with
`--scope anlyon:guardrails`, or use an API key (see *Scopes* below).

## Profiles

A profile is a named target: API origin, credential and the workspace/environment it resolved
to at login. It never contains a secret.

```sh
anlyon auth login --profile staging
anlyon profile list
anlyon profile use staging        # default for new commands
export ANLYON_PROFILE=staging     # pin this terminal only ($env:ANLYON_PROFILE on PowerShell)
```

Before any request, every command resolves, in order: profile (`--profile`, `ANLYON_PROFILE`,
the default, then `default`), API origin, credential, and then the workspace and environment
**from the server**. Consequences:

- `--environment <id|slug>` is an assertion. If the credential is bound to another environment
  the command stops with exit 10. The CLI never sends an environment override.
- If a profile's credential now resolves to a different workspace or environment than it did at
  login (rebound elsewhere), commands stop with exit 10 until you log in again.
- A profile's credential is only ever sent to that profile's API origin. `ANLYON_API_URL`
  pointing elsewhere is refused.
- Each profile has its own credential entry, OAuth client and server-side binding. Two terminals
  on different profiles cannot retarget each other.
- Concurrent commands on one profile serialise token refreshes across processes, so parallel
  jobs do not invalidate each other's session.

## Commands

```
anlyon init [--yes] [--pack <name>] [--wait 15m] [--mcp claude,cursor,codex|none] [--no-install] [--no-smoke]
anlyon setup claude-code | cursor [--api-url <url>]   # point a coding agent at Anlyon: no secret, no login, lists direct servers
anlyon plan [--file anlyon.yaml] [--markdown]
anlyon apply [--file anlyon.yaml] [--yes] [--wait 30m]
anlyon pull [--file anlyon.yaml] [--yes]
anlyon billing status | upgrade --plan starter|production|growth [--interval month|year] [--wait 10m]

anlyon auth login | status | logout | scopes
anlyon profile list | use <name>
anlyon whoami
anlyon doctor

anlyon actions list | get <ref> | versions <ref>
anlyon actions invoke <ref> [--data '<json>' | --input <file|->] [--idempotency-key <key>] [--wait 10m]
anlyon actions declare <ref> [--dimension <d> [--unit <u>] --amount <expr> --bound exact|upper_bound]
                             [--verify-url <url> --verify-status <code> [--verify-match path=value]…]
                             [--governed] [--no-impact] [--no-verify] [--ungoverned] [--wait 10m]
anlyon invocations list [--action <ref>] [--status <status>] | get <id>
anlyon runs list [--status …] [--search …] [--agent …] [--since …] [--until …] | get <id>
anlyon approvals list [--status pending|…] [--origin …] | get <id>
anlyon approvals approve <id> [--note …] | deny <id> [--note …]
anlyon policies list [--action <name>] | get <id> | versions <id>
anlyon effects list [--action <name>] [--outcome <o>] [--grade <g>] [--unresolved] | get <id>
anlyon impact-limits list [--include-archived] | get <id>
anlyon sign-offs list [--status pending|applied|rejected|expired|cancelled|failed]
anlyon sign-offs get <id> [--wait 10m] | cancel <id> [--yes]

anlyon mcp add <url> [--name <name>] [--header "Authorization: Bearer {{secret:NAME}}"] [--oauth] [--wait 10m]
anlyon mcp list | tools <name> [--refresh] | archive <name> [--yes]
anlyon mcp adopt <name> <tool...> [--approval suggested|all|none] [--wait 15m]   # a person signs this off, exit 15

anlyon self-host init [--domain <host>] [--dir deploy/self-host] [--edition community|team|enterprise] [--up] [--force] [--yes]
```

`anlyon <command> --help` describes each one.

### Self-hosting

`anlyon self-host init`, run in a checkout of the Anlyon repository, sets up a self-hosted
install. It asks only for the public domain, writes `deploy/self-host/.env` with a fresh root
key, setup token and database password (readable by you only, never printed), optionally starts
it with `docker compose up -d --build` (`--up`), and prints the setup URL that creates the first
owner. It never replaces an existing `.env` without `--force`, because a new root key makes
secrets stored under the old one unreadable. Everything else is configured in the console.

### Writes

`actions invoke`, `actions declare` and `approvals approve | deny` change things, so:

- **They confirm first.** Interactively you are asked, with the workspace and environment named.
  Anywhere else (scripts, CI, an agent's shell) pass `--yes`. Without it nothing is sent.
- **They carry an idempotency key.** Every call carries one: yours, or one the CLI generates
  and prints. Re-running with the same key returns the recorded result and does not run the
  action twice, which is what makes an interrupted command safe to repeat.
- **Policy and approvals apply as for any caller.** An invoke that needs approval exits 12 with
  the approval id. `--wait <duration>` follows it to its outcome. An outcome the destination
  could not confirm (e.g. a timeout after it received the request) exits 13. Do not retry with
  a new key. Reconcile first.
- **Deciding approvals needs `approvals:decide`.** Log in with
  `anlyon auth login --scope anlyon:approvals.decide`. The consent screen names it. A credential
  can never decide an approval it requested: not the requesting API key, and not the OAuth app
  (such as a CLI login) that made the request for you. Decide those from the dashboard or a
  separate login.

```sh
anlyon actions invoke refund_payment --data '{"charge":"ch_123","amount":1200}' --yes
anlyon approvals list --status pending
anlyon approvals approve apr_123 --note "checked with the customer"
```

### Changes a human must approve

An agent may never loosen its own guardrails. When a CLI login or an API key asks for a change
that loosens one (raise or remove a limit, disable a policy, remove what an action declares,
widen a secret's hosts, resume a halted environment), Anlyon does not apply it. It records a
sign-off request and the command exits 15:

```
Needs a human's sign-off. A workspace admin must approve this change before it applies:
https://console.anlyon.com/sign-offs/sor_...

id:      sor_...
change:  Remove declarations from action "send_email"

  - governed: true
  + governed: false

This command cannot approve it, and neither can any API key or CLI login.
```

- Give the link to a workspace admin. They approve or reject it in the console. Nothing changes
  until they approve it, and a request nobody decides expires after 24 hours.
- With `--json`, stdout carries the request as `{"data": {...}}`: its `id`, `status`, `diff` and
  `signOffUrl`.
- `--wait <duration>` on `actions declare` follows the request: exit 0 with the result once it is
  approved and applied, 14 when it is rejected, expires, is withdrawn or could not be applied
  (the reason is printed), and 9 when the wait ends before a decision.
- `anlyon sign-offs list`, `get` and `cancel` read and withdraw this credential's own requests.
  They need no scope. `sign-offs get <id> --wait 10m` follows one with the same exit codes.
- A change that tightens a guardrail applies at once, as before.

```sh
anlyon actions declare send_email --ungoverned --yes --wait 30m
anlyon sign-offs list --status pending
anlyon sign-offs get sor_123 --wait 10m
anlyon sign-offs cancel sor_123 --yes
```

### Governed actions

An action is governed when it declares an impact, a read-back, or `--governed` alone.
`actions declare` sets and removes those declarations. A flag you leave out keeps what the
action already declares.

```sh
# One call sends count(input.to) emails. Any impact limit in the unit "emails" now applies.
anlyon actions declare send_email --dimension emails --amount 'count(input.to)' --bound exact --yes

# Money needs its currency. The amount is a ceiling here.
anlyon actions declare refund_payment --dimension money --unit usd --amount input.amount --bound upper_bound --yes

# Read the write back after dispatch. A match grades the effect confirmed.
anlyon actions declare send_email \
  --verify-url 'https://api.example.com/v1/messages/{{response.id}}' --verify-status 200 \
  --verify-match data.status=sent --yes

anlyon actions declare send_email --no-verify --yes    # remove the read-back
anlyon actions declare send_email --ungoverned --yes   # remove every declaration
```

- `--dimension` is `money`, `resource_mutations`, or a unit you name such as `emails`.
- `--amount` is an integer, `input.<path>` or `count(input.<path>)`, with an optional `* <integer>`.
- `--verify-match` may be repeated, up to 10 times. A value that reads as a number, `true`,
  `false` or `null` is sent as that. Quote it as JSON to send a string: `--verify-match 'id="42"'`.
- Setting an impact replaces the whole impact, and the same holds for the read-back.
- Declaring needs `actions:write`. Changing or removing what a governed action already declares
  also needs `actions:govern`, which no browser login grants. Use an operator API key for that.
- `actions get` shows `governed`, `impact` and `verify`.

Every governed call leaves an effect with a receipt grade. `effects list` has a `GRADE` column
and a `--grade` filter, and `effects get` prints what the grade means.

| Grade | Meaning |
| --- | --- |
| `confirmed` | A read-back matched the request. On a declared action that is the verify rule the workspace wrote. |
| `acknowledged` | The provider accepted the request. Nothing read it back. |
| `unknown` | No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it. |
| `failed` | The provider rejected the request, or it never left Anlyon. |
| `refused` | Anlyon refused it at dispatch. |
| `denied` | The approval was denied. |
| `pending` | No receipt yet. |

`impact-limits list` and `impact-limits get` show the `unit` each limit counts: the currency for
money, the declared unit otherwise.

A grade is a database record with provider evidence. It is not signed. A limit counts governed
actions routed through Anlyon in one environment.

The SDK's `anlyon-policy` executable is unchanged
and keeps working. Policy changes are not in `anlyon policies` yet.

## Terminal contract

These are stable across 0.x minor releases (see *Compatibility*).

| Flag | Meaning |
| --- | --- |
| `--json` | stdout carries exactly one JSON document. Lists: `{"data": [...], "nextCursor": string\|null, "total"?: number}`. Single objects: `{"data": {...}}`. |
| `--profile <name>` | Use this profile. |
| `--environment <id\|slug>` | Assert the credential's environment. It never switches it. |
| `--input <file\|->` | Read options as a JSON object (keys are the command's option names, plus `limit`/`cursor`). Flags win. Unknown keys are rejected. |
| `--limit <1-100>` / `--cursor <c>` | Pagination for list commands. Pass back `nextCursor`. Cursors are opaque and bound to the list that issued them. |
| `--timeout <duration>` | Give up after e.g. `30s`, `2m`, `500ms` (default 60s, 10m for `auth login`). |
| `--no-input` | Never prompt or open a browser. Fail instead. |

- Results go to **stdout**. Progress, hints, warnings and errors go to **stderr**.
- With `--json`, an error is one JSON object on stderr:
  `{"error": {"code", "message", "exitCode", "status"?, "requestId"?, "hint"?, "fix"?}}`.
  `fix` is what the API says to do about it: `{"summary", "command"?, "url"?, "docs"?}`. When it
  names a command or a console page, that is the `hint` too.
- Output passes through a redactor. It masks the credentials this process handled and anything
  shaped like an API key, a token or a `Bearer` value.
- Ctrl-C cancels the in-flight request and exits 130.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Error (unexpected, or no more specific code) |
| 2 | Usage: bad flags, arguments or `--input`. Nothing was sent |
| 3 | Not logged in, or the credential expired, was revoked or was rejected (401) |
| 4 | Permission denied: missing scope or role (403) |
| 5 | Not found in this workspace/environment (404) |
| 6 | Rejected by the server as invalid or conflicting (400/409/422) |
| 7 | Rate limited or over quota (429) |
| 8 | Server error or unreachable (5xx, network) |
| 9 | `--timeout` elapsed |
| 10 | Target mismatch: `--environment`, a changed binding, or an API origin override |
| 11 | Needs a server endpoint that is not available yet. Nothing was sent |
| 12 | Action accepted, not finished: waiting for approval or still running |
| 13 | Action outcome unknown: it may have taken effect. Do not retry with a new key |
| 14 | Action did not succeed: failed, denied, or its approval expired. Also a followed sign-off request that was rejected, expired, withdrawn or could not be applied |
| 15 | Waiting for a human's sign-off: the change loosens a guardrail and was not applied. A workspace admin approves it at the printed link |
| 130 | Cancelled (Ctrl-C) |

`anlyon doctor` exits 0 when every check passes and 1 otherwise.

## Scopes

Browser login asks for `openid profile email offline_access anlyon:actions anlyon:observability`,
which covers actions, invocations, runs, approvals, effects and impact limits. Add consent groups with
`anlyon auth login --scope anlyon:approvals.decide` (they are shown on the consent screen).
Approval policies, `plan`, `apply` and `pull` need `policies:read`: add the sensitive
`anlyon:guardrails` group (`--scope anlyon:guardrails`), or use an operator API key. `anlyon init`
asks for `anlyon:keys`, which lets the login create one agent key with the standard scopes.
A loosening change made with a CLI login or an API key waits for a person's sign-off (exit 15).
`anlyon auth scopes` shows exactly what the current credential can run.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANLYON_PROFILE` | Profile for this shell. |
| `ANLYON_API_KEY` | API key for automation. Bypasses profiles. |
| `ANLYON_API_URL` | API origin for `ANLYON_API_KEY` and new logins (`ANLYON_BASE_URL` is accepted too). |
| `ANLYON_CONFIG_DIR` | Config directory (default `~/.config/anlyon`, `%APPDATA%\anlyon` on Windows). |
| `ANLYON_CREDENTIAL_STORE` | `auto` (default), `keychain`, or `file` (unencrypted opt-in). |
| `ANLYON_NO_BROWSER=1` | Print the login URL instead of opening a browser. |

## Compatibility

- **Versioning.** The CLI is versioned independently of the SDK and the API. While 0.x, a minor
  release may add commands, flags, JSON fields and exit codes. It does not remove or rename them,
  change the meaning of an exit code, or change the shape of existing `--json` fields without a
  CHANGELOG entry marked **Breaking**. From 1.0, those are major-version changes only.
- **Machine contract.** Scripts should rely on `--json` output and exit codes, not on
  human-readable output, which may change in any release.
- **SDK.** Each build bundles a specific `@anlyonhq/sdk` (shown by `anlyon --version`). The CLI's
  tests run against that SDK's source and check every request path against the API's OpenAPI
  contract.
- **Server.** The CLI requires `GET /api/v2/auth/identity` and `GET /api/v2/environment`, and,
  for browser login, OAuth discovery at `/.well-known/oauth-protected-resource/mcp`. Exit 11 is
  reserved for a command whose endpoint a server does not have. No current command uses it.
- **Config.** `config.json` carries a `version`. A CLI refuses a config version it does not
  know rather than rewriting it.
- **Platforms.** Linux (x64, arm64), macOS (x64, arm64) and Windows (x64). The npm package
  supports Node 20.3 and later.
