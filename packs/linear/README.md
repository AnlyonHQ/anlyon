# anlyon/linear

The Linear toolset an agent needs for issue tracking: find a team, its workflow states and labels;
list, search and read issues and their comments; create an issue, change it, assign it, move it to
another state, label it, comment on it and archive it. This is the **catalogue pack** for the Linear
sign-in integration (`linear`): the console offers its actions one by one after you connect Linear
("What may your agent do here?"), and you can install any subset from the CLI.

Linear is connected by signing in with OAuth, through Anlyon's Linear app where this deployment has
one, or the environment's own app. Anlyon keeps the token and binds it to `api.linear.app`, sent in
the `Authorization` header as `Bearer <token>`. The agent never holds the token: Anlyon makes every
call. To connect with a personal API key instead, use the `linear-key` integration and its pack,
[`anlyon/linear-key`](../linear-key/README.md): Linear wants a key sent bare and an OAuth token
under `Bearer`, so the two cannot share one pack.

## Sign-in

Anlyon asks Linear for the `read` and `write` scopes. The token acts as the person who signed in,
with their teams and permissions. Linear access tokens last 24 hours and come with a refresh token;
Anlyon refreshes them, and each refresh answers a new pair.

## Reads

Reads return Linear's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Every read is a GraphQL query posted to
`https://api.linear.app/graphql` that changes nothing. Responses over 64 KB are cut, so page sizes
are fixed in each query. Lists page with a cursor: when `pageInfo.hasNextPage` is true, pass
`pageInfo.endCursor` as `after`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `linear-list-teams` | Lists the teams the key's user can see, with id, key and name. 50 a page | `after` |
| `linear-list-workflow-states` | Lists one team's workflow states with id, name and type. 50 a page | `team_id`, `after` |
| `linear-list-labels` | Lists the workspace's and teams' issue labels. 50 a page | `after` |
| `linear-list-issues` | Lists issues by team, state, assignee, label, priority, title text or last update. 25 a page, no descriptions | all optional: `filter`, `order_by`, `after` |
| `linear-search-issues` | Searches issues by text, with the same filter. 25 a page | `term`, `filter`, `team_id`, `include_comments`, `after` |
| `linear-get-issue` | Gets one issue, with its description, state, assignee, project, parent and labels | `issue_id` (id or identifier such as `ENG-123`) |
| `linear-list-issue-comments` | Lists the comments on one issue. 20 a page | `issue_id`, `after` |

`filter` is a part of Linear's `IssueFilter`, sent as it is given:
`{ "team": { "id": { "eq": "<team id>" } }, "state": { "type": { "in": ["unstarted", "started"] } }, "assignee": { "isMe": { "eq": true } } }`.
It takes `team.id.eq`, `state.id.eq` or `state.type.in`, `assignee.id.eq`, `assignee.isMe.eq` or
`assignee.null`, `labels.some.id.eq` or `labels.some.name.eqIgnoreCase`, `priority.eq`,
`title.containsIgnoreCase` and `updatedAt.gte`. Anything else is refused by the input schema.

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt. Each is a GraphQL mutation, read back with a fixed query that
reads and changes nothing, on the same URL.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `linear-create-issue` | Creates one issue in a team | `team_id`, `title` and any of `description`, `priority`, `assignee_id`, `state_id`, `label_ids`, `due_date` | The issue by the id Linear returned; title and team must match |
| `linear-update-issue` | Changes an issue's title, description, priority or due date | `issue_id` and the fields to change | The issue; title, priority and last update time must equal what Linear answered |
| `linear-assign-issue` | Assigns an issue to a user | `issue_id`, `assignee_id` | The issue; the assignee must be that user |
| `linear-move-issue` | Moves an issue to another state of its team | `issue_id`, `state_id` | The issue; the state must be the one given |
| `linear-add-issue-label` | Adds one label to an issue | `issue_id`, `label_id` | The issue; the label must be among its labels |
| `linear-remove-issue-label` | Removes one label from an issue | `issue_id`, `label_id` | The issue; the label must no longer be among its labels |
| `linear-add-comment` | Adds a markdown comment to an issue | `issue_id` (the id), `body` | The comment by id; body must equal what Linear stored, and it must be on this issue |
| `linear-archive-issue` | Archives an issue | `issue_id` | The issue; its archive time must equal what Linear answered |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| linear: approve archiving an issue | Every archive requires approval. An archived issue leaves the team's views; turn it on when your agent should not archive alone |

Suggested limits are created with `--with-limits`, not by default. Each counts one write action per day. The
amounts suit one team's normal day of use: changing issues more often than creating or archiving
them. Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| linear: issues created per day | 50 |
| linear: issues updated per day | 200 |
| linear: issues assigned per day | 100 |
| linear: issues moved per day | 200 |
| linear: labels added per day | 200 |
| linear: labels removed per day | 100 |
| linear: comments per day | 200 |
| linear: issues archived per day | 20 |

## Exercise

