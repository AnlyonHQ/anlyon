# anlyon/zendesk

The Zendesk Support toolset an agent needs for tickets: find and read them, read their comments, look
up the requester, reply, add internal notes, set status and priority, assign and tag. This is the
**catalogue pack** for the Zendesk integration: the console offers its actions one by one after you
connect Zendesk ("What may your agent do here?"), and you can install any subset from the CLI.

Zendesk is connected with your subdomain, an agent's email and an API token, not by signing in.
Anlyon checks them with Zendesk before it stores them, sends them as HTTP Basic
(`{email}/token:{apiToken}`) in the `Authorization` header, and sends them to
`{subdomain}.zendesk.com` and nowhere else. The agent never holds the token: Anlyon makes every call.

## API token and agent

An admin turns on API token access and adds an API token in Admin Center, Apps and integrations,
APIs, API tokens. A token has no scopes and is not tied to one user: any verified user's email works
with it, and Zendesk warns that a token can be used to impersonate anyone in the account, including
admins. Each call acts as the agent whose email it is sent with, with that agent's role, groups and
ticket access. Connect the email of an agent who can see and edit the tickets your agent should
reach. A call on a ticket that agent cannot see or edit is refused by Zendesk. An end user's email
does not fit: the ticket lists, the search and the updates are for agents.

Zendesk is removing API tokens as an authentication method. Since July 28, 2026 a token unused for
30 days is deleted automatically, and by April 30, 2027 every API token stops working. Zendesk asks
integrations to move to OAuth access tokens. This pack connects with an API token only.

## Reads

Reads return Zendesk's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed. Lists page with a cursor: when `meta.has_more` is true, pass `meta.after_cursor` as `cursor`.
The two searches page by number: pass `page`, and stop when `next_page` is null.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `zendesk-search-tickets` | Searches tickets with Zendesk's search syntax (`type:ticket` is added). 10 a page | `query`, `sort_by`, `sort_order`, `page` |
| `zendesk-list-tickets` | Lists the account's tickets, by id or by `sort`. 10 a page | `sort`, `cursor` (both optional) |
| `zendesk-get-ticket` | Gets one ticket with its status, priority, people, group, tags and custom fields | `ticket_id` |
| `zendesk-list-ticket-comments` | Lists a ticket's comments, public replies and internal notes. 10 a page | `ticket_id`, `sort`, `cursor` |
| `zendesk-list-user-tickets` | Lists the tickets one user requested. 10 a page | `user_id`, `cursor` |
| `zendesk-search-users` | Finds customers and agents by name, email or search syntax. 20 a page | `query`, `page` |
| `zendesk-get-user` | Gets one user: name, email, role, organization, tags | `user_id` |
| `zendesk-list-groups` | Lists agent groups. 50 a page | `cursor` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `zendesk-create-ticket` | Creates one ticket with a subject and an opening comment | `subject`, `body` and any of `public`, `requester_id` or `requester`, `priority`, `type`, `group_id`, `assignee_id`, `tags` | The ticket by id; the subject must match |
| `zendesk-reply-to-ticket` | Adds a public reply, which the account's triggers can email to the requester | `ticket_id`, `body` | The ticket's newest comment; it must belong to this update's audit and be public |
| `zendesk-add-internal-note` | Adds an internal note that agents see and the requester does not | `ticket_id`, `body` | The ticket's newest comment; it must belong to this update's audit and not be public |
| `zendesk-set-ticket-status` | Sets the status to open, pending, hold or solved | `ticket_id`, `status` | The ticket; `status` must match |
| `zendesk-set-ticket-priority` | Sets the priority to low, normal, high or urgent | `ticket_id`, `priority` | The ticket; `priority` must match |
| `zendesk-assign-ticket` | Assigns the ticket to an agent, optionally in another group | `ticket_id`, `assignee_id`, `group_id` | The ticket; `assignee_id` must match |
| `zendesk-add-ticket-tags` | Adds one tag; the other tags stay | `ticket_id`, `tag` | The ticket's tags; the tag must be among them |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| zendesk: approve replying to a requester | Every public reply requires approval. A reply can be emailed to the customer, so turn it on while you review what your agent writes |
| zendesk: approve creating a ticket | Every new ticket requires approval. A public opening comment can be emailed to the requester, and an unknown requester email creates an end user |
| zendesk: approve solving a ticket | Setting a ticket to solved requires approval (`input.status == 'solved'`); open, pending and hold do not. Solving can email the requester, and Zendesk later closes a solved ticket, after which it cannot be changed |

Suggested limits are created with `--with-limits`, and printed otherwise. Each counts one write action per day. The
amounts suit one support team's normal day of use: notes, status changes and tags more often than
new tickets. Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| zendesk: tickets created per day | 50 |
| zendesk: public replies per day | 200 |
| zendesk: internal notes per day | 300 |
| zendesk: status changes per day | 300 |
| zendesk: priority changes per day | 200 |
| zendesk: assignments per day | 200 |
| zendesk: tags added per day | 300 |

## Exercise

`anlyon packs exercise ./packs/zendesk --need agent_email=<the connected agent's email>` runs every
action once, in the order of `exercise.json`, against your Zendesk account. Use a sandbox or trial
account.

