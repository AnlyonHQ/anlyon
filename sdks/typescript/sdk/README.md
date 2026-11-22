# @anlyonhq/sdk

**Governed execution for AI agents.** Official TypeScript SDK for
[Anlyon](https://anlyon.com). Your agent invokes a named action. Anlyon holds
the credentials, evaluates policy, waits for approval when required, and makes
the production call itself.

[![npm](https://img.shields.io/npm/v/@anlyonhq/sdk.svg?color=16A34A)](https://www.npmjs.com/package/@anlyonhq/sdk)
[![downloads](https://img.shields.io/npm/dm/@anlyonhq/sdk.svg?color=16A34A)](https://www.npmjs.com/package/@anlyonhq/sdk)
[![minzipped](https://img.shields.io/bundlephobia/minzip/@anlyonhq/sdk?color=16A34A)](https://bundlephobia.com/package/@anlyonhq/sdk)
[![license](https://img.shields.io/npm/l/@anlyonhq/sdk.svg?color=16A34A)](./LICENSE)

```bash
npm install @anlyonhq/sdk
```

```typescript
import { Client } from '@anlyonhq/sdk';

// Once, from an operator key. The one place the credential appears.
const ops = new Client({ apiKey: process.env.ANLYON_OPERATOR_KEY! });

await ops.secrets.put('STRIPE_TEST_KEY', {
  value: process.env.STRIPE_TEST_KEY!, // sk_test_... The key must match the action's mode.
  allowedHosts: ['api.stripe.com'], // Anlyon will not send this key to any other host
});

// The Stripe refund adapter. `mode` is 'live' or 'test', and the key must match it.
await ops.actions.create({
  name: 'refund-order',
  requiresApproval: true,
  adapter: {
    type: 'stripe.refund',
    config: { account: 'acct_1Nxyz', mode: 'test', currency: 'usd' },
    credentialSecret: 'STRIPE_TEST_KEY',
  },
});

// From here on, this is all your agent sees. No URL, no header, no key.
const anlyon = new Client({ apiKey: process.env.ANLYON_AGENT_KEY! });

const { data } = await anlyon.actions.invoke('refund-order', {
  paymentIntent: 'pi_3Pabc',
  amount: 1250, // $12.50 in minor units
  currency: 'usd',
});

if (data!.pendingApproval) {
  console.log('Parked for a human:', data!.approvalId);
}
```

Full TypeScript types, ESM and CJS, no required peer dependencies, and
framework adapters for Next.js, Hono, Express, Fastify, SvelteKit, h3 and
Cloudflare Workers.

---

## Actions

Hosted tools. An adapter action, like the one above, builds the request
itself. For any other HTTPS API you define the HTTP call once, with
`urlTemplate`, `headers` and credentials referenced as `{{secret:NAME}}`. Either
way the agent sends only `{input}`. Anlyon validates the input against the
action's schema, resolves the credentials at dispatch, makes the call, and
records the outcome. Actions marked `requiresApproval` park behind a human
decision instead of firing.

An action with no adapter and no declaration keeps the template executor. It
gets no shared limit, no bound approval and no grade.

This holds for actions routed through Anlyon. A tool your own code calls
directly is not routed through Anlyon and is not governed by it.

```typescript
// Invoke by name. Ungated actions run inline. Gated ones come back parked.
const refund = { paymentIntent: 'pi_3Pabc', amount: 1250, currency: 'usd' };
const { data } = await anlyon.actions.invoke('refund-order', refund);

// Your own key ties the call to your business operation. The same key and the
// same request return the recorded invocation. The action does not run twice.
await anlyon.actions.invoke('refund-order', refund, {
  idempotencyKey: 'refund:ord_42',
});

// What Anlyon actually did on your behalf.
const { data: invocation } = await anlyon.actions.invocation('inv_1');
console.log(invocation!.status, invocation!.responseStatus);
```

`status` distinguishes `failed` (the call did not happen, safe to retry) from
`unknown` (it may have reached the destination, so reconcile before retrying).
Anlyon does not retry an action invocation.

The client does retry its own HTTP request to Anlyon after a network error or a timeout, or when
Anlyon answers 429, 500, 502, 503 or 504, up to `retry.maxAttempts` (3 by default). The SDK sends an
idempotency key on every invoke. When you do not pass an `idempotencyKey`, it
generates one for that call and sends the same key on each resend. A resend is
answered from the recorded invocation and is not executed again.

A generated key covers one call to `invoke`. Two calls are two keys, and two
keys are two invocations. Pass your own `idempotencyKey` when your code may
call `invoke` twice for the same business operation, for example after a
restart or from a job that runs again.

A generated key is not returned in the response. If a resend arrives while the
original request is still running, the API can answer 409
`idempotency_request_in_progress`. The SDK does not resend that. The error
names the key in its message and in `details.idempotencyKey`. Call `invoke`
again with that key to get the result of the original. A call without it is a
new invocation.

### Declaring impact and a read-back

An action can declare how much one call changes and how to read the result
back. Either declaration makes the action governed. Its impact is reserved
against shared limits before dispatch, and every call returns a receipt grade.
A governed action needs a fixed `https` host.

```typescript
await ops.actions.declare('send-email', {
  // Counted before dispatch. `emails` is a unit this workspace declares.
  impact: { dimension: 'emails', amount: 'count(input.to)', bound: 'exact' },
  // A GET on the action's own host, issued after the write.
  verify: {
    url: 'https://api.example.com/v1/messages/{{response.id}}',
    status: 200,
    match: [{ path: 'status', equals: 'sent' }],
  },
});

// One limit, shared by every agent, session and key in the environment.
await ops.impactLimits.create({ name: 'Daily emails', dimension: 'emails', period: 'day', amount: 500 });

const { data } = await anlyon.actions.invoke('send-email', { to: ['a@example.com'] });
console.log(data!.grade); // 'confirmed' when the read-back matched

// Receipts that nobody read back.
const { data: effects } = await ops.actions.effects({ grade: 'acknowledged' });
```

The grades are `confirmed`, `acknowledged`, `unknown`, `failed`, `refused`,
`denied` and `pending`. `acknowledged` means the provider answered 2xx and no
read-back has matched. `refused` means Anlyon stopped the call at dispatch, for
example on an exhausted limit. Pass `null` to remove one declaration, as in
`declare('send-email', { verify: null })`. Changing what a governed action
already declares needs `actions:govern`.

For an API you declare, you write what the action counts, and Anlyon enforces it
before dispatch. A declared action has no
provider idempotency, so a lost response stays `unknown` until a read-back or an
operator settles it. A limit counts governed actions routed through Anlyon in
one environment. A grade is a database record. It is not signed.

## Secrets

A write-only vault. Secrets go in, and no method returns one, because no
endpoint behind one exists.

```typescript
await ops.secrets.put('STRIPE_TEST_KEY', {
  value: process.env.STRIPE_TEST_KEY!,
  allowedHosts: ['api.stripe.com'],
});

// Metadata only. Never a value.
const { data } = await ops.secrets.list();
```

Writing a secret needs `secrets:write`. *Referencing* one from an action needs
`secrets:read`, because a reference is a use.

## Approvals

Put a human in front of a call the agent should not make alone. A gated action
parks and Anlyon runs it on approval. For a call that cannot move into Anlyon,
`approvals.gate()` wraps one of your own functions instead: it waits for the
decision, then *your* process runs *your* function with *your* credential. That
gives you the decision and the record, not credential isolation.

```typescript
const { data } = await client.approvals.request({
  title: 'Refund order ord_1?',
  description: 'EUR 120.00, irreversible.',
  payload: { orderId: 'ord_1', amountCents: 12_000 },
});

const decided = await client.approvals.waitForDecision(data!.id);
if (decided.status === 'approved') await issueRefund();
```

Or wrap the dangerous function once and stop threading approval state through
your own code. `gate()` requests, waits, and calls through only on approval.
A denial or an expiry throws `ApprovalDeniedError`. A wait that runs out while
the approval is still pending throws `ApprovalPendingError`, and your function
does not run:

```typescript
const refund = client.approvals.gate(
  (orderId: string) => ({ title: `Refund ${orderId}?` }),
  async (orderId: string) => stripe.refunds.create({ payment_intent: orderId }),
);

await refund('ord_1'); // waits for a human, five minutes by default
```

Which requests need approval, are auto-approved, or are auto-denied is set by
approval policies (`client.approvalPolicies`, operator credential). Shared
limits on money, resource mutations or a declared unit live in
`client.impactLimits`. `client.environment` halts and resumes the environment.
A halt stops new dispatch. It does not recall a request another server already
accepted.

## Act for your users

Your users connect their own Gmail, HubSpot or Slack, and every action your
agent takes in those accounts is limited, approved and receipted for that user.
Your server names the user with `forUser()`. The model never does.

```typescript
import { Client, EndUserNotConnectedError, parseConnectRedirect } from '@anlyonhq/sdk';

const anlyon = new Client({ apiKey: process.env.ANLYON_API_KEY! });

// 1. Connect: send the user to Anlyon's consent page.
const { data: link } = await anlyon.endUsers.createConnectLink({
  endUserId: user.id,
  integration: 'gmail',
  redirectUrl: 'https://app.example.com/connections/callback',
});
redirect(link!.url);

// 2. The callback route: confirm the flow for the user in *your* session.
const result = parseConnectRedirect(request.url);
if (result?.status === 'pending_confirmation' && result.flowId) {
  await anlyon.endUsers.confirmConnection(session.user.id, result.flowId);
}

// 3. Act for that user. Every request carries `Anlyon-End-User`.
try {
  await anlyon.forUser(user.id).actions.invoke('gmail-send-email', { to, subject, body });
} catch (error) {
  if (error instanceof EndUserNotConnectedError) {
    // Show a "Connect Gmail" button: error.connectUrl, or a link you create.
  }
  throw error;
}
```

- `forUser(endUserId)` checks the id (1 to 128 of `A-Z a-z 0-9 . _ : @ -`) and
  returns a client bound to that user for good. It cannot be switched, and the
  client you call it on is unchanged.
- The confirm step is required. It stops a connect link forwarded to someone
  else from attaching their account to your user: confirm with the user from
  your own session, never one read from the URL. A mismatch throws
  `EndUserMismatchError`. A link with no `redirectUrl` and no default throws
  `RedirectUrlRequiredError`.
- `EndUserNotConnectedError` and `EndUserReconnectRequiredError` (409) carry
  `integration` and `connectUrl` (null when the environment has no default
  redirect URL). `EndUserRequiredError` (400) means the key requires an end user.
- `endUsers` also has `setConnection` (an API-key integration),
  `listConnections`, `deleteConnection`, `erase`, `list({ cursor })`, and
  `approvals.list` / `approvals.decide` for approvals your user decides in your app.
- `endUsers.createSession(endUserId, { ttlSeconds? })` mints a short-lived token
  (15 minutes by default) for that user's browser, for the prebuilt components in
  `@anlyonhq/react`. It can list, connect and disconnect the user's
  accounts and decide their own approvals, and nothing else.
- The MCP server and CLI act with workspace connections only.

## Functions

A function is your code, hosted by Anlyon, calling your actions under the same
policies, limits, approvals and receipts. It has no network, environment
variables or secrets of its own: it reaches the outside through the actions you
allow.

```typescript
await anlyon.functions.create({ name: 'refund-with-checks' });
await anlyon.functions.publish('refund-with-checks', {
  language: 'javascript',
  source: `export default async function run(input, anlyon) {
    const order = await anlyon.read('lookup-order', { order: input.order });
    if (order.paid) await anlyon.invoke('refund', { order: input.order });
  }`,
  allowedActions: ['lookup-order', 'refund'],
});

// Plan: reads run for real, writes are recorded and not sent.
const { data: plan } = await anlyon.functions.run('refund-with-checks', { input: { order: 'ord_123' } });
if (plan!.status === 'awaiting_approval') {
  // plan.plan.approval.id is decided by your team, or by the end user with
  // endUsers.approvals.decide. Then carry out exactly what was approved:
  await anlyon.functions.run('refund-with-checks', {
    input: { order: 'ord_123' },
    mode: 'apply',
    planRunId: plan!.id,
  });
}
```

- An apply run sends each write when it equals the plan's next write. A write
  that differs ends the run `diverged` before it is sent. A plan is applied once.
- `mode: 'straight_through'` sends calls as they are made, with writes limited to
  the version's `straightThrough` policy (`{ actions, maxWrites }`).
- On a client from `forUser()`, `functions.run` and `functions.runs.get` act for
  that user, and every call the run makes carries the user.
- Read a run with `functions.runs.get(id)`. `client.runs` holds agent traces.

## Runs

Runs are the trace model: your agent starts one, spans hang off it, and you
read it back through `client.runs`. For live updates, `client.stream()`
subscribes to the realtime event stream for this key's workspace and
environment and resumes from a cursor after a dropped connection:

```typescript
const { data: run } = await client.runs.start({ name: 'nightly-summary' });
const { data: trace } = await client.runs.get(run!.id);

const ac = new AbortController();
for await (const event of client.stream({ signal: ac.signal })) {
  if (event.type === 'run.started') console.log(event.data.runId);
}
```

## Receiving webhooks

### Next.js

```typescript
// app/api/anlyon/route.ts
import { serve } from '@anlyonhq/sdk/nextjs';

export const { POST } = serve(async (request) => {
  const data = await request.json();
  await processJob(data); // signature already verified
  return { success: true };
});
```

Set `ANLYON_SIGNING_SECRET` in the environment. For more control over the
handler, `verifySignature()` from the same entry point wraps a route you write
yourself.

### Anywhere else

```typescript
import { Receiver } from '@anlyonhq/sdk';

const receiver = new Receiver({ signingSecret: process.env.ANLYON_SIGNING_SECRET! });

if (!receiver.verify({ signature: req.headers.get('anlyon-signature'), body: rawBody })) {
  return new Response('Unauthorized', { status: 401 });
}
```

`verifyOrThrow()` is the same check as a throwing call.

## Entry points

| Import | For |
|---|---|
| `@anlyonhq/sdk` | `Client`, `Receiver`, error types |
| `@anlyonhq/sdk/nextjs` | `serve()`, `verifySignature()` |
| `@anlyonhq/sdk/hono` | Hono middleware |
| `@anlyonhq/sdk/express` | Express middleware |
| `@anlyonhq/sdk/fastify` | Fastify plugin |
| `@anlyonhq/sdk/sveltekit` | SvelteKit handler |
| `@anlyonhq/sdk/h3` | h3 / Nitro handler |
| `@anlyonhq/sdk/cloudflare-workers` | Workers fetch handler |
| `@anlyonhq/sdk/types` | Types only |

Every framework peer dependency is optional. Installing the SDK pulls in none
of them.

## Related packages

- [`@anlyonhq/ai-sdk`](https://www.npmjs.com/package/@anlyonhq/ai-sdk): Vercel
  AI SDK tools for hosted actions and approvals.
- [`@anlyonhq/mcp-server`](https://www.npmjs.com/package/@anlyonhq/mcp-server):
  actions and approvals as MCP tools for Claude Code, Cursor, Codex and any
  other MCP client.

## Upgrading from 2.x

Version 3 removes the client namespaces of the retired features, whose API
endpoints no longer exist: `messages`, `schedules`, `queues`, `workflows`
(with the `@anlyonhq/sdk/workflows` and `@anlyonhq/sdk/nextjs/workflows` entry
points), `memory`, `cache`, `files`, `sessions`, `context`, and the URL groups
and flow control namespaces. `logs` and `analytics` lose their schedule methods and
`logs.forMessage()`/`logs.forSchedule()`, and budgets lose the `cacheLookups` and
`memoryOps` dimensions. Webhook verification (`Receiver`, `serve()`), `events`
and `dlq` are unchanged. See [CHANGELOG.md](./CHANGELOG.md).

## Source

The source is in [AnlyonHQ/anlyon](https://github.com/AnlyonHQ/anlyon/tree/main/sdks/typescript/sdk), under the MIT licence. Releases are published to npm from CI.

## Links

- Documentation: https://docs.anlyon.com/guides/typescript-sdk
- API reference: https://docs.anlyon.com/api-reference
- Issues: https://github.com/AnlyonHQ/anlyon/issues
- Support: support@anlyon.com

## License

MIT © Anlyon
