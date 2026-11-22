# anlyon-llamaindex

LlamaIndex integration for [Anlyon](https://anlyon.com). `action_tools` turns Anlyon actions into LlamaIndex tools.

## Installation

```bash
pip install anlyon-llamaindex
```

## Actions as tools

```python
from anlyon import Client
from anlyon_llamaindex import action_tools

client = Client(api_key="anlyon_live_...")

# Declare once, from an operator key. This makes the action governed.
client.actions.declare(
    "send-email",
    impact={"dimension": "emails", "amount": "count(input.to)", "bound": "exact"},
    verify={"url": "https://api.example.com/v1/messages/{{response.id}}", "status": 200},
)

tools = action_tools(client)  # one FunctionTool per enabled action
send_email = next(tool for tool in tools if tool.metadata.name == "send-email")

print(send_email.metadata.description)
# Sends an email. Declared impact: emails. Each call counts toward any shared limit set for this environment.

output = send_email.call(to=["a@example.com"], subject="Hi")
print(output.raw_output["grade"])  # "confirmed", "acknowledged", "unknown", "failed", "refused", "denied" or "pending"
```

Each tool calls `client.actions.invoke()`. Anlyon holds the credential, evaluates policy and makes the call. A tool your own code calls directly is not routed through Anlyon and is not governed by it. The description carries the declared impact when the action declares one. It says what one call counts. It does not say a limit is configured. The raw output is the invocation as a dict. `grade` is the receipt grade of a governed action, and `None` for an action that is not governed. A gated action comes back with `pendingApproval` and an `approvalId`.

Pass `names=[...]` to keep a subset.

See the [Anlyon docs](https://docs.anlyon.com) for the full guide.

## Act for your users

Build the tools from `client.for_user(user_id)`. Each call then uses that
user's own connections, limits and approvals. No tool schema has an end-user
field, so the model cannot choose or switch the user. When the user has not
connected the integration, the tool returns instead of raising:

```python
tools = action_tools(client.for_user(session.user_id), names=["gmail-send-email"])
# A tool result when Gmail is not connected:
# {"status": "connect_required", "integration": "gmail",
#  "connectUrl": "https://...", "message": "The user has not connected gmail yet, ..."}
```

`status` is `reconnect_required` for a revoked connection, and `connectUrl` is
`None` when the environment has no default redirect URL. See the `anlyon`
README for connecting a user and the confirm step.

## License

MIT

## Upgrading from 0.4

Version 0.5 removes `AnlyonVectorStore`, which was built on the retired memory
API. `action_tools` is unchanged. See [CHANGELOG.md](./CHANGELOG.md).
