# anlyon/sentry

The Sentry toolset an agent needs for issue triage: find projects, teams and releases, search
issues, read an issue with its comments and activity, its events and its latest event in full; and
resolve, resolve in the next release, reopen, archive, assign, unassign, prioritise, bookmark and
mark issues seen. Anlyon holds the auth token and makes every call; the agent never sees it. This is
the **catalogue pack** for the Sentry integration: the console offers its actions one by one after
you connect Sentry ("What may your agent do here?"), and you can install any subset from the CLI.

Sentry is connected with an auth token you create, not by signing in. Anlyon checks the token with
Sentry before it stores it, and binds it to `sentry.io` in a request header.

## Token scopes

| Scope | Needed for |
| --- | --- |
| `org:read` | The connect check, `list-projects`, `list-teams` |
| `event:write` | Every issue write; it also allows the issue and event reads (`list-issues`, `get-issue`, `list-issue-events`, `get-issue-event`), which take `event:read` or `event:write` |
| `project:read` | `list-releases` only. **New in 0.2.0.** A token without it can use every other action |

## Operations

### Reads

Reads are plain tools: Anlyon makes the call with the stored key and returns Sentry's response to the agent, logged, and subject to any approval or deny policy you add. They have no impact, no limit and no receipt.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `sentry-list-projects` | Lists the organization's projects, 25 per page | `organization`; optional `query`, `cursor` |
| `sentry-list-issues` | Searches issues in the organization, 25 per page | `organization`; optional `query`, `project`, `environment`, `statsPeriod`, `sort`, `cursor` |
| `sentry-get-issue` | Gets one issue, with its activity and comments | `organization`, `issue_id` |
| `sentry-list-issue-events` | Lists an issue's events, 20 per page | `organization`, `issue_id`; optional `query`, `environment`, `statsPeriod`, `cursor` |
| `sentry-get-issue-event` | Gets one event in full (or the latest, oldest or recommended one) | `organization`, `issue_id`, `event_id` |
| `sentry-list-releases` | Lists releases, most recent first, 20 per page | `organization`; optional `query`, `project`, `environment`, `cursor` |
| `sentry-list-teams` | Lists teams, 25 per page, to pick a team assignee | `organization`; optional `query`, `cursor` |

### Writes

Each write declares 1 resource mutation, counts against its limit, can be put behind an approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `sentry-resolve-issue` | Resolves one issue | `organization`, `issue_id` | The issue; its status must be `resolved` |
| `sentry-reopen-issue` | Reopens one resolved or archived issue | `organization`, `issue_id` | The issue; its status must be `unresolved` |
| `sentry-assign-issue` | Assigns one issue to a member, by email address | `organization`, `issue_id`, `assignee_email` | The issue; the assignee's email must match |
| `sentry-unassign-issue` | Removes an issue's assignee | `organization`, `issue_id` | The issue; it must have no assignee |
| `sentry-assign-issue-to-team` | Assigns an issue to a team | `organization`, `issue_id`, `team_id` | The issue; the assignee must be that team |
| `sentry-resolve-issue-in-next-release` | Resolves an issue in the next release | `organization`, `issue_id` | The issue; `resolved` with `statusDetails.inNextRelease` true |
| `sentry-archive-issue` | Archives an issue until it escalates, or forever | `organization`, `issue_id`, `substatus` | The issue; `ignored` with that substatus |
| `sentry-archive-issue-for-duration` | Archives an issue for 30 minutes to 1 week | `organization`, `issue_id`, `ignore_duration` (minutes, fixed choices) | The issue; `ignored`, `archived_until_condition_met` |
| `sentry-set-issue-priority` | Sets an issue's priority | `organization`, `issue_id`, `priority` | The issue; its priority must match |
| `sentry-bookmark-issue` | Bookmarks an issue, or removes the bookmark | `organization`, `issue_id`, `bookmarked` | The issue; `isBookmarked` must match |
| `sentry-mark-issue-seen` | Marks an issue seen or unseen | `organization`, `issue_id`, `seen` | The issue; `hasSeen` must match |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| sentry: approve resolving an issue | Every resolve requires approval |
| sentry: approve resolving an issue in the next release | Every resolve-in-next-release requires approval |
| sentry: approve archiving an issue | Every archive (until escalating or forever) requires approval |
| sentry: approve archiving an issue for a time | Every timed archive requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| sentry: issues resolved per day | 100 |
| sentry: issues reopened per day | 100 |
| sentry: issues assigned per day | 200 |
| sentry: issues unassigned per day | 200 |
| sentry: issues assigned to a team per day | 200 |
| sentry: issues resolved in the next release per day | 100 |
| sentry: issues archived per day | 100 |
| sentry: issues archived for a time per day | 100 |
| sentry: priorities set per day | 200 |
| sentry: bookmarks changed per day | 200 |
| sentry: issues marked seen per day | 500 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Every action takes `organization`**, the organization's slug; issue actions take `issue_id`, the
  number in the issue's URL (not its short id such as `WEB-4F`).
