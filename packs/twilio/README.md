# anlyon/twilio

The Twilio toolset an agent needs for SMS, phone numbers and call logs. This is the **catalogue
pack** for the Twilio integration: the console offers its actions one by one after you connect
Twilio ("What may your agent do here?"), and you can install any subset from the CLI.

Twilio is connected with an Account SID and an Auth Token, not by signing in. Anlyon checks them
with Twilio before it stores them, and sends them to `api.twilio.com` as HTTP Basic
(`{accountSid}:{authToken}`) in the `Authorization` header. The agent never holds the token:
Anlyon makes every call.

## Account SID and Auth Token

Both are in the Twilio Console under Account, API keys and tokens. The Auth Token has no scopes: it
can do anything the account can, including buying numbers and sending to any destination the
account allows. Connect a **subaccount** that holds the phone numbers your agent should use, so its
token cannot reach the rest of your Twilio project.

Every action takes `account_sid` as an input, because Twilio's URLs name the account
(`/2010-04-01/Accounts/{AccountSid}/...`) and the Account SID stored with the connection is not
readable by an action template. Give the SID of the connected account. Twilio documents that a
parent account's SID and token reach the 2010-04-01 resources of its subaccounts, and that a
subaccount's credentials cannot reach its parent or other subaccounts. So with a parent account's
token an agent can act in any of its subaccounts by naming that SID; a subaccount's token keeps it
in that subaccount. A SID the credentials do not cover is refused by Twilio with error 20003
(permission denied).

## Reads

Reads return Twilio's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so lists ask for
20 a page. When a page's `next_page_uri` is not null, pass its `Page` and `PageToken` values as
`page` and `page_token`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `twilio-list-messages` | Lists sent and received messages, by recipient, sender or date sent (UTC). 20 a page | `account_sid` and any of `to`, `from`, `date_sent`, `date_sent_on_or_before`, `date_sent_on_or_after`, `page`, `page_token` |
| `twilio-get-message` | Gets one message: body, status, segments, price, error code | `account_sid`, `message_sid` |
| `twilio-list-message-media` | Lists a message's media files (type and uri, not the file). 20 a page | `account_sid`, `message_sid`, `page`, `page_token` |
| `twilio-list-phone-numbers` | Lists the account's phone numbers, by number (with `*` wildcards) or friendly name. 20 a page | `account_sid` and any of `phone_number`, `friendly_name`, `page`, `page_token` |
| `twilio-get-phone-number` | Gets one phone number with its capabilities and incoming URLs | `account_sid`, `phone_number_sid` |
| `twilio-list-calls` | Lists calls, by recipient, caller, status or start date (UTC). 20 a page | `account_sid` and any of `to`, `from`, `status`, `started_before`, `started_on_or_after`, `page`, `page_token` |
| `twilio-get-call` | Gets one call: status, direction, times, duration, price | `account_sid`, `call_sid` |

## Writes

Each write declares an impact, counts against its limit, can be put behind an approval policy, and
gets a receipt. `send-sms` counts 1 message; the others count 1 resource mutation.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `twilio-send-sms` | Sends one SMS to one number, from one of the account's numbers or through a Messaging Service | `account_sid`, `to`, `body`, and `from` or `messaging_service_sid` | The message by its new sid; `to` must match and `body` must equal what Twilio stored. Status is not checked: it moves from queued to sent and delivered |
| `twilio-redact-message` | Empties a message's body and keeps its record | `account_sid`, `message_sid` | The message; `body` must be empty |
| `twilio-delete-message` | Deletes a message record and its body | `account_sid`, `message_sid` | Getting the message must answer 404 |
| `twilio-rename-phone-number` | Changes a phone number's friendly name | `account_sid`, `phone_number_sid`, `friendly_name` | The number; `friendly_name` must match |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| twilio: approve sending an SMS | Every SMS requires approval. It reaches a person and costs money; turn it on until you trust what your agent sends |
| twilio: approve redacting a message | Every redaction requires approval. It cannot be undone |
| twilio: approve deleting a message | Every deletion requires approval. It cannot be undone |

Suggested limits are created with `--with-limits` and printed otherwise. Each counts one write action per day. The
amounts suit one team's normal day of use; the SMS limit is in messages, not segments or money.
Change them to fit your volume and budget.

| Suggested limit | Per day |
| --- | --- |
| twilio: SMS sent per day | 100 messages |
| twilio: messages redacted per day | 100 |
| twilio: messages deleted per day | 100 |
| twilio: phone numbers renamed per day | 20 |

## Exercise

`anlyon packs exercise ./packs/twilio --need account_sid=AC... --need from_number=+1... --need to_number=+1...`
runs every action once, in the order of `exercise.json`. It needs the connected account's SID, a
number the account owns that can send SMS, and a phone you hold that receives SMS. Use an upgraded account: a trial account sends only to verified
numbers and limits what a message may say, so the run's own message can be refused. The call log must hold at least one call, because the pack has no
action that places one; `list-calls` saves the sid of a call on its page and `get-call` reads it.

