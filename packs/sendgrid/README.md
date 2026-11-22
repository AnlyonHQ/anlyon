# anlyon/sendgrid

The Twilio SendGrid toolset an agent needs to send email and keep a mailing audience in order:
send an email or a template email, find and read Marketing contacts and lists, add and update
contacts, take them off lists or delete them, and honour unsubscribes. This is the **catalogue
pack** for the SendGrid integration: the console offers its actions one by one after you connect
SendGrid ("What may your agent do here?"), and you can install any subset from the CLI.

SendGrid is connected with an API key you create, not by signing in. Anlyon checks the key with
SendGrid before it stores it, and binds it to `api.sendgrid.com` in a request header. The agent
never holds the key: Anlyon makes every call.

## API key permissions

Create the key in SendGrid under Settings, API Keys, Create API Key, with **Custom Access**. Give it
these permissions. A key without them is accepted at connect and refused when an operation runs.

| Permission in SendGrid | Level | Needed by |
| --- | --- | --- |
| Mail Send: Mail Send | Full Access | `send-email`, `send-template-email` |
| Marketing: Marketing | Full Access | Every contact and list action, and `get-contact-job` |
| Suppressions (Suppressions and Unsubscribe Groups) | Full Access | Every unsubscribe action, `list-unsubscribe-groups` and `get-bounce` |
| Template Engine | Read Access | `list-templates`, `get-template` |

A subset of actions needs just their permissions: for example, the two send actions and
`list-templates` alone need Mail Send: Full Access and Template Engine: Read Access.

## Reads

Reads return SendGrid's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed. Lists and templates page with a `page_token`: take it from the `_metadata.next` URL of the
page before.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `sendgrid-search-contacts` | Finds Marketing contacts with an SGQL query. Changes nothing (POST search). At most 50 contacts, no next page | `query` |
| `sendgrid-get-contacts-by-email` | Gets contacts by exact email address, primary or alternate. Changes nothing (POST search). Up to 100 addresses | `emails` |
| `sendgrid-get-contact` | Gets one contact with all its fields, lists and segments | `contact_id` |
| `sendgrid-get-contact-job` | Gets the status of a contacts job from `upsert-contacts` or `delete-contact` | `job_id` |
| `sendgrid-list-lists` | Lists contact lists with their contact counts. 50 a page | `page_token` (optional) |
| `sendgrid-get-list` | Gets one list's name and contact count | `list_id` |
| `sendgrid-list-templates` | Lists dynamic transactional templates and their versions. 20 a page | `page_token` (optional) |
| `sendgrid-get-template` | Gets one template with every version's subject and content | `template_id` |
| `sendgrid-list-unsubscribe-groups` | Lists the unsubscribe groups. SendGrid returns them all in one response | none |
| `sendgrid-get-email-unsubscribe-groups` | Gets every unsubscribe group for one address, marked where it left | `email` |
| `sendgrid-get-global-unsubscribe` | Checks whether one address is on the global unsubscribe list | `email` |
| `sendgrid-get-bounce` | Gets the bounce records for one address | `email` |

## Writes

