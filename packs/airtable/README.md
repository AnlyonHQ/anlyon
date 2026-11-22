# anlyon/airtable

The Airtable toolset an agent needs for bases, records and comments. This is the **catalogue pack**
for the Airtable integration: the console offers its actions one by one after you connect Airtable
("What may your agent do here?"), and you can install any subset from the CLI.

Airtable is connected with a personal access token you create, not by signing in. Anlyon checks the
token with Airtable before it stores it, and binds it to `api.airtable.com` in a request header. The
agent never holds the token: Anlyon makes every call.

## Token scopes

Create the token in Airtable's builder hub, under Personal access tokens. Give it these scopes, and
add only the bases your agent should reach. A token without them is accepted at connect and refused
when an operation runs.

| Scope | Needed by |
| --- | --- |
| `data.records:read` | `list-records`, `get-record` |
| `data.records:write` | `create-record`, `create-records`, `update-record`, `upsert-records`, `delete-record` |
| `data.recordComments:read` | `list-comments`, and the read-back of `add-comment` and `update-comment` |
| `data.recordComments:write` | `add-comment`, `update-comment` |
| `schema.bases:read` | `list-bases`, `get-base-schema` |
| `user.email:read` (optional) | `get-current-user` returns the email address as well as the user id |

The token acts as the user who made it, so that user also needs access in Airtable: editor on a base
for the record writes, commenter for comments, read-only for reads. A write's read-back uses the
matching read scope: `create-record` and `create-records` need `data.records:read` as well, or the
receipt cannot be confirmed.

## Reads

Reads return Airtable's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes are
fixed where Airtable allows it. Airtable pages with `offset`: when a response has one, pass it back
for the next page.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `airtable-get-current-user` | Gets the user the token acts as: id, and email with `user.email:read` | none |
| `airtable-list-bases` | Lists the bases the token reaches, with your permission level. Airtable sets the page size | `offset` |
| `airtable-get-base-schema` | Gets a base's tables, with their fields and views | `base_id` |
| `airtable-list-records` | Lists or searches a table's records with a formula, a view and a sort. 10 a page | `base_id`, `table`, `view`, `filter_by_formula`, `sort_field`, `sort_direction`, `offset` |
| `airtable-get-record` | Gets one record with its non-empty fields | `base_id`, `table`, `record_id` |
| `airtable-list-comments` | Lists a record's comments, newest first. 20 a page | `base_id`, `table`, `record_id`, `offset` |

## Writes

Each write declares an impact in resource mutations (one per record for the batch writes), counts
against its limit, can be put behind an approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `airtable-create-record` | Creates one record | `base_id`, `table`, `fields`, `typecast` | The record by the returned id; id and createdTime must match |
| `airtable-create-records` | Creates up to 10 records | `base_id`, `table`, `records`, `typecast` | The first new record by id; id and createdTime must match |
| `airtable-update-record` | Changes the given fields on one record | `base_id`, `table`, `record_id`, `fields`, `typecast` | none: fields are named per table and chosen per call. Check with `get-record` |
| `airtable-upsert-records` | Updates or creates up to 10 records, matched on one to three fields | `base_id`, `table`, `merge_on`, `records`, `typecast` | none: each record may be created or updated. Check with `get-record` |
| `airtable-delete-record` | Deletes one record and its comments | `base_id`, `table`, `record_id` | Getting the record answers 404 |
| `airtable-add-comment` | Adds a comment to a record, or replies to one | `base_id`, `table`, `record_id`, `text`, `parent_comment_id` | The newest 20 comments; the new id and the text must be among them |
| `airtable-update-comment` | Replaces the text of a comment the token's user wrote | `base_id`, `table`, `record_id`, `comment_id`, `text` | The newest 100 comments; the id, the text and Airtable's edit time must be among them |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| airtable: approve deleting a record | Every record deletion requires approval |
| airtable: approve creating records in bulk | Every `create-records` call requires approval |
| airtable: approve upserting records | Every `upsert-records` call requires approval |

