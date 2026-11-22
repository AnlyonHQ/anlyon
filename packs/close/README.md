# anlyon/close

The Close toolset an agent needs for leads, contacts, opportunities, tasks and notes. This is the
**catalogue pack** for the Close integration: the console offers its actions one by one after you
connect Close ("What may your agent do here?"), and you can install any subset from the CLI.

Close is connected with an API key, not by signing in. Anlyon checks the key with Close
(`GET https://api.close.com/api/v1/me/`) before it stores it, and binds it to `api.close.com` in the
`Authorization` header as HTTP Basic, with the key as the username and an empty password. The agent
never holds the key: Anlyon makes every call.

## API key

A Close API key is made in Close under Settings, Developer, API keys. It starts with `api_`. It
belongs to the user who made it, in that user's organization, and can never do more than that user:
it follows the user's role and lead visibility. Its access level narrows that further: read only,
or read, write and delete. Make the key from a user whose role fits what your agent should do, and
give it read, write and delete access if the agent uses the writes. A call on something the key may
not see or change is refused by Close.

## Reads

Reads return Close's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed and lists ask Close for a fixed set of fields (`_fields`). Lists page with `skip` (Close's
`_skip`): while `has_more` is true, pass the number of results already read.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `close-search-leads` | Searches leads with Close's search syntax, or lists them all. 20 a page | `query`, `skip` (both optional) |
| `close-get-lead` | Gets one lead with its contacts, opportunities and addresses | `lead_id` |
| `close-get-contact` | Gets one contact | `contact_id` |
| `close-list-lead-statuses` | Lists the organization's lead statuses | none |
| `close-list-opportunity-statuses` | Lists the opportunity statuses and their type (active, won, lost) | none |
| `close-list-opportunities` | Lists opportunities of a lead, an owner or a status type. 20 a page | all optional: `lead_id`, `user_id`, `status_type`, `skip` |
| `close-get-opportunity` | Gets one opportunity | `opportunity_id` |
| `close-list-tasks` | Lists lead tasks of a lead or an assignee, open or complete. 20 a page | all optional: `lead_id`, `assigned_to`, `is_complete`, `skip` |
| `close-get-task` | Gets one task | `task_id` |
| `close-list-activities` | Lists a lead's notes, calls, emails and SMS. 10 a page | `lead_id`, `type`, `skip` |
| `close-get-note` | Gets one note activity | `note_id` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `close-create-lead` | Creates one lead, with its contacts | `name` and any of `url`, `description`, `status_id`, `contacts` | The lead by id; the name must match |
| `close-update-lead` | Updates a lead's name, url, description or status | `lead_id` and the fields to change | The lead; name, description and status must equal what Close returned |
| `close-delete-lead` | Deletes one lead with everything on it | `lead_id` | Getting the lead must answer 404 |
| `close-create-contact` | Adds one contact to a lead | `lead_id`, `name` and any of `title`, `emails`, `phones` | The contact by id; name and lead must match |
| `close-create-opportunity` | Creates one opportunity on a lead | `lead_id` and any of `contact_id`, `status_id`, `value`, `value_period`, `confidence`, `note` | The opportunity by id; the lead must match and the status must equal what Close returned |
| `close-update-opportunity` | Changes an opportunity's status, value, period, confidence or note | `opportunity_id` and the fields to change | The opportunity; status and confidence must equal what Close returned |
| `close-add-note` | Logs one plain-text note on a lead | `lead_id`, `note` | The note by id; the lead must match and the text must equal what Close stored |
| `close-create-task` | Creates one open task on a lead | `lead_id`, `text` and any of `date`, `assigned_to` | The task by id; text and lead must match |
| `close-complete-task` | Marks a task complete | `task_id` | The task; `is_complete` must be true |

An opportunity's value records what a deal is worth, in cents. No money moves, so it is counted as a
resource mutation, not as money.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| close: approve deleting a lead | Every lead deletion requires approval. A deleted lead takes its contacts, opportunities, tasks and activities with it, so turn it on unless your agent is trusted to delete leads alone |

Suggested limits are created with `--with-limits`, and not otherwise. Each counts one write action per day. The
amounts suit one sales team's normal day of use: creating and updating more often than deleting.
Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| close: leads created per day | 100 |
| close: leads updated per day | 200 |
| close: leads deleted per day | 20 |
| close: contacts created per day | 100 |
| close: opportunities created per day | 50 |
| close: opportunities updated per day | 200 |
| close: notes per day | 300 |
| close: tasks created per day | 200 |
| close: tasks completed per day | 300 |

## Exercise

`anlyon packs exercise ./packs/close` runs every action once, in the order of `exercise.json`,
against your Close organization. It needs nothing given: it reads your lead statuses and your
opportunity statuses (the organization needs at least two opportunity statuses; Close's defaults
have more).

