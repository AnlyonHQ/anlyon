# anlyon/postmark

The Postmark toolset an agent needs to send email and look after delivery on one Postmark server:
sent and received email, bounces, suppressions, templates and stats. This is the **catalogue pack**
for the Postmark integration: the console offers its actions one by one after you connect Postmark
("What may your agent do here?"), and you can install any subset from the CLI.

Postmark is connected with a Server API token you copy from Postmark, not by signing in. Anlyon
checks the token with Postmark before it stores it, and binds it to `api.postmarkapp.com` in the
`X-Postmark-Server-Token` header. The agent never holds the token: Anlyon makes every call.

## Server API token

Copy the token from the server's API Tokens tab in Postmark. Account Owners, Account Admins and
Server Admins can see it. A Server API token reaches one server: every action works on that server
and its message streams. Postmark has no scoped server tokens, so the token can do anything the
Server API allows. The pack uses the actions below and nothing else.

Account-level work (servers, domains, sender signatures) needs an Account API token and is not in
this pack.

## Reads

Reads return Postmark's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed. Postmark pages with `offset`: pass 0, then add 20 for each next page. `offset` plus 20 may not
pass 10000; narrow the dates to reach older results. Dates are US Eastern time.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `postmark-list-message-streams` | Lists the server's streams that are not archived: id, name, type | `type` (optional) |
| `postmark-search-outbound-messages` | Searches sent and queued email, without bodies. 20 a page | `offset`, and optional `recipient`, `from_email`, `tag`, `status`, `subject`, `message_stream`, `fromdate`, `todate` |
| `postmark-get-outbound-message` | Gets one sent email with its bodies and its events (delivered, bounced, opened, clicked) | `message_id` |
| `postmark-search-inbound-messages` | Searches received email. 20 a page | `offset`, and optional `recipient`, `from_email`, `subject`, `mailbox_hash`, `status`, `fromdate`, `todate` |
| `postmark-get-inbound-message` | Gets one received email with its bodies and headers | `message_id` |
| `postmark-list-bounces` | Lists bounces, with whether each address is inactive and can be reactivated. 20 a page | `offset`, and optional `type`, `inactive`, `email`, `tag`, `message_id`, `message_stream`, `fromdate`, `todate` |
| `postmark-get-bounce` | Gets one bounce with its details and content | `bounce_id` |
| `postmark-get-delivery-stats` | Gets bounce totals by type and the count of inactive addresses | none |
| `postmark-get-outbound-stats` | Gets sent, bounced, spam complaint, open and click totals | optional `tag`, `fromdate`, `todate`, `message_stream` |
| `postmark-list-suppressions` | Lists the addresses a stream will not send to, with reason and origin | `message_stream`, and optional `email`, `reason`, `origin`, `fromdate`, `todate` |
| `postmark-list-templates` | Lists the server's templates: id, alias, type, active. 20 a page | `offset`, `type` (optional) |
| `postmark-get-template` | Gets one template with its subject, bodies and placeholders | `template` (id or alias) |

## Writes

Each write declares its impact, counts against its limit, can be put behind an approval policy, and
gets a receipt.

| Action (installed name) | What it does | Inputs | Impact | Read-back |
| --- | --- | --- | --- | --- |
| `postmark-send-email` | Sends one email to one recipient | `from`, `to`, `subject`, `text_body` or `html_body`, `reply_to`, `tag`, `message_stream` | 1 email | The message by its MessageID; the subject and stream must match |
| `postmark-send-template-email` | Sends one email to one recipient from a server template | `template_id` or `template_alias`, `template_model`, `from`, `to`, `reply_to`, `tag`, `message_stream` | 1 email | The message by its MessageID; the stream must match |
| `postmark-activate-bounce` | Reactivates an address Postmark deactivated after a bounce | `bounce_id` | 1 resource mutation | The bounce; `Inactive` must be false |
| `postmark-suppress-recipient` | Stops a stream from sending to one address | `message_stream`, `email` | 1 resource mutation | The stream's suppressions for that address; it must be listed |
| `postmark-unsuppress-recipient` | Removes one address from a stream's suppressions | `message_stream`, `email` | 1 resource mutation | The stream's suppressions for that address; it must be gone |

| Policy (installed **disabled**) | Effect | When to turn it on |
| --- | --- | --- |
| postmark: approve sending an email | Every `send-email` waits for a person | When the agent writes to your customers and a person should read each email before it goes |
| postmark: approve sending a template email | Every `send-template-email` waits for a person | When a template email reaches customers and a person should check the values before it goes |
| postmark: approve reactivating a bounced address | Every `activate-bounce` waits for a person | Always, unless a person already checked each address the agent fixes |
| postmark: approve removing a suppression | Every `unsuppress-recipient` waits for a person | Always: the person may have asked not to be emailed |

