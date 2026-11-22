# anlyon/intercom

A support agent's Intercom toolset. This is the **catalogue pack** for the Intercom integration: the
console offers its actions one by one after you connect Intercom ("What may your agent do here?"),
and you can install any subset from the CLI. Anlyon holds the access token and makes every call; the
agent never sees it.

Intercom is connected with an access token from a Developer Hub app, not by signing in. Anlyon checks
the token with Intercom before it stores it, and binds it to `api.intercom.io` in a request header.
Every request sends `Intercom-Version: 2.11` (released 2024; not retired, see Limitations).

## Reads

Reads return Intercom's response to the agent (cut at 64 KB), are logged, and can be put under an
approval or deny policy. They have no limit and no receipt. Installed as `intercom-<name>`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `search-contacts` | Search contacts with an Intercom query (POST; changes nothing). 15 per page | `query`, `starting_after` | none |
| `list-contacts` | List contacts, 15 per page | `starting_after` | none |
| `get-contact` | One contact: role, email, name, phone, custom attributes, first tags/notes/companies | `contact_id` | none |
| `list-tags` | Every tag in the workspace (id, name); no paging | none | none |
| `search-conversations` | Search conversations with an Intercom query (POST; changes nothing). 10 per page, without parts | `query`, `starting_after` | none |
| `list-conversations` | List conversations, 10 per page, without parts | `starting_after` | none |
| `get-conversation` | One conversation with up to its 500 most recent parts, as plain text | `conversation_id` | none |
| `list-admins` | Every teammate: id, name, email, away mode, team ids; no paging | none | none |
| `get-admin` | One teammate, with the ids of their teams | `admin_id` | none |
| `list-teams` | Every team: id, name, member admin ids; no paging | none | none |
| `list-companies` | List companies, 20 per page (POST; changes nothing) | `page` | none |
| `get-company` | One company by its Intercom id | `company_id` | none |
| `search-articles` | Help Center articles matching a phrase: up to 10, with bodies | `phrase`, `state`, `help_center_id` | none |
| `get-article` | One Help Center article | `article_id` | none |

Paging: the search and list actions for contacts and conversations return `pages.next.starting_after`;
pass it back as `starting_after`. `list-companies` pages by number (`page`, from 1; the response gives
`pages.total_pages`). `list-tags`, `list-admins` and `list-teams` return everything at once.

## Writes

Every write declares an impact of 1 resource mutation, counts against its daily limit, can be put
under an approval policy, and leaves a receipt. With a read-back the receipt can be graded
`confirmed`; without one it is `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-contact` | Create a lead or user with an email and a name | `role`, `email`, `name` | The contact by id; `email` must match |
| `update-contact` | Change name, email, phone, external id or custom attributes | `contact_id`, any of `name`, `email`, `phone`, `external_id`, `custom_attributes` | The contact by id; `name`, `email`, `phone` must equal Intercom's answer to the update |
| `tag-contact` | Add an existing tag to a contact | `contact_id`, `tag_id` | The contact's tags; the tag must be among them |
| `untag-contact` | Remove a tag from a contact | `contact_id`, `tag_id` | The contact's tags; the tag must no longer be among them |
| `attach-contact-to-company` | Attach a contact to a company | `contact_id`, `company_id` | The contact's first 50 companies; the company must be among them |
| `detach-contact-from-company` | Detach a contact from a company | `contact_id`, `company_id` | The contact's first 50 companies; the company must no longer be among them |
| `delete-contact` | Permanently delete a contact | `contact_id` | none: Intercom documents no answer for a deleted contact |
| `create-conversation` | Start a conversation as a message from a contact | `from_type`, `contact_id`, `body` | The new conversation; its contact must be this contact |
| `reply-to-conversation` | Reply to the customer, as an admin (customer-facing) | `conversation_id`, `admin_id`, `body` | none: the reply is stored as HTML, which cannot be compared with the text sent |
| `add-conversation-note` | Add an internal note, as an admin | `conversation_id`, `admin_id`, `body` | none: the note is stored as HTML, which cannot be compared with the text sent |
| `assign-conversation` | Assign to a teammate | `conversation_id`, `admin_id`, `assignee_id` (number) | The conversation; `admin_assignee_id` must equal `assignee_id` |
| `assign-conversation-to-team` | Assign to a team | `conversation_id`, `admin_id`, `team_id` (number) | The conversation; `team_assignee_id` must equal `team_id` |
| `snooze-conversation` | Snooze until a Unix time | `conversation_id`, `admin_id`, `snoozed_until` | The conversation; `state` is `snoozed` and `snoozed_until` matches |
| `close-conversation` | Close a conversation | `conversation_id`, `admin_id` | The conversation; `state` must be `closed` |
| `reopen-conversation` | Reopen a closed or snoozed conversation | `conversation_id`, `admin_id` | The conversation; `state` must be `open` |
| `tag-conversation` | Add an existing tag to a conversation, as an admin | `conversation_id`, `tag_id`, `admin_id` | The conversation; the tag must be among its tags |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| intercom: approve closing a conversation | Every close requires approval |
| intercom: approve deleting a contact | Every contact deletion requires approval |
| intercom: approve replying to a customer | Every customer-facing reply requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| intercom: contacts created per day | 100 |
| intercom: contacts updated per day | 200 |
| intercom: contact tags added per day | 200 |
| intercom: contact tags removed per day | 200 |
| intercom: contacts attached to companies per day | 100 |
| intercom: contacts detached from companies per day | 100 |
| intercom: contacts deleted per day | 20 |
| intercom: conversations started per day | 50 |
| intercom: conversation replies per day | 200 |
| intercom: conversation notes per day | 300 |
| intercom: conversations assigned to a teammate per day | 300 |
| intercom: conversations assigned to a team per day | 300 |
| intercom: conversations snoozed per day | 200 |
| intercom: conversations closed per day | 200 |
| intercom: conversations reopened per day | 200 |
| intercom: conversation tags added per day | 300 |

