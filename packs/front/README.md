# anlyon/front

The Front toolset an agent needs for shared inboxes: find a conversation, read its messages and
comments, reply or draft a reply, leave an internal comment, assign, archive, reopen and tag it, and
find, create and update the contacts behind it. This is the **catalogue pack** for the Front
integration: the console offers its actions one by one after you connect Front ("What may your
agent do here?"), and you can install any subset from the CLI.

Front is connected with an API token you create, not by signing in. Anlyon checks the token with
Front before it stores it, and binds it to `api2.frontapp.com` in a request header. The agent never
holds the token: Anlyon makes every call.

## API token permissions

A Front admin creates the token under Settings, Developers, API Tokens. A token without these is
accepted at connect and refused when an operation runs.

| In Front | Choose | Needed by |
| --- | --- | --- |
| Namespace: Global resources | on | `list-teammates`, `list-tags`, every contact operation |
| Namespace: Shared resources | the workspaces your agent works in, or All shared workspaces | Every conversation, message, comment, inbox and channel operation |
| Namespace: Private resources | only if your agent works in teammates' own inboxes | The same, for private inboxes |
| Permission: Read | on | Every read, and every read-back |
| Permission: Write | on | Every write except `reply-to-conversation` |
| Permission: Send | on | `reply-to-conversation` |
| Permission: Delete | off | Nothing in this pack deletes |

Installing only some actions needs only their permissions: for example, the reads and
`add-comment` alone need Read and Write, and no Send.

## Reads

Reads return Front's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed. Front pages with a token: when `_pagination.next` is set, pass the `page_token` value from
that URL as `page_token`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `front-search-conversations` | Searches conversations with Front's search syntax (`is:open inbox:inb_123`, `from:pam@example.com`). 10 a page | `query`, `page_token` |
| `front-get-conversation` | Gets one conversation: status, assignee, recipient, tags | `conversation_id` |
| `front-list-conversation-messages` | Lists a conversation's messages, newest first, with bodies. 5 a page | `conversation_id`, `page_token` |
| `front-get-message` | Gets one message with its body | `message_id` |
| `front-list-conversation-comments` | Lists a conversation's internal comments. Front returns them all in one response | `conversation_id` |
| `front-list-inboxes` | Lists the inboxes the token can see | none |
| `front-list-channels` | Lists the channels (addresses) the token can see. A draft needs a channel id | none |
| `front-list-teammates` | Lists the company's teammates, for assigning and for writing as one | none |
| `front-list-tags` | Lists the tags the token can see. 50 a page | `page_token` |
| `front-get-contact` | Gets one contact by id: name, description, handles, lists | `contact_id` |
| `front-find-contact-by-email` | Gets the contact with this email address; 404 when there is none | `email` |
| `front-list-contact-conversations` | Lists one contact's conversations, newest first. 10 a page | `contact_id`, `page_token` |
| `front-list-contact-notes` | Lists the notes on a contact | `contact_id` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `front-reply-to-conversation` | Sends a reply to the conversation's current recipients, from its channel, optionally as a teammate. It does not archive the conversation | `conversation_id`, `body`, `author_id` | The message by the uid Front returns; it must exist and be outbound |
| `front-create-draft-reply` | Creates a shared draft reply from one channel. Nothing is sent | `conversation_id`, `channel_id`, `body`, `author_id` | The conversation's drafts; the draft's id must be among them |
| `front-add-comment` | Adds an internal comment. The customer never sees it | `conversation_id`, `body`, `author_id` | The comment by id; the body must match |
| `front-assign-conversation` | Assigns a conversation to one teammate | `conversation_id`, `assignee_id` | The conversation; `assignee.id` must be that teammate |
| `front-unassign-conversation` | Removes the assignee | `conversation_id`, `assignee_id` (the current one) | The conversation; that teammate must no longer be the assignee |
| `front-archive-conversation` | Archives a conversation | `conversation_id` | The conversation; `status` must be `archived` |
| `front-reopen-conversation` | Reopens an archived conversation | `conversation_id` | The conversation; `status` must no longer be `archived` |
| `front-tag-conversation` | Adds one existing tag; the other tags stay | `conversation_id`, `tag_id` | The conversation; the tag must be among its tags |
| `front-create-contact` | Creates a contact with a name and one email address | `name`, `email`, `description` | The contact by id; the name and the email handle must match |
| `front-rename-contact` | Replaces a contact's name | `contact_id`, `name` | The contact; the name must match |
| `front-set-contact-description` | Replaces a contact's description | `contact_id`, `description` | The contact; the description must match |
| `front-add-contact-note` | Adds a note to a contact, as one teammate | `contact_id`, `author_id`, `body` | none: Front returns the note without an id. Check with `list-contact-notes` |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| front: approve replying to a customer | Every reply waits for a person. Turn it on while you build trust in what the agent writes; `create-draft-reply` lets a teammate review and send in Front instead |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| front: replies sent per day | 100 |
| front: draft replies per day | 200 |
| front: comments per day | 300 |
| front: conversations assigned per day | 300 |
| front: conversations unassigned per day | 100 |
| front: conversations archived per day | 300 |
| front: conversations reopened per day | 100 |
| front: conversation tags added per day | 300 |
| front: contacts created per day | 100 |
| front: contacts renamed per day | 100 |
| front: contact descriptions set per day | 100 |
| front: contact notes per day | 200 |

The amounts are starting points for one agent working one team's inboxes, set above a normal day so
that only a loop or a misread instruction reaches them. Replies are set below drafts and comments
because a customer receives each one. Change them to your own volume.

## Exercise

`anlyon packs exercise ./packs/front --need conversation_id=<cnv_...> --need teammate_id=<tea_...> --need channel_id=<cha_...> --need tag_id=<tag_...>`
runs every action once, in the order of `exercise.json`, against your Front company.

| Need | What to give |
| --- | --- |
| `conversation_id` | An open conversation that is safe to reply to: one you sent from your own address to a shared inbox |
| `teammate_id` | Your own teammate id (`list-teammates` shows it) |
| `channel_id` | The channel that conversation came in on (`list-channels` shows it) |
| `tag_id` | A tag that is safe to put on that conversation (`list-tags` shows it) |

The run comments on the conversation, assigns and unassigns you, tags it, creates a draft, sends one
test reply to its recipients, then archives and reopens it. It creates a contact
(`anlyon-exercise-<run>@example.com`), renames it, sets its description and adds a note. It cannot
clean up after itself: this pack has no delete or untag action, so remove the comment, the tag, the
draft and the contact in Front afterwards. Turn the reply policy off (or approve the reply) for the
run, or it stops there.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Replies are accepted, then created.** Front answers a reply with `202` and a message uid, and
  creates the message a moment later. The read-back looks the message up by that uid; until Front has
  created it, the receipt stays unconfirmed and the read-back is repeated.
- **Replies go to the conversation's recipients.** Recipients, cc, bcc, subject, signature and
  attachments cannot be set. Replying never archives the conversation (Front's own default would).
- **No idempotency.** A retry of `reply-to-conversation`, `create-draft-reply`, `add-comment` or
  `add-contact-note` after an unknown outcome can send or add a second one. `create-contact` is
  refused by Front for an email address another contact has, which makes its retry safe.
- **Removing a tag is not offered.** Front takes the tag ids to remove in the body of a `DELETE`, and
  Anlyon sends no body with a `DELETE`. Replacing every tag (`PATCH` with `tag_ids`) is left out
  because one wrong call would drop tags the agent never saw. Remove a tag in Front.
- **Contact notes are not read back.** Front returns a note without an id, so a receipt for
  `add-contact-note` is graded acknowledged.
- **Unassigning takes the current assignee.** The read-back checks that teammate is gone, so pass
  `assignee.id` from `get-conversation`.
- **Whole lists.** Front returns inboxes, channels, teammates, comments and contact notes in one
  response. A very large company's list can be cut at 64 KB.
- **Search is Front's.** `query` is passed to Front as given; see Front's search syntax. Front limits
  search to a share of the company's rate limit.
- **Merged conversations.** Front answers a merged conversation's id with a redirect to the
  conversation it was merged into.
- **Left out:** deleting conversations and contacts, merging contacts, contact lists and groups,
  links, followers, reminders, custom fields, creating new conversations, attachments (multipart),
  and every teammate, inbox, channel, rule, webhook and analytics setting.

## Install

```bash
anlyon packs plan ./packs/front
anlyon packs install ./packs/front --yes --action search-conversations --action get-conversation --action add-comment
```

Every action sends `{{connection:front}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Front account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/front`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Front account (`anlyon connections add front --secret FRONT`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name FRONT=<your secret>`. Do this when the environment has more than one Front account. A call made for one of your users still uses their own account.

Then review and enable the policy. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: conversation search and reads, messages, comments, inboxes,
  channels, teammates, tags and contacts; replies, drafts, comments, assignment, archive and reopen,
  tags and contacts as governed writes.

## Sources

Front Core API, checked 2026-10-24:

- OpenAPI description (core-api/core-api.json, fetched 2026-10-24):
  https://raw.githubusercontent.com/frontapp/front-api-specs/main/core-api/core-api.json
- Conversations: https://dev.frontapp.com/reference/search-conversations,
  https://dev.frontapp.com/reference/get-conversation-by-id,
  https://dev.frontapp.com/reference/update-conversation,
  https://dev.frontapp.com/reference/update-conversation-assignee,
  https://dev.frontapp.com/reference/add-conversation-tag,
  https://dev.frontapp.com/reference/remove-conversation-tag
- Messages and drafts: https://dev.frontapp.com/reference/list-conversation-messages,
  https://dev.frontapp.com/reference/get-message,
  https://dev.frontapp.com/reference/create-message-reply,
  https://dev.frontapp.com/reference/create-draft-reply,
  https://dev.frontapp.com/reference/list-conversation-drafts
- Comments: https://dev.frontapp.com/reference/list-conversation-comments,
  https://dev.frontapp.com/reference/add-comment,
  https://dev.frontapp.com/reference/get-comment
- Inboxes, channels, teammates, tags: https://dev.frontapp.com/reference/list-inboxes,
  https://dev.frontapp.com/reference/list-channels,
  https://dev.frontapp.com/reference/list-teammates,
  https://dev.frontapp.com/reference/list-tags
- Contacts: https://dev.frontapp.com/reference/get-contact,
  https://dev.frontapp.com/reference/create-contact,
  https://dev.frontapp.com/reference/update-a-contact,
  https://dev.frontapp.com/reference/list-contact-conversations,
  https://dev.frontapp.com/reference/list-notes,
  https://dev.frontapp.com/reference/add-note
- Guides: https://dev.frontapp.com/docs/search-1,
  https://dev.frontapp.com/docs/pagination,
  https://dev.frontapp.com/docs/resource-aliases-1,
  https://dev.frontapp.com/docs/create-and-revoke-api-tokens