Each write declares its impact, counts against its limit, can be put behind an approval policy, and
gets a receipt. The two sends count `emails`, one per recipient. `upsert-contacts` counts one
resource mutation per contact. Every other write counts one resource mutation.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `sendgrid-send-email` | Sends one email with a plain-text body and an optional HTML body | `to`, `from`, `reply_to`, `subject`, `content` | none: SendGrid answers 202 with an empty body and no message id |
| `sendgrid-send-template-email` | Sends one email built from a dynamic template | `template_id`, `to`, `from`, `reply_to`, `dynamic_template_data` | none: as for `send-email` |
| `sendgrid-upsert-contacts` | Adds or updates contacts by email, and adds them to lists | `contacts`, `list_ids` | The background job by `job_id`; its type must be `upsert` |
| `sendgrid-delete-contact` | Deletes one contact | `contact_id` | The background job by `job_id`; its type must be `delete` |
| `sendgrid-create-list` | Creates one list | `name` | The list by id; the name must match |
| `sendgrid-rename-list` | Renames one list | `list_id`, `name` | The list; the name must match |
| `sendgrid-delete-list` | Deletes one list and keeps its contacts | `list_id` | Getting the list answers 404 |
| `sendgrid-remove-contact-from-list` | Takes one contact off one list | `list_id`, `contact_id` | none: a background job whose status SendGrid does not report |
| `sendgrid-add-to-unsubscribe-group` | Unsubscribes one address from one group | `group_id`, `email` | The group's addresses; this one must be among them |
| `sendgrid-remove-from-unsubscribe-group` | Subscribes one address to one group again | `group_id`, `email` | The group's addresses; this one must be gone |
| `sendgrid-add-global-unsubscribe` | Puts one address on the global unsubscribe list | `email` | The address on the list; `recipient_email` must match |
| `sendgrid-remove-global-unsubscribe` | Takes one address off the global unsubscribe list | `email` | The address on the list; `recipient_email` must be gone |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| sendgrid: approve an email to more than 5 recipients | A `send-email` call with more than 5 addresses in `to` requires approval |
| sendgrid: approve a template email to more than 5 recipients | The same for `send-template-email` |
| sendgrid: approve deleting a contact | Every contact deletion requires approval |
| sendgrid: approve deleting a list | Every list deletion requires approval |
| sendgrid: approve subscribing an address to a group again | Every `remove-from-unsubscribe-group` call requires approval |
| sendgrid: approve taking an address off the global unsubscribe list | Every `remove-global-unsubscribe` call requires approval |

The send threshold of 5 is a suggestion. A reply to one person or a short thread goes out without
waiting, and a send to a group waits for a person. Lower it to 0 to approve every send. Sending mail
again to a person who opted out is a legal question in many places, so both resubscribe policies
have no condition.

| Suggested limit (created with `--with-limits`) | Unit | Per day |
| --- | --- | --- |
| sendgrid: emails sent per day | emails | 100 |
| sendgrid: template emails sent per day | emails | 100 |
| sendgrid: contacts added or updated per day | resource mutations | 500 |
| sendgrid: contacts deleted per day | resource mutations | 20 |
| sendgrid: lists created per day | resource mutations | 10 |
| sendgrid: lists renamed per day | resource mutations | 20 |
| sendgrid: lists deleted per day | resource mutations | 5 |
| sendgrid: contacts taken off lists per day | resource mutations | 100 |
| sendgrid: group unsubscribes per day | resource mutations | 100 |
| sendgrid: group resubscribes per day | resource mutations | 10 |
| sendgrid: global unsubscribes per day | resource mutations | 100 |
| sendgrid: global resubscribes per day | resource mutations | 10 |

The amounts are suggestions for an agent that answers people and keeps a list tidy, not one that runs
campaigns. Change them to fit your volume. The email limits count recipients, so one send to 10
addresses uses 10 of the 100. Unsubscribes are set higher than resubscribes on purpose: honouring an
opt-out should rarely be blocked, and undoing one should be rare. Deletes are kept low because they
cannot be undone.

## Exercise

`anlyon packs exercise ./packs/sendgrid --need from_email=<sender> --need to_email=<inbox> --need template_id=<d-…> --need group_id=<id>`
runs every action once, in the order of `exercise.json`, against your SendGrid account.

| Need | What to give |
| --- | --- |
| `from_email` | A verified sender, or an address on a domain you authenticated in SendGrid |
| `to_email` | An inbox you own, in lower case. The run sends it two emails |
| `template_id` | A dynamic template id with an active version (`list-templates` shows it) |
| `group_id` | An unsubscribe group that is safe for a test address (`list-unsubscribe-groups` shows it) |

