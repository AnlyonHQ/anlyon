# anlyon/mailchimp

The Mailchimp toolset an agent needs to keep an audience in order for a person: find someone in an
audience, read their profile, tags, notes and activity, add or update them, change their status on
request, tag them, note a conversation, archive them, put them in or take them out of a static
segment, and test, schedule or unschedule a campaign. This is the **catalogue pack** for the
Mailchimp integration: the console offers its actions one by one after you connect Mailchimp ("What
may your agent do here?"), and you can install any subset from the CLI.

Mailchimp is connected with an API key you create, not by signing in. Anlyon checks the key with
Mailchimp before it stores it, and binds it to your account's data center host (`us21.api.mailchimp.com`
for a key ending in `-us21`) in a request header. The agent never holds the key: Anlyon makes every
call. Connect with the key and its data center, the part after the dash at the end of the key.

## API key

Create the key in Mailchimp under your profile, Extras, API keys, Create A Key. A Mailchimp API key
has no permission settings: it can do anything the account can. Create it from a user whose access
fits what your agent should reach, and revoke it in the same place.

## Reads

Reads return Mailchimp's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed and each list asks Mailchimp for the fields it needs. Mailchimp pages with `offset`: add the
page size for the next page, and stop at `total_items`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `mailchimp-list-audiences` | Lists audiences with member and unsubscribe counts. 20 a page | `offset` |
| `mailchimp-get-audience` | Gets one audience: defaults, permission reminder, stats | `list_id` |
| `mailchimp-search-members` | Finds members by email or name, in one audience or all. No next page | `query`, `list_id` |
| `mailchimp-list-members` | Lists an audience's members, most recently changed first. 20 a page | `list_id`, `status`, `offset` |
| `mailchimp-get-member` | Gets one member by email address or member id | `list_id`, `member` |
| `mailchimp-list-member-tags` | Lists a member's tags. 50 a page | `list_id`, `member_id`, `offset` |
| `mailchimp-list-member-notes` | Lists a member's notes, newest first. 10 a page | `list_id`, `member_id`, `offset` |
| `mailchimp-get-member-activity` | Gets a member's recent opens, clicks, bounces and other events. 20 a page | `list_id`, `member_id`, `activity_filters`, `offset` |
| `mailchimp-list-segments` | Lists segments and tags with member counts. 20 a page | `list_id`, `type`, `offset` |
| `mailchimp-list-segment-members` | Lists the members of one segment or tag. 20 a page | `list_id`, `segment_id`, `offset` |
| `mailchimp-list-campaigns` | Lists campaigns, newest first, with recipient counts. 10 a page | `status`, `list_id`, `offset` |
| `mailchimp-get-campaign` | Gets one campaign: settings, recipients, send time, report summary | `campaign_id` |

`member_id` is the member's `id` from `get-member`, `search-members` or `list-members`: 32 hex
characters, the MD5 hash of the lowercase email address. `get-member` also takes the email address.

## Writes

Each write declares its impact, counts against its limit, can be put behind an approval policy, and
gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `mailchimp-upsert-member` | Adds a person to an audience, or updates their name if they are in it. A new member gets `status_if_new`; an existing member keeps their status | `list_id`, `email`, `status_if_new`, `first_name`, `last_name` | The member by id; it must be in this audience |
| `mailchimp-update-member-name` | Replaces a member's first and last name | `list_id`, `member_id`, `first_name`, `last_name` | The member; `FNAME` and `LNAME` must match |
| `mailchimp-set-member-status` | Sets a member to `unsubscribed`, `pending` or `subscribed` | `list_id`, `member_id`, `status` | The member; the status must match |
| `mailchimp-add-member-tag` | Adds one tag to a member | `list_id`, `member_id`, `tag` | The member's tags; the tag must be among them |
| `mailchimp-remove-member-tag` | Removes one tag from a member | `list_id`, `member_id`, `tag` | The member's tags; the tag must be gone |
| `mailchimp-add-member-note` | Adds one internal note to a member | `list_id`, `member_id`, `note` | The note by id; the text must match |
| `mailchimp-archive-member` | Archives a member; their history is kept | `list_id`, `member_id` | The member; the status must be `archived` |
| `mailchimp-add-to-segment` | Adds a member to a static segment or tag | `list_id`, `segment_id`, `email` | The member's tags; the segment's id must be among them |
| `mailchimp-remove-from-segment` | Removes a member from a static segment or tag | `list_id`, `segment_id`, `member_id` | The member's tags; the segment's id must be gone |
| `mailchimp-send-test-email` | Sends a test of a campaign to the addresses given. Counted in emails, one per address | `campaign_id`, `test_emails`, `send_type` | none: Mailchimp answers 204 and keeps no record of a test to read |
| `mailchimp-schedule-campaign` | Schedules a draft campaign to its whole audience | `campaign_id`, `schedule_time` | The campaign; the status must be `schedule` |
| `mailchimp-unschedule-campaign` | Unschedules a campaign, back to a draft | `campaign_id` | The campaign; the status must no longer be `schedule` |

