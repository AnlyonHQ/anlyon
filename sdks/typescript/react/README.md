# @anlyonhq/react

Prebuilt React components and hooks for [Anlyon](https://anlyon.com). Your end users approve what your agent wants to do, and connect their own accounts, inside your app.

This package is a beta release. Its API may change before 1.0.

```bash
npm install @anlyonhq/react @anlyonhq/sdk
```

React 18 or 19. No runtime dependencies beyond React.

## How it fits together

1. Your server mints a short-lived **end-user session token** for whoever is signed in. Your API key never leaves the server.
2. `<AnlyonProvider>` fetches that token from your route and keeps it fresh.
3. The components call Anlyon from the browser with the token. It acts for that one end user only.

The token can list, connect and disconnect the end user's accounts. When your key has `end-users:approvals`, it can also list and decide that end user's own approvals. It cannot call actions, read secrets, or see any other user. It lasts 15 minutes by default.

## 1. The server route

```ts
// app/api/anlyon/session/route.ts
import { Client } from '@anlyonhq/sdk';
import { createSessionHandler } from '@anlyonhq/react/server';

const anlyon = new Client({ apiKey: process.env.ANLYON_API_KEY! });

export const POST = createSessionHandler({
  client: anlyon,
  getEndUserId: async () => (await auth())?.user.id, // your own session
});
```

The key needs `end-users:write`, and `end-users:approvals` for the approval components. It answers `401` when nobody is signed in.

For connecting accounts, add the callback route your connect links return to. It confirms the connection on your server, for the signed-in user only:

```ts
// app/api/anlyon/connected/route.ts
import { createConnectCallbackHandler } from '@anlyonhq/react/server';

export const GET = createConnectCallbackHandler({
  client: anlyon,
  getEndUserId: async () => (await auth())?.user.id,
  redirectTo: '/settings/connections',
});
```

In the console, add your app's URL, for example `https://app.example.com/api/anlyon/connected`, to the environment's **allowed redirect URLs**. Their origins are also the origins the browser may call Anlyon from with a session token.

## 2. The provider

```tsx
'use client';
import { AnlyonProvider } from '@anlyonhq/react';
import '@anlyonhq/react/styles.css';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AnlyonProvider
      getToken={() => fetch('/api/anlyon/session', { method: 'POST' }).then((r) => r.json())}
      baseUrl={process.env.NEXT_PUBLIC_ANLYON_BASE_URL} // unset: https://api.anlyon.com
      connect={{ redirectUrl: 'https://app.example.com/api/anlyon/connected' }}
    >
      {children}
    </AnlyonProvider>
  );
}
```

| Prop | |
|---|---|
| `getToken` | Returns `{ token, expiresAt }` (what `createSessionHandler` answers) or the token. Called again a minute before it expires, and after the API refuses one. |
| `baseUrl` | Default `https://api.anlyon.com`. Set it for another environment's API host. |
| `connect` | `{ mode: 'popup' \| 'redirect', redirectUrl }`. Popup is the default; it falls back to a redirect when the browser blocks it. |
| `pollInterval` | How often open approvals are checked while the page is visible, in ms. Default 30000. `0` turns it off. |
| `locale` | For amounts and dates. Default: the browser's. |

The provider holds one user's session. When the signed-in user changes without a page load, remount it with that user's id as its `key`, so nothing from the previous user stays on screen.

## 3. The components

### `<ApprovalInbox />`

Everything waiting for the end user's answer, newest first. Each row opens to what the agent wants: the action in words, its input, the preview (fields, a diff, the amount), and when it expires. Approve or Decline, with an optional note.

```tsx
<ApprovalInbox />
<ApprovalInbox status="all" limit={50} title="Requests" />
```

### `<ApprovalPrompt approvalId />`

One approval, inline: for example under a chat message whose tool result carries an `approvalId`.

```tsx
<ApprovalPrompt approvalId={result.approvalId} onDecided={(decision) => resume(decision)} />
```

Both show each state honestly: waiting, sending, approved (with the action's outcome), declined, expired, and failed with the API's own message. An answer that lands after someone else decided shows what actually happened.

### `<ConnectButton integration="github" />`

Connect, or reconnect, one integration. Shows `GitHub connected` once it is.

### `<Connections />`

The end user's connected accounts with their status, reconnect, and disconnect behind a confirm step. Pass `integrations={['github', 'slack']}` to offer ones not connected yet.

### `<ConnectPrompt result={toolResult} />`

For `@anlyonhq/ai-sdk` tool results. Renders a connect card for `connect_required` and `reconnect_required`, and nothing for any other result, so it can sit in every tool result's slot.

## Hooks

Each component is built on a hook you can use with your own markup:

| Hook | Returns |
|---|---|
| `useApprovals({ status, limit })` | `items`, `pendingCount`, `loading`, `error`, `refresh`, `decide(id, 'approve' \| 'deny', reason?)` |
| `useApproval(approvalId)` | `item`, `loading`, `error`, `refresh`, `decide(decision, reason?)` |
| `useConnections()` | `connections`, `loading`, `error`, `refresh`, `disconnect(integration)` |
| `useConnect(integration)` | `status`, `phase`, `connection`, `error`, `connect()`, `cancel()` |

Errors are `AnlyonUIError` with the API's `status`, `code` and `message`.

## Theming

Every color comes from a CSS variable. Each one reads `--anlyon-*` first, then the [shadcn/ui](https://ui.shadcn.com) token of the same role, then a neutral default. In a shadcn app the components follow your theme with no setup.

| Variable | Falls back to |
|---|---|
| `--anlyon-bg` | `--background` |
| `--anlyon-fg` | `--foreground` |
| `--anlyon-muted` / `--anlyon-muted-fg` | `--muted` / `--muted-foreground` |
| `--anlyon-accent` | `--accent` (hover) |
| `--anlyon-border` | `--border` |
| `--anlyon-primary` / `--anlyon-primary-fg` | `--primary` / `--primary-foreground` |
| `--anlyon-destructive` / `--anlyon-destructive-fg` | `--destructive` / white |
| `--anlyon-ring` | `--ring` |
| `--anlyon-radius` | `--radius` |
| `--anlyon-success`, `--anlyon-warning` | built-in green and amber |

Values are full colors: hex, `rgb()`, `oklch()`. A shadcn theme that stores bare HSL channels (`--background: 0 0% 100%`) needs `class="anlyon-shadcn-hsl"` on `<html>`.

Dark mode follows `prefers-color-scheme`. A `.dark` or `[data-theme="dark"]` ancestor forces dark; `.light` or `[data-theme="light"]` forces light.

Every rule weighs no more than one class, so your CSS wins. Every component takes `className`, and `unstyled` to drop the bundled styles entirely. The class names below and the `data-state` attributes stay, for your own CSS.

| Component | Root class | Parts |
|---|---|---|
| `ApprovalInbox` | `anlyon-inbox` | `anlyon-header`, `anlyon-title`, `anlyon-count`, `anlyon-list`, `anlyon-approval[data-state]`, `anlyon-approval-row`, `anlyon-approval-body` |
| `ApprovalPrompt` | `anlyon-approval-prompt` | `anlyon-prompt-head`, `anlyon-prompt-title`, `anlyon-prompt-body`, `anlyon-prompt-foot`, `anlyon-badge[data-state]` |
| both | | `anlyon-fields`, `anlyon-diff`, `anlyon-chips`, `anlyon-decision`, `anlyon-outcome[data-state]`, `anlyon-button[data-variant]`, `anlyon-error` |
| `ConnectButton` | `anlyon-connect` | `anlyon-connect-button`, `anlyon-connected` |
| `Connections` | `anlyon-connections` | `anlyon-connection[data-status]`, `anlyon-monogram`, `anlyon-confirm` |
| `ConnectPrompt` | `anlyon-connect-prompt` | `anlyon-connect-prompt-title`, `anlyon-connect-prompt-action` |

`data-state` on an approval is one of `pending`, `deciding`, `approved`, `declined`, `expired`, `failed`.

## What stays on your server

- Your API key, and minting session tokens.
- Confirming a connection (`createConnectCallbackHandler`).
- Calling actions, and everything else the token cannot do.

## Accessibility

Rows and buttons are real buttons. Up, Down, Home and End move between inbox rows. Decisions and disconnects are announced in a live region. After an answer, focus returns to the row or the prompt; after a confirm closes, to its button. Motion stops under `prefers-reduced-motion`. The layout holds at 320 px.

## License

MIT © Anlyon