The run creates its own list (`Anlyon exercise <run>`) and contact
(`anlyon-exercise-<run>@example.com`), puts that address on the global unsubscribe list and in the
group and takes it off both, then removes the contact from the list, deletes the contact and deletes
the list. Nothing it did not create is changed or deleted. SendGrid adds a contact in a background
job, so `search-contacts` can find nothing when it runs a few seconds later. If the run stops there,
run it again once `get-contact-job` reports `completed`. Turn the delete and resubscribe policies off
(or approve them) for the run, or it stops at the policy.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Sends cannot be read back.** SendGrid answers a send with 202, an empty body and no message id, so
  both sends are graded acknowledged. Reading a message's delivery needs SendGrid's Email Activity
  API, which this pack does not use.
- **Suppressed recipients are dropped silently.** SendGrid skips an address on a suppression list
  without an error, so fewer emails can go out than were counted. The `emails` impact is an upper
  bound for that reason.
- **Everyone is on the To line.** The send actions put every recipient in one envelope, so each sees
  the others. There is no cc, bcc, attachment or scheduled send. Send to people one at a time when
  they should not see each other.
- **No idempotency.** SendGrid has no idempotency key on sends or list creation. A retry after an
  unknown outcome can send an email twice or create a second list.
- **Contact changes run in the background.** `upsert-contacts` and `delete-contact` are read back as
  the job SendGrid queued, which shows SendGrid accepted the change, not that every contact was saved
  or removed. `get-contact-job` shows `completed`, `errored` or `failed` once the job has run.
  `remove-contact-from-list` runs as a job SendGrid does not report on, so it has no read-back.
- **Search is limited.** `search-contacts` returns at most 50 contacts, with no next page, and SGQL
  queries over 20 seconds answer 408. New contacts can take a while to appear in search.
- **Group read-backs list the whole group.** A group with many suppressed addresses can pass the
  response limit, and the receipt is then not confirmed. A group id that does not exist puts the
  address on the global unsubscribe list instead, and the read-back then fails.
- **Lower-case addresses for suppressions.** The suppression and bounce actions take addresses in
  lower case, so the read-back compares the same text SendGrid stores.
- **Standard contact fields.** Contacts are written with email, name, city, country and postal
  code. Custom fields need an action you declare.
- **Dynamic templates.** `send-template-email` and `list-templates` use dynamic templates (ids
  starting with `d-`). Legacy templates need an action you declare.
- **The global region.** Every action calls `api.sendgrid.com`. An EU regional subuser, which uses
  `api.eu.sendgrid.com`, cannot be reached with this pack.

## Install

```bash
anlyon packs plan ./packs/sendgrid
anlyon packs install ./packs/sendgrid --yes --action send-email --action get-contacts-by-email --action upsert-contacts
```

Every action sends `{{connection:sendgrid}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own SendGrid account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/sendgrid`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected SendGrid account (`anlyon connections add sendgrid --secret SENDGRID`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name SENDGRID=<your secret>`. Do this when the environment has more than one SendGrid account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the initial version. Sends, Marketing contacts and lists, templates, unsubscribes and
  bounces, drafted from SendGrid's OpenAPI spec with `pnpm packs:draft` and curated by hand. The two
  send actions were written by hand from the spec, because the draft cannot translate the Mail Send
  body.

## Sources

Twilio SendGrid v3 API, checked 2026-10-24:

- OpenAPI spec (official, `twilio/sendgrid-oai` on GitHub, `spec/json/`): `tsg_mail_v3.json`,
  `tsg_mc_contacts_v3.json`, `tsg_mc_lists_v3.json`, `tsg_templates_v3.json`,
  `tsg_suppressions_v3.json`, `tsg_scopes_v3.json`. Repository: https://github.com/twilio/sendgrid-oai
- API reference: https://www.twilio.com/docs/sendgrid/api-reference
- Mail Send overview: https://www.twilio.com/docs/sendgrid/api-reference/mail-send
- API key permissions: https://www.twilio.com/docs/sendgrid/ui/account-and-settings/api-keys
- Segmentation query language (SGQL):
  https://sendgrid.com/docs/for-developers/sending-email/segmentation-query-language/