The run creates one low-priority task ticket (`Anlyon exercise <run>`) with the connected agent as
its requester and an internal opening comment, so no customer is emailed. It adds an internal note
and a public reply (sent to that agent, if your triggers email requesters), sets the priority to
high, adds the tag `anlyon_exercise_tagged`, assigns the ticket to the agent, reads the agent's user
record and requested tickets, and sets the ticket to solved. The pack has no action that deletes a
ticket: Zendesk closes the solved ticket by its own automations, or delete it in Zendesk afterwards.
The search step may find nothing for a few minutes after the ticket is created; it still succeeds.
Nothing it did not create is changed. Turn the policies off (or approve them) for the run, or it
stops at the policy it meets.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as one agent.** A Zendesk API token has no scopes. What the agent can see and
  change is what the agent whose email it is sent with can.
- **Replies reach customers through triggers.** Zendesk emails a public reply, a public opening
  comment or a solved ticket when the account's triggers say so (the default triggers do). Anlyon
  cannot see what a trigger sent, and a trigger can also change a ticket's status, priority or tags
  after the update, so the read-back can disagree with the request.
- **Comment read-backs look at the newest comment.** `reply-to-ticket` and `add-internal-note` read
  the ticket's newest comment and check that it belongs to the audit Zendesk returned for this update.
  If another comment lands on the ticket in between, the receipt stays unconfirmed.
- **Closed tickets.** A closed ticket cannot be reopened, and most of its fields cannot be changed.
  `add-ticket-tags` uses Zendesk's tags endpoint, which never works on a closed ticket. An admin can
  allow changes to a closed ticket's subject, priority, tags and some custom fields; it stays closed.
  Make a follow-up ticket instead.
- **Removing a tag is not offered.** Zendesk removes tags with a `DELETE` that carries the tags in
  its body, and Anlyon sends no body with a `DELETE`. Replacing every tag is left out because one
  wrong call would drop tags the agent never saw. Remove a tag in Zendesk.
- **No idempotency.** A retry of `create-ticket`, `reply-to-ticket` or `add-internal-note` after an
  unknown outcome can create or send a second one.
- **Search.** `search-tickets` returns at most 1000 results a query and can lag behind recent
  changes by a few minutes. `list-tickets` leaves out archived tickets (in most accounts, tickets
  closed for 120 days); `list-user-tickets` and search include them.
- **Standard fields.** Custom fields, custom ticket statuses, ticket forms, CCs and followers are
  returned by the reads but not set by the writes. Attachments are not offered (uploads are
  multipart).
- **Plain text comments.** Comments are sent as plain text (`body`); HTML replies are not offered.
- **Rate limits.** Zendesk limits requests per minute by plan and answers `429` with `Retry-After`
  when the limit is reached.
- **Tag collisions.** Zendesk documents that two updates to one ticket at the same moment can lose
  tags. `add-ticket-tags` does not send Zendesk's safe-update stamp; its read-back shows a lost tag.
- **Left out:** deleting, merging and spam-marking tickets, creating or editing users, organizations,
  groups and memberships, macros, views, triggers and automations, satisfaction ratings, side
  conversations, Help Center, and every account, webhook and API token setting.

## Install

```bash
anlyon packs plan ./packs/zendesk
anlyon packs install ./packs/zendesk --yes --action search-tickets --action get-ticket --action add-internal-note
```

Every action sends `{{connection:zendesk}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Zendesk account. Store their own subdomain, agent email and token with `PUT /api/v2/end-users/{endUserId}/connections/zendesk`, with `fields`: `subdomain`, `email` and `apiToken`. A user with no account stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Zendesk account (`anlyon connections add zendesk --secret ZENDESK`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name ZENDESK=<your secret>`. Do this when the environment has more than one Zendesk account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: search and read tickets, comments, requested tickets, users and
  groups; create tickets, reply publicly, add internal notes, set status and priority, assign and add
  tags, as governed writes.

## Sources

Zendesk Support (Ticketing) API, checked 2026-11-22.

- The Support API OpenAPI description: https://developer.zendesk.com/zendesk/oas.yaml
- Tickets: https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
- Ticket comments: https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/
- Search: https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/
- Tags: https://developer.zendesk.com/api-reference/ticketing/ticket-management/tags/
- Users: https://developer.zendesk.com/api-reference/ticketing/users/users/
- Groups: https://developer.zendesk.com/api-reference/ticketing/groups/groups/
- Cursor pagination: https://developer.zendesk.com/api-reference/introduction/pagination/
- Authentication with `{email}/token:{api_token}` in HTTP Basic:
  https://developer.zendesk.com/api-reference/introduction/security-and-auth/
- Rate limits and `Retry-After`: https://developer.zendesk.com/api-reference/introduction/rate-limits/
- API tokens, and their removal: https://support.zendesk.com/hc/en-us/articles/4408889192858
- Closed tickets: https://support.zendesk.com/hc/en-us/articles/7335734335258
- Archived tickets: https://support.zendesk.com/hc/en-us/articles/4408887617050
