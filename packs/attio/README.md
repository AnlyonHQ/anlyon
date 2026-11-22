# anlyon/attio

The Attio toolset an agent needs for people, companies, notes, lists and tasks. This is the
**catalogue pack** for the Attio integration: the console offers its actions one by one after you
connect Attio ("What may your agent do here?"), and you can install any subset from the CLI.

Attio is connected with an API key you create, not by signing in. Anlyon checks the key with Attio
before it stores it, and binds it to `api.attio.com` in a request header. The agent never holds the
key: Anlyon makes every call.

## Access token scopes

Create the token in Attio under Workspace settings, Developers, and give it these scopes. A key
without them is accepted at connect and refused when an operation runs.

| Scope in Attio | API scope | Level | Needed by |
| --- | --- | --- | --- |
| Records | `record_permission` | Read-write | Every record, note and task operation; Read-write for creating, updating and deleting people and companies |
| Object configuration | `object_configuration` | Read | Every record, note and task operation, and `list-attributes` on objects |
| List configuration | `list_configuration` | Read | `list-lists`, every list entry operation, and `list-attributes` on lists |
| List entries | `list_entry` | Read-write | `list-entries`, `get-entry`, `add-to-list`, `update-entry`, `remove-entry` |
| Notes | `note` | Read-write | `list-notes`, `get-note`, `add-note`, `delete-note` |
| Tasks | `task` | Read-write | `list-tasks`, `get-task` and the task writes |
| User management | `user_management` | Read | Every task operation (Attio requires it on every task endpoint) |

Installing only some actions needs only their scopes: for example, the person, company and note
actions alone need Records: Read-write, Object configuration: Read and Notes: Read-write.

## Reads

Reads return Attio's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed. Attio pages with `offset`: add the page size for the next page; a page shorter than the page
size is the last.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `attio-query-people` | Finds people with an Attio filter and sorts. Changes nothing (POST query). 10 records a page | `filter`, `sorts`, `offset` (all optional) |
| `attio-query-companies` | Finds companies the same way. Changes nothing. 10 records a page | `filter`, `sorts`, `offset` (all optional) |
| `attio-get-record` | Gets one person or company with all its values | `object` (`people`, `companies`), `record_id` |
| `attio-list-attributes` | Lists an object's or a list's attributes: slug, type, multiselect, unique. 25 a page | `target` (`objects`, `lists`), `identifier`, `offset` |
| `attio-list-notes` | Lists notes, all or those on one record. 10 a page | `parent_object`, `parent_record_id`, `offset` (all optional) |
| `attio-get-note` | Gets one note with its content as plain text and markdown | `note_id` |
| `attio-list-lists` | Lists every list the key can see. Attio returns them all in one response | none |
| `attio-list-entries` | Finds entries in a list with a filter and sorts. Changes nothing (POST query). 20 a page | `list`, `filter`, `sorts`, `offset` |
| `attio-get-entry` | Gets one list entry with its values | `list`, `entry_id` |
| `attio-list-tasks` | Lists tasks, filtered by linked record, assignee email or completion. 25 a page | `linked_object`, `linked_record_id`, `assignee`, `is_completed`, `sort`, `offset` (all optional) |
| `attio-get-task` | Gets one task | `task_id` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `attio-create-person` | Creates one person with an email address and a name | `email`, `first_name`, `last_name` | The record by id; the email address must match |
| `attio-create-company` | Creates one company with a name and a domain | `name`, `domain` | The record by id; the domain must match |
| `attio-add-note` | Adds one plain-text note to a person | `record_id`, `title`, `content` | The note by id; the title must match |
| `attio-update-person-job-title` | Replaces a person's job title | `record_id`, `job_title` | The record; `job_title` must match |
| `attio-set-person-company` | Replaces the company a person works at | `record_id`, `company_record_id` | The record; the company's record id must match |
| `attio-update-company-description` | Replaces a company's description | `record_id`, `description` | The record; `description` must match |
| `attio-delete-record` | Deletes one person or company | `object`, `record_id` | Getting the record answers 404 |
| `attio-delete-note` | Deletes one note | `note_id` | Getting the note answers 404 |
| `attio-add-to-list` | Adds a person or company to a list as a new entry with no values | `list`, `object`, `record_id` | The entry by id; the parent record id must match |
| `attio-update-entry` | Sets values on one list entry | `list`, `entry_id`, `entry_values` | none: the attributes are chosen per call, so no fixed field can show them. Check with `get-entry` |
| `attio-remove-entry` | Removes one entry from a list (the record stays) | `list`, `entry_id` | Getting the entry answers 404 |
| `attio-create-task` | Creates one open task with a deadline, linked to a person or company, optionally assigned | `content`, `deadline_at`, `linked_object`, `linked_record_id`, `assignee` | The task by id; content and linked record must match |
| `attio-update-task-deadline` | Moves a task's deadline | `task_id`, `deadline_at` | The task; the stored deadline must equal the one Attio answered with |
| `attio-complete-task` | Marks a task completed | `task_id` | The task; `is_completed` must be true |
| `attio-delete-task` | Deletes one task | `task_id` | Getting the task answers 404 |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| attio: approve creating a company | Every new company requires approval |
| attio: approve deleting a record | Every person or company deletion requires approval |
| attio: approve deleting a note | Every note deletion requires approval |
| attio: approve removing a list entry | Every removal from a list requires approval |
| attio: approve deleting a task | Every task deletion requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| attio: people created per day | 100 |
| attio: companies created per day | 50 |
| attio: notes per day | 500 |
| attio: job titles updated per day | 200 |
| attio: person companies set per day | 200 |
| attio: company descriptions updated per day | 100 |
| attio: records deleted per day | 20 |
| attio: notes deleted per day | 50 |
| attio: list entries added per day | 200 |
| attio: list entries updated per day | 500 |
| attio: list entries removed per day | 50 |
| attio: tasks created per day | 200 |
| attio: task deadlines moved per day | 200 |
| attio: tasks completed per day | 300 |
| attio: tasks deleted per day | 50 |

