# anlyon/google-calendar

The Google Calendar tools an agent can be given. This is the **catalogue pack** for the Google
Calendar integration: the console offers its actions one by one after you connect Google Calendar
("What may your agent do here?"), and you can install any subset from the CLI. Anlyon holds the
token and makes every call; the agent never sees it.

Google Calendar is connected by signing in with Google (OAuth). Anlyon asks for one scope,
`https://www.googleapis.com/auth/calendar.events`: read and change events on the calendars the account
can reach, and nothing else of the account (not its calendar list, settings or sharing). The token is
bound to `www.googleapis.com` in a request header. Every call uses the Calendar API v3
(`https://www.googleapis.com/calendar/v3`).

A calendar is named by its id: `primary` for the account's own calendar, or a calendar's id from its
settings (Integrate calendar), such as `team@group.calendar.google.com`. An event is named by the id
Google gives it. Actions install as `google-calendar-<name>` unless `--no-prefix`.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them.

| Action | What it does | Inputs | Page size and next page |
| --- | --- | --- | --- |
| `list-events` | The events on one calendar that overlap a time range, earliest first, each occurrence of a recurring event on its own: id, status, summary, location, start, end, organizer, attendees and responses, series id, link. Cancelled events are left out | `calendar_id`, `time_min`, `time_max`, `query`?, `page_token`? | 50; `nextPageToken` as `page_token` |
| `get-event` | One event with everything Google holds for it, its description included. A cancelled event is returned with status `cancelled` | `calendar_id`, `event_id` | one event |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Every write here has a read-back, so its receipt is graded
`confirmed` when the read-back matches. Google emails attendees about a write only when
`send_updates` says so (`all`, `externalOnly`); left out, it emails nobody.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-event` | Creates one event with a title, a start and an end, and optionally a description, a location and attendees | `calendar_id`, `summary`, `start`, `end`, `description`?, `location`?, `attendees`?, `send_updates`? | The event by the id Google returns; the summary must match and the status must be `confirmed` |
| `update-event` | Changes an event's title, description, location, start, end or attendees; only what is given changes, and `attendees` replaces the whole list | `calendar_id`, `event_id`, any of `summary`, `description`, `location`, `start`, `end`, `attendees`, `send_updates`? | The event by id; its `etag` must be the one this change produced |
| `cancel-event` | Cancels one event, or every occurrence when given a series id | `calendar_id`, `event_id`, `send_updates`? | The event by id; Google keeps it, and its status must be `cancelled` |

`start` and `end` are objects: `{ "dateTime": "2026-11-10T15:00:00Z" }` (with its offset), or
`{ "date": "2026-11-10" }` for an all-day event (the end day is exclusive). Add `timeZone` (an IANA
name) when the time should follow a zone rather than an offset.

## Policies and limits

Every write changes a calendar someone else may read, and with `send_updates` it emails attendees. So
each write has a suggested approval policy. Turn on at least the one for `create-event` when the agent
books with people outside your team, and the one for `cancel-event`.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| google-calendar: approve creating an event | Every new event requires approval |
| google-calendar: approve changing an event | Every change requires approval |
| google-calendar: approve cancelling an event | Every cancellation requires approval |

The limits are suggestions sized for one person's calendar: 50 new events and 50 cancellations a day
leave room for a busy day and stop a loop before it fills a calendar; changes come in bursts when a day
is rearranged, so they get 100.

| Suggested limit (created with `--with-limits`) | Per day |
| --- | --- |
| google-calendar: events created per day | 50 |
| google-calendar: events changed per day | 100 |
| google-calendar: events cancelled per day | 50 |

## Exercise

`anlyon packs exercise ./packs/google-calendar` runs every action once against the connected test
account's primary calendar, in the order of `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `start`, `end` | A free slot, with offsets (`2026-11-10T15:00:00Z`, `2026-11-10T15:30:00Z`) |
| `new_start`, `new_end` | A second free slot, for the change |
| `time_min`, `time_max` | A range around both slots, for `list-events` |
| `attendee_email` | An inbox you own, invited to the event |

The run creates an event with one attendee, reads it, finds it with `list-events`, moves it to the
second slot and cancels it. Every step sends `send_updates: none`, so Google emails nobody.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Google's Testing mode.** While a Google app is in Testing mode, only the test users listed on it can connect, and Google ends their sign-in after 7 days, so the account must be connected again. Publish the app, with Google's verification for its scopes, before production use.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, check with `list-events` before invoking `create-event` again, or a second event can be created.
- **`update-event`'s read-back proves the version, not the fields.** It matches the `etag` of the event Google stores against the one the change returned: this change is the latest one. A change made by someone else in between makes it fail to match. An event the account does not organise may refuse changes.
- **`cancel-event`'s read-back can match an event already cancelled.** Cancelling cannot be undone with this pack; create the event again.
- **Not included.** Recurring events (`recurrence`), reminders, colours, video conference links, working location and focus time events, moving an event to another calendar, free/busy, the calendar list, calendar settings and sharing. The `calendar.events` scope does not reach the calendar list, settings or sharing, and the rest are outside the jobs of booking and managing meetings.

## Install

```bash
anlyon packs plan ./packs/google-calendar
anlyon packs install ./packs/google-calendar --yes
```

Every action sends `{{connection:google-calendar}}`, so nothing needs connecting before install. A
call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK)
uses that user's own Google Calendar; a user who has not connected gets `409 END_USER_NOT_CONNECTED`
with a connect link. Any other call uses this environment's connected Google Calendar account
(`anlyon connections add google-calendar --secret GOOGLE_CALENDAR`).

To bind the actions to that account by name instead, add `--credential secret`, or
`--secret-name GOOGLE_CALENDAR=<your secret>`. Then review and enable the policies. Add
`--with-limits` to create the limits (needs `impact-limits:write`).

## History

- 0.1.0 (2026-11-03): two reads (list events in a range, get an event) and three writes (create, change, cancel), written by hand from Google's reference.

Sources: the Calendar API v3 reference, https://developers.google.com/workspace/calendar/api/v3/reference/events
(`events.list`, `events.get`, `events.insert`, `events.patch`, `events.delete`; the Events resource,
whose `status` is `cancelled` for a deleted event, which `events.get` always returns), and the scope
list at https://developers.google.com/workspace/calendar/api/auth.