Every write except `send-test-email` counts one resource mutation. `send-test-email` counts one email
per address in `test_emails`, as an upper bound: Mailchimp can refuse a test once the account's daily
test allowance is used.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| mailchimp: approve adding a new member as subscribed | An `upsert-member` call with `status_if_new` of `subscribed` requires approval |
| mailchimp: approve changing a member's status | Every `set-member-status` call requires approval |
| mailchimp: approve archiving a member | Every archive requires approval |
| mailchimp: approve sending a campaign test | Every test send requires approval |
| mailchimp: approve scheduling a campaign | Every schedule requires approval |

Adding someone as `subscribed` skips Mailchimp's confirmation email, so it is the case a person should
see; `pending` and `transactional` go through without the policy. A status change is the member's
consent: narrow that policy to `input.status != 'unsubscribed'` if your agent should honour
unsubscribe requests without waiting. Scheduling sends a campaign to a whole audience, so its policy
has no condition.

| Suggested limit (created only with `--with-limits`) | Unit | Per day |
| --- | --- | --- |
| mailchimp: members added or updated per day | resource mutations | 200 |
| mailchimp: member names updated per day | resource mutations | 200 |
| mailchimp: member statuses changed per day | resource mutations | 50 |
| mailchimp: member tags added per day | resource mutations | 300 |
| mailchimp: member tags removed per day | resource mutations | 100 |
| mailchimp: member notes per day | resource mutations | 300 |
| mailchimp: members archived per day | resource mutations | 20 |
| mailchimp: segment members added per day | resource mutations | 200 |
| mailchimp: segment members removed per day | resource mutations | 100 |
| mailchimp: test emails per day | emails | 20 |
| mailchimp: campaigns scheduled per day | resource mutations | 3 |
| mailchimp: campaigns unscheduled per day | resource mutations | 10 |

These amounts are suggestions for an agent that looks after people one at a time, not one that runs
imports. They sit above a normal day of that work, so a loop or a misread instruction hits them
early. Removals, archives and status changes are lower than additions because they are harder to put
right. Campaign schedules are the lowest because each one mails a whole audience. Change any of them
to fit your use.

## Exercise

`anlyon packs exercise ./packs/mailchimp --need list_id=<id> --need member_email=<address> --need segment_id=<id> --need campaign_id=<id> --need schedule_time=<time>`
runs every action once, in the order of `exercise.json`, against your Mailchimp account.

| Need | What to give |
| --- | --- |
| `list_id` | The id of an audience you test with |
| `member_email` | An address you own that may join that audience |
| `segment_id` | The numeric id of a tag in that audience that is safe to put on the test member |
| `campaign_id` | The id of a draft campaign to that audience |
| `schedule_time` | A UTC time on the quarter hour at least an hour ahead, such as `2026-11-03T15:30:00Z` |