`anlyon packs exercise ./packs/linear --need assignee_id=... --need label_id=...` runs every action
once, in the order of `exercise.json`, against your Linear workspace. It uses the team at the top of
`list-teams` and that team's second workflow state (the team needs at least two). It needs a user id to
assign (your own is fine) and a label the team can use.

The run creates an issue (`Anlyon exercise <run>`, low priority), renames it, assigns it, moves it,
adds and removes the label, comments on it, finds it by filter and by search, then archives it.
Nothing it did not create is changed; the archived issue can be deleted in Linear afterwards. A
search right after a create may not find the new issue yet. Turn the policy off (or approve it) for
the run, or it stops there.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **GraphQL answers most errors with HTTP 200.** A refused write (a wrong id, a state of another
  team, a person without access to the team) can come back as `200` with an `errors` list. Its
  receipt rests on the read-back, so a refused write is seen as a read-back that does not match.
- **The token acts as one user.** What the agent can see and change is what the person who signed
  in can.
- **No member list.** Users and team members are left out. A user id for `assign-issue` comes from an
  issue's `assignee.id` or `creator.id`, or from the person. Unassigning is not offered.
- **Bounded read-backs.** `update-issue` checks title, priority and the update time; the description
  and due date are sent but not read back. `add-comment` checks the body Linear stored against what it
  answered, not against the input, because Linear may normalise markdown.
- **Archive, not delete.** `archive-issue` archives; the pack does not restore or delete. Restore an
  archived issue in Linear. Linear's schema says `issue(id:)` also returns archived issues; the
  read-back expects the issue with `archivedAt` set.
- **Search.** `search-issues` uses Linear's ranked text search. `team_id` limits the results to one
  team. Linear's schema rate-limits this search to 30 requests a minute.
- **Filters.** A filter part with nothing set (`"state": {}`) is sent as it is; Linear does not
  document how it treats an empty part. Leave out a part you do not need.
- **No idempotency.** A retry of `create-issue` or `add-comment` after an unknown outcome can create a
  second one. Search before you create.
- **Standard fields.** Projects, cycles, estimates, parents, custom views and attachments are read
  where shown but not set. Setting one needs an action you declare. Uploads are not supported.
- **Usage is limited by Linear.** Linear limits requests and query complexity per user and per hour.
  For an OAuth app that is 5,000 requests and 2,000,000 complexity points an hour for each user,
  more on Business and Enterprise plans. A limited request gets HTTP 429 with a `RATELIMITED` error.
  Every query in this pack fixes its page size to keep its complexity low.

## Install

```bash
anlyon packs plan ./packs/linear
anlyon packs install ./packs/linear --yes --action list-issues --action get-issue --action add-comment
```

Every action sends `Bearer {{connection:linear}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Linear account: send them a connect link (`POST /api/v2/end-users/{endUserId}/connect-links` with `integration: "linear"`). A user who has not connected gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Linear account (connect it in the console under Integrations, Linear). Where this deployment has no Linear app of Anlyon's, add your own OAuth app on the integration's Sign-in tab first; until then a connect answers `400 OWN_OAUTH_APP_REQUIRED`.

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name LINEAR=<your secret>`. Do this when the environment has more than one Linear account. A call made for one of your users still uses their own account.

Then review and enable the policy. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: list teams, workflow states and labels; list, search and read
  issues and their comments; create and update issues, assign them, move them between states, add and
  remove labels, comment and archive, as governed writes.
- 2026-10-27: this pack serves the sign-in integration (`linear`, token under `Bearer`). The same
  actions for a personal API key moved to `anlyon/linear-key`.

## Sources

Linear GraphQL API, checked 2026-11-22:

- GraphQL schema (every query, mutation, input, filter, payload and field used here; the
  `searchIssues` rate limit; that `issue(id:)` takes an identifier and also returns archived issues;
  priority values; state types; default page size):
  https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
- Working with the GraphQL API (personal API keys in `Authorization` with no prefix, OAuth tokens
  under `Bearer`, `issue(id:)` by identifier, errors returned with HTTP 200):
  https://linear.app/developers/graphql
- OAuth 2.0 (access tokens last 24 hours; a refresh token gets a new pair):
  https://linear.app/developers/oauth-2-0-authentication
- The SDK sends an API key bare and an OAuth token under `Bearer`:
  https://github.com/linear/linear/blob/master/packages/sdk/src/client.ts
- Error types (`authentication error`, `forbidden`, `ratelimited`, `invalid input`):
  https://github.com/linear/linear/blob/master/packages/sdk/src/error.ts
- Rate limiting (requests and complexity per user and per hour; HTTP 429 with `RATELIMITED`):
  https://linear.app/developers/rate-limiting
- Filtering (comparators and relation filters): https://linear.app/developers/filtering
- Personal API keys (where they are made; narrowing their permissions and teams; admins can turn
  them off for members): https://linear.app/docs/api-and-webhooks
- The `lin_api_` form of a personal API key:
  https://github.com/linear/linear-solutions/blob/main/integration_guides/README.md