The run renames the sending number to `Anlyon exercise <run>` and back to its old friendly name,
sends one SMS (`Anlyon exercise <run>: a test message, no reply needed.`), which Twilio bills, then
redacts it and deletes it. Twilio refuses to delete a message still being sent (error 20009): if the
last step fails with it, wait a few minutes and run `delete-message` again. Turn the policies off
(or approve them) for the run, or it stops at the send.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The SID is an input.** Every action takes `account_sid`. A parent account's token reaches every
  subaccount named this way; connect a subaccount to keep the agent in one.
- **Sending costs money and is counted in messages.** Twilio bills each segment (160 GSM-7 or 70
  UCS-2 characters) at the destination's rate, and fills in `price` after sending. The impact and
  the limit count one message per send, not segments or money, so a limit of 100 messages does not
  cap spend. Set a budget in Twilio as well.
- **No recall and no idempotency.** A sent SMS cannot be recalled. No idempotency key is sent, so a
  retry after an unknown outcome can send a second SMS.
- **SMS to phone numbers.** `send-sms` sends text to E.164 numbers. MMS media, WhatsApp and other
  channels, scheduled sends, status callbacks and Content Templates are not offered.
- **Trial accounts.** A trial account sends only to verified numbers. On a trial in Twilio's legacy
  Console, Twilio starts the body with a trial notice ("Sent from a Twilio Trial account"), which is
  why the read-back compares the body with what Twilio stored, not with the input. On a trial in the
  current Twilio Console, custom message bodies are not supported: the body must name one of
  Twilio's templates, and the message is sent from a Twilio trial number.
- **Redaction and deletion are permanent.** Twilio does not document in which statuses a message can
  be redacted; redact it once it is sent, delivered, failed or received. A message still being sent
  or received cannot be deleted (error 20009).
- **Calls are read.** Placing, changing or ending calls needs TwiML and is not offered. Recordings
  and transcriptions are left out.
- **Phone number settings.** `rename-phone-number` changes the friendly name and nothing else.
  Incoming SMS and voice URLs (webhooks), buying and releasing numbers are left out.
- **Lookup is a different host.** Phone number Lookup is on `lookups.twilio.com`, which the
  connection is not bound to, so it is left out.
- **Rate limits.** Twilio answers 429 (error 20429) when too many requests run at once. A sent
  message can wait in Twilio's queue before it goes out.

## Install

```bash
anlyon packs plan ./packs/twilio
anlyon packs install ./packs/twilio --yes --action list-messages --action get-message --action send-sms
```

Every action sends `{{connection:twilio}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Twilio account. Store their own credentials with `PUT /api/v2/end-users/{endUserId}/connections/twilio`, giving `fields` `accountSid` and `authToken`. A user with nothing stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Twilio account (`anlyon connections add twilio --secret TWILIO`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name TWILIO=<your secret>`. Do this when the environment has more than one Twilio account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: read messages, their media, phone numbers and calls; send an
  SMS, redact or delete a message, and rename a phone number, as governed writes.

## Sources

Twilio REST API 2010-04-01, checked 2026-11-22:

- OpenAPI description (Messages, Media, IncomingPhoneNumbers and Calls: paths, filters, `PageSize`,
  `Page` and `PageToken`, form bodies, redaction by an empty `Body`, response fields, HTTP Basic with
  the Account SID and Auth Token):
  https://github.com/twilio/twilio-oai/blob/main/spec/json/twilio_api_v2010.json
- Message resource (a delete answers 204 and the message leaves the logs; redaction keeps the
  record): https://www.twilio.com/docs/messaging/api/message-resource
- Media resource: https://www.twilio.com/docs/messaging/api/media-resource
- IncomingPhoneNumber resource:
  https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
- Call resource: https://www.twilio.com/docs/voice/api/call-resource
- Subaccounts (parent credentials reach subaccount 2010-04-01 resources; a subaccount's credentials
  do not reach its parent or other subaccounts): https://www.twilio.com/docs/iam/api/subaccounts
- HTTP status codes (`401`, `404`, `429`): https://www.twilio.com/docs/usage/twilios-response
- Error 20003 (permission denied; causes include subaccount credentials used on the parent or on
  another subaccount): https://www.twilio.com/docs/api/errors/20003
- Error 20009 (cannot delete a message before it is complete):
  https://www.twilio.com/docs/api/errors/20009
- Error 20404 (not found, for a wrong SID or a resource that has been deleted):
  https://www.twilio.com/docs/api/errors/20404
- Error 20429 (too many requests, answered with HTTP 429):
  https://www.twilio.com/docs/api/errors/20429
- Trial accounts (verified recipients only): https://www.twilio.com/docs/usage/trials
- SMS on a trial in the current Twilio Console (template bodies, a Twilio trial number):
  https://www.twilio.com/docs/usage/trials/try-out-sms
- Trial restrictions in the legacy Console (the trial notice at the start of the body):
  https://support.twilio.com/hc/en-us/articles/360036052753-Free-Trial-Account-Restrictions-and-Limitations
