# Anlyon Python SDK

**Governed execution for AI agents.** Official Python SDK for
[Anlyon](https://anlyon.com). Your agent invokes a named action. Anlyon holds
the credentials, evaluates policy, waits for approval when required, and makes
the production call itself.

## Installation

```bash
pip install anlyon
```

## Quick start

Define the action once, from an operator key. That is the one place your
credential appears. This example uses the Stripe refund adapter with a Stripe
test key. The adapter takes `"mode": "live"` or `"mode": "test"` and a key that
matches it:

```python
import os
from anlyon import Client

ops = Client(api_key=os.environ["ANLYON_OPERATOR_KEY"])

ops.secrets.put(
    "STRIPE_TEST_KEY",
    value=os.environ["STRIPE_TEST_KEY"],  # sk_test_... The key must match the action's mode.
    allowed_hosts=["api.stripe.com"],  # Anlyon will not send this key to any other host
)

ops.actions.create(
    name="refund-order",
    requires_approval=True,
    adapter={
        "type": "stripe.refund",
        "config": {"account": "acct_1Nxyz", "mode": "test", "currency": "usd"},
        "credentialSecret": "STRIPE_TEST_KEY",
    },
)
```

From then on, this is all your agent sees. No URL, no header, no key:

```python
anlyon = Client(api_key=os.environ["ANLYON_AGENT_KEY"])

# Successful calls expose the canonical response envelope.
refund = {"paymentIntent": "pi_3Pabc", "amount": 1250, "currency": "usd"}  # $12.50 in minor units
result = anlyon.actions.invoke("refund-order", refund)

if result.data["pendingApproval"]:
    print("Parked for a human:", result.data["approvalId"])
else:
    print("Receipt grade:", result.data["grade"])

anlyon.close()
```

For an API with no adapter, `create()` takes `url_template` and `headers` with
`{{secret:NAME}}` instead.

`status` on an invocation distinguishes `failed` (the call did not happen, safe
to retry) from `unknown` (it may have reached the destination, so reconcile
before retrying). Anlyon does not retry an action invocation.

The client does retry its own HTTP request to Anlyon after a network error or a timeout, or when
Anlyon answers 429, 500, 502, 503 or 504, up to `RetryConfig.max_attempts` (3 by default). The SDK
sends an idempotency key on every invoke. When you do not pass an
`idempotency_key`, it generates one for that call and sends the same key on
each resend. A resend is answered from the recorded invocation and is not
executed again.

A generated key covers one call to `invoke`. Two calls are two keys, and two
keys are two invocations. Pass your own `idempotency_key` when your code may
call `invoke` twice for the same business operation, for example after a
restart or from a job that runs again.

A generated key is not returned in the response. If a resend arrives while the
original request is still running, the API can answer 409
`idempotency_request_in_progress`. The SDK does not resend that. The error
names the key in its message and in `details["idempotency_key"]`. Call `invoke`
again with that key to get the result of the original. A call without it is a
new invocation.

This covers actions routed through Anlyon. A tool your own code calls directly,
with a credential your own process holds, is not routed through Anlyon and is
not governed by it.

## Declare impact and verify

Any action can say how much one invocation changes and how to read the result
back. Declaring either one makes the action governed.

```python
ops.actions.declare(
    "send-email",
    impact={"dimension": "emails", "amount": "count(input.to)", "bound": "exact"},
    verify={
        "url": "https://api.example.com/v1/messages/{{response.id}}",
        "status": 200,
        "match": [{"path": "status", "equals": "sent"}],
    },
)

# One limit, shared by every agent, session and key in the environment.
# It counts governed actions routed through Anlyon.
ops.impact_limits.create(name="Daily emails", dimension="emails", period="day", amount=500)
```

`dimension` is `money`, `resource_mutations`, or a unit you name, such as
`emails`. `amount` is an expression over the input: an integer, `input.<path>`
or `count(input.<path>)`, with one optional `* <integer>`. `create()` and
`update()` take the same `impact`, `verify` and `governed` arguments. `None`
removes a declaration. An argument you leave out keeps what is there.
`governed=False` removes every declaration.

Every governed invocation answers with a receipt grade:

```python
result = anlyon.actions.invoke("send-email", {"to": ["a@example.com"], "subject": "Hi"})
print(result.data["grade"])  # "confirmed" once the read-back matches

for effect in anlyon.actions.effects(grade="unknown").data:
    print(effect["id"], effect["grade"])
```

| Grade | Meaning |
| --- | --- |
| `confirmed` | A read-back matched the request. An adapter reads the provider's own record. |
| `acknowledged` | The provider accepted the request. Nothing read it back. |
| `unknown` | No usable response. Anlyon does not send it again. It stays unknown until a read-back or an operator settles it. |
| `failed` | The provider rejected the request, or it never left Anlyon. |
| `refused` | Anlyon refused it at dispatch. An exhausted limit is one cause. |
| `denied` | The approval was denied. |
| `pending` | No receipt yet. |

An action with no declaration and no adapter is not governed. It creates no
effect and returns no grade. Anlyon evaluates the amount you declare. It does
not check that the expression describes what the provider will do. A declared
action has no provider idempotency, so a lost response stays `unknown` until a
read-back or an operator settles it.

## Act for your users

Your users connect their own accounts, and every action your agent takes in
them is limited, approved and receipted for that user. Your server names the
user with `for_user()`. The model never does.

```python
from anlyon import Client, EndUserNotConnectedError, parse_connect_redirect

client = Client()

# 1. Connect: send the user to Anlyon's consent page.
link = client.end_users.create_connect_link(
    end_user_id=user.id,
    integration="gmail",
    redirect_url="https://app.example.com/connections/callback",
)
redirect(link.data["url"])

# 2. The callback route: confirm the flow for the user in *your* session.
result = parse_connect_redirect(str(request.url))
if result and result.status == "pending_confirmation" and result.flow_id:
    client.end_users.confirm_connection(session.user_id, result.flow_id)

# 3. Act for that user. Every request carries Anlyon-End-User.
try:
    client.for_user(user.id).actions.invoke("gmail-send-email", {"to": [to]})
except EndUserNotConnectedError as error:
    show_connect_button(error.integration, error.connect_url)  # connect_url may be None
```

- `for_user(end_user_id)` checks the id (1 to 128 of `A-Z a-z 0-9 . _ : @ -`)
  and returns a client bound to that user for good. The parent is unchanged.
  `AsyncClient.for_user` is the same.
- The confirm step is required: confirm with the user from your own session,
  never one read from the URL. A mismatch raises `EndUserMismatchError`; a link
  with no redirect URL and no default raises `RedirectUrlRequiredError`.
- `EndUserNotConnectedError` and `EndUserReconnectRequiredError` (409, both
  `EndUserConnectionRequiredError`) carry `integration` and `connect_url`.
  `EndUserRequiredError` (400) means the key requires an end user.
- `client.end_users` also has `set_connection`, `list_connections`,
  `delete_connection`, `erase`, `list(cursor=...)`, and `approvals.list` /
  `approvals.decide`. The LangChain and LlamaIndex action tools return a
  `connect_required` result instead of raising.
- `client.end_users.create_session(end_user_id, ttl_seconds=...)` mints a
  short-lived token (15 minutes by default) for that user's browser, for the
  prebuilt components in `@anlyonhq/react`. Return it from a route that knows who
  is signed in, and only for that user.

## Functions

A function is your code, hosted by Anlyon, calling your actions under the same
policies, limits, approvals and receipts. It has no network, environment
variables or secrets of its own.

```python
client.functions.create(name="refund-with-checks")
client.functions.publish(
    "refund-with-checks",
    language="python",
    source=SOURCE,  # a module that defines run(input, anlyon)
    allowed_actions=["lookup-order", "refund"],
)

# Plan: reads run for real, writes are recorded and not sent.
plan = client.functions.run("refund-with-checks", {"order": "ord_123"})
if plan.data["status"] == "awaiting_approval":
    # plan.data["plan"]["approval"]["id"] is decided by your team, or by the end
    # user with end_users.approvals.decide. Then carry out what was approved:
    client.functions.run(
        "refund-with-checks", {"order": "ord_123"}, mode="apply", plan_run_id=plan.data["id"]
    )
```

- A write in an apply run that differs from the plan ends the run `diverged`
  before it is sent. A plan is applied once.
- `mode="straight_through"` sends calls as they are made, with writes limited
  to the version's `straight_through` policy (`{"actions": [...], "max_writes": n}`).
- On a client from `for_user()`, runs and `functions.runs.get` act for that
  user. Read a run with `client.functions.runs.get(run_id)`; `client.runs`
  holds agent traces.

## Async

```python
import asyncio
import os
from anlyon import AsyncClient

async def main():
    async with AsyncClient(api_key=os.environ["ANLYON_AGENT_KEY"]) as client:
        refund = {"paymentIntent": "pi_3Pabc", "amount": 1250, "currency": "usd"}
        result = await client.actions.invoke("refund-order", refund)
        print(result.data["status"])

asyncio.run(main())
```

## Configuration

```python
from anlyon import Client, RetryConfig

client = Client(
    api_key="anlyon_live_xxx",       # falls back to ANLYON_API_KEY
    base_url="http://localhost:4000",  # falls back to ANLYON_BASE_URL
    timeout=10.0,
    retry=RetryConfig(max_attempts=5),
)
```

## Resources

The governed execution path:

- `client.actions`: create, import_openapi, list, get, update, declare, delete, invoke, invocations, invocation, versions, preview, effects, effect (hosted execution)
- `client.impact_limits`: list, get, create, update, archive (shared limits in money, resource mutations or a declared unit)
- `client.secrets`: put, list, get, delete (write-only vault, no method returns a value); put_external and check for a secret read at dispatch from your own store
- `client.secret_stores` (Enterprise): create, update, check, list, get, delete for your own AWS Secrets Manager or HashiCorp Vault. Needs `secret-stores:read` / `secret-stores:write`, which no key receives by default
- `client.approvals`, `client.approval_policies`: approval requests, decisions and the policies that route them
- `client.budgets`: monthly caps per agent key on Anlyon operations. They do not cap model tokens or the money an action moves
- `client.environment`: get, halt, resume
- `client.runs`: traces of what an agent did
- `client.functions`: create, list, publish, run (plan, apply or straight through) and runs.get for hosted functions

Also on the client:

- `client.events`: publish, list, get, topics CRUD, subscriptions
- `client.analytics`, `client.logs`: usage, delivery analytics, redacted execution history, exports
- `client.billing`, `client.notifications`: billing state and notification preferences
- `client.integrations`: Slack and Discord delivery
- `client.audit` (Enterprise and Team plan): list_events, export and schema for the audit trail of the key's own environment. Needs `audit:read`, which no key receives by default

Most write operations accept an `idempotency_key`. The same key and the same request return the recorded result instead of writing twice:

```python
client.actions.invoke("refund-order", refund, idempotency_key="refund:ord_42")
```

## Error handling

Successful calls return `ApiResponse` with `success`, `data`, `pagination`,
`stats`, and `request_id`, matching the HTTP contract and TypeScript SDK.
For compatibility with the 0.1 release, indexing, iteration, `get()`, `len()`,
and equality delegate to `response.data`. New code should use
`response.data` explicitly. That shortcut is deprecated for removal in
the next major release.

Failed requests raise typed exceptions (never return an error envelope):

```python
from anlyon import Client, NotFoundError, RateLimitError

client = Client(api_key="anlyon_live_xxx")
try:
    client.actions.get("act_missing")
except NotFoundError:
    print("Not found")
except RateLimitError as e:
    print(f"Rate limited, retry after {e.retry_after}s")
```

## Upgrading from 0.9

Version 0.10 removes the client namespaces of the retired features, whose API
endpoints no longer exist: `messages`, `schedules`, `queues`, `workflows`,
`memory`, `cache`, `files`, `sessions`, `context`, the URL groups and flow
control namespaces, and `anlyon.integrations.AnlyonSession` (the OpenAI Agents SDK
session). `logs.for_message`, `logs.for_schedule`,
`analytics.schedule_stats` and `analytics.schedule_executions` are gone too.
`events`, `dlq`, the rest of `logs` and `analytics`, and webhook verification
(`Receiver`) are unchanged. See [CHANGELOG.md](./CHANGELOG.md).
