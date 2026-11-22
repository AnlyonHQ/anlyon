# anlyon/jira

The Jira toolset an agent needs for issues: search them with JQL, read an issue, its comments and the
moves its workflow allows, create an issue, rename, label, prioritise, assign and transition it,
comment on it, and delete comments and issues. This is the **catalogue pack** for the Jira
integration: the console offers its actions one by one after you connect Jira ("What may your agent
do here?"), and you can install any subset from the CLI.

Jira is connected with your Jira site, the email of an Atlassian account and an API token, not by
signing in. Anlyon checks them with `GET /rest/api/3/myself` on the site before it stores them, and
sends them as HTTP Basic (`email:token`) in the `Authorization` header to that site,
`<site>.atlassian.net`, and nowhere else. The agent never holds the token: Anlyon makes every call.

## API token

Create the token at id.atlassian.com, Security, API tokens
(`https://id.atlassian.com/manage-profile/security/api-tokens`), with **Create API token** (the kind
without scopes). A token with scopes is sent to `https://api.atlassian.com/ex/jira/{cloudId}` rather
than the site, which this pack does not address. The token acts as that Atlassian account, with its
project permissions on the site. What each action needs, in the projects your agent works in:

| Actions | Jira project permission |
| --- | --- |
| every action | Browse projects |
| `list-issue-types`, `create-issue` | Create issues |
| `rename-issue`, `add-issue-label`, `set-issue-priority` | Edit issues |
| `assign-issue` | Assign issues (and the new assignee needs Assignable user) |
| `list-transitions`, `transition-issue` | Transition issues |
| `add-comment` | Add comments |
| `delete-comment` | Delete all comments, or Delete own comments for the account's own |
| `delete-issue` | Delete issues |

Connect the token of an account whose permissions fit what your agent should do. A call Jira does
not permit is refused by Jira; an issue the account cannot see answers 404.

## Reads

Reads return Jira's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes and
the fields returned are fixed. `search-issues` pages with `nextPageToken`; the other lists page with
`startAt`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `jira-get-myself` | Gets the user the connection acts as, with its account id | none |
| `jira-list-projects` | Lists the projects the user can see. 50 a page | `query`, `start_at` (optional) |
| `jira-list-issue-types` | Lists the issue types a project can create. 50 a page | `project_key`, `start_at` |
| `jira-list-priorities` | Lists the issue priorities. 50 a page | `start_at` (optional) |
| `jira-search-issues` | Searches issues with a bounded JQL query. 25 a page, with summary, status, assignee, priority, type, project, labels and dates | `jql`, `next_page_token` |
| `jira-get-issue` | Gets one issue, with its description (Atlassian Document Format) | `issue_key` |
| `jira-list-transitions` | Lists the transitions the user can make on an issue, each with the status it leads to | `issue_key` |
| `jira-list-comments` | Lists an issue's comments. 20 a page | `issue_key`, `order`, `start_at` |
| `jira-get-comment` | Gets one comment | `issue_key`, `comment_id` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `jira-create-issue` | Creates one issue with a summary, a plain-text description and labels | `project_key`, `issue_type_id`, `summary`, `description`, `labels` | The issue by the key Jira returned; key, summary and project must match |
| `jira-rename-issue` | Changes an issue's summary | `issue_key`, `summary` | The issue; the summary must match |
| `jira-add-issue-label` | Adds one label, keeping the others | `issue_key`, `label` | The issue; the label must be among its labels |
| `jira-set-issue-priority` | Sets an issue's priority | `issue_key`, `priority_id` | The issue; the priority id must match |
| `jira-assign-issue` | Assigns an issue to a user by account id | `issue_key`, `account_id` | The issue; the assignee's account id must match |
| `jira-transition-issue` | Moves an issue through its workflow | `issue_key`, `transition_id`, `to_status_id` | The issue; its status id must equal `to_status_id` |
| `jira-add-comment` | Adds one plain-text comment | `issue_key`, `body` | The comment by the id Jira returned; its text must equal `body` |
| `jira-delete-comment` | Deletes one comment | `issue_key`, `comment_id` | Getting the comment must answer 404 |
| `jira-delete-issue` | Deletes one issue with its comments and history | `issue_key` | Getting the issue must answer 404 |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| jira: approve deleting an issue | Every issue deletion requires approval. Treat a delete as final |
| jira: approve deleting a comment | Every comment deletion requires approval. Treat a delete as final |
| jira: approve adding a comment | Every comment requires approval. A comment is seen by everyone who can see the issue, and Jira can email its watchers. Turn it on when your agent should not write to people alone |

Suggested limits are printed, and created with `--with-limits`. Each counts one write action per day. The
amounts suit one team's normal day of use: editing and commenting more often than creating, and
deleting rarely. Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| jira: issues created per day | 50 |
| jira: issues renamed per day | 100 |
| jira: labels added per day | 200 |
| jira: priorities set per day | 100 |
| jira: issues assigned per day | 100 |
| jira: issues transitioned per day | 200 |
| jira: comments added per day | 200 |
| jira: comments deleted per day | 20 |
| jira: issues deleted per day | 10 |

## Exercise

`anlyon packs exercise ./packs/jira --need project_key=OPS --need issue_type_id=10001` runs every
action once, in the order of `exercise.json`, against your Jira site. It needs a project the account
can create, edit, comment on and delete issues in, and the id of a standard (not subtask) issue type
in it (`list-issue-types` shows them).

The run reads the connected user and the priorities, creates an issue (`Anlyon exercise <run>`, label
`anlyon-exercise`), reads and searches it, renames it, adds a label, sets the priority listed at the
top, assigns it to the connected user, makes the transition listed at the top for its status, adds a
two-line comment, reads it, deletes the comment and deletes the issue. Nothing it did not create is
changed. Turn the policies off (or approve them) for the run, or it stops at the next one. The
two-line comment checks how Jira stores a line break inside a text node (see Limitations).

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as one user.** An API token without scopes has that account's permissions on the
  site. What the agent can see and change is what that account can.
- **Plain text, one paragraph.** Descriptions and comments are Atlassian Document Format (ADF). The
  pack builds one paragraph with one text node from the input; headings, lists, links, mentions and
  formatting are not offered. A line break is sent inside the text node as it is. Jira's ADF marks a
  line break with a `hardBreak` node, and whether Jira stores and shows a newline inside a text node
  as a break is not documented. If Jira changes such text, the
  `add-comment` read-back does not match and the receipt says so.
- **No description on update, no priority or assignee on create.** A Jira field left empty in a
  nested body would be sent as an empty object, so `create-issue` takes a description it always
  sends and sets no priority, assignee, parent or due date. Set those with their own actions
  afterwards. Subtasks cannot be created.
- **Transitions with screens.** `transition-issue` sends the transition alone. A transition whose
  screen requires fields (a resolution, a comment) is refused by Jira. `to_status_id` is used for the
  read-back and must be the `to.id` of the same transition.
- **Assigning.** `assign-issue` takes an Atlassian account id. Unassigning and the project's default
  assignee are not offered. Finding other users is not offered either (user search is left out):
  use the connected user's id from `get-myself`, or an assignee or reporter id from `get-issue`.
- **Search is eventually consistent.** Jira says recent changes can take a moment to show in JQL
  search. `get-issue` shows an issue's current state. JQL must be bounded (a restriction, not just an
  `ORDER BY`), and the search returns no total count. `nextPageToken` expires after 7 days.