The run creates a lead (`Anlyon exercise <run>`) with a contact
(`anlyon-exercise-<run>@example.com`), adds a second contact, creates an opportunity with a value of
10000 cents, moves it to the second status, logs a note, creates and completes a task, then deletes
the lead, which removes everything it created. Nothing it did not create is changed. Turn the policy
off (or approve it) for the run, or it stops at the delete. If `search-leads` finds nothing, Close
may not have indexed the new lead yet; run it again.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The key acts as one user.** What the agent can see and change is what that user can, narrowed
  by the key's access level. A read-only key cannot use the writes.
- **Search syntax.** `search-leads` passes `query` to Close's lead list as it is (for example
  `name:"Acme"`, `email_address:"jo@acme.com"`). Close deprecated that parameter in 2022 in favour of
  its Advanced Filtering API, and its reference for the lead list no longer lists it. That POST
  endpoint is not offered here.
- **Offset paging.** Lists page with `_skip`. Close makes very deep offsets slow or refuses them, so
  narrow a search rather than page far into it.
- **Bounded read-backs on updates.** `update-lead` checks name, description and status;
  `update-opportunity` checks status and confidence. A lead's url and an opportunity's value, period
  and note are sent but not read back.
- **Values are in cents.** `value` 500000 is 5,000.00 in the organization's currency.
- **Delete is permanent through the API.** `delete-lead` removes the lead with its contacts,
  opportunities, tasks and activities. Close finishes the deletion in the background, so the lead can
  still be found for a short time; its read-back expects 404, and until then the receipt stays
  acknowledged.
- **Contacts are read through their lead.** `get-lead` returns a lead's contacts. A contact list of
  its own, and contact updates, are not offered.
- **No idempotency.** Close accepts leads and contacts with the same name or email. A retry of a
  create or `add-note` after an unknown outcome can create a second record. Search before you create.
- **Standard fields.** Custom fields are neither returned by the reads (the field list is fixed) nor
  set by the writes. Setting one needs an action you declare.
- **No email or SMS.** Sending an email or an SMS to a customer is not offered. `list-activities`
  shows emails and SMS without their bodies.
- **Rate limits.** Close limits API use per endpoint group, per organization and per key, and answers
  429 when a limit is hit.

## Install

```bash
anlyon packs plan ./packs/close
anlyon packs install ./packs/close --yes --action search-leads --action get-lead --action add-note
```

Every action sends `{{connection:close}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Close account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/close`, with `fields: { "apiKey": "api_..." }`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Close account (`anlyon connections add close --secret CLOSE`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name CLOSE=<your secret>`. Do this when the environment has more than one Close account. A call made for one of your users still uses their own account.

Then review and enable the policy. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: search and read leads, contacts, opportunities, tasks, notes and
  activities; create and update leads, add contacts, create and update opportunities, log notes,
  create and complete tasks, and delete a lead, as governed writes.

## Sources

Checked 2026-11-22.

- Authentication with an API key as the Basic username and an empty password, and
  `GET /api/v1/me/`: https://developer.close.com/api/overview/api-key-authentication and
  https://developer.close.com/api/resources/users/get-me
- Key format (`api_` then an id and a secret part), and a key's owner, role, lead visibility and
  access level: https://help.close.com/docs/api-keys-oauth
- Pagination with `_limit`, `_skip`, `has_more`, and the maximum `_skip`; `_fields`:
  https://developer.close.com/api/overview/pagination and https://developer.close.com/api/overview/fields
- Response codes (404 not found, 429 rate limited) and rate limits:
  https://developer.close.com/api/overview and https://developer.close.com/api/overview/rate-limits
- Leads, contacts, opportunities, opportunity and lead statuses, tasks:
  https://developer.close.com/api/resources/leads,
  https://developer.close.com/api/resources/leads/list,
  https://developer.close.com/api/resources/leads/delete,
  https://developer.close.com/api/resources/contacts,
  https://developer.close.com/api/resources/opportunities,
  https://developer.close.com/api/resources/opportunity-statuses,
  https://developer.close.com/api/resources/lead-statuses,
  https://developer.close.com/api/resources/tasks
- The `query` parameter on the lead endpoint deprecated in favour of the Advanced Filtering API:
  https://developer.close.com/api/overview/changelog/2022/2/14
- Activities and notes (`lead_id`, `_type` on a single lead; `note` and `note_html`):
  https://developer.close.com/api/resources/activities and
  https://developer.close.com/api/resources/activities/notes
- OpenAPI document (experimental, per Close's changelog of 2026-04-06):
  https://api.close.com/api/openapi.json
- Close's own API scripts and Python client:
  https://github.com/closeio/close-api-scripts (`GET lead/` with `query`, `_skip`, `_fields`,
  `has_more`, `total_results`; `GET task/` with `assigned_to` and `is_complete`; `GET opportunity/`
  with `user_id` and `status_type`; `GET activity/` with `_fields`; `POST activity/note` with
  `lead_id` and `note`; opportunity `value` in cents and `value_period` `one_time` or `monthly`;
  `PUT task/`, `PUT opportunity/` with a partial body; `status/lead`, `status/opportunity`) and
  https://github.com/closeio/closeio-api (Basic auth as `(api_key, '')`, 429 handling)