The run adds `member_email` as a transactional member, renames, tags, notes and segments it, sets it
to unsubscribed and archives it at the end. It sends one campaign test to `member_email`, then
schedules the campaign and unschedules it straight away. Nothing it did not create is changed, apart
from the campaign's schedule, which it puts back. Turn the policies off (or approve them) for the
run, or it stops at the first one.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **One data center per key.** Every call goes to `<dc>.api.mailchimp.com`, the host Mailchimp's
  fundamentals page gives. Mailchimp refuses a key on any other data center's host, so the data
  center given at connect must be the one at the end of the key.
- **A key reaches the whole account.** Mailchimp API keys have no permission settings.
- **Upserts never change consent.** `upsert-member` sets `status_if_new` only, so an existing member
  keeps their status. Use `set-member-status` for that. Mailchimp refuses `subscribed` for someone who
  unsubscribed themselves; `pending` sends them the opt-in email instead.
- **Names are the FNAME and LNAME merge fields.** An audience that renamed or removed them refuses
  the name in `upsert-member` and `update-member-name`. Other merge fields need an action you declare.
- **Static segments only.** `add-to-segment` and `remove-from-segment` work on static segments and
  tags. Their read-back uses the member's tags, because Mailchimp keeps a static segment as a tag, and
  sees the first 100 tags.
- **The upsert read-back shows membership.** It proves the person is in this audience; it does not
  check the name, which `update-member-name` reads back.
- **Test sends are acknowledged.** Mailchimp keeps no record of a test send to read back.
- **Scheduling is not counted in people.** The number of recipients is not in the request, so a
  limit counts schedules, not emails. Check `recipients.recipient_count` with `get-campaign`, and keep
  the approval policy on.
- **No idempotency on notes.** A retry of `add-member-note` after an unknown outcome can add the note
  twice. Tags, segments, status and archive land in the same state when repeated.
- **`search-members` has no next page.** Mailchimp answers exact matches and a fuller search in one
  response.

## Install

```bash
anlyon packs plan ./packs/mailchimp
anlyon packs install ./packs/mailchimp --yes --action search-members --action get-member --action add-member-note
```

Every action sends `{{connection:mailchimp}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Mailchimp account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/mailchimp`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Mailchimp account (`anlyon connections add mailchimp --secret MAILCHIMP`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name MAILCHIMP=<your secret>`. Do this when the environment has more than one Mailchimp account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: audiences, members, tags, notes, activity, segments and campaigns
  as reads; member upserts, names, status, tags, notes, archives and static segments, campaign tests
  and schedules as governed writes.

## Left out

- **Sending a campaign now** (`actions/send`): it mails a whole audience at once, cannot be undone,
  and its recipient count is not in the request. Schedule it instead; it can be unscheduled.
- **Permanent delete** (`actions/delete-permanent`): it erases a member and their history for good.
  Archive keeps the history and can be undone.
- Account administration, API keys, webhooks, authorized apps, verified domains, batch operations,
  file uploads, e-commerce stores, campaign content editing, and creating audiences or campaigns.

## Sources

Mailchimp Marketing API, checked 2026-10-24:

- OpenAPI description (3.1.1; server `https://api.mailchimp.com`, Bearer API key):
  https://api.mailchimp.com/schema/openapi/OpenAPI.json
- Fundamentals: https://mailchimp.com/developer/marketing/docs/fundamentals/
- Quick start: https://mailchimp.com/developer/marketing/guides/quick-start/
- API keys: https://mailchimp.com/help/about-api-keys/
- Operations used, by operationId: `getLists`, `getListsId`, `getSearchMembers`, `getListsIdMembers`,
  `getListsIdMembersId`, `getListMemberTags`, `getListsIdMembersIdNotes`,
  `getListsIdMembersIdActivityFeed`, `previewASegment`, `getListsIdSegmentsIdMembers`, `getCampaigns`,
  `getCampaignsId`, `putListsIdMembersId`, `patchListsIdMembersId`, `postListMemberTags`,
  `postListsIdMembersIdNotes`, `getListsIdMembersIdNotesId`, `deleteListsIdMembersId`,
  `postListsIdSegmentsIdMembers`, `deleteListsIdSegmentsIdMembersId`, `postCampaignsIdActionsTest`,
  `postCampaignsIdActionsSchedule`, `postCampaignsIdActionsUnschedule`
