# anlyon/clickup

The ClickUp tools an agent can be given. This is the **catalogue pack** for the ClickUp integration:
the console offers its actions one by one after you connect ClickUp ("What may your agent do here?"),
and you can install any subset from the CLI. Anlyon holds the token and makes every call; the agent
never sees it.

ClickUp is connected with a personal API token you create, not by signing in. Anlyon checks the token
with ClickUp before it stores it (`GET /api/v2/user`), and binds it to `api.clickup.com` in the
`Authorization` header. ClickUp takes the token on its own, with no `Bearer` in front. Every call uses
ClickUp's API v2 (`https://api.clickup.com/api/v2`).

ClickUp calls a workspace a team, so a workspace id is `team_id`. Space, folder, list and comment ids
are numbers, sent as strings; task ids are short codes such as `86a1b2c3d`; checklist and checklist
item ids are UUIDs; user ids are numbers. Actions install as `clickup-<name>` unless `--no-prefix`.

## The token's permissions

A ClickUp personal token has no scopes. It can do whatever its user can do in every workspace they
belong to. Create it from an account that is a member of the spaces your agent should reach, and no
others. ClickUp's own permissions still apply: an action on a space or list the user cannot edit is
refused by ClickUp.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `list-workspaces` | Workspaces the token can reach, with their members | none | none (read) |
| `list-spaces` | Spaces in a workspace, with their statuses and features | `team_id`, `archived`? | none (read) |
| `list-folders` | Folders in a space, with the lists inside each | `space_id`, `archived`? | none (read) |
| `list-lists` | Lists in a folder | `folder_id`, `archived`? | none (read) |
| `list-folderless-lists` | Lists directly in a space, outside any folder | `space_id`, `archived`? | none (read) |
| `get-list` | One list, with the statuses its tasks can take | `list_id` | none (read) |
| `list-tasks` | Tasks whose home is a list, 100 per page | `list_id`, `page`?, `status`?, `assignee`?, `tag`?, `include_closed`?, `subtasks`?, `order_by`?, `reverse`?, `due_after`?, `due_before`?, `updated_after`? | none (read) |
| `search-tasks` | Tasks across a workspace, narrowed to a space, folder or list, 100 per page | `team_id`, `space_id`?, `folder_id`?, `list_id`?, and the filters of `list-tasks` | none (read) |
| `get-task` | One task: description, status, people, tags, priority, dates, checklists, custom fields | `task_id`, `include_subtasks`?, `include_markdown_description`? | none (read) |
| `list-task-comments` | A task's comments, 25 at a time, newest to oldest | `task_id`, `start`?, `start_id`? | none (read) |
| `list-comment-replies` | The replies in one comment's thread | `comment_id` | none (read) |
| `list-space-tags` | A space's tags | `space_id` | none (read) |