- **Treat deletes as final.** Jira removes a deleted issue from its database, and Atlassian's backups
  cannot restore a single issue. `delete-issue` is refused for an issue with subtasks. Both deletes
  read back as a 404, which is also what Jira answers for an issue or comment the account cannot see.
- **Summary length.** The pack bounds a summary to one line of 255 characters.
- **No idempotency.** A retry of `create-issue` or `add-comment` after an unknown outcome can create a
  second issue or comment. Search before you create.
- **Standard fields.** Custom fields, components, versions, sprints, attachments, worklogs and issue
  links are not offered. Attachments need a multipart upload, which is not supported.
- **Notifications.** Jira emails users as the project's notification scheme says (a new comment, an
  assignment). The pack does not change that.
- **Rate limits.** Jira Cloud applies burst limits to API token calls per site and per endpoint. When
  a limit is reached it answers `429 Too Many Requests` with a `Retry-After` header, the seconds to
  wait.
- **Status codes.** `GET /rest/api/3/myself` answers 401 for a wrong email or token, and getting a
  deleted issue or comment answers 404. Jira treats a request with bad credentials as anonymous, so an
  endpoint anonymous users can call may answer 404 or 200 rather than 401 (Atlassian's own bugs
  JRACLOUD-94680, a 404 for a project, and JRACLOUD-93811).

## Install

```bash
anlyon packs plan ./packs/jira
anlyon packs install ./packs/jira --yes --action search-issues --action get-issue --action add-comment
```

Every action sends `{{connection:jira}}` to `https://{{connection.host}}/`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Jira site and account. Store their own credential with `PUT /api/v2/end-users/{endUserId}/connections/jira`, with `fields` `{ "site": "acme", "email": "...", "apiToken": "..." }` (`site` is the name before `.atlassian.net`). A user with no credential stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Jira account (`anlyon connections add jira --secret JIRA`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name JIRA=<your secret>`. Do this when the environment has more than one Jira account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: search issues with JQL and read issues, comments, transitions,
  projects, issue types and priorities; create, rename, label, prioritise, assign and transition
  issues, add comments, and delete comments and issues, as governed writes.

## Sources

Jira Cloud platform REST API v3, checked 2026-11-22.

- The Jira Cloud platform v3 OpenAPI description:
  https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
- Issue search (`GET /rest/api/3/search/jql`):
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Removal of `GET` and `POST /rest/api/3/search`: https://developer.atlassian.com/changelog/#CHANGE-2046
  and https://confluence.atlassian.com/display/JIRAKB/Run+JQL+search+query+using+Jira+Cloud+REST+API
- Issues (create, get, edit, delete, assign, transitions, create metadata):
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- Issue comments: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
- Projects: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/
- Priorities: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-priorities/
- Current user: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/
- Bad credentials treated as anonymous: https://jira.atlassian.com/browse/JRACLOUD-93811 and
  https://jira.atlassian.com/browse/JRACLOUD-94680
- Atlassian Document Format: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
  and the `hardBreak` node: https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/hardBreak/
- Basic auth with an email and API token:
  https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- API tokens, with and without scopes:
  https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- Deleted issues: https://support.atlassian.com/jira/kb/restore-deleted-work-items-in-jira-cloud-using-local-backup-files/
- Rate limiting: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
