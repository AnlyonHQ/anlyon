# anlyon/calendly

The Calendly tools an agent can be given. This is the **catalogue pack** for the Calendly integration:
the console offers its actions one by one after you connect Calendly ("What may your agent do here?"),
and you can install any subset from the CLI. Anlyon holds the token and makes every call; the agent
never sees it.

Calendly is connected with a personal access token you create, not by signing in. Anlyon checks the
token with Calendly before it stores it, and binds it to `api.calendly.com` in a request header. Every
call uses Calendly's API v2 (`https://api.calendly.com`). The pack was drafted from Calendly's
published OpenAPI document and curated by hand.

Calendly names everything by uri (`https://api.calendly.com/scheduled_events/<uuid>`). Actions that
filter a list or book take the uri as Calendly returns it (`user`, `event_type`). Actions that read
or change one object take its uuid, the last part of its uri. Actions install as
`calendly-<name>` unless `--no-prefix`.

## Token scopes

A personal access token carries the scopes you choose when you create it. Give it what the actions
you install need, and no more:

| Scope | Actions |
| --- | --- |
| `users:read` | `get-current-user` |
| `event_types:read` | `list-event-types`, `get-event-type` |
| `availability:read` | `list-available-times`, `list-busy-times`, `list-availability-schedules` |
| `scheduled_events:read` | `list-scheduled-events`, `get-scheduled-event`, `list-event-invitees`, `get-invitee`, `get-no-show`, and the read-backs of every write but the scheduling link |
| `scheduled_events:write` | `book-meeting`, `cancel-event`, `mark-no-show`, `unmark-no-show` |
| `scheduling_links:write` | `create-scheduling-link` |

A token made by a regular member reaches that member's own data. The token acts as the person who
made it.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them. Paged lists return a fixed page size; when Calendly has
more, the response carries `pagination.next_page_token`, which the agent passes back as `page_token`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `get-current-user` | The token's user: name, email, timezone, scheduling URL, uri and organization uri | none | none (read) |
| `list-event-types` | A user's event types, 10 per page, by name | `user`, `active`?, `page_token`? | none (read) |
| `get-event-type` | One event type: duration, locations, custom questions, scheduling URL | `event_type_uuid` | none (read) |
| `list-available-times` | Open start times of an event type in a range (at most 31 days, not paged) | `event_type`, `start_time`, `end_time` | none (read) |
| `list-busy-times` | A user's busy times in a range (at most 7 days, not paged) | `user`, `start_time`, `end_time` | none (read) |
| `list-availability-schedules` | A user's working-hours schedules and their rules | `user` | none (read) |
| `list-scheduled-events` | The user's meetings, 20 per page, by status, invitee email and start time | `user`, `status`?, `invitee_email`?, `min_start_time`?, `max_start_time`?, `sort`?, `page_token`? | none (read) |
| `get-scheduled-event` | One meeting: times, status, location and join URL, hosts, cancellation | `event_uuid` | none (read) |
| `list-event-invitees` | A meeting's invitees, 20 per page: answers, no-show, cancel and reschedule URLs | `event_uuid`, `status`?, `email`?, `page_token`? | none (read) |
| `get-invitee` | One invitee, with its no-show mark | `event_uuid`, `invitee_uuid` | none (read) |
| `get-no-show` | One no-show mark | `no_show_uuid` | none (read) |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Where Calendly has a GET that shows the change, the receipt is
graded `confirmed` by a read-back; otherwise `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `book-meeting` | Books a meeting for one invitee. Calendly sends the confirmation and invite | `event_type`, `start_time`, `invitee_name`, `invitee_email`, `invitee_timezone`, `user`, `location`?, `answers`?, `guest_emails`? | The token user's active meetings with that invitee, latest first; the booked meeting must be among them |
| `create-scheduling-link` | Creates a single-use booking link for an event type | `event_type` | none: Calendly has no call that reads a scheduling link |
| `cancel-event` | Cancels a meeting with a reason. Calendly notifies the invitees | `event_uuid`, `reason` | The meeting; its status must be `canceled` and its cancellation reason this one |
| `mark-no-show` | Marks an invitee as a no-show | `event_uuid`, `invitee_uuid` | The invitee; its no-show must be the mark this call made |
| `unmark-no-show` | Removes a no-show mark | `no_show_uuid`, `event_uuid`, `invitee_uuid` | The invitee; its no-show must be empty |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| calendly: approve booking a meeting | Every booking requires approval. A booking emails the invitee and its guests and puts the meeting in their calendars |
| calendly: approve cancelling a meeting | Every cancellation requires approval. The invitees are told, and Calendly has no call that undoes it |
| calendly: approve removing a no-show mark | Removing a mark requires approval. `mark-no-show` puts it back |

Turn on the booking and cancelling policies before an agent acts for someone else's calendar. Leave
the no-show policy off unless no-show records feed something you report on.

| Suggested limit (created only with `--with-limits`) | Per day | Why this amount |
| --- | --- | --- |
| calendly: meetings booked per day | 20 | A full day of half-hour meetings fits under it; more is unlikely to be one person's real day |
| calendly: scheduling links per day | 50 | Links tell nobody until sent, so the room is wider |
| calendly: meetings cancelled per day | 10 | Cancelling reaches other people and cannot be undone, so it is kept low |
| calendly: no-shows marked per day | 50 | Above the meetings one host holds in a day |
| calendly: no-show marks removed per day | 50 | The same as marking |

These are suggestions. Change the amount to fit how your users work.

## Exercise

`anlyon packs exercise ./packs/calendly` runs every action once against your test account, in the
order of `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `event_type_uuid` | A test event type the token's user hosts, with no required custom questions |
| `window_start`, `window_end` | A future range of at most 7 days, UTC ISO 8601 |
| `start_time` | An open start time in that range, from `list-available-times` |
| `invitee_email` | A mailbox you control. The test booking's confirmation goes there |
| `event_uuid` | A past test meeting of the token's user |
| `invitee_uuid` | That meeting's invitee, already marked as a no-show |
| `no_show_uuid` | That invitee's no-show mark, from `get-invitee` (`no_show.uri`) |
| `cancel_event_uuid` | A future test meeting the run may cancel, with an invitee you control |

