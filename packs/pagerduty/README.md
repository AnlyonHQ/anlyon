# anlyon/pagerduty

The PagerDuty toolset an agent needs for incident response: find and read incidents, their notes,
log entries and alerts; see services, who is on call, escalation policies, schedules and
maintenance windows; and open, acknowledge, resolve, reassign, re-prioritise, snooze, merge and
annotate incidents and schedule maintenance. Anlyon holds the API key and makes every call; the
agent never sees it. This is the **catalogue pack** for the PagerDuty integration: the console
offers its actions one by one after you connect PagerDuty ("What may your agent do here?"), and you
can install any subset from the CLI.

PagerDuty is connected with an API key you create, not by signing in. Anlyon checks the key with
PagerDuty before it stores it, and binds it to `api.pagerduty.com` in a request header
(`Authorization: Token token=...`, with the REST API v2 `Accept` header).

## Operations

### Reads

Reads are plain tools: Anlyon makes the call with the stored key and returns PagerDuty's response to the agent, logged, and subject to any approval or deny policy you add. They have no impact, no limit and no receipt.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `pagerduty-list-incidents` | Lists incidents, newest first, 25 per page | `offset`, `status`, `second_status`, `service_id`, `user_id`, `urgency`, `since`, `until`, `date_range` (all optional) |
| `pagerduty-get-incident` | Gets one incident | `incident_id` |
| `pagerduty-list-incident-notes` | Lists an incident's notes, newest first (no pagination exists) | `incident_id` |
| `pagerduty-list-incident-log-entries` | Lists an incident's log entries, 25 per page | `incident_id`; optional `offset`, `is_overview` |
| `pagerduty-list-incident-alerts` | Lists the alerts in an incident, 10 per page | `incident_id`; optional `offset`, `status` |
| `pagerduty-list-services` | Lists services, 25 per page | optional `offset`, `query` |
| `pagerduty-get-service` | Gets one service | `service_id` |
| `pagerduty-list-oncalls` | Lists who is on call (now, by default), 25 per page | optional `offset`, `escalation_policy_id`, `schedule_id`, `user_id`, `since`, `until`, `earliest` |
| `pagerduty-list-escalation-policies` | Lists escalation policies, 25 per page | optional `offset`, `query`, `user_id` |
| `pagerduty-list-schedules` | Lists on-call schedules, 25 per page | optional `offset`, `query` |
| `pagerduty-list-users` | Lists users, 25 per page, to pick an assignee | optional `offset`, `query` |
| `pagerduty-list-maintenance-windows` | Lists maintenance windows, 25 per page | optional `offset`, `filter`, `service_id`, `query` |

### Writes

Each write declares 1 resource mutation, counts against its limit, can be put behind an approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `pagerduty-create-incident` | Opens one incident on a service, which notifies whoever is on call | `from`, `service_id`, `title` | The incident by id; the title must match |
| `pagerduty-acknowledge-incident` | Acknowledges one incident | `from`, `incident_id` | The incident; its status must be `acknowledged` |
| `pagerduty-resolve-incident` | Resolves one incident, which stops its notifications | `from`, `incident_id` | The incident; its status must be `resolved` |
| `pagerduty-add-note` | Adds a note to an incident | `from`, `incident_id`, `content` | The incident's notes; the newest must be this note, with this text |
| `pagerduty-reassign-incident` | Reassigns an open incident to one user, who is notified | `from`, `incident_id`, `user_id` | The incident; its first assignee must be that user |
| `pagerduty-change-incident-urgency` | Sets an incident's urgency to high or low | `from`, `incident_id`, `urgency` | The incident; its urgency must match |
| `pagerduty-snooze-incident` | Snoozes an acknowledged incident for 5 minutes to 24 hours | `from`, `incident_id`, `duration` (seconds, fixed choices) | The incident; its status must still be `acknowledged` |
| `pagerduty-merge-incidents` | Merges one incident into another; the source is resolved | `from`, `incident_id` (target), `source_incident_id` | The source incident; resolved, with the target as its merge reason |
| `pagerduty-create-maintenance-window` | Puts one service in maintenance between two times (no incidents, no pages) | `from`, `service_id`, `start_time`, `end_time`, `description` | The window by id; description and service must match |
| `pagerduty-end-maintenance-window` | Deletes a future maintenance window or ends an ongoing one | `maintenance_window_id` | none (a future window is deleted, an ongoing one stays readable) |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| pagerduty: approve resolving an incident | Every resolve requires approval |
| pagerduty: approve merging incidents | Every merge requires approval (it resolves the source incident and cannot be undone) |
| pagerduty: approve a maintenance window | Every new maintenance window requires approval (nobody is paged for the service while it runs) |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| pagerduty: incidents opened per day | 20 |
| pagerduty: incidents acknowledged per day | 100 |
| pagerduty: incidents resolved per day | 50 |
| pagerduty: notes added per day | 200 |
| pagerduty: incidents reassigned per day | 50 |
| pagerduty: urgency changes per day | 50 |
| pagerduty: incidents snoozed per day | 50 |
| pagerduty: incidents merged per day | 20 |
| pagerduty: maintenance windows created per day | 5 |
| pagerduty: maintenance windows ended per day | 10 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Incident writes take `from`, the email address of a PagerDuty user.** PagerDuty requires it on
  writes made with an account API key and records that user as the one who acted. An address that
  is not a user in the account is refused. Ending a maintenance window does not take it.