Turn on the delete policy when a base holds records your team cannot rebuild. Turn on the two batch
policies when one call may change up to 10 records at once and a person should see them first.
`upsert-records` can overwrite existing records that match, so it is behind its own policy.

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| airtable: records created per day | 200 |
| airtable: records created in bulk per day | 200 |
| airtable: records updated per day | 500 |
| airtable: records upserted per day | 200 |
| airtable: records deleted per day | 20 |
| airtable: comments added per day | 200 |
| airtable: comments edited per day | 100 |

The amounts are suggestions for one agent's normal day: updates run highest, because an agent keeps
records current; creates are lower; deletes are kept low, so a mistaken loop stops early. The batch
limits count records, not calls. Change any of them to fit your base.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Field values are not read back.** Fields are named per table, so no fixed rule can check a
  value. `create-record` and `create-records` are read back by record id and createdTime, which
  shows the record exists, not each value. `update-record` and `upsert-records` have no read-back,
  and their receipts are graded acknowledged.
- **Batch writes read back one record.** `create-records` reads back the first record it created.
  Airtable accepts up to 10 records a call and refuses more.
- **Comment read-backs see the newest comments.** `add-comment` checks the newest 20 and
  `update-comment` the newest 100. Editing an older comment cannot be read back, and its receipt
  shows a mismatch.
- **A token edits only its own comments.** Airtable refuses an edit to a comment another user wrote.
- **Large responses are cut.** `list-bases` and `get-base-schema` have no page size Airtable lets
  us set. A token that reaches many bases, or a base with many tables and fields, can return more
  than 64 KB. Give the token only the bases the agent needs.
- **No idempotency.** A retry of a create or a comment after an unknown outcome can add it twice.
  Use `upsert-records` with a field that identifies a record to avoid duplicates.
- **Formulas are Airtable's.** `filter_by_formula` is passed to Airtable as given. An invalid formula
  is refused by Airtable.
- **No attachments, tables or fields.** Uploading files and changing a base's schema need actions
  you declare.

## Exercise

`anlyon packs exercise ./packs/airtable --need base_id=<app…> --need table=<tbl…>` runs every action
once, in the order of `exercise.json`, against your Airtable base.

| Need | What to give |
| --- | --- |
| `base_id` | The id of a test base the token can edit |
| `table` | The id of a table in it whose primary field is a single line text field named `Name`, as on a new table |

The run creates three records named `Anlyon exercise <run>`, upserts one of them, comments on one and
edits the comment, then deletes all three. Nothing it did not create is changed or deleted. Turn the
policies off (or approve them) for the run, or it stops at the first one.

## Install

```bash
anlyon packs plan ./packs/airtable
anlyon packs install ./packs/airtable --yes --action list-records --action get-record --action create-record
```

Every action sends `{{connection:airtable}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Airtable account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/airtable`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Airtable account (`anlyon connections add airtable --secret AIRTABLE`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name AIRTABLE=<your secret>`. Do this when the environment has more than one Airtable account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): bases, base schemas, records and comments: reads, and creates, updates,
  upserts, deletes and comments as governed writes. Every action sends `{{connection:airtable}}`.

## Sources

Airtable Web API, checked 2026-10-24. Airtable publishes no OpenAPI description of its Web API, so
the actions are written by hand from the reference:

- Introduction and authentication: https://airtable.com/developers/web/api/introduction,
  https://airtable.com/developers/web/api/authentication,
  https://airtable.com/developers/web/api/scopes,
  https://airtable.com/developers/web/guides/personal-access-tokens
- Errors and rate limits: https://airtable.com/developers/web/api/errors,
  https://airtable.com/developers/web/api/rate-limits
- User: https://airtable.com/developers/web/api/get-user-id-scopes
- Bases: https://airtable.com/developers/web/api/list-bases,
  https://airtable.com/developers/web/api/get-base-schema
- Records: https://airtable.com/developers/web/api/list-records,
  https://airtable.com/developers/web/api/get-record,
  https://airtable.com/developers/web/api/create-records,
  https://airtable.com/developers/web/api/update-record,
  https://airtable.com/developers/web/api/update-multiple-records,
  https://airtable.com/developers/web/api/delete-record
- Comments: https://airtable.com/developers/web/api/list-comments,
  https://airtable.com/developers/web/api/create-comment,
  https://airtable.com/developers/web/api/update-comment
- The 10-record limit per call: https://support.airtable.com/docs/managing-api-call-limits-in-airtable
