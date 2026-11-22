# anlyon/resend

The Resend toolset an agent needs for transactional email and contacts. This is the **catalogue
pack** for the Resend integration: the console offers its actions one by one after you connect
Resend, and you can install any subset from the CLI.

Resend is connected with an API key you create in your own account, not by signing in. Anlyon checks
the key with Resend before it stores it, binds it to `api.resend.com` in a request header, and makes
every call itself; the agent never holds the key. Every request also sends `User-Agent: anlyon`,
because Resend refuses requests without one.

Reads return Resend's response to the agent and are logged. Writes are governed: each declares its
impact, counts against a limit, can be put behind an approval, and gets a receipt. Sending is the
built-in `resend.email_send` adapter, which counts emails per recipient, sends Resend's idempotency
key and reads the sent email back.

## API key

Create the key in Resend under API Keys with **Full access**. A Sending access key can send but
cannot read anything (Resend answers `401 restricted_api_key`), so every read, every contact write
and every read-back would fail.

## Reads

Lists page with `after`: pass the last item's id until `has_more` is false.

| Action | What it does | Inputs | Page size |
| --- | --- | --- | --- |
| `list-emails` | Lists sent and scheduled emails, newest first, without bodies | `after` | 20 |
| `get-email` | One email: recipients, subject, bodies, tags, `last_event`, `scheduled_at` | `email_id` | |
| `list-domains` | Lists sending domains with status and capabilities | `after` | 20 |
| `get-domain` | One domain with its DNS records and their status | `domain_id` | |
| `list-contacts` | Lists contacts, optionally only one segment's | `segment_id`, `after` | 20 |
| `get-contact` | One contact, by id or email address | `contact` | |
| `list-segments` | Lists segments | `after` | 20 |
| `get-segment` | One segment | `segment_id` | |
| `list-contact-segments` | Lists the segments one contact is in | `contact_id`, `after` | 20 |

## Writes

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `send-email` | Sends one email from the install's sending domain (adapter `resend.email_send`) | `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `html`, `text` | The sent email by id; it must carry this effect's tag and not be failed or canceled |
| `reschedule-email` | Moves a scheduled email to a new time | `email_id`, `scheduled_at` (ISO 8601) | none: Resend returns the time in another format |
| `cancel-scheduled-email` | Cancels a scheduled email | `email_id` | The email; `last_event` must be `canceled` |
| `create-contact` | Creates a contact | `email` (lowercase), `first_name`, `last_name`, `unsubscribed` | The new contact; `email` must match |
| `update-contact-name` | Sets a contact's first and last name | `contact_id`, `first_name`, `last_name` | The contact; both names must match |
| `set-contact-subscription` | Unsubscribes a contact from broadcasts, or subscribes them again | `contact_id`, `unsubscribed` | The contact; `unsubscribed` must match |
| `delete-contact` | Deletes a contact | `contact_id` | none: reading a deleted contact is not documented |
| `add-contact-to-segment` | Adds a contact to a segment | `contact_id`, `segment_id` | The contact's segments; the segment must be among them |
| `remove-contact-from-segment` | Removes a contact from a segment | `contact_id`, `segment_id` | The contact's segments; the segment must no longer be among them |

`send-email` takes one install parameter, `sending_domain`: the verified domain every `from` address
must be on.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| resend: approve sending an email | Every send requires approval |
| resend: approve canceling a scheduled email | Every cancellation requires approval |
| resend: approve deleting a contact | Every contact deletion requires approval |
| resend: approve subscribing a contact again | Setting `unsubscribed` to false requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| resend: emails per day | 100 emails (one per recipient) |
| resend: emails rescheduled per day | 50 |
| resend: scheduled emails canceled per day | 50 |
| resend: contacts created per day | 200 |
| resend: contacts renamed per day | 200 |
| resend: contact subscriptions changed per day | 200 |
| resend: contacts deleted per day | 20 |
| resend: contacts added to segments per day | 200 |
| resend: contacts removed from segments per day | 200 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **No idempotency on declared writes.** After an `unknown` outcome, reconcile before invoking
  again; `create-contact` can fail as a duplicate or create a second contact.
