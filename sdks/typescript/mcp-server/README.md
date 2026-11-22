# @anlyonhq/mcp-server

MCP server for [Anlyon](https://anlyon.com): governed execution for AI agents.

Your agent gets `invoke_action` (ask Anlyon to run a named production call) and
`request_approval` (ask a human first). It never receives a credential: it
receives a tool name, and Anlyon resolves the credential at dispatch, evaluates
policy, waits for approval when required, and makes the call itself. Every
enabled action in the workspace also shows up as its own tool.

This holds for actions routed through Anlyon. A tool your own code calls
directly is not routed through Anlyon and is not governed by it.

[![npm](https://img.shields.io/npm/v/@anlyonhq/mcp-server.svg?color=16A34A)](https://www.npmjs.com/package/@anlyonhq/mcp-server)
[![downloads](https://img.shields.io/npm/dm/@anlyonhq/mcp-server.svg?color=16A34A)](https://www.npmjs.com/package/@anlyonhq/mcp-server)
[![license](https://img.shields.io/npm/l/@anlyonhq/mcp-server.svg?color=16A34A)](./LICENSE)

## Quick start

### Stdio (local)

```bash
npx @anlyonhq/mcp-server
```

Set your API key first:

```bash
export ANLYON_API_KEY=anlyon_live_xxx
```

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anlyon": {
      "command": "npx",
      "args": ["-y", "@anlyonhq/mcp-server"],
      "env": {
        "ANLYON_API_KEY": "anlyon_live_xxx"
      }
    }
  }
}
```

### Remote HTTP (Anlyon-hosted), no API key needed

The hosted endpoint is served by the API itself:

```
https://api.anlyon.com/mcp
```

It authenticates with OAuth ("Login with Anlyon"), so there is no API key to
paste. Point any MCP client at that URL and it will register itself and open a
browser:

```bash
# Claude Code
claude mcp add --transport http anlyon https://api.anlyon.com/mcp   # then: /mcp

# Codex
codex mcp login anlyon

# OpenCode
opencode mcp auth anlyon
```

Cursor takes the same URL through its "Add MCP server" dialog.

You choose which workspace and environment the client acts on, and which groups
of permissions it gets, on the consent screen. High-access groups, such as
approving on your behalf, secrets, budgets and notification channels, are off
unless you turn them on.

> Earlier builds served this at `mcp.anlyon.com`. That host is gone: MCP and the
> OAuth server that guards it are one origin now. `https://api.anlyon.com/mcp` is
> also the OAuth resource identifier.

### One MCP server per integration

`https://api.anlyon.com/mcp/<integration>`, for example
`https://api.anlyon.com/mcp/github`, serves the actions you turned on for that
integration, plus `check_approval` and `wait_for_approval`, and nothing else from
your workspace. Sign-in, permissions, approvals and limits are the same as on
`/mcp`.

```bash
claude mcp add --transport http anlyon-github https://api.anlyon.com/mcp/github
```

See [MCP servers](https://docs.anlyon.com/ai-tools/mcp-servers).

### Acting for one of your users

A server-side agent can act for one of your users, in that user's own connected
accounts. Your server names the user; the model never does, and no tool has an
end-user argument.

- **stdio:** pass `--end-user <id>` or set `ANLYON_END_USER`. Every call carries
  `Anlyon-End-User: <id>`.

  ```bash
  ANLYON_API_KEY=anlyon_live_xxx npx -y @anlyonhq/mcp-server --end-user user_123
  ```

- **HTTP, hosted or `--http`:** connect with an API key and send
  `Anlyon-End-User: <id>` on each request. The user is fixed for that connection.
  An OAuth connection that sends it is refused (`END_USER_HEADER_NOT_ALLOWED`).

The id is 1 to 128 characters of letters, digits and `. _ : @ -`. A key created
with "Require an end user" needs one: the hosted endpoint refuses the connection
without it, and the API refuses each action call (`END_USER_REQUIRED`).

When the user has not connected the account an action needs, the tool returns a
result, not an error, that the model can pass on:

```json
{
  "status": "connect_required",
  "integration": "gmail",
  "connectUrl": "https://api.anlyon.com/connect/...",
  "message": "The user has not connected gmail yet, so nothing was done. Ask them to connect it, then try again."
}
```

`reconnect_required` means the connection was revoked or stopped refreshing. The
same fields are in `structuredContent`. See
[End-user connections](https://docs.anlyon.com/execution/end-user-connections).

## Tools

### Actions and approvals

What the agent uses. Secrets are deliberately absent: they are write-only and
belong in a human's hands, not in an agent's tool list.

| Tool | Description |
|---|---|
| `list_actions` | Discover the actions this workspace has defined, with their input schemas and whether each needs approval |
| `invoke_action` | Invoke an action by name. Anlyon holds the credentials and makes the call |
| `request_approval` | Ask a human to decide before doing something consequential |
| `check_approval` | Check whether an approval has been decided |
| `wait_for_approval` | **Block** until the human decides (long-poll), instead of polling `check_approval` |

`wait_for_approval` keeps the decision inside the turn. After a gated action or
a `request_approval`, the agent waits instead of polling. If the human has not
decided when the wait ends (default 45s, max 120s), it returns the
still-`pending` approval and the model calls it again.

The descriptions of `invoke_action`, `check_approval` and `wait_for_approval`
also tell the agent what a governed action adds. A governed action is one with
an adapter, a declared `impact` or `verify`, or `governed: true`. An action
with none of these gets none of the three.

- **Shared limit.** Any limit on a governed action is shared by every agent,
  session and key in the environment. A new session does not get a new
  allowance. The description does not say a limit is configured.
- **Bound approval.** An approval for a governed action is bound to the exact
  request. Anlyon recomputes the digest before dispatch and refuses on any
  difference.
- **Grade.** The result of a governed action carries a `grade`. `confirmed`
  means a read-back matched. `acknowledged` means the provider accepted it.
  `unknown` means do not retry. A grade is a database record. It is not signed.

### Your actions become tools

Every enabled action in the workspace is also exposed as its own MCP tool named
`action_<name>`, carrying the action's real input schema and description. Define
an action in the dashboard and it shows up in the model's tool list once the
30-second cache expires, with no code change and no restart:

| Action (dashboard) | Tool the model sees |
|---|---|
| `refund-customer`, gated | `action_refund-customer`, "Refund a Stripe charge. Gated. It requires human approval, and the call parks until a human decides." |
| `send-welcome-email`, declares `impact` | `action_send-welcome-email`, "Send the welcome email. Each call counts emails toward any shared limit set for this environment (amount: count(input.to), exact)." |

An action that declares `impact` says in its tool description what one call
counts, so the agent reads it before calling. The sentence comes from the
declaration. It does not mean a limit is configured. An adapter action with no
declared impact gets a general sentence instead.

Calling a gated one parks it behind an approval and returns an instruction to
call `wait_for_approval` with the `apr_…` id.

The list is fetched with the caller's API key and cached for 30 seconds. A
workspace whose key lacks `actions:read` simply gets the static tools. Set
`ANLYON_MCP_DYNAMIC_ACTIONS=0` to turn this off (a few MCP hosts dislike a tool
list that changes).

### Reviewer tools

For the person deciding, not the agent asking. Deciding needs the
`approvals:decide` scope (for OAuth, the "Approve on your behalf" permission on
the consent screen). A decision made here counts once toward an N-of-M policy:
as a **user** for an OAuth connection, as a **credential** for an API key. A key
can never decide an approval it requested.

| Tool | Description |
|---|---|
| `list_pending_approvals` | What is waiting for a decision in this environment |
| `decide_approval` | Approve or deny, with a reason recorded as the decision note. Approving a gated action runs the reviewed request |

### Changes a human must approve

An agent may never loosen its own guardrails. When a call through this server
asks for a change that loosens one (raise or remove a limit, disable a policy,
add a write action, widen a secret's hosts, resume a halted environment),
Anlyon does not apply it. The tool returns a result, not an error, that starts
with the link a workspace admin opens to approve or reject the change:

```
A human must approve this change before it applies. Give them this link: https://console.anlyon.com/sign-offs/sor_...

Change: Raise impact limit "Daily refunds" from 50000 to 200000

- amount: 50000
+ amount: 200000

Sign-off id: sor_...

You cannot approve it yourself. Call wait_for_sign_off with this id, or check_sign_off later.
```

`structuredContent` carries `status: "sign_off_required"`, `signOffId`,
`signOffUrl`, `summary`, `diff` and `expiresAt`. No API key or MCP session can
approve the request. A change that tightens a guardrail applies at once.

| Tool | Description |
|---|---|
| `check_sign_off` | The request's status (`pending`, `applied`, `rejected`, `expired`, `cancelled`, `failed`), the diff and the link |
| `wait_for_sign_off` | **Block** until a human decides, or until `timeoutSeconds` (default 45, max 300). Still `pending` when it returns: call it again |

Reading your own requests needs no consent group.

### Workspace tools

| Tool | Description |
|---|---|
| `list_workspaces` | The workspaces you can act in, with their environments, and which one this connection is using |
| `select_workspace` | Point this connection at a different workspace. Applies immediately and persists |

### Annotations and permissions

Every tool carries MCP `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) and `securitySchemes` naming the OAuth
consent groups it needs. Anything that deletes, sends a request or runs an
action is `destructiveHint: true`. The exception is the tool for an action
that is a plain `GET` with no adapter, which is marked read-only. On the hosted endpoint, the tool list shows
only the tools the groups you granted on the consent screen cover.

## Auth

Get your API key from the [Anlyon dashboard](https://console.anlyon.com), under
Workspace Settings and then API Keys. Use a key with `actions:read`,
`actions:invoke`, `approvals:read` and `approvals:write` for the agent, and
`approvals:decide` for a reviewer.

## Earlier tool set

Earlier releases also served the events tools (`publish_event`, `list_events`,
`get_event`, `create_topic`, `list_topics`, `delete_topic`,
`create_subscription`, `list_subscriptions`, `delete_subscription`). They
remain in the package and keep working, but they are not part of governed
execution and are off by default: they do not appear in `tools/list`, and a call
to one answers as an unknown tool. To turn them back on, set
`ANLYON_MCP_LEGACY_TOOLS=1` in the environment the server runs in (for a stdio
client, next to `ANLYON_API_KEY` in the `env` block).

Version 3 removed the memory, queue, files, semantic cache, session and context
tools (`memory_*`, `queue_*`, the file tools, `cache_*`, `get_context`,
`create_session`, `append_to_session`, `get_session_context`), whose API no
longer exists. The variable no longer brings them back.

## Source

The source is in [AnlyonHQ/anlyon](https://github.com/AnlyonHQ/anlyon/tree/main/sdks/typescript/mcp-server), under the MIT licence. Releases are published to npm from CI.

## Links

- Documentation: https://docs.anlyon.com/ai-tools/claude-code
- TypeScript SDK: [`@anlyonhq/sdk`](https://www.npmjs.com/package/@anlyonhq/sdk)
- Vercel AI SDK integration: [`@anlyonhq/ai-sdk`](https://www.npmjs.com/package/@anlyonhq/ai-sdk)
- Issues: https://github.com/AnlyonHQ/anlyon/issues
- Support: support@anlyon.com

## License

MIT © Anlyon
