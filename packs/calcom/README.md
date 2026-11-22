# anlyon/calcom

The Cal.com tools an agent can be given. This is the **catalogue pack** for the Cal.com integration:
the console offers its actions one by one after you connect Cal.com ("What may your agent do here?"),
and you can install any subset from the CLI. Anlyon holds the key and makes every call; the agent
never sees it.

Cal.com is connected with an API key you create, not by signing in. Anlyon checks the key with Cal.com
(`GET /v2/me`) before it stores it, and binds it to `api.cal.com` in a request header. Every call uses
Cal.com's API v2 (`https://api.cal.com/v2`). Each action pins the `cal-api-version` header its
endpoint needs: `2026-02-25` for a booking and its writes, `2026-05-01` for the booking list,
`2024-08-13` for attendees and guests, `2026-06-12` for event types, `2024-09-04` for slots and
`2024-06-11` for schedules.

A booking is named by its `uid` (a short string such as `a1B2c3D4e5F6g7H8i9J0kL`), not its numeric id.
Event types and schedules are named by their numeric ids. Times sent to Cal.com are UTC. Actions
install as `calcom-<name>` unless `--no-prefix`.

## The key

A Cal.com API key acts as the user who made it, with that user's access. Cal.com keys have no
per-permission settings. Create the key from the account whose calendar the agent should manage. A key
can be set to expire; when it does, Anlyon marks the account `needs_reauth`.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `get-me` | The key's user: id, username, email, time zone, default schedule id | none | none (read) |
| `list-event-types` | Event types: id, title, slug, length, locations, booking fields, booking URL. All at once, no cursor | `username`? (another user's public ones) | none (read) |
| `get-event-type` | One event type, with its booking fields, confirmation policy, recurrence and seats | `event_type_id` | none (read) |
| `find-available-slots` | Free times for an event type between two dates, grouped by date, each with start and end | `event_type_id`, `start`, `end`, `time_zone`?, `duration`?, `booking_uid_to_reschedule`? | none (read) |
| `list-schedules` | Availability schedules: weekly hours, date overrides, which is the default | none | none (read) |
| `get-schedule` | One availability schedule | `schedule_id` | none (read) |
| `list-bookings` | Bookings, 20 per page; `pagination.nextCursor` is the next page's `cursor` | `status`?, `attendee_email`?, `attendee_name`?, `event_type_id`?, `after_start`?, `before_end`?, `sort_start`?, `cursor`? | none (read) |
| `get-booking` | One booking: status, times, event type, location, hosts, attendees, guests, reasons, reschedule links | `booking_uid` | none (read) |
| `list-booking-attendees` | A booking's attendees, guests included, with their absent flag | `booking_uid` | none (read) |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Every write here has a read-back, so its receipt is graded
`confirmed` when the read-back matches. Most of them email someone: Cal.com sends its own booking,
reschedule, cancellation and invitation emails.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-booking` | Books one meeting for one attendee; Cal.com emails the attendee and the host | `event_type_id`, `start`, `attendee_name`, `attendee_email`, `attendee_time_zone`, `attendee_phone`?, `length_in_minutes`? | The new booking by uid; event type id and attendee email must match |
| `reschedule-booking` | Moves a booking to a new time; Cal.com makes a new booking with a new uid and emails the attendees | `booking_uid`, `start`, `reason`?, `rescheduled_by`? | The new booking by uid; `rescheduledFromUid` must be this booking |
| `cancel-booking` | Cancels a booking; Cal.com emails the attendees and the host | `booking_uid`, `reason`? | The booking; status must be `cancelled` |
| `confirm-booking` | Confirms a booking waiting for the host's confirmation | `booking_uid` | The booking; status must be `accepted` |
| `decline-booking` | Declines a booking waiting for the host's confirmation | `booking_uid`, `reason`? | The booking; status must be `rejected` |
| `mark-attendee-absent` | Marks one attendee of a past booking as a no-show | `booking_uid`, `attendee_email` | The booking; the attendee must be there and an attendee must be absent |
| `mark-host-absent` | Marks the host of a past booking as a no-show | `booking_uid` | The booking; `absentHost` must be true |
| `add-guest` | Adds one guest to a booking; Cal.com emails the guest an invitation | `booking_uid`, `guest_email`, `guest_name`?, `guest_time_zone`? | The booking's attendees; the guest's email must be among them |

## Policies and limits

Every write reaches a person outside the agent: an attendee, a guest or the host gets an email, or a
no-show can start the event type's follow-up workflows. So each write has a suggested approval policy.
Turn on at least the ones for `create-booking`, `cancel-booking` and `reschedule-booking` when the
agent books for people it has not met, and `decline-booking` when it handles requests that need
confirmation.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| calcom: approve creating a booking | Every new booking requires approval |
| calcom: approve rescheduling a booking | Every reschedule requires approval |
| calcom: approve cancelling a booking | Every cancellation requires approval |
| calcom: approve confirming a booking | Every confirmation requires approval |
| calcom: approve declining a booking | Every decline requires approval |
| calcom: approve marking an attendee absent | Every attendee no-show requires approval |
| calcom: approve marking the host absent | Every host no-show requires approval |
| calcom: approve adding a guest | Every added guest requires approval |

The limits are suggestions sized for one person's calendar. A person rarely books, moves or cancels
more than a handful of meetings a day, so 20 a day leaves room for a busy day and stops a loop well
before it fills a calendar or floods inboxes. Confirmations and attendee no-shows come in batches after
a busy day of calls, so they get 50. Change any amount to fit your use.

| Suggested limit (created with `--with-limits`) | Per day |
| --- | --- |
| calcom: bookings created per day | 20 |
| calcom: bookings rescheduled per day | 20 |
| calcom: bookings cancelled per day | 20 |
| calcom: bookings confirmed per day | 50 |
| calcom: bookings declined per day | 20 |
| calcom: attendees marked absent per day | 50 |
| calcom: hosts marked absent per day | 20 |
| calcom: guests added per day | 20 |

## Exercise

`anlyon packs exercise ./packs/calcom` runs every action once against your test account, in the order
of `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `event_type_id` | A test event type of the key's user that books without confirmation: not recurring, not seated, no required custom booking fields |
| `confirmation_event_type_id` | A second test event type with Requires confirmation turned on, with the same restrictions |
| `slots_from`, `slots_to` | Two consecutive dates for `find-available-slots` |
| `start`, `new_start` | Two free UTC start times for `event_type_id` |
| `pending_start`, `second_pending_start` | Two free UTC start times for `confirmation_event_type_id` |
| `attendee_email` | A lowercase inbox you own; Cal.com emails it about each booking |
| `guest_email` | A second lowercase inbox you own |
| `past_booking_uid`, `past_attendee_email` | A past test booking of the key's user and its attendee's email, for the no-show steps |

The run books a meeting, adds a guest, reschedules it and cancels the new booking. It books two
meetings that need confirmation, confirms and cancels one, and declines the other. It marks the past
booking's attendee and host absent; that cannot be undone with this pack. Every booking it makes ends
cancelled or declined, and Cal.com sends its emails for each step to the inboxes you gave.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The key acts as the person who made it.** It can do whatever that Cal.com user can do. Cal.com keys have no scopes.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, reconcile with `list-bookings` before invoking again, or a second meeting can be booked.
- **Cal.com sends its own emails.** Booking, reschedule, cancellation, confirmation, decline and guest invitations go out from Cal.com as soon as the write lands. A cancellation cannot be undone; the attendee has to book again.
- **`create-booking` books one attendee, at a time you supply in UTC.** It cannot fill required custom booking fields, choose a location, or add guests at booking time (use `add-guest` after). For a recurring event type Cal.com books every occurrence and answers with a list, so the read-back cannot run and the impact counts one booking.
- **Recurring and seated bookings.** `cancel-booking` takes the uid of one occurrence; a series uid cancels every occurrence and its read-back fails. A single seat of a seated booking cannot be cancelled or moved, and `add-guest` does not work on seated bookings.
- **Weak read-backs.** `confirm-booking` and `mark-host-absent` also match a booking already in that state. In a booking with several attendees, `mark-attendee-absent` can match when another attendee was marked absent earlier. The read-backs match lowercase emails, so the email inputs must be lowercase.
- **`add-guest`** is rate limited by Cal.com to 5 calls a minute and 30 guests per booking. Its read-back reads the booking's attendees, where Cal.com stores guests; confirm this on the real run.
- **`list-event-types` has no page cursor.** An account with very many event types can be cut at 64 KB; read one with `get-event-type`. `find-available-slots` should ask for a week or less at a time.
- **No-shows are for past bookings.** Marking absent cannot be undone with this pack.
- **Not included.** Creating, changing or deleting event types and schedules, out-of-office entries, booking limits, reserving slots, reassigning hosts, requesting a reschedule from the attendee, changing a booking's location, recordings and transcripts, calendars and conferencing apps, teams, organizations, managed users, OAuth clients, webhooks, API keys, routing forms, insights and billing. These are account setup, team administration or outside the jobs of booking and managing meetings.

## Install

```bash
anlyon packs plan ./packs/calcom
anlyon packs install ./packs/calcom --yes --action find-available-slots --action list-bookings --action get-booking --action create-booking --action cancel-booking
```

Every action sends `{{connection:calcom}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Cal.com account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/calcom`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Cal.com account (`anlyon connections add calcom --secret CALCOM`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name CALCOM=<your secret>`. Do this when the environment has more than one Cal.com account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): nine reads (user, event types, slots, schedules, bookings, attendees) and eight writes (book, reschedule, cancel, confirm, decline, mark attendee or host absent, add a guest). Drafted from Cal.com's OpenAPI spec with `pnpm packs:draft` (`ops.txt`); create, reschedule, cancel and get-event-type were written by hand, because their bodies or path parameter use `oneOf`.

Sources: the Cal.com API v2 OpenAPI spec, https://cal.com/docs/api-reference/v2/openapi.json (fetched 2026-10-24; operations `MeController_getMe`, `EventTypesController_2026_06_12_getEventTypes`, `EventTypesController_2026_06_12_getEventTypeById`, `SlotsController_2024_09_04_getAvailableSlots`, `SchedulesController_2024_06_11_getSchedules`, `SchedulesController_2024_06_11_getSchedule`, `BookingsController_2026_05_01_getBookings`, `BookingsController_2026_02_25_getBooking`, `BookingAttendeesController_2024_08_13_getBookingAttendees`, `BookingsController_2026_02_25_createBooking`, `BookingsController_2026_02_25_rescheduleBooking`, `BookingsController_2026_02_25_cancelBooking`, `BookingsController_2026_02_25_confirmBooking`, `BookingsController_2026_02_25_declineBooking`, `BookingsController_2026_02_25_markNoShow`, `BookingGuestsController_2024_08_13_addGuests`); the reference at https://cal.com/docs/api-reference/v2/introduction; and the booking output in Cal.com's source, https://github.com/calcom/cal.com/blob/main/apps/api/v2/src/platform/bookings/2024-08-13/services/output.service.ts (statuses lowercased, attendees with `absent`, `absentHost`, `rescheduledFromUid`), checked 2026-10-24.