- **Two writes have no read-back** and are graded acknowledged at best: `reschedule-email` and
  `delete-contact`. Check a reschedule with `get-email`.
- **The cancel read-back expects `last_event` to be `canceled`.** The send adapter relies on the same
  value, but Resend's event list does not name it; the exercise confirms it.
- **The cancel read-back can match an email that was already canceled.** A canceled email cannot be
  rescheduled, and only a scheduled email can be rescheduled or canceled.
- **`create-contact` takes a lowercase email**, so the read-back can compare it exactly.
- **`get-email` returns the full html and text bodies**, cut at 64 KB.
- **The pack cannot schedule an email.** The send adapter sends now; reschedule and cancel act on
  emails your own application scheduled.

## Left out

- Batch sends and broadcasts: they send to many people at once, and the only send here is the
  adapter, one email at a time.
- Received email, inboxes, threads and drafts; templates, automations, events and topics: outside
  the day-to-day sending and contacts scope, and add them on demand.
- Creating, updating, verifying or deleting domains, contact properties and imports, segments,
  API keys, webhooks and logs: account administration.
- Audiences: Resend replaced them with segments; contacts are now global and join segments.

## Exercise

`exercise.json` drives `anlyon packs exercise ./packs/resend`. It sends one email to you, creates
its own contact and deletes it at the end. It needs:

| Need | What |
| --- | --- |
| `from_address` | An address on the pack's sending domain |
| `recipient` | Your own address; the run sends one email to it |
| `scheduled_email_id` | An email to yourself scheduled by hand for this run only, at least an hour ahead; the run reschedules and cancels it |
| `reschedule_at` | An ISO 8601 time after that email's schedule and within 30 days |
| `segment_id` | A segment for the exercise (an empty one is enough); the run adds and removes its own contact |

Schedule a new email for each run. The exercise contact uses an `@example.com` address and is
never emailed.

## Install

```bash
anlyon packs plan ./packs/resend --param sending_domain=mail.example.com
anlyon packs install ./packs/resend --yes --param sending_domain=mail.example.com \
  --action send-email --action get-email --action list-emails
```

Every action sends `{{connection:resend}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Resend account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/resend`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Resend account (`anlyon connections add resend --secret RESEND`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name RESEND=<your secret>`. Do this when the environment has more than one Resend account. A call made for one of your users still uses their own account.

`send-email` uses Anlyon's Resend adapter, which is fixed at install to one sending domain (`sending_domain`). It names the `RESEND` secret, so it needs that connected account before it installs, and it is meant for your own sending domain.

Then review and enable the policies you want. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.2.0 (2026-10-24): every action sends `{{connection:resend}}` instead of `{{secret:RESEND}}`. A call made for one of your users acts in their own Resend account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.1.0: first version.

Sources: https://resend.com/docs/api-reference/introduction,
https://resend.com/docs/api-reference/pagination, https://resend.com/docs/api-reference/errors,
https://resend.com/docs/api-reference/emails/send-email,
https://resend.com/docs/api-reference/emails/list-emails,
https://resend.com/docs/api-reference/emails/retrieve-email,
https://resend.com/docs/api-reference/emails/update-email,
https://resend.com/docs/api-reference/emails/cancel-email,
https://resend.com/docs/dashboard/emails/schedule-email,
https://resend.com/docs/api-reference/domains/list-domains,
https://resend.com/docs/api-reference/domains/get-domain,
https://resend.com/docs/api-reference/contacts/create-contact,
https://resend.com/docs/api-reference/contacts/get-contact,
https://resend.com/docs/api-reference/contacts/list-contacts,
https://resend.com/docs/api-reference/contacts/update-contact,
https://resend.com/docs/api-reference/contacts/delete-contact,
https://resend.com/docs/api-reference/contacts/add-contact-to-segment,
https://resend.com/docs/api-reference/contacts/delete-contact-segment,
https://resend.com/docs/api-reference/contacts/list-contact-segments,
https://resend.com/docs/api-reference/segments/list-segments,
https://resend.com/docs/api-reference/segments/get-segment,
https://resend.com/docs/webhooks/event-types, checked 2026-10-15.
