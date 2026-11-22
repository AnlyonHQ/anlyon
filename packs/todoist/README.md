# anlyon/todoist

The Todoist tools an agent can be given. This is the **catalogue pack** for the Todoist integration:
the console offers its actions one by one after you connect Todoist ("What may your agent do here?"),
and you can install any subset from the CLI. Anlyon holds the token and makes every call; the agent
never sees it.

Todoist is connected with an API token, not by signing in. Anlyon checks the token with Todoist before
it stores it, and binds it to `api.todoist.com` in a request header. Every call uses Todoist's API v1
(`https://api.todoist.com/api/v1`), which replaced the REST API v2 and the Sync API v9.

Ids are Todoist's v1 string ids (`6XGgmFVcrG5RRjVr`). Labels are named by name on a task. Actions
install as `todoist-<name>` unless `--no-prefix`.

## The token

A Todoist API token has no scopes. It can do anything its user can do in Todoist: every personal
project, and every shared or workspace project that user has joined. Create the token from an account
limited to the projects your agent should reach.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them. Lists return a fixed page size; when Todoist has more,
the response carries `next_cursor`, which the agent passes back as `cursor` with the same other inputs.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `list-projects` | Active projects, 50 per page | `cursor`? | none (read) |
| `get-project` | One project: name, description, parent, view style, shared and archived state | `project_id` | none (read) |
| `list-sections` | Active sections, 50 per page, for one project or all | `project_id`?, `cursor`? | none (read) |
| `get-section` | One section: name, project, order, archived state | `section_id` | none (read) |
| `list-labels` | Personal labels, 100 per page | `cursor`? | none (read) |
| `list-tasks` | Active tasks, 25 per page, by project, section, parent or label | `project_id`?, `section_id`?, `parent_id`?, `label`?, `cursor`? | none (read) |
| `filter-tasks` | Active tasks matching a Todoist filter query, 25 per page | `query`, `lang`?, `cursor`? | none (read) |
| `get-task` | One active task: content, description, project, section, labels, priority, due, deadline | `task_id` | none (read) |
| `list-completed-tasks` | Tasks completed in a date range of up to 3 months, 25 per page | `since`, `until`, `project_id`?, `filter_query`?, `cursor`? | none (read) |
| `list-task-comments` | Comments on a task, 20 per page | `task_id`, `cursor`? | none (read) |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Where Todoist has a GET that shows the change, the receipt is
graded `confirmed` by a read-back; otherwise `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-task` | Creates one task, in a project or the Inbox | `content`, `description`?, `project_id`?, `section_id`?, `parent_id`?, `labels`?, `priority`?, `due_string`?, `due_date`?, `deadline_date`? | The task by id; the content must match |
| `update-task` | Changes content, description, labels, priority, due date or deadline; only the fields given change | `task_id`, the fields to change | The task; content, description, priority and last-updated time must equal Todoist's response to this update |
| `close-task` | Completes a task, as the app does | `task_id` | none: get-task reads active tasks only, and a recurring task stays active |
| `reopen-task` | Reopens a completed task, with its completed parents and sections | `task_id` | The task; it must be active |
| `move-task-to-project` | Moves a task and its subtasks to another project | `task_id`, `project_id` | The task; its project must be this one |
| `move-task-to-section` | Moves a task and its subtasks into a section | `task_id`, `section_id` | The task; its section must be this one |
| `delete-task` | Deletes a task and its subtasks | `task_id` | none: a deleted task answers 404, like an id that never existed |
| `add-comment` | Adds one comment to a task | `task_id`, `content` | The comment by id; the content must match |
| `create-section` | Creates a section at the end of a project | `project_id`, `name` | The section by id; name and project must match |
| `delete-section` | Deletes a section and every task in it | `section_id` | none: a deleted section answers 404, like an id that never existed |

| Policy (installed **disabled**) | Effect | When to turn it on |
| --- | --- | --- |
| todoist: approve deleting a task | Every task deletion requires approval | Always, unless the agent works in a project of its own. A deleted task cannot be restored through the API |
| todoist: approve deleting a section | Every section deletion requires approval | Always. It deletes every task in the section too |
| todoist: approve moving a task to another project | Every move to another project requires approval | When the user has shared projects: a task moved into one is visible to its members |