| Suggested limit (created only with `--with-limits`) | Per day | Why this amount |
| --- | --- | --- |
| postmark: emails sent per day | 200 emails | One-to-one replies and notices an agent sends in a working day stay well under it. Raise it for a product that sends on every sign-up or order |
| postmark: template emails sent per day | 200 emails | The same reasoning as plain sends |
| postmark: bounced addresses reactivated per day | 10 | Reactivating is a fix for a few addresses a person checked, not routine work |
| postmark: addresses suppressed per day | 50 | Covers a day of unsubscribe and do-not-contact requests handled by an agent |
| postmark: suppressions removed per day | 10 | Removing a suppression is rare and should stay small |

The amounts are suggestions. Change them to match your own sending. With `scope: "end_user"` a
limit counts per end user, for example 20 emails a day for each user's agent.

## Exercise

`anlyon packs exercise ./packs/postmark --need from=... --need to=... --need message_stream=outbound --need template_alias=... --need bounce_id=... --need inbound_message_id=...`
runs every action once, in the order of `exercise.json`, against your Postmark server.

| Need | What to give |
| --- | --- |
| `from` | An address on a confirmed sender signature or domain of the server |
| `to` | An address you own. It gets two test emails |
| `message_stream` | A transactional stream id, `outbound` unless you renamed it |
| `template_alias` | The alias of an active Standard template. Its placeholders may stay empty |
| `bounce_id` | An inactive hard bounce with `CanActivate` true. Send one email to `hardbounce@bounce-testing.postmarkapp.com` from the server; Postmark records a test hard bounce, and `list-bounces` shows its ID |
| `inbound_message_id` | The MessageID of one email the server received |

The run sends two emails to `to`, tagged `anlyon-exercise`. It suppresses
`anlyon-exercise-<run>@example.com` and removes that suppression again. It reactivates the bounce
you name. Nothing else is changed. Turn the policies off (or approve the requests) for the run, or it
stops at the policy it meets. A server in Postmark's sandbox mode can be used for the run.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **One recipient per send.** `send-email` and `send-template-email` take one `to` address and no
  Cc or Bcc, so each call is exactly one email and the limit counts emails. Send again for each
  recipient.
- **No attachments, custom headers or metadata.** Attachments are base64 in the body, which no
  input schema here bounds well. Declare an action of your own if you need them.
- **No batch or bulk sends.** Postmark's batch endpoint answers 200 when single messages fail, so a
  receipt could not say which were sent. The Bulk API needs Postmark's approval. Both are left out.
- **No idempotency on sends.** Postmark has no idempotency key. A retry after an unknown outcome can
  send the email twice.
- **The send read-back reads Postmark's activity.** It finds the message by MessageID in the
  stream's activity. Postmark keeps messages for the server's retention period (45 days by default).
  A template send is checked on its stream, not its subject, because the template renders the
  subject.
- **Suppressions answer 200 on failure.** Postmark reports a failed suppression or removal inside a
  200 response. The read-back is what shows the change landed. A suppression from a spam complaint
  cannot be removed. Give addresses in lower case, as Postmark lists them, or the read-back may not
  match.
- **One server per token.** Every action works on the server whose token you connected. Servers,
  domains, sender signatures, webhooks, inbound rules and templates' editing are left out.
- **Inbound retries and bypasses are left out.** Retrying a failed inbound message or bypassing a
  blocked one changes how your inbound webhook is called. Do it in Postmark.
- **Searches are capped.** Postmark returns at most 10000 results for a search. Narrow the dates
  for older results. Suppression lists come in one response; filter by address or date on a large
  list.

## Install

```bash
anlyon packs plan ./packs/postmark
anlyon packs install ./packs/postmark --yes --action search-outbound-messages --action get-outbound-message --action send-email
```

Every action sends `{{connection:postmark}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Postmark server token. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/postmark`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Postmark account (`anlyon connections add postmark --secret POSTMARK`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name POSTMARK=<your secret>`. Do this when the environment has more than one Postmark account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): searches and reads for sent and received email, bounces,
  suppressions, templates and stats; sends to one recipient, bounce reactivation and suppressions as
  governed writes.

## Sources

Postmark publishes no OpenAPI description of its API, so this pack is written by hand from the API
reference, checked 2026-10-24:

- Overview (endpoint, authentication, response codes, error codes): https://postmarkapp.com/developer/api/overview
- Email: https://postmarkapp.com/developer/api/email-api
- Templates (send with template, list, get): https://postmarkapp.com/developer/api/templates-api
- Messages (outbound and inbound search and details): https://postmarkapp.com/developer/api/messages-api
- Bounces (delivery stats, list, get, activate): https://postmarkapp.com/developer/api/bounce-api
- Suppressions (dump, create, delete): https://postmarkapp.com/developer/api/suppressions-api
- Message streams: https://postmarkapp.com/developer/api/message-streams-api
- Stats: https://postmarkapp.com/developer/api/stats-api
- Test bounces: https://postmarkapp.com/developer/user-guide/sandbox-mode/generate-fake-bounces