- **Opening an incident pages a person, and so does reassigning one.** Keep the daily limits low,
  and consider enabling an approval policy of your own on `pagerduty-create-incident`.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown`
  outcome, reconcile before invoking again, or a second incident, note or maintenance window can be
  created.
- **A status read-back can match a change someone else made.** It proves the incident has that
  status, urgency or assignee now, not that this call set it.
- **Snoozing is read back by status only.** PagerDuty refuses to snooze an incident that is not
  acknowledged, and the incident does not show the snooze length.
- **A note's read-back reads the newest note.** PagerDuty lists notes newest first; if someone adds a
  note between the write and the read-back, the read-back does not match.
- **Ending a maintenance window has no read-back.** PagerDuty deletes a future window but only ends
  an ongoing one, which stays readable, so no single read-back fits both.
- **Pages are fixed.** Lists return 25 rows (alerts 10); pass `offset` 25, 50 and so on while the
  response says `more: true`. PagerDuty stops classic pagination at offset + limit 10,000.
  Incident notes have no pagination: every note comes back at once. Every response is cut at 64 KB.
- **Filters take one value each.** `list-incidents` takes up to two statuses (`status`,
  `second_status`) and one service, user and urgency; the others take one id per filter.
- **Without `since`/`until`, `list-incidents` searches the last month** (PagerDuty's default); pass
  `date_range: all` to search every date.
- **Urgency needs a plan with configurable urgencies.**
- **Merging:** PagerDuty merges only incidents that have alerts or were opened by hand, into an
  open target.

Not included: account administration (users, teams, roles, schedules and escalation policy edits,
services and integrations, webhooks, API keys), editing or deleting a note (PagerDuty has no read of
one note, and it is rarely needed), escalating to a level, setting priority (needs the account's
priority ids), responder requests and status updates (they notify people outside the incident),
and incident custom fields. Each can be added on demand.

## Install

```bash
anlyon packs plan ./packs/pagerduty
anlyon packs install ./packs/pagerduty --yes --action list-incidents --action get-incident --action acknowledge-incident
```

Every action sends `{{connection:pagerduty}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own PagerDuty account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/pagerduty`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected PagerDuty account (`anlyon connections add pagerduty --secret PAGERDUTY`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name PAGERDUTY=<your secret>`. Do this when the environment has more than one PagerDuty account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## Exercise

`anlyon packs exercise ./packs/pagerduty` runs `exercise.json` against your test account. It needs:

| Need | What to give |
| --- | --- |
| `from` | The email address of a PagerDuty user in the test account; the run acts as them |
| `service_id` | A test service whose escalation policy pages only you (the id at the end of its URL) |

The run opens two incidents on that service (you are paged), notes, re-prioritises, reassigns to
the same on-call user, acknowledges and snoozes the first, merges the second into it (which resolves
the second), then resolves the first. It creates a maintenance window on 2030-01-01 and deletes it.
Everything it creates is resolved or deleted at the end.

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:pagerduty}}` instead of `{{secret:PAGERDUTY}}`. A call made for one of your users acts in their own PagerDuty account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full toolset: 12 reads and 7 more writes (`add-note`, `reassign-incident`,
  `change-incident-urgency`, `snooze-incident`, `merge-incidents`, `create-maintenance-window`,
  `end-maintenance-window`), two more suggested policies, an exercise. The first three actions are
  unchanged apart from `kind: write`.
- 0.1.0: first version.

Sources: PagerDuty REST API v2 reference, https://developer.pagerduty.com/api-reference/ (List
incidents, Get an incident, Update an incident, Snooze an incident, Merge incidents, List / Create
notes, List log entries, List alerts for an incident, List services, Get a service, List all of the
on-calls, List escalation policies, List schedules, List users, List / Create / Delete a maintenance
window), as published in PagerDuty's OpenAPI document
https://github.com/PagerDuty/api-schema/blob/main/reference/REST/openapiv3.json, and
https://developer.pagerduty.com/docs/pagination, checked 2026-10-15.