- **sentry.io only.** A self-hosted Sentry, or an organization addressed on a regional host, cannot be
  connected yet.
- **Sentry puts the next page's cursor in a `Link` response header, and Anlyon passes back only the
  body.** For projects and teams (25 per page) the cursor is `25:<page>:0`, for releases (20 per page)
  `20:<page>:0`, and for an issue's events (20 per page) `0:<row offset>:0`; each action's
  description says so. Issue search cursors are sort scores the agent cannot work out, so
  `list-issues` pages by narrowing the search: sort by `date` and repeat with
  `lastSeen:<the last issue's lastSeen>` added to the query.
- **Issue lists leave out the per-issue event graphs** (`collapse=stats,lifetime,filtered`) to keep
  25 issues within the 64 KB response cut. A full event (`get-issue-event`) can still exceed 64 KB and
  is then cut.
- **Assigning** is by a member's primary email address (`assign-issue`) or a team id
  (`assign-issue-to-team`, ids from `list-teams`).
- **Bookmarks and "seen" belong to the user who made the token**, not to the organization.
- **`resolve-issue-in-next-release` needs release tracking** on the issue's project.
- **A status read-back can match a change someone else made.** It proves the issue is in that state
  now, not that this call set it. A timed archive is read back as archived with a condition; the
  issue does not show the length.

Not included: issue comments (Sentry's public API reference has no endpoint for them; `get-issue`
returns them in the issue's activity), deleting an issue (needs the `event:admin` scope, beyond this
integration's `event:write`; ask if you want it, behind approval), merging and discarding issues,
making an issue public (changes who can see it), creating or editing releases and deploys, and
account administration (members, teams, projects, alert rules, integrations, tokens). Each can be
added on demand.

## Install

```bash
anlyon packs plan ./packs/sentry
anlyon packs install ./packs/sentry --yes --action list-issues --action get-issue --action resolve-issue --action assign-issue
```

Every action sends `{{connection:sentry}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Sentry account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/sentry`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Sentry account (`anlyon connections add sentry --secret SENTRY`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name SENTRY=<your secret>`. Do this when the environment has more than one Sentry account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## Exercise

`anlyon packs exercise ./packs/sentry` runs `exercise.json` against your organization. Sentry has no
API to create an issue with an auth token, so the run works on one issue you choose and puts it back
as it found it. It needs:

| Need | What to give |
| --- | --- |
| `organization` | Your organization's slug |
| `issue_id` | An unresolved, unassigned issue with a priority set, in a test project that has at least one release |
| `assignee_email` | Your own Sentry account's primary email address |

Every change is reverted by a later step: priority, bookmark and seen are set back to the values read
at the start; assignments end with the issue unassigned; each resolve or archive is followed by a
reopen, so the issue ends unresolved. The token needs `project:read` for `list-releases`.

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:sentry}}` instead of `{{secret:SENTRY}}`. A call made for one of your users acts in their own Sentry account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full toolset: 7 reads and 8 more writes (`unassign-issue`, `assign-issue-to-team`,
  `resolve-issue-in-next-release`, `archive-issue`, `archive-issue-for-duration`,
  `set-issue-priority`, `bookmark-issue`, `mark-issue-seen`), three more suggested policies, an
  exercise. `list-releases` needs the `project:read` scope. The first three actions are unchanged
  apart from `kind: write`.
- 0.1.0: first version.

Sources: https://docs.sentry.io/api/organizations/list-an-organizations-projects/, https://docs.sentry.io/api/events/list-an-organizations-issues/, https://docs.sentry.io/api/events/retrieve-an-issue/, https://docs.sentry.io/api/events/list-an-issues-events/, https://docs.sentry.io/api/events/retrieve-an-issue-event/, https://docs.sentry.io/api/releases/list-an-organizations-releases/, https://docs.sentry.io/api/teams/list-an-organizations-teams/, https://docs.sentry.io/api/events/update-an-issue/, https://docs.sentry.io/api/events/remove-an-issue/, https://docs.sentry.io/api/pagination/, https://docs.sentry.io/api/permissions/, and Sentry's OpenAPI document https://github.com/getsentry/sentry-api-schema,
checked 2026-10-15.
