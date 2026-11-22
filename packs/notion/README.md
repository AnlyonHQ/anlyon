# anlyon/notion

The operations an agent can be allowed to perform in Notion. This is the **catalogue pack** for the
Notion integration: the console offers its actions one by one after you connect Notion ("What may
your agent do here?"), and you can install any subset from the CLI.

Notion is connected with an internal integration token you create in your own workspace, not by
signing in. Anlyon checks the token with Notion before it stores it, and binds it to
`api.notion.com` in a request header. The agent never holds the token: Anlyon makes every call.

Reads (search, get, list, query) return Notion's response to the agent and are logged; approval and
deny policies can still apply. Writes are governed: each declares its impact, counts against a limit
you can set, can be put behind an approval policy, and gets a receipt, read back from Notion where
Notion has a read that shows the change.

## Reads

| Action | What it does | Inputs | Page size and next page |
| --- | --- | --- | --- |
| `search-pages` | Searches the pages shared with the integration by title, most recently edited first (POST, changes nothing) | `query?`, `start_cursor?` | 10; `next_cursor` as `start_cursor` |
| `search-databases` | The same, for databases | `query?`, `start_cursor?` | 10; `next_cursor` as `start_cursor` |
| `get-page` | One page's properties, parent, url and trash state (not its content) | `page_id` | one page |
| `get-page-property` | One property in full, for values `get-page` cuts at 25 (relations, people, long text, rollups) | `page_id`, `property_id` (decoded id, or `title`), `start_cursor?` | 25; `next_cursor` as `start_cursor` |
| `get-block` | One block: type, content, `has_children`, trash state | `block_id` | one block |
| `list-block-children` | A page's content, or the blocks under a block, first level only | `block_id`, `start_cursor?` | 10; `next_cursor` as `start_cursor` |
| `get-database` | A database's title and column schema | `database_id` | one database |
| `query-database` | A database's rows, filtered and sorted (POST, changes nothing) | `database_id`, `filter?`, `sorts?`, `start_cursor?` | 10; `next_cursor` as `start_cursor` |
| `list-comments` | The open comments on a page or block, with each `discussion_id` | `block_id`, `start_cursor?` | 25; `next_cursor` as `start_cursor` |

## Writes

| Action | What it does | Inputs | Impact | Read-back |
| --- | --- | --- | --- | --- |
| `create-page` | Creates one page under a page | `parent_page_id`, `title` | 1 | The page by id; the title must match |
| `create-database` | Creates one database under a page, with its columns | `parent_page_id`, `title`, `properties`, `is_inline?` | 1 | The database by id; the title must match |
| `create-database-page` | Adds one row to a database | `database_id` (hyphenated), `properties` | 1 | The page by id; its parent must be that database |
| `update-page-properties` | Sets a page's title or a row's column values | `page_id`, `properties` | 1 | The page by id; live, and its `last_edited_time` must equal the one the update returned (values are not compared) |
| `archive-page` | Moves one page to the trash | `page_id` | 1 | The page; it must be archived |
| `restore-page` | Takes one page out of the trash | `page_id` | 1 | The page; it must not be archived |
| `append-paragraph` | Adds one paragraph to the end of a page | `page_id`, `text` | 1 | The new block by id; the text must match |
| `append-blocks` | Adds up to 100 text blocks (paragraph, headings, bulleted and numbered items, to-do, toggle, quote, callout, code, divider) at the end or after a block | `block_id`, `children`, `after?` | one per block | The first new block by id; its type and creation time must match |
| `update-block-text` | Replaces a block's text, or ticks a to-do | `block_id`, one of `paragraph`, `heading_1..3`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`, `quote`, `callout`, `code` | 1 | The block by id; live, and its `last_edited_time` must equal the one the update returned (text is not compared) |
| `delete-block` | Moves one block to the trash | `block_id` | 1 | The block; it must be archived |
| `add-comment` | Starts a comment discussion on a page | `page_id`, `text` | 1 | The comment by id; the text and discussion must match |
| `reply-to-comment` | Replies in an existing discussion | `discussion_id` (hyphenated), `text` | 1 | The comment by id; the discussion and text must match |
| `update-comment` | Replaces the text of a comment the integration posted | `comment_id`, `text` | 1 | The comment; the text must match |
| `delete-comment` | Deletes a comment the integration posted | `comment_id` | 1 | none: Notion does not document what reading a deleted comment returns (graded `acknowledged`) |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| notion: approve archiving a page | Every page archive requires approval |
| notion: approve deleting a block | Every block deletion requires approval |
| notion: approve deleting a comment | Every comment deletion requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| notion: pages created per day | 100 |
| notion: databases created per day | 10 |
| notion: database rows created per day | 200 |
| notion: page property updates per day | 300 |
| notion: pages archived per day | 20 |
| notion: pages restored per day | 20 |
| notion: paragraphs added per day | 500 |
| notion: blocks added per day (each block counts) | 1000 |
| notion: block edits per day | 300 |
| notion: blocks deleted per day | 50 |
| notion: comments per day | 100 |
| notion: comment replies per day | 100 |
| notion: comment edits per day | 100 |
| notion: comments deleted per day | 50 |

## Exercise

`exercise.json` drives `anlyon packs exercise ./packs/notion` against your own workspace. It needs
one thing made by hand:

- `parent_page_id`: a page shared with the integration (open the page's menu, Connections, add the
  integration), the last 32 characters of its URL. The integration needs **read, update and insert
  content** and **read and insert comments** (comment capabilities are off by default).

The run creates a page under it, renames it, adds a paragraph and three blocks, reads the content,
ticks the to-do, deletes the paragraph, comments, replies, edits and deletes both comments, creates a
database in the run's page with a row, queries and updates the row, then archives the run's page,
restores it and archives it again. Everything it creates is in the trash when it finishes; nothing
outside the run's page is changed.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The integration reaches only pages and databases shared with it.** A page that is not shared
  answers 404 and the action fails. Search only finds what is shared.
- **Pinned to `Notion-Version: 2022-06-28`.** Notion's latest version is `2026-03-11`; `2025-09-03`
  split databases into data sources (query, schema and row parents move to `/v1/data_sources/...`,
  the search filter value `database` becomes `data_source`) and `2026-03-11` renames `archived` to
  `in_trash` and replaces `after` with `position`. Every action keeps `2022-06-28` so the shapes stay
  consistent across the pack. Consequence: `get-database`, `query-database` and
  `create-database-page` fail with a validation error on a database that has more than one data
  source. The comment read, update and delete endpoints are documented only under the latest
  version; the exercise is what shows they answer under `2022-06-28`.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown`
  outcome, reconcile before invoking again, or a second page, database, row, block or comment can be
  created.
- **Some read-backs show the state, not this call.** `archive-page` and `delete-block` match a page or
  block that was already archived; `restore-page` matches a page that was never archived.
- **Two read-backs do not compare values.** `update-page-properties` and `update-block-text` take
  values whose property names or block type the caller chooses, so the read-back proves the page or
  block is live at the edit time the update returned, not the values themselves.
- **Creates and edits read back by the id or time Notion returns.** If the response is lost, the
  read-back cannot run and the effect stays `unknown` until an operator resolves it.
- **Hyphenated ids where the read-back compares them.** `create-database-page` takes `database_id`
  and `reply-to-comment` takes `discussion_id` in the lowercase hyphenated form the API returns,
  because the read-back compares them as text.
- **Bounded inputs.** Blocks are text blocks without nesting or mentions (append nested blocks with
  `append-blocks` on the new block's id). Database filters accept Notion's documented filter keys
  and `and`/`or` nested two levels; property values and column definitions are passed through in
  Notion's own form and Notion validates them. Only comments the integration posted can be edited
  or deleted.
- **Rate limit.** Notion allows about three requests per second per integration; a burst answers 429.

## Left out

- Users and the bot user (`/v1/users`): account-level; people values come back with ids in page
  properties.
- Database schema changes (`PATCH /v1/databases/{id}`), moving pages, file uploads, views, templates
  and Markdown page content: schema changes are workspace structure, and the rest are newer
  features documented only for the latest API version.
- Restoring a trashed block: possible with Update a block, not part of routine work.

## Install

```bash
anlyon packs plan ./packs/notion
anlyon packs install ./packs/notion --yes --action create-page --action append-paragraph
```

Every action sends `{{connection:notion}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Notion account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/notion`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Notion account (`anlyon connections add notion --secret NOTION`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name NOTION=<your secret>`. Do this when the environment has more than one Notion account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:notion}}` instead of `{{secret:NOTION}}`. A call made for one of your users acts in their own Notion account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full toolset: search, pages, page properties, blocks, databases and rows, comments;
  restore a page; `kind` on every action; `expectedUrl` in every fixture; `exercise.json`.
- 0.1.0: first version.

Sources, checked 2026-10-15:
https://developers.notion.com/reference/versioning,
https://developers.notion.com/docs/upgrade-guide-2025-09-03,
https://developers.notion.com/docs/upgrade-guide-2026-03-11,
https://developers.notion.com/page/changelog,
https://developers.notion.com/reference/intro,
https://developers.notion.com/reference/post-search,
https://developers.notion.com/reference/retrieve-a-page,
https://developers.notion.com/reference/retrieve-a-page-property,
https://developers.notion.com/reference/post-page,
https://developers.notion.com/reference/patch-page,
https://developers.notion.com/reference/retrieve-a-block,
https://developers.notion.com/reference/get-block-children,
https://developers.notion.com/reference/patch-block-children,
https://developers.notion.com/reference/update-a-block,
https://developers.notion.com/reference/delete-a-block,
https://developers.notion.com/reference/retrieve-a-database,
https://developers.notion.com/reference/create-a-database,
https://developers.notion.com/reference/post-database-query,
https://developers.notion.com/reference/post-database-query-filter,
https://developers.notion.com/reference/post-database-query-sort,
https://developers.notion.com/reference/list-comments,
https://developers.notion.com/reference/create-a-comment,
https://developers.notion.com/reference/retrieve-comment,
https://developers.notion.com/reference/update-a-comment,
https://developers.notion.com/reference/delete-a-comment
