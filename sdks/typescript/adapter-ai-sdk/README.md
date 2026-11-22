# @anlyonhq/ai-sdk

[![npm](https://img.shields.io/npm/v/@anlyonhq/ai-sdk.svg?color=16A34A)](https://www.npmjs.com/package/@anlyonhq/ai-sdk)
[![downloads](https://img.shields.io/npm/dm/@anlyonhq/ai-sdk.svg?color=16A34A)](https://www.npmjs.com/package/@anlyonhq/ai-sdk)
[![license](https://img.shields.io/npm/l/@anlyonhq/ai-sdk.svg?color=16A34A)](./LICENSE)

[Vercel AI SDK](https://sdk.vercel.ai) integration for [Anlyon](https://anlyon.com). It gives the model the workspace's hosted actions and approvals as AI SDK **tools**. The model names an action and passes input. Anlyon resolves the credential at dispatch and makes the request.

```bash
npm install @anlyonhq/ai-sdk @anlyonhq/sdk ai zod @ai-sdk/anthropic
```

Requires **`ai` v7** (`^7.0.0`), `zod` (`^3.25.76` or `^4.1.8`) and Node 22+. This package is ESM-only, because `ai` v7 is. The examples use Claude through `@ai-sdk/anthropic`; any AI SDK provider works.
Using `ai` v4? Stay on [`@anlyonhq/ai-sdk@1.x`](https://www.npmjs.com/package/@anlyonhq/ai-sdk/v/1.0.1).

## Tools

```ts
import { stepCountIs, streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { Client } from '@anlyonhq/sdk';
import { createAnlyonTools } from '@anlyonhq/ai-sdk';

const client = new Client({ apiKey: process.env.ANLYON_API_KEY! });
const tools = createAnlyonTools(client);

const result = streamText({
  model: anthropic('claude-sonnet-5-5'),
  tools,
  prompt: 'Refund the charge ch_123, then tell me what happened.',
  stopWhen: stepCountIs(5),
});
```

The client calls `https://api.anlyon.com`. Pass `baseUrl` to it for another environment, such as staging.

`createAnlyonTools(client)` returns five tools:

| Tool | What the model can do |
|---|---|
| `listActions` | See the hosted actions the workspace has defined, their input schemas and which ones need approval |
| `invokeAction` | Invoke a hosted action by name. Anlyon holds the credential and makes the call |
| `requestApproval` | Ask a human to decide before a consequential step |
| `checkApproval` | Read an approval's status |
| `waitForApproval` | Wait for the decision inside the turn, up to 120 seconds a call (60 by default) |

Each tool is exported on its own too (`anlyonInvokeActionTool`, `anlyonWaitForApprovalTool`, …) if you would rather assemble your own set.

The events tools are exported on their own too (`anlyonPublishEventTool`,
`anlyonListEventsTool`). Version 3 removed the memory, files, semantic
cache and context tools and the cache and session middleware
(`anlyonCacheMiddleware`, `anlyonSessionMiddleware`), whose API no longer exists.

What `invokeAction` tells the model:

- A gated action returns an approval id. Anlyon runs the reviewed request once it is approved.
- A governed action's result carries its receipt grade, such as `confirmed` or `acknowledged`.
- An `unknown` outcome is reported as unknown, not as failed. The request may have reached the destination, so the model is told not to invoke the action again.

This covers actions routed through Anlyon. A tool your own code calls directly is not routed through Anlyon and is not governed by it. `requestApproval` records a person's decision. It does not route the step that follows through Anlyon.

`invokeAction` goes through `client.actions.invoke()`, so every tool call carries an idempotency key that the SDK generates for it. The SDK client retries its own HTTP request to Anlyon after a network error, a timeout, or a 429, 500, 502, 503 or 504 answer, and each resend carries the same key. A resend is answered from the recorded invocation and is not executed again. This needs an `@anlyonhq/sdk` release later than 2.1.0. A model that calls `invokeAction` twice makes two invocations. To tie a call to your own business operation, write a tool that calls `client.actions.invoke()` with your `idempotencyKey`.

## Act for your users

Build the tools from a client bound to the signed-in user. Each action becomes a
tool with the action's own input schema. No tool schema has an end-user field,
so nothing the model writes can choose or switch the user.

```ts
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { Client } from '@anlyonhq/sdk';
import { anlyonTools } from '@anlyonhq/ai-sdk';

const anlyon = new Client({ apiKey: process.env.ANLYON_API_KEY!, baseUrl: process.env.ANLYON_BASE_URL });

export async function POST(request: Request) {
  const user = await requireSession();
  const { messages } = (await request.json()) as { messages: UIMessage[] };
  const tools = await anlyonTools({
    client: anlyon.forUser(user.id),
    actions: ['gmail-send-email'],
  });
  const result = streamText({
    model: anthropic('claude-sonnet-5-5'),
    tools,
    // In AI SDK v7, convertToModelMessages is async.
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
  });
  return result.toUIMessageStreamResponse();
}
```

`anlyonTools()` returns one tool per action and one more, `anlyon_check_request`
(see [After an approval](#after-an-approval)). Pass `checkTool: false` to leave it
out, or `checkTool: 'my_name'` to rename it.

When the user has not connected the integration, the tool does not throw. It
returns a result the model relays and your UI can render as a button:

```json
{ "status": "connect_required", "integration": "gmail", "displayName": "Gmail", "connectUrl": "https://...", "endUserId": "user_42", "message": "The user has not connected Gmail yet, ..." }
```

`status` is `reconnect_required` for a connection the provider revoked.
`connectUrl` is null when the environment has no default redirect URL; then
create a link with `anlyon.endUsers.createConnectLink()`. The connect flow ends
in your callback route with `anlyon.endUsers.confirmConnection(user.id, flowId)`
(see `@anlyonhq/sdk`). `invokeAction` from `createAnlyonTools()` returns the
same result.

### What an action tool returns

Besides the sentence in `message`, every result has fields your code (and the
model) can branch on:

| Field | |
|---|---|
| `status` | `succeeded`, `failed`, `unknown`, `running`, `pending_approval`, `denied` or `expired` |
| `invocationId` | The call (`inv_…`). Pass it to `anlyon_check_request`, or to `client.actions.invocation()` |
| `approvalId` | The approval (`apr_…`) while a person decides |
| `effectId`, `grade` | The receipt of a governed action and its grade, such as `confirmed` or `acknowledged` |
| `endUserId` | The end user the call was made for |
| `requestId` | The API request's id, when the API sent one, for support |
| `code` | Why the call was refused, or null: `impact_limit_exceeded`, `policy_denied`, `approval_denied`, `approval_expired` |
| `limits` | For `impact_limit_exceeded`: `[{ name, requested, available }]` for each limit that had not enough left |
| `body`, `bodyTruncated` | The destination's response, cut at 8,000 characters with a `…[truncated: N more characters]` marker. Set `maxBodyChars` to change it |

A refusal is a result, not an error: nothing was sent, and the model is told
not to retry. Other API errors (a bad key, a missing scope) still throw.

### After an approval

A gated action returns `status: 'pending_approval'` with its `invocationId` and
`approvalId`; nothing has run yet. Render the approval in your app (for example
with `<ApprovalPrompt approvalId={result.approvalId} />` from `@anlyonhq/react`).
The result's message tells the model to call `anlyon_check_request` with that
`invocationId` once the user says they decided, and not to call the action again.

`anlyon_check_request` reads the call, and its approval, with the same client, so
a `forUser()` client reads only that user's calls. A call that was just approved
gets a few seconds to finish; a call still waiting for a decision is answered at
once. It returns the same fields as an action tool, plus `action` and
`approvalStatus`, and a message for each case: approved and succeeded, declined,
expired, still waiting, an unknown outcome (do not retry), or failed with the
reason. Build it on its own with `anlyonCheckRequestTool(client)`.

## Source

The source is in [AnlyonHQ/anlyon](https://github.com/AnlyonHQ/anlyon/tree/main/sdks/typescript/adapter-ai-sdk), under the MIT licence. Releases are published to npm from CI.

## Links

- Documentation: https://docs.anlyon.com/guides/typescript-sdk
- TypeScript SDK: [`@anlyonhq/sdk`](https://www.npmjs.com/package/@anlyonhq/sdk)
- MCP server: [`@anlyonhq/mcp-server`](https://www.npmjs.com/package/@anlyonhq/mcp-server)
- Issues: https://github.com/AnlyonHQ/anlyon/issues
- Support: support@anlyon.com

## License

MIT © Anlyon