## Exercise

`anlyon packs exercise ./packs/intercom` runs `exercise.json` against your workspace: it creates a lead
(`anlyon-exercise-<run>@example.com`) and a conversation from that lead, runs every action on them, and
ends by closing the conversation and deleting the lead. The reply goes to that test lead only. Tagging
and company attachment are undone in the run, except the conversation's tag (the pack has no untag for
conversations), which stays on the closed test conversation.

| `--need` | What to give |
| --- | --- |
| `admin_id` | Your own teammate id (`list-admins`). Conversation steps are recorded as you. You must belong to at least one team: the run reads your first team from `get-admin` and assigns the test conversation to it |
| `tag_id` | A tag that is safe to put on a test contact and conversation (`list-tags`) |
| `company_id` | The Intercom id (24 characters) of a company that has at least one contact (`list-companies`) |
| `article_phrase` | A word from the title of one published Help Center article |

The first team `list-teams` returns must have at least one teammate: the run assigns the test
conversation to that teammate.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **US workspaces only.** The token is bound to `api.intercom.io`. A workspace hosted in the EU or
  Australia uses another host and cannot be connected yet.
- **API version 2.11.** It is not retired (Intercom lists no retirement date for it); 2.17 is current.
  The pack stays on 2.11 so the existing actions keep their meaning.
- **The token's app needs permissions** to read and write users and companies, conversations and tags,
  and to read admins, teams and Help Center articles. A missing permission answers 401 or 403.
- **No read-back for replies, notes or deletion.** Intercom stores reply and note text as HTML, which
  cannot be compared exactly with the text sent, and documents no answer for reading a deleted contact,
  so their receipts are `acknowledged`.
- **The company read-backs see a contact's first 50 companies.** For a contact with more,
  `attach-contact-to-company` can miss the company and fail, and `detach-contact-from-company` can pass
  without having seen it.
- **`update-contact` checks Intercom's own answer.** Its inputs are all optional, so the read-back
  compares the stored name, email and phone with what Intercom returned for the update, not with the
  input. Custom attributes are not read back, and must already exist in the workspace.
- **Assignee ids are numbers.** `assign-conversation` and `assign-conversation-to-team` take `assignee_id`
  and `team_id` as numbers because Intercom returns `admin_assignee_id` and `team_assignee_id` as
  integers; `list-admins` and `list-teams` show ids as strings. Assigning a closed conversation reopens it.
- **A state read-back can match a change someone else made.** It proves the conversation has that state
  or assignee now, not that this call set it.
- **No untag for conversations.** Intercom's remove-tag call for a conversation needs `admin_id` in the
  body of a `DELETE`, and Anlyon sends no body with a `DELETE`.
- **`search-articles` returns at most 10 articles** with their full bodies; Intercom documents no
  parameter for the next page. Narrow the phrase instead.
- **Long conversations can be cut.** `get-conversation` returns up to the 500 most recent parts; the
  agent receives at most 64 KB of it.
- **Search lag.** A contact or conversation created in the last few minutes may not be found by search yet.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. A retry after an
  unknown outcome can create a second contact or conversation, or send a second reply or note.

## Install

```bash
anlyon packs plan ./packs/intercom
anlyon packs install ./packs/intercom --yes --action search-conversations --action get-conversation --action reply-to-conversation
```

Every action sends `{{connection:intercom}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Intercom account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/intercom`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Intercom account (`anlyon connections add intercom --secret INTERCOM`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name INTERCOM=<your secret>`. Do this when the environment has more than one Intercom account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:intercom}}` instead of `{{secret:INTERCOM}}`. A call made for one of your users acts in their own Intercom account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full support toolset: 14 reads and 16 writes (was 3 writes). Existing actions unchanged.
- 0.1.0: first version.

Sources: https://developers.intercom.com/docs/references/2.11/rest-api/api.intercom.io (contacts:
searchcontacts, listcontacts, showcontact, createcontact, updatecontact, deletecontact,
attachtagtocontact, detachtagfromcontact, attachcontacttoacompany, detachcontactfromacompany;
conversations: listconversations, searchconversations, retrieveconversation, createconversation,
replyconversation, manageconversation, attachtagtoconversation, detachtagfromconversation; tags/listtags;
admins/listadmins, admins/retrieveadmin; teams/listteams; companies/listallcompanies,
companies/retrieveacompanybyid; articles/searcharticles, articles/retrievearticle),
https://github.com/intercom/Intercom-OpenAPI/blob/main/descriptions/2.11/api.intercom.io.yaml (request
schemas and examples), https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/api-changelog
(versions), checked 2026-10-15.
