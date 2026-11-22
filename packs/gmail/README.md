# anlyon/gmail

Send email from a person's own Gmail address, governed. This is the **catalogue pack** for the Gmail
integration: the console offers its action after you connect Gmail, and you can install it from the
CLI. Anlyon holds the token and makes every call; the agent never sees it.

Gmail is connected by signing in with Google (OAuth). Anlyon asks for one scope,
`https://www.googleapis.com/auth/gmail.send`: send email as the account, and nothing else. Anlyon
cannot read, search, label or delete mail. Every Gmail scope that could read a message is restricted
by Google and puts the whole app through a yearly third-party security assessment, so none is asked
for. The token is bound to `gmail.googleapis.com` in a request header.

## Writes

| Action | What it does | Inputs | Impact | Read-back |
| --- | --- | --- | --- | --- |
| `send-email` | Sends one email; Google delivers it to every address in its To, Cc and Bcc headers and keeps a copy in Sent | `raw`, `thread_id`? | 1 email per call | none (graded `acknowledged`) |

`raw` is the whole message in RFC 2822 form, base64url-encoded: headers (`To`, `Cc`, `Subject`,
`Content-Type`; `From` may be left out, and Google sets it to the connected address), a blank line,
then the body. For example:

```bash
printf 'To: dana@example.com\r\nSubject: Your intro call\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nHi Dana, our call is on Tuesday.\r\n' \
  | base64 -w0 | tr '+/' '-_' | tr -d '='
```

To reply in a thread, pass the `threadId` an earlier send returned as `thread_id`, keep the thread's
Subject, and set `In-Reply-To` and `References` to the message replied to.

### Why the receipt is `acknowledged`

A governed write is graded `confirmed` only when a read of the provider's own record matches. With
`gmail.send` alone Google lets Anlyon send but not read, so nothing sent can be read back. Google's
answer (the message id and `labelIds: ["SENT"]`) is recorded, and the receipt is graded
`acknowledged`: Google accepted the message. It is the same grade an adopted MCP tool gets. Delivery
to the recipient is not observed.

## Policies and limits

An email reaches a person outside the agent and cannot be recalled, so the pack suggests an approval
for every send. An approval shows `raw` as it was given: decode it before approving
(`echo '<raw>' | tr '_-' '/+' | base64 -d`).

| Policy (installed **disabled**) | Effect |
| --- | --- |
| gmail: approve sending an email | Every send requires approval |

| Suggested limit (created with `--with-limits`) | Per day |
| --- | --- |
| gmail: emails sent per day | 20 |

Twenty a day is sized for an assistant writing on one person's behalf; it stops a loop long before
it reaches a contact list. Google's own sending limits for the account still apply.

## Exercise

`anlyon packs exercise ./packs/gmail --need raw=<base64url message>` sends one email. Address it to an
inbox you own; the command that builds `raw` is in `exercise.json`.

## Limitations

These are also in the action's description, which the preview shows a reviewer as "Action notes".

- **Google's Testing mode.** While a Google app is in Testing mode, only the test users listed on it can connect, and Google ends their sign-in after 7 days, so the account must be connected again. Publish the app, with Google's verification for its scopes, before production use.
- **No read-back.** See above: the receipt is `acknowledged`, never `confirmed`.
- **One email per call, counted as one.** The limit counts calls, not recipients: a message with ten addresses in To counts as one email.
- **The approval shows the encoded message.** Decode `raw` before approving.
- **No provider idempotency.** Anlyon sends each email once and never repeats it. After an `unknown` outcome, ask the recipient or check Sent in Gmail before invoking again, or the email can be sent twice.
- **`raw` is at most 4,096 characters**, about 3 KB of message: short text or HTML, no attachments.
- **Not included.** Reading, searching, drafting, labelling, archiving or deleting mail, and the mailbox's settings: each needs a scope Anlyon does not ask for.

## Install

```bash
anlyon packs plan ./packs/gmail
anlyon packs install ./packs/gmail --yes
```

The action sends `{{connection:gmail}}`, so nothing needs connecting before install. A call made for
one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) sends from that
user's own Gmail; a user who has not connected gets `409 END_USER_NOT_CONNECTED` with a connect link.
Any other call sends from this environment's connected Gmail account (`anlyon connections add gmail
--secret GMAIL`). Add `--credential secret` to bind it to `GMAIL` by name.

Then review and enable the policy. Add `--with-limits` to create the limit (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-11-03): one write, send an email, written by hand from Google's reference.

Sources: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
(`raw`, `threadId`, the response's `id`, `threadId` and `labelIds`), the scope list at
https://developers.google.com/workspace/gmail/api/auth/scopes (`gmail.send` is sensitive; the read
scopes are restricted), and https://developers.google.com/workspace/gmail/api/guides/sending.
