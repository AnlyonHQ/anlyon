# anlyon/monday

The monday.com toolset an agent needs for boards and items: list boards and read their columns and
groups, list, search and read items and their updates, create items, set column values, move items
between groups, post updates, and archive or delete items. This is the **catalogue pack** for the
monday.com integration: the console offers its actions one by one after you connect monday.com
("What may your agent do here?"), and you can install any subset from the CLI.

monday.com is connected with a personal API token, not by signing in. Anlyon checks the token with
monday.com before it stores it, and binds it to `api.monday.com` in the `Authorization` request
header, sent as it is with no prefix. The agent never holds the token: Anlyon makes every call.

## API token

Each monday.com user has a personal API token, under the profile picture, Developers, My access
tokens. It has no scopes: it acts as that user, with that user's boards and permissions. Connect the
token of a user who is a member of the boards your agent should work in. A call on a board that user
cannot see or edit is refused by monday.com. Regenerating the token in monday.com stops the old one;
connect the new one.

Every call is a GraphQL request to `https://api.monday.com/v2` with the `API-Version: 2026-07` header,
the current version on monday.com's versioning page.

## Reads

Reads return monday.com's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Each is a fixed read-only GraphQL query, and
its variables are what the inputs fill. Responses over 64 KB are cut, so page sizes are fixed in the query. Items
page with a cursor: when `cursor` is not null, pass it to `next-items-page`. The cursor expires 60
minutes after the listing started. Boards and updates page with `page`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `monday-list-boards` | Lists active boards the user can reach. 25 a page | `page` |
| `monday-get-board` | Gets a board's columns (with settings, such as status labels) and groups | `board_id` |
| `monday-list-items` | Lists a board's items with their column values as text. 20 a page | `board_id`, `column_ids` |
| `monday-list-group-items` | Lists the items in one group. 20 a page | `board_id`, `group_id`, `column_ids` |
| `monday-search-items` | Finds items whose column holds a value, exactly. 20 a page | `board_id`, `column_id`, `value`, `column_ids` |
| `monday-next-items-page` | Gets the next 20 items after a cursor from any of the three above | `cursor`, `column_ids` |
| `monday-get-item` | Gets one item with its board, group, state and every column's text and raw value | `item_id`, `column_ids` |
| `monday-list-updates` | Lists the updates (comments) on an item. 20 a page | `item_id`, `page` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt. Each read-back is a fixed, read-only GraphQL query on the same URL.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `monday-create-item` | Creates one item in a group, or in the top group | `board_id`, `item_name`, `group_id`, `column_values` | The item by its new id; the name must match |
| `monday-set-column-value` | Sets one column from plain text: a status label, a date (YYYY-MM-DD), a text, a number | `board_id`, `item_id`, `column_id`, `value` | The item's column; its text must equal what monday.com returned for the change |
| `monday-change-column-values` | Sets several columns in one call | `board_id`, `item_id`, `column_values` | The item; its last update time must equal the one monday.com returned for the change |
| `monday-move-item-to-group` | Moves an item to another group on its board | `item_id`, `group_id` | The item; its group must be the one asked for |
| `monday-add-update` | Posts an update (a comment) on an item | `item_id`, `body` | The update by its new id; it must be on this item, with the body monday.com stored |
| `monday-archive-item` | Archives an item (restorable from the board's archive) | `item_id` | The item; its state must be `archived` |
| `monday-delete-item` | Deletes an item (moved to the trash, restorable for a time) | `item_id` | The item; its state must be `deleted` |

### `column_values`

`create-item` and `change-column-values` take `column_values` as a JSON object written as a string,
keyed by column id, as monday.com's `JSON` argument expects. For example:

```json
"{\"status\":{\"label\":\"Done\"},\"date4\":{\"date\":\"2026-11-02\"},\"text_mkx1abcd\":\"Call before kickoff\"}"
```

It is sent as a GraphQL variable, never written into the query, so no value can change the operation.
The input must be one string that starts with `{` and ends with `}`; monday.com parses it and refuses
one that is not valid JSON or names a column the board does not have. Each column type has its own
value shape (monday.com's column types reference); `set-column-value` takes plain text instead and
suits a single status, date or text.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| monday: approve deleting an item | Every item deletion requires approval |
| monday: approve archiving an item | Every archive requires approval. Turn it on when items should leave a board when a person agrees |
| monday: approve posting an update | Every update requires approval. Updates are seen by everyone on the board, and monday.com notifies the item's subscribers and anyone mentioned |

Suggested limits are created with `--with-limits`, and printed otherwise. Each counts one write action per day. The
amounts suit one team's normal day of use: changing columns more often than creating, and archiving
or deleting least. Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| monday: items created per day | 100 |
| monday: single column changes per day | 300 |
| monday: multiple column changes per day | 200 |
| monday: items moved between groups per day | 200 |
| monday: updates posted per day | 200 |
| monday: items archived per day | 50 |
| monday: items deleted per day | 20 |

## Exercise

`anlyon packs exercise ./packs/monday --need board_id=... --need text_column_id=...` runs every
action once, in the order of `exercise.json`, against your monday.com account. It needs a test board
the token's user can edit, with at least two groups, a text column and more than 20 items (so
`list-items` returns a cursor for `next-items-page`).

The run creates an item (`Anlyon exercise <run>`) in the board's top group, sets the text column,
searches for it, changes the column again, moves the item to the second group, posts an update on it
and deletes it. It creates a second item (`Anlyon exercise <run> (archive)`) and archives it; delete
that one from the board's archive afterwards. Nothing it did not create is changed. Turn the policies
off (or approve them) for the run, or it stops at the step a policy holds.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **GraphQL answers most errors with HTTP 200.** monday.com returns a refused or failed request
  (a missing permission, an unknown column, a bad label, a complexity budget spent) as an `errors`
  list with status 200. A refused write is therefore seen as a read-back that does not match, and
  its receipt is not graded confirmed. A bad or missing token gets 401.
- **Query complexity.** monday.com charges each query a complexity cost against a per-minute budget
  for the token, and refuses a query that would pass it. The queries here are kept small: 25 boards
  or 20 items a page, and column values as text in lists. On a wide board, pass `column_ids` to read
  the columns you need.
- **The token acts as one user.** A personal API token has no scopes. What the agent can see and
  change is what that user can.
- **Cursors expire.** An items cursor lasts 60 minutes from the call that started the listing.
  `list-items` and `list-group-items` take no filter; use `search-items` to filter by one column, and
  page any of them with `next-items-page`.
- **Search is exact and by column type.** `search-items` matches a value exactly, on the column types
  monday.com supports for it; others are refused.
- **Bounded read-backs on column changes.** `set-column-value` checks the one column's text.
  `change-column-values` checks the item's last update time, not each column; read the columns with
  `get-item`. `create-item` checks the name, not the column values set at creation.
- **Deleted and archived items are read back by state.** monday.com keeps a deleted item in the
  trash and an archived one in the board's archive, so the read-back asks for the item and expects
  `state` `deleted` or `archived`.
- **No idempotency.** A retry of `create-item` or `add-update` after an unknown outcome can create a
  second item or update. Search before you create.
- **Left out.** Creating or deleting boards, columns and groups, subitems, files, users, teams,
  workspaces and webhooks are not offered. Moving an item to another board is not offered.
- **API version.** Every action pins `API-Version: 2026-07`. monday.com retires a version on a
  schedule; the pack is updated before that.

## Install

```bash
anlyon packs plan ./packs/monday
anlyon packs install ./packs/monday --yes --action list-items --action get-item --action set-column-value
```

Every action sends `{{connection:monday}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own monday.com account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/monday`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected monday.com account (`anlyon connections add monday --secret MONDAY`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name MONDAY=<your secret>`. Do this when the environment has more than one monday.com account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: list boards and read their columns and groups; list, search and
  read items and their updates; create items, set one or several column values, move items between
  groups, post updates, and archive and delete items, as governed writes.

## Sources

monday.com API, checked 2026-10-24. monday.com publishes no OpenAPI spec; the GraphQL types were
checked against the schema types in monday.com's own SDK, `mondaycom/monday-graphql-api`
(`packages/api-types/generated/api-types.d.ts`, commit of 2026-10-13).

- Versioning (current version 2026-07): https://developer.monday.com/api-reference/docs/api-versioning
- Authentication with a personal API token in the `Authorization` header:
  https://developer.monday.com/api-reference/docs/authentication
- Boards: https://developer.monday.com/api-reference/reference/boards
- Columns, `change_simple_column_value`, `change_multiple_column_values`:
  https://developer.monday.com/api-reference/reference/columns
- Column `settings` replacing `settings_str` (2025-10):
  https://developer.monday.com/api-reference/changelog/deprecating-settings_str-field-on-columns
- Column values: https://developer.monday.com/api-reference/reference/column-values-v2
- Groups: https://developer.monday.com/api-reference/reference/groups
- Items, `create_item`, `move_item_to_group`, `archive_item`, `delete_item`:
  https://developer.monday.com/api-reference/reference/items
- Items page (cursor, 60-minute expiry, cursor and `query_params` not together, at most 500):
  https://developer.monday.com/api-reference/reference/items-page
- Next items page: https://developer.monday.com/api-reference/reference/next-items-page
- Items page by column values: https://developer.monday.com/api-reference/reference/items-page-by-column-values
- Updates, `create_update`: https://developer.monday.com/api-reference/reference/updates
- Errors (401 for a bad token, 200 with `errors` for application errors):
  https://developer.monday.com/api-reference/docs/error-handling
- Rate limits and query complexity: https://developer.monday.com/api-reference/docs/rate-limits