Dates are Unix time in milliseconds. Task lists page with `page`, from 0: `list-tasks` returns
`last_page: true` on the last page, and `search-tasks` returns an empty `tasks` list after the last
one. Comments page backwards: pass the `date` and `id` of the oldest comment you have as `start` and
`start_id`.

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Where ClickUp has a GET that shows the change, the receipt is
graded `confirmed` by a read-back; otherwise `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-task` | Creates one task in a list, or a subtask with `parent_task_id` | `list_id`, `name`, `description`?, `status`?, `priority`?, `due_date`?, `assignees`?, `tags`?, `parent_task_id`? | The task by id; name and list must match |
| `update-task` | Changes a task's name, description, priority or due date; fields left out stay as they are | `task_id`, `name`?, `description`?, `priority`?, `due_date`? | The task; name, description, due date and update time must equal ClickUp's response to this update |
| `set-task-status` | Moves a task to another status of its list | `task_id`, `status` | The task; its status must be the one given |
| `add-assignee` | Assigns one person, keeping the others | `task_id`, `user_id` | The task; the user must be among its assignees |
| `remove-assignee` | Unassigns one person, keeping the others | `task_id`, `user_id` | The task; the user must no longer be among its assignees |
| `comment-on-task` | Adds one plain-text comment | `task_id`, `text` | The task's 25 newest comments; the new comment's id must be among them |
| `add-tag` | Puts an existing tag of the space on a task | `task_id`, `tag_name` | The task; the tag must be among its tags |
| `remove-tag` | Takes a tag off a task | `task_id`, `tag_name` | The task; the tag must no longer be among its tags |
| `create-checklist` | Adds an empty checklist to a task | `task_id`, `name` | The task; the new checklist's id and the name must be among its checklists |
| `add-checklist-item` | Adds one item to a checklist | `checklist_id`, `name`, `assignee`? | The checklist's task; the checklist must be there and an item with this name in one of its checklists |
| `resolve-checklist-item` | Marks a checklist item done, or not done | `checklist_id`, `checklist_item_id`, `resolved` | none: ClickUp has no read for one item, and a rule cannot tie an item's state to its id |
| `delete-task` | Deletes a task (to the workspace's trash) | `task_id` | none: ClickUp does not document reading a deleted task |

`priority` is 1 urgent, 2 high, 3 normal or 4 low.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| clickup: approve deleting a task | Every task deletion requires approval. Turn it on unless your agent cleans up after itself. |
| clickup: approve commenting on a task | Every comment requires approval. ClickUp notifies the task's assignees and watchers, so a comment reaches people. |
| clickup: approve assigning a person | Assigning someone requires approval. ClickUp notifies the person assigned. |
| clickup: approve unassigning a person | Taking someone off a task requires approval. |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| clickup: tasks created per day | 100 |
| clickup: task updates per day | 200 |
| clickup: status changes per day | 200 |
| clickup: assignees added per day | 50 |
| clickup: assignees removed per day | 50 |
| clickup: comments per day | 200 |
| clickup: tags added per day | 200 |
| clickup: tags removed per day | 200 |
| clickup: checklists created per day | 50 |
| clickup: checklist items added per day | 200 |
| clickup: checklist items resolved per day | 200 |
| clickup: tasks deleted per day | 20 |

The amounts are suggestions. They are set so a day of an agent
working through one team's tasks stays under them, while a loop that repeats a write stops within a
day. Changes that reach people (assigning) and deletions are set lower. Change them to fit your use.

## Exercise

`anlyon packs exercise ./packs/clickup` runs every action once against your test account, in the
order of `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `team_id` | The test workspace's id (from `list-workspaces`, or the number after `app.clickup.com/` in a ClickUp URL) |
| `space_id` | A test space in it, with tags turned on |
| `folder_id` | Any folder in that space |
| `list_id` | A test list the token's user can edit |
| `status` | A status of that list other than the one new tasks start in, as `get-list` returns it |
| `tag_name` | A tag of that space that may be put on and taken off a test task |
| `user_id` | The token user's own ClickUp user id |

The run creates a task, changes it, moves it to `status`, assigns the token user and takes them off
again, comments, adds the tag and removes it, adds a checklist with one item and resolves it, and
deletes the task at the end (to the workspace's trash, with its comment and checklist).

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as the person who made it**, in every workspace they belong to. ClickUp personal tokens have no scopes.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, reconcile before invoking again, or a second task, comment, checklist or item can be created.
- **Task pages are fixed at 100 tasks.** ClickUp has no smaller page size, so a page of long tasks can be cut at 64 KB. Narrow `list-tasks` and `search-tasks` with their filters. `list-workspaces`, `list-spaces`, `list-folders`, `list-lists` and `list-comment-replies` return everything at once; a very large workspace can be cut too.
- **One value per filter.** The task filters take one status, one assignee, one tag, one space, one folder and one list per call, though ClickUp accepts several.
- **Some writes have no read-back** (receipt graded `acknowledged`). ClickUp has no read for one checklist item, so `resolve-checklist-item` is not read back. ClickUp does not document what reading a deleted task returns, so `delete-task` is not read back.
- **Weak read-backs.** The status, tag and assignee read-backs can match a task that was already in that state. `add-checklist-item` checks that an item with this name is in one of the task's checklists, not that it is the new one. `comment-on-task` reads the 25 newest comments, so it reports a mismatch if more than 24 comments land on the task in between.
- **`update-task` cannot clear a priority or a due date**, and its read-back compares the task with ClickUp's own response to the update (and fails if someone else edits the task in between).
- **Names are matched as ClickUp returns them.** ClickUp returns status and tag names in lower case. Pass them exactly as `get-list` and `list-space-tags` return them, or the read-back reports a mismatch even when the change happened. `add-tag` takes a tag that exists in the task's space.
- **Custom task ids are not accepted.** Pass ClickUp's own task id.
- **Not included.** Custom fields, dependencies and links, time tracking, attachments (uploads are not supported), docs, chat, goals, views, guests, members, user groups, webhooks and workspace settings are left out: they are account administration or outside day-to-day task work. Creating and deleting spaces, folders and lists is left out too.

## Install

```bash
anlyon packs plan ./packs/clickup
anlyon packs install ./packs/clickup --yes --action search-tasks --action get-task --action create-task --action comment-on-task
```

Every action sends `{{connection:clickup}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own ClickUp account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/clickup`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected ClickUp account (`anlyon connections add clickup --secret CLICKUP`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name CLICKUP=<your secret>`. Do this when the environment has more than one ClickUp account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): twelve reads (workspaces, spaces, folders, lists, a list, tasks in a list, task search, a task, comments, replies, space tags) and twelve writes (create, update and delete tasks, set status, add and remove an assignee, comment, add and remove a tag, create a checklist, add and resolve a checklist item). Every action sends `{{connection:clickup}}`.

Sources: drafted with `pnpm packs:draft` from ClickUp's OpenAPI spec, https://developer.clickup.com/openapi/clickup-api-v2-reference.json (fetched 2026-10-24; `contentEncoding` and nullable type unions stripped from a local copy so the draft could read it). Reference pages: https://developer.clickup.com/reference/getauthorizedteams, https://developer.clickup.com/reference/getspaces, https://developer.clickup.com/reference/getfolders, https://developer.clickup.com/reference/getlists, https://developer.clickup.com/reference/getfolderlesslists, https://developer.clickup.com/reference/getlist, https://developer.clickup.com/reference/gettasks, https://developer.clickup.com/reference/getfilteredteamtasks, https://developer.clickup.com/reference/gettask, https://developer.clickup.com/reference/gettaskcomments, https://developer.clickup.com/reference/getthreadedcomments, https://developer.clickup.com/reference/getspacetags, https://developer.clickup.com/reference/createtask, https://developer.clickup.com/reference/updatetask, https://developer.clickup.com/reference/createtaskcomment, https://developer.clickup.com/reference/addtagtotask, https://developer.clickup.com/reference/removetagfromtask, https://developer.clickup.com/reference/createchecklist, https://developer.clickup.com/reference/createchecklistitem, https://developer.clickup.com/reference/editchecklistitem, https://developer.clickup.com/reference/deletetask, https://developer.clickup.com/reference/getauthorizeduser, https://developer.clickup.com/docs/authentication, checked 2026-10-24.
