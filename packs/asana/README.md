# anlyon/asana

The Asana tools an agent can be given. This is the **catalogue pack** for the Asana integration: the
console offers its actions one by one after you connect Asana ("What may your agent do here?"), and
you can install any subset from the CLI. Anlyon holds the token and makes every call; the agent never
sees it.

Asana is connected with a personal access token you create, not by signing in. Anlyon checks the token
with Asana before it stores it, and binds it to `app.asana.com` in a request header. Every call uses
Asana's REST API 1.0 (`https://app.asana.com/api/1.0`).

Ids are Asana's numeric gids. Actions install as `asana-<name>` unless `--no-prefix`.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them. Lists return a fixed page size; when Asana has more, the
response carries `next_page.offset`, which the agent passes back as `offset`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `list-workspaces` | Workspaces and organizations the token can reach, 25 per page | `offset`? | none (read) |
| `list-projects` | Projects in a workspace, 25 per page: name, archived, team, permalink | `workspace_gid`, `archived`?, `offset`? | none (read) |
| `get-project` | One project: name, notes, owner, team, dates, state, latest status title | `project_gid` | none (read) |
| `list-sections` | Sections of a project, 50 per page, in project order | `project_gid`, `offset`? | none (read) |
| `list-project-tasks` | Tasks in a project, 25 per page: name, completed, assignee, due date | `project_gid`, `completed_since`? (`now` or ISO 8601), `offset`? | none (read) |
| `list-section-tasks` | Tasks in a section, 25 per page, same fields | `section_gid`, `completed_since`?, `offset`? | none (read) |
| `get-task` | One task: notes, state, assignee, dates, parent, projects and sections, tags, followers, subtask count | `task_gid` | none (read) |
| `list-subtasks` | Subtasks of a task, 25 per page | `task_gid`, `offset`? | none (read) |
| `list-task-stories` | A task's comments and activity, 20 per page, oldest first | `task_gid`, `resource_subtype`? (`comment_added` for comments only), `sort_ascending`?, `offset`? | none (read) |
| `list-tags` | Tags in a workspace, 50 per page | `workspace_gid`, `offset`? | none (read) |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Where Asana has a GET that shows the change, the receipt is graded
`confirmed` by a read-back; otherwise `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-task` | Creates one task in a project | `project_gid`, `name`, `notes` | The task by id; the name must match |
| `create-subtask` | Creates one subtask under a task | `task_gid`, `name`, `notes`?, `assignee`?, `due_on`? | The subtask by id; name and parent must match |
| `update-task` | Changes a task's name, notes, due date or assignee; only the fields given change | `task_gid`, `name`?, `notes`?, `due_on`?, `assignee`? | The task; name, notes, due date and modified time must equal Asana's response to this update |
| `comment-on-task` | Adds one comment to a task | `task_gid`, `text` | The comment by id; the text must match |
| `complete-task` | Marks a task complete | `task_gid` | The task; it must be completed |
| `reopen-task` | Marks a task incomplete | `task_gid` | The task; it must not be completed |
| `add-task-to-section` | Moves a task to the top of a section of its project | `section_gid`, `task_gid` | The task; its first membership's section must be this one |
| `add-follower` | Adds a follower (`me`, gid or email) to a task | `task_gid`, `follower` | none: a follower is named three ways, Asana lists followers by gid |
| `remove-follower` | Removes a follower from a task | `task_gid`, `follower` | none: as above |
| `add-tag` | Puts an existing tag on a task | `task_gid`, `tag_gid` | The task; the tag must be among its tags |
| `remove-tag` | Takes a tag off a task | `task_gid`, `tag_gid` | The task; the tag must no longer be among its tags |
| `delete-task` | Deletes a task or subtask (to the trash, restorable for 30 days) | `task_gid` | none: Asana does not document reading a deleted task |
| `create-section` | Creates a section in a project | `project_gid`, `name` | The section by id; name and project must match |
| `delete-section` | Deletes an empty section | `section_gid` | none: Asana does not document reading a deleted section |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| asana: approve completing a task | Every completion requires approval |
| asana: approve deleting a task | Every task deletion requires approval |
| asana: approve deleting a section | Every section deletion requires approval |
| asana: approve adding a follower | Adding a follower (who can then see the task) requires approval |
| asana: approve removing a follower | Removing a follower requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| asana: tasks created per day | 100 |
| asana: comments per day | 300 |
| asana: tasks completed per day | 100 |
| asana: tasks reopened per day | 100 |
| asana: task updates per day | 200 |
| asana: subtasks created per day | 100 |
| asana: tasks moved to a section per day | 200 |
| asana: followers added per day | 50 |
| asana: followers removed per day | 50 |
| asana: tags added per day | 200 |
| asana: tags removed per day | 200 |
| asana: tasks deleted per day | 20 |
| asana: sections created per day | 20 |
| asana: sections deleted per day | 20 |

