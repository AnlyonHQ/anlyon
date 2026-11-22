# @anlyonhq/react

## 0.1.1

### Patch Changes

- 3ed1bd4: An end user's connect-required error names what to connect. `EndUserConnectionRequiredError` gains `displayName`, the name the API gives: an integration's, or an MCP server's own for a tool adopted from one. `<ConnectPrompt>` shows it on the card, and the MCP server's `connect_required` result carries it and uses it in its message.

## 0.1.0

### Minor Changes

- b165f45: Initial release, in beta: prebuilt React components and hooks for end users. `<AnlyonProvider getToken>`, `<ApprovalInbox />`, `<ApprovalPrompt approvalId />`, `<ConnectButton integration />`, `<Connections />` and `<ConnectPrompt result />`, each with a headless hook, plus `createSessionHandler` and `createConnectCallbackHandler` in `@anlyonhq/react/server`. Styles in `@anlyonhq/react/styles.css` follow shadcn/ui tokens, or `--anlyon-*` variables. The API may change before 1.0.

### Patch Changes

- 51985cd: `useConnect` (and so `<ConnectButton />` and `<Connections />`) now opens a connect link only when it is https, or http on localhost, the same check `<ConnectPrompt />` applies to a tool result's link. Any other link is not followed: the popup closes and the component shows an error.
- 0117edb: Approvals read like a person's decision, not an operator's review.
  
  - `<ApprovalPrompt>` and `<ApprovalInbox>` show what will happen, the exact change, whether it can be undone (one line, from the preview's new `undo` and `reversible`), and when the request expires. The execution target and the adapter's guarantees are never shown, even from an older server that still sends them.
  - When a preview has nothing to show but the action's input (a declared action), the input is shown as Details rather than behind a disclosure.
  - `<ApprovalInbox approvalTitle={(approval) => ...}>` sets each row's headline in your app's words; return `undefined` to keep the default.
  - `<ApprovalPrompt title>` is now what assistive tech names and announces, not the default headline.
  - A declared unit reads correctly for one: `1 reminder`, not `1 reminders`.