The suggested limits are per day. Each amount is a guess at a busy day of one person's task list, with
room to spare, so normal use stays under it and a runaway loop stops. Change them to fit. Deletes get
the lowest amounts because they cannot be undone.

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| todoist: tasks created per day | 100 |
| todoist: task updates per day | 200 |
| todoist: tasks completed per day | 100 |
| todoist: tasks reopened per day | 50 |
| todoist: tasks moved to a project per day | 50 |
| todoist: tasks moved to a section per day | 100 |
| todoist: tasks deleted per day | 20 |
| todoist: comments per day | 200 |
| todoist: sections created per day | 20 |
| todoist: sections deleted per day | 10 |

## Exercise

`anlyon packs exercise ./packs/todoist` runs every action once against your test account, in the order
of `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `project_id` | A test project the token's user can edit: its id from `list-projects`, or the end of the project's URL in the Todoist app |
| `since` | The start of a completion range that includes today, as an RFC 3339 date-time (the first of this month at `00:00:00Z`) |
| `until` | The end of that range, later than now and at most 3 months after `since` (tomorrow at `00:00:00Z`) |

The run creates a section and a task due tomorrow in the test project. It reads them, updates the task,
comments on it, moves it into the section and back out to the project, completes it, lists completed
tasks, and reopens it. Then it deletes the task (with its comment) and the section.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as the person who made it.** It has no scopes and reaches every project that person can.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, reconcile before invoking again, or a second task, comment or section can be created.
- **Some writes have no read-back** (receipt graded `acknowledged`). `get-task` reads active tasks only: a completed task answers 404, and a recurring task stays active with its next date, so `close-task` is not read back. A deleted task or section answers 404, the same as an id that never existed, so `delete-task` and `delete-section` are not read back.
- **`reopen-task`'s read-back also matches a task that was never completed.**
- **`update-task` cannot clear a due date**, and `labels` replaces the task's whole list. Its read-back compares the task with Todoist's own response to the update, and fails if someone else edits the task in between.
- **`delete-section` deletes every task in the section.** The impact counts one section, not its tasks.
- **Priority runs from 1 (normal) to 4 (urgent).** The Todoist app shows 4 as P1. The OpenAPI document's request bodies say 1 is highest; its task object, which matches Todoist's behaviour, says 4 is urgent.
- **Long text can cut a page.** A task description or a comment (up to 15,000 characters) has no length limit in a list response, so a page can be cut at 64 KB. Read one task with `get-task` when that happens.
- **`filter-tasks` takes one query.** Todoist does not support the comma operator here.
- **`list-labels` lists personal labels.** A shared label that is only on other people's tasks is not in it.
- **Not included.** Quick add (`POST /tasks/quick`) parses free text into a task the read-back cannot predict; `create-task` with `due_string` covers the same job. Moving a task under a parent task, creating, updating, archiving or deleting projects, updating and deleting comments, labels management, comment reactions, collaborators and sharing, workspaces and folders, file uploads, backups, templates, activity logs, productivity stats, reminders, webhooks, tokens and the `/sync` endpoint are left out: they are account administration, or outside day-to-day task work.

## Install

```bash
anlyon packs plan ./packs/todoist
anlyon packs install ./packs/todoist --yes --action filter-tasks --action get-task --action create-task --action close-task
```

Every action sends `{{connection:todoist}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Todoist account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/todoist`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Todoist account (`anlyon connections add todoist --secret TODOIST`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name TODOIST=<your secret>`. Do this when the environment has more than one Todoist account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): ten reads and ten writes on Todoist API v1.

Sources: the Todoist API v1 reference, https://developer.todoist.com/api/v1/ (the OpenAPI 3.1 document embedded in that page, fetched 2026-10-24), sections Tasks (Get Tasks, Get Tasks By Filter, Get Task, Create Task, Update Task, Close Task, Reopen Task, Move Task, Delete Task, Get Completed Tasks By Completion Date), Comments (Get Comments, Create Comment, Get Comment), Projects (Get Projects, Get Project), Sections (Get Sections, Get Section, Create Section, Delete Section), Labels (Get Labels), Pagination and Authorization, checked 2026-10-24. The API token is under Settings, Integrations, Developer: https://app.todoist.com/app/settings/integrations/developer.