## Exercise

`anlyon packs exercise ./packs/asana` runs every action once against your test account, in the order
of `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `workspace_gid` | The workspace the test project is in (from `list-workspaces`) |
| `project_gid` | A test project the token's user can edit, with at least one section of its own: the first number in its URL |
| `tag_gid` | A tag in that workspace that may be put on and taken off a test task |

The run creates a task, a subtask and a section, and deletes all three at the end (the tasks go to the
token user's trash). It removes the token user as a follower of its own task and adds them back, adds
the tag and removes it, and completes the task and reopens it. It assigns the task to the token user.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as the person who made it.** A personal access token can do whatever that person can do in Asana. Create it from an account limited to the projects your agent should reach.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, reconcile before invoking again, or a second task, subtask, section or comment can be created.
- **Some writes have no read-back** (receipt graded `acknowledged`). A follower can be named as `me`, a gid or an email, while Asana lists followers by gid only, so `add-follower` and `remove-follower` are not read back. Asana does not document what reading a deleted task or section returns, so `delete-task` and `delete-section` are not read back.
- **`update-task` cannot clear a due date or unassign a task**, and its read-back compares the task with Asana's own response to the update (and fails if someone else edits the task in between).
- **The completion and reopen read-backs can match a task that was already in that state.**
- **`add-task-to-section` reads back the task's first project membership**, so for a task in more than one project it can report a mismatch even though the move happened.
- **`list-section-tasks`**: Asana's reference labels its endpoint "board view only". For a list-view project, `list-project-tasks` always works.
- **Not included.** Task search (`GET /workspaces/{gid}/tasks/search`) is premium-only: free-plan accounts get `402 Payment Required`, and it has no page cursor. Creating a project is left out: in an organization it needs a team (a deprecated field, replaced by a separate membership call), and the pack does not delete projects, so a created project could not be cleaned up. Users, teams, memberships, webhooks, custom-field definitions, portfolios and goals are account administration or outside day-to-day task work.

## Install

```bash
anlyon packs plan ./packs/asana
anlyon packs install ./packs/asana --yes --action list-project-tasks --action get-task --action create-task --action comment-on-task
```

Every action sends `{{connection:asana}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Asana account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/asana`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Asana account (`anlyon connections add asana --secret ASANA`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name ASANA=<your secret>`. Do this when the environment has more than one Asana account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:asana}}` instead of `{{secret:ASANA}}`. A call made for one of your users acts in their own Asana account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full toolset: ten reads (workspaces, projects, sections, tasks, subtasks, stories, tags) and eleven more writes (reopen, update, subtask, move to section, followers, tags, delete task, create and delete section). The three 0.1.0 actions are unchanged apart from being marked `kind: write`.
- 0.1.0: first version.

Sources: https://developers.asana.com/reference/getworkspaces, https://developers.asana.com/reference/getprojectsforworkspace, https://developers.asana.com/reference/getproject, https://developers.asana.com/reference/getsectionsforproject, https://developers.asana.com/reference/gettasksforproject, https://developers.asana.com/reference/gettasksforsection, https://developers.asana.com/reference/gettasks, https://developers.asana.com/reference/gettask, https://developers.asana.com/reference/getsubtasksfortask, https://developers.asana.com/reference/getstoriesfortask, https://developers.asana.com/reference/gettagsforworkspace, https://developers.asana.com/reference/updatetask, https://developers.asana.com/reference/createsubtaskfortask, https://developers.asana.com/reference/addtaskforsection, https://developers.asana.com/reference/addfollowersfortask, https://developers.asana.com/reference/removefollowerfortask, https://developers.asana.com/reference/addtagfortask, https://developers.asana.com/reference/removetagfortask, https://developers.asana.com/reference/deletetask, https://developers.asana.com/reference/createsectionforproject, https://developers.asana.com/reference/getsection, https://developers.asana.com/reference/deletesection, https://developers.asana.com/reference/searchtasksforworkspace, https://developers.asana.com/reference/createproject, checked 2026-10-15.
