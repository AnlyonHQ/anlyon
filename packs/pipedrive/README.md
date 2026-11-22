# anlyon/pipedrive

The Pipedrive toolset an agent needs for deals, people, organizations, activities and notes. This is
the **catalogue pack** for the Pipedrive integration: the console offers its actions one by one after
you connect Pipedrive ("What may your agent do here?"), and you can install any subset from the CLI.

Pipedrive is connected with an API token, not by signing in. Anlyon checks the token with Pipedrive
before it stores it, and binds it to `api.pipedrive.com` in the `x-api-token` request header. The
agent never holds the token: Anlyon makes every call.

## API token

Each Pipedrive user has one personal API token, under Settings, Personal preferences, API
(`https://app.pipedrive.com/settings/api`). It has no scopes: it acts as that user, with that user's
visibility and permissions. Connect the token of a user who can see and edit the deals, people and
organizations your agent should reach. A call on a record that user cannot see or edit is refused by
Pipedrive.

## Reads

Reads return Pipedrive's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed. API v2 lists page with a cursor: when `additional_data.next_cursor` is present, pass it as
`cursor`. Notes (API v1) page with `start`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `pipedrive-search-deals` | Searches deals by title, notes and custom fields. 20 a page | `term`, `exact_match`, `person_id`, `organization_id`, `status`, `cursor` |
| `pipedrive-search-persons` | Searches people by name, email, phone, notes and custom fields. 20 a page | `term`, `exact_match`, `organization_id`, `cursor` |
| `pipedrive-search-organizations` | Searches organizations by name, address, notes and custom fields. 20 a page | `term`, `exact_match`, `cursor` |
| `pipedrive-list-deals` | Lists deals by owner, person, organization, pipeline, stage, status or last update. 20 a page | all optional: `owner_id`, `person_id`, `org_id`, `pipeline_id`, `stage_id`, `status`, `updated_since`, `sort_by`, `sort_direction`, `cursor` |
| `pipedrive-get-deal` | Gets one deal with its values and custom fields | `deal_id` |
| `pipedrive-get-person` | Gets one person | `person_id` |
| `pipedrive-get-organization` | Gets one organization | `org_id` |
| `pipedrive-list-activities` | Lists activities by owner, deal, person, organization or done. 20 a page | all optional: `owner_id`, `deal_id`, `person_id`, `org_id`, `done`, `sort_by`, `sort_direction`, `cursor` |
| `pipedrive-get-activity` | Gets one activity | `activity_id` |
| `pipedrive-list-pipelines` | Lists pipelines. 50 a page | `cursor` |
| `pipedrive-list-stages` | Lists stages, of one pipeline or all. 50 a page | `pipeline_id`, `cursor` |
| `pipedrive-list-notes` | Lists notes on a deal, person or organization. 10 a page | `deal_id`, `person_id`, `org_id`, `start` (all optional) |
| `pipedrive-get-note` | Gets one note | `note_id` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `pipedrive-create-person` | Creates one person with a name and a work email | `name`, `email`, `phones`, `org_id`, `owner_id` | The person by id; name and email must match |
| `pipedrive-update-person` | Updates a person's name, emails, phones, organization or owner | `person_id` and any of `name`, `emails`, `phones`, `org_id`, `owner_id` | The person; name, organization and owner must equal what Pipedrive returned |
| `pipedrive-delete-person` | Deletes one person (Pipedrive keeps it 30 days) | `person_id` | none: Pipedrive does not document how a read shows a deleted person. Check with `get-person` |
| `pipedrive-create-organization` | Creates one organization | `name`, `owner_id` | The organization by id; the name must match |
| `pipedrive-create-deal` | Creates one open deal | `title` and any of `person_id`, `org_id`, `pipeline_id`, `stage_id`, `value`, `currency`, `owner_id`, `expected_close_date` | The deal by id; the title must match |
| `pipedrive-update-deal` | Updates a deal's title, value, currency, owner, close date, person or organization | `deal_id` and the fields to change | The deal; title, value, currency and owner must equal what Pipedrive returned |
| `pipedrive-move-deal-stage` | Moves a deal to another stage | `deal_id`, `stage_id` | The deal; `stage_id` must match |
| `pipedrive-set-deal-status` | Marks a deal won or lost, or reopens it | `deal_id`, `status`, `lost_reason` | The deal; `status` must match |
| `pipedrive-delete-deal` | Deletes one deal (Pipedrive keeps it 30 days) | `deal_id` | The deals deleted in the last 30 days; this deal must be among them |
| `pipedrive-create-activity` | Creates one call, meeting, task or other activity on a deal or organization | `subject`, `type` and any of `deal_id`, `org_id`, `owner_id`, `due_date`, `due_time`, `duration`, `note` | The activity by id; subject and type must match |
| `pipedrive-complete-activity` | Marks an activity done | `activity_id` | The activity; `done` must be true |
| `pipedrive-add-note` | Adds one note to a deal, person or organization | `content` and at least one of `deal_id`, `person_id`, `org_id` | The note by id; the content must equal what Pipedrive returned |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| pipedrive: approve deleting a deal | Every deal deletion requires approval |
| pipedrive: approve deleting a person | Every person deletion requires approval |
| pipedrive: approve marking a deal won or lost | A status change to won or lost requires approval (`input.status != 'open'`); reopening does not. Won and lost close the deal, so turn it on when your agent should not close deals alone |