The run creates a single-use link, books one meeting, removes the test invitee's no-show mark and
puts it back, and cancels the meeting you named. The account needs a paid Calendly plan for the
booking step.

It cannot cancel the meeting it books. Calendly returns the booking as a uri, and `cancel-event` takes
a uuid, which an exercise cannot cut from a uri. Cancel it afterwards: run `cancel-event` with the
last part of `resource.event` from the booking's response, or cancel it in Calendly.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as the person who made it.** It reaches what that person can reach in Calendly, within the scopes you gave it.
- **Booking needs a paid plan.** `book-meeting` uses Calendly's Scheduling API, which answers `403` for a Free plan (Standard and above can book).
- **Booking is people-facing.** Calendly sends its usual confirmation and calendar invite to the invitee and any guests, and runs the event type's workflows.
- **The booking read-back looks among the token user's own meetings.** Calendly lists meetings by user for the token's own user alone, so a booking on an event type the token user does not host (a team event hosted by someone else) reads back as a mismatch even though it was made.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, reconcile before invoking again, or a second meeting can be booked or a second link created.
- **A cancellation cannot be undone.** Calendly has no call for it; the invitee has to book again.
- **`create-scheduling-link` has no read-back** (receipt graded `acknowledged`): Calendly has no call that reads a scheduling link.
- **`list-available-times` and `list-busy-times` are not paged.** Keep the range short (a week or less) so a busy calendar fits in the 64 KB response.
- **Inputs mix uris and uuids.** List filters and booking take a uri as Calendly returns it. The get, cancel and no-show actions take the uuid, the last part of a uri.
- **Not included.** Rescheduling: Calendly's API has no reschedule call; the invitee uses the `reschedule_url` that `get-invitee` returns. Creating and changing event types, one-off meetings and customized share links are left out: they change the booking page itself. Organization members and invitations, groups, webhooks, routing forms, contacts, meeting recaps, the activity log and data-compliance deletes are account administration or outside a meeting's lifecycle.

## Install

```bash
anlyon packs plan ./packs/calendly
anlyon packs install ./packs/calendly --yes --action get-current-user --action list-scheduled-events --action get-invitee --action cancel-event
```

Every action sends `{{connection:calendly}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Calendly account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/calendly`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Calendly account (`anlyon connections add calendly --secret CALENDLY`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name CALENDLY=<your secret>`. Do this when the environment has more than one Calendly account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): first version. Eleven reads (user, event types, available and busy times, availability schedules, scheduled meetings, invitees, no-shows) and five writes (book a meeting, single-use scheduling link, cancel, mark and unmark a no-show).

## Sources

Checked 2026-10-24.

- Calendly API v2 OpenAPI document, exported from Calendly's API reference: https://calendly.stoplight.io/api/v1/projects/calendly/api-docs/nodes/reference/calendly-api/openapi.yaml?fromExportButton=true&snapshotType=http_service&deref=optimizedBundle (the reference at https://developer.calendly.com/api-docs). Operations used: `get-current-user`, `list-event-types`, `get-event-type`, `list-event-type-available-times`, `list-user-busy-times`, `list-user-availability-schedules`, `list-scheduled-events`, `get-scheduled-event`, `list-event-invitees`, `get-scheduled-event-invitees`, `get-invitee-no-show`, `post-invitee`, `create-scheduling-link`, `create-scheduled-event-cancellation`, `create-invitee-no-show`, `delete-invitee-no-show`.
- Personal access tokens: https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens
- Scopes: https://developer.calendly.com/docs/authentication/scopes