## Exercise

`anlyon packs exercise ./packs/attio --need list=<slug>` runs every action once, in the order of
`exercise.json`, against your Attio workspace.

| Need | What to give |
| --- | --- |
| `list` | The api_slug of a list whose records are people |

The run creates its own company (`anlyon-exercise-<run>.com`) and person
(`anlyon-exercise-<run>@example.com`), then a note, a list entry and a task on them, and deletes all
of them at the end. Nothing it did not create is changed or deleted. The `update-entry` step sends
empty entry values, because which attributes a list has is up to your workspace. Turn the delete and
remove policies off (or approve them) for the run, or it stops at the first one.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Standard objects only.** The record operations work on the `people` and `companies` objects and
  their built-in attributes. A custom object or attribute needs an action you declare.
- **Bounded updates.** People and companies are updated one attribute at a time (job title, company,
  description), so each write is read back on the field it set. Other attributes need an action you
  declare.
- **List entry values are not read back.** `update-entry` takes the list's own attribute slugs, which
  differ per list, so its receipt is graded acknowledged. Values for multiselect attributes are added
  to the existing ones (Attio's PATCH semantics).
- **Attio refuses duplicates on create.** A second person with the same email address, or company with
  the same domain, is refused, which also makes a blind retry of those creates safe.
- **No idempotency elsewhere.** A retry of `add-note`, `add-to-list` or `create-task` after an unknown
  outcome can create a second note, entry or task. Attio allows a record in a list more than once.
- **Notes attach to people.** Adding a note to a company or a deal needs an action you declare.
- **Tasks need a deadline and a linked record.** Attio requires `deadline_at`; this action always
  links one person or company. Assignees are given by workspace member email address.
- **Filters are Attio's.** `filter` and `sorts` are passed to Attio as given; see Attio's filtering
  guide. An invalid filter is refused by Attio.

## Install

```bash
anlyon packs plan ./packs/attio
anlyon packs install ./packs/attio --yes --action query-people --action get-record --action add-note
```

Every action sends `{{connection:attio}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Attio account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/attio`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Attio account (`anlyon connections add attio --secret ATTIO`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name ATTIO=<your secret>`. Do this when the environment has more than one Attio account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:attio}}` instead of `{{secret:ATTIO}}`. A call made for one of your users acts in their own Attio account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full toolset: queries and reads for people, companies, notes, lists, entries and tasks;
  bounded updates, deletes, list entries and tasks as governed writes. The three 0.1.0 actions are
  unchanged.
- 0.1.0: first version.

## Sources

Attio REST API v2, checked 2026-10-15:

- OpenAPI description: https://api.attio.com/openapi/api
- Records: https://docs.attio.com/rest-api/endpoint-reference/records/list-records,
  https://docs.attio.com/rest-api/endpoint-reference/records/get-a-record,
  https://docs.attio.com/rest-api/endpoint-reference/records/create-a-record,
  https://docs.attio.com/rest-api/endpoint-reference/records/update-a-record-append-multiselect-values,
  https://docs.attio.com/rest-api/endpoint-reference/records/delete-a-record
- Attributes: https://docs.attio.com/rest-api/endpoint-reference/attributes/list-attributes,
  https://docs.attio.com/docs/attribute-types/attribute-types-text,
  https://docs.attio.com/docs/attribute-types/attribute-types-record-reference,
  https://docs.attio.com/docs/standard-objects/standard-objects-people,
  https://docs.attio.com/docs/standard-objects/standard-objects-companies
- Notes: https://docs.attio.com/rest-api/endpoint-reference/notes/list-notes,
  https://docs.attio.com/rest-api/endpoint-reference/notes/get-a-note,
  https://docs.attio.com/rest-api/endpoint-reference/notes/create-a-note,
  https://docs.attio.com/rest-api/endpoint-reference/notes/delete-a-note
- Lists and entries: https://docs.attio.com/rest-api/endpoint-reference/lists/list-all-lists,
  https://docs.attio.com/rest-api/endpoint-reference/entries/list-entries,
  https://docs.attio.com/rest-api/endpoint-reference/entries/get-a-list-entry,
  https://docs.attio.com/rest-api/endpoint-reference/entries/create-an-entry-add-record-to-list,
  https://docs.attio.com/rest-api/endpoint-reference/entries/update-a-list-entry-append-multiselect-values,
  https://docs.attio.com/rest-api/endpoint-reference/entries/delete-a-list-entry
- Tasks: https://docs.attio.com/rest-api/endpoint-reference/tasks/list-tasks,
  https://docs.attio.com/rest-api/endpoint-reference/tasks/get-a-task,
  https://docs.attio.com/rest-api/endpoint-reference/tasks/create-a-task,
  https://docs.attio.com/rest-api/endpoint-reference/tasks/update-a-task,
  https://docs.attio.com/rest-api/endpoint-reference/tasks/delete-a-task
- Guides: https://docs.attio.com/rest-api/guides/filtering-and-sorting,
  https://docs.attio.com/rest-api/guides/pagination,
  https://docs.attio.com/rest-api/guides/authentication