Suggested limits are created only with `--with-limits`. Each counts one write action per day. The
amounts suit one sales team's normal day of use: creating and updating more often than deleting.
Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| pipedrive: people created per day | 100 |
| pipedrive: people updated per day | 200 |
| pipedrive: people deleted per day | 20 |
| pipedrive: organizations created per day | 50 |
| pipedrive: deals created per day | 50 |
| pipedrive: deals updated per day | 200 |
| pipedrive: deal stage moves per day | 200 |
| pipedrive: deals marked won or lost per day | 50 |
| pipedrive: deals deleted per day | 20 |
| pipedrive: activities created per day | 200 |
| pipedrive: activities completed per day | 300 |
| pipedrive: notes per day | 300 |

## Exercise

`anlyon packs exercise ./packs/pipedrive` runs every action once, in the order of `exercise.json`,
against your Pipedrive company. It needs nothing given: it reads your first pipeline and its first two
stages (the pipeline needs at least two).

The run creates an organization (`Anlyon exercise <run>`), a person
(`anlyon-exercise-<run>@example.com`), a deal with a value of 100 USD, a note and a task, moves the
deal to the second stage, marks it lost, then deletes the deal and the person. The organization is
left in place, because the pack has no action that deletes an organization: delete it in Pipedrive
afterwards. Nothing it did not create is changed. Turn the policies off (or approve them) for the
run, or it stops at the first one.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as one user.** Pipedrive's API token has no scopes. What the agent can see and
  change is what that user can.
- **Deletes are soft.** Pipedrive keeps a deleted deal or person for 30 days, then removes it. A
  deleted deal is read back from the list of deleted deals. A deleted person is not read back, so its
  receipt is graded acknowledged.
- **Bounded read-backs on updates.** `update-person` checks name, organization and owner;
  `update-deal` checks title, value, currency and owner. Emails, phones, the close date and the linked
  person or organization are sent but not read back.
- **Notes are HTML.** Pipedrive sanitizes note content, so `add-note` checks the content Pipedrive
  stored against what it answered, not against the input. A note needs a deal, person or organization;
  without one Pipedrive refuses it. Notes use API v1, because v2 has no notes endpoint.
- **Activities link through a deal.** `create-activity` links a deal or an organization. A person is
  linked through the deal; setting participants directly is not offered.
- **No idempotency.** Pipedrive accepts people and organizations with the same email or name. A retry
  of a create or `add-note` after an unknown outcome can create a second record. Search before you
  create.
- **Standard fields.** Custom fields are returned by the reads (keyed by the field's hash) but
  not set by the writes. Setting one needs an action you declare.
- **Usage is counted by Pipedrive.** Pipedrive limits API use per company in tokens. Its spec gives a
  cost per endpoint: a search costs 20, a get 1, a create or update 5.
- **`api.pipedrive.com`.** The pack calls the host in Pipedrive's published OpenAPI specs, not the
  company's own `<company>.pipedrive.com` domain.

## Install

```bash
anlyon packs plan ./packs/pipedrive
anlyon packs install ./packs/pipedrive --yes --action search-deals --action get-deal --action add-note
```

Every action sends `{{connection:pipedrive}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Pipedrive account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/pipedrive`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Pipedrive account (`anlyon connections add pipedrive --secret PIPEDRIVE`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name PIPEDRIVE=<your secret>`. Do this when the environment has more than one Pipedrive account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: search and read deals, people, organizations, activities, notes,
  pipelines and stages; create and update people, organizations and deals, move a deal's stage, mark
  it won or lost, log activities and notes, and delete deals and people, as governed writes.

## Sources

Pipedrive API, checked 2026-10-24:

- OpenAPI description, API v2: https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  (deals, persons, organizations, activities, pipelines, stages and their searches)
- OpenAPI description, API v1: https://developers.pipedrive.com/docs/api/v1/openapi.yaml (notes,
  `GET /users/me`)
- Authentication with an API token in the `x-api-token` header:
  https://pipedrive.readme.io/docs/core-api-concepts-authentication
- Where the token is found: https://app.pipedrive.com/settings/api
- Rate limits in tokens: https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting (endpoint
  costs from each operation's `x-token-cost` in the specs)
