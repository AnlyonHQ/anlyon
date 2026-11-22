# anlyon/trello

The Trello toolset an agent needs for boards, lists, cards, comments and labels. This is the
**catalogue pack** for the Trello integration: the console offers its actions one by one after you
connect Trello ("What may your agent do here?"), and you can install any subset from the CLI.

Trello is connected with an API key and a token, not by signing in. Anlyon checks them with Trello
before it stores them, and binds them to `api.trello.com` in the `Authorization` header, in the form
Trello documents: `OAuth oauth_consumer_key="<key>", oauth_token="<token>"`. The agent never holds
the key or the token: Anlyon makes every call.

## API key and token

Create a Power-Up at `https://trello.com/apps/admin`, generate an API key on its Trello Auth tab,
then use the key's Token link to create a token for your account. Both are given at
connect. The token has no per-board scopes in this pack's use: it acts as the Trello member who
created it, on every board that member can reach. Create it from an account that is a member of the
boards your agent should work in. A call on a board that member cannot see or edit is refused by
Trello. A revoked token is answered with 401 `invalid token`.

## Reads

Reads return Trello's response to the agent. They have no impact, limit or receipt; every call is
logged and approval or deny policies can still apply. Responses over 64 KB are cut, so page sizes and
fields are fixed. Card lists page with `before` (the id of the last card of the previous page);
comments and search page with `page`.

| Action (installed name) | What it does | Inputs |
| --- | --- | --- |
| `trello-list-boards` | Lists the account's boards, by open, closed, starred or all. Not paged | `filter` |
| `trello-get-board` | Gets one board, with its label names | `board_id` |
| `trello-list-lists` | Lists a board's lists, open by default. Not paged | `board_id`, `filter` |
| `trello-list-labels` | Lists a board's labels, up to 50 | `board_id` |
| `trello-list-board-cards` | Lists a board's open cards, without descriptions. 50 a page | `board_id`, `before` |
| `trello-list-list-cards` | Lists one list's open cards, without descriptions. 50 a page | `list_id`, `before` |
| `trello-search-cards` | Searches cards by text, on one board or all of them. 20 a page | `query`, `board_id`, `partial`, `page` |
| `trello-get-card` | Gets one card with its description, labels, members and badges | `card_id` |
| `trello-list-card-comments` | Lists a card's comments, newest at the top. 50 a page, up to page 19 | `card_id`, `page` |

## Writes

Each write declares an impact of 1 resource mutation, counts against its limit, can be put behind an
approval policy, and gets a receipt.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `trello-create-card` | Creates one card in a list | `list_id`, `name` and any of `desc`, `pos`, `due`, `label_ids` | The card by id; name and list must match |
| `trello-update-card` | Updates a card's name, description, due date or due-complete flag | `card_id` and the fields to change | The card; name, description and due complete must equal what Trello returned |
| `trello-move-card` | Moves a card to another list, on the same or another board | `card_id`, `list_id`, `board_id`, `pos` | The card; its list must match |
| `trello-archive-card` | Archives a card | `card_id` | The card; `closed` must be true |
| `trello-restore-card` | Restores an archived card | `card_id` | The card; `closed` must be false |
| `trello-add-comment` | Adds one comment to a card | `card_id`, `text` | The comment action by id; a `commentCard` on this card with the stored text |
| `trello-add-label` | Puts one board label on a card | `card_id`, `label_id` | The card's label ids; the label must be among them |
| `trello-remove-label` | Takes one label off a card | `card_id`, `label_id` | The card's label ids; the label must not be among them |
| `trello-delete-card` | Deletes a card for good | `card_id` | none: Trello's reference does not say what a read of a deleted card answers. Check with `get-card` |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| trello: approve deleting a card | Every card deletion requires approval. A deleted card cannot be restored; `archive-card` can be undone with `restore-card` |

Comments are seen by the board's members, and a member they @mention is notified. They are not given a
policy, because they stay inside the board. Declare one on `add-comment` when your boards are public
or shared with customers.

Suggested limits are created with `--with-limits`, and printed otherwise. Each counts one write action per day. The
amounts suit one team's normal day of use: moving and labelling more often than creating, and deleting
least. Change them to fit your volume.

| Suggested limit | Per day |
| --- | --- |
| trello: cards created per day | 100 |
| trello: cards updated per day | 200 |
| trello: cards moved per day | 300 |
| trello: cards archived per day | 100 |
| trello: cards restored per day | 50 |
| trello: comments per day | 200 |
| trello: labels added per day | 300 |
| trello: labels removed per day | 300 |
| trello: cards deleted per day | 20 |

## Exercise

`anlyon packs exercise ./packs/trello --need board_id=<id>` runs every action once, in the order of
`exercise.json`, against your Trello account. It needs one board the account can edit, with at least
two open lists and one label (a new Trello board has color labels). It reads the board's lists and
labels itself.

The run creates a card (`Anlyon exercise <run>`) in the board's leftmost list, updates it, comments on
it, adds and removes a label, moves it to the second list, finds it, archives and restores it, then
deletes it. Nothing it did not create is changed. Search can take a moment to index a new card, so
`search-cards` may return no cards in the run; that is not a failure. Turn the policy off (or approve
it) for the run, or it stops at `delete-card`.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token acts as one member.** What the agent can see and change is what the member who created
  the token can, on every board they belong to.
- **Fields travel in the URL query.** Trello's reference documents card and comment fields as query
  parameters, and the pack sends them that way. The pack bounds a description and a comment to 4000
  characters and a card name to 500, so the URL stays short.
- **Deletes are not read back.** `delete-card` is graded acknowledged.
- **Bounded read-backs on updates.** `update-card` checks the name, description and due-complete
  flag. A new due date is sent but not read back.
- **Card-list paging is not in the endpoint reference.** Trello's reference lists no query
  parameters for a board's or a list's cards. The pack sends `before` as Trello's paging guide
  describes it, and `fields` and `limit=50`, which neither the reference nor the guide lists for these
  endpoints.
- **Some lists are not paged.** `list-boards` and `list-lists` return everything Trello answers, and
  `list-labels` returns up to 50. A member on a very large number of boards may hit the 64 KB cut.
- **Search is eventually consistent.** A card just created or changed can take a moment to appear in
  `search-cards`. Read it by id with `get-card` instead.
- **Standard fields.** Checklists, attachments, custom fields, start dates and members are returned
  by `get-card` where Trello includes them, but not set by the writes. Attachments need multipart
  uploads, which are not supported.
- **No idempotency.** Trello accepts cards with the same name. A retry of `create-card` or
  `add-comment` after an unknown outcome can create a second one. Search before you create.
- **Rate limits are Trello's.** Trello allows 300 requests per 10 seconds per API key and 100 per 10
  seconds per token, and answers 429 above that. Calls to `/1/members/` itself, such as the key check
  at connect (`/1/members/me`), have a further limit of 100 requests per 900 seconds. Nested routes
  such as `/1/members/me/boards` (`list-boards`) do not count against it. Trello also gives
  `/1/search` (`search-cards`) a much stricter limit, without a number.

## Install

```bash
anlyon packs plan ./packs/trello
anlyon packs install ./packs/trello --yes --action search-cards --action get-card --action add-comment
```

Every action sends `{{connection:trello}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Trello account. Store their key and token with `PUT /api/v2/end-users/{endUserId}/connections/trello`, giving both in `fields` (`{ "fields": { "key": "...", "token": "..." } }`). A user with nothing stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Trello account (`anlyon connections add trello --secret TRELLO`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name TRELLO=<your secret>`. Do this when the environment has more than one Trello account. A call made for one of your users still uses their own account.

Then review and enable the policy. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): the toolset: read boards, lists, labels, cards and comments, and search cards;
  create, update, move, archive, restore and delete cards, comment, and add or remove labels, as
  governed writes.

## Sources

Checked 2026-11-22.

- Trello OpenAPI document, https://developer.atlassian.com/cloud/trello/swagger.v3.json (sha256
  `b07c97d06e93f7caff661a307e86f2b58c1f97591614ac8179f8e31bda27334b`): every path and method the
  pack uses, every query parameter (`filter`, `fields`, `limit`, `query`, `idBoards`, `modelTypes`,
  `partial`, `card_fields`, `cards_limit`, `cards_page`, `page`, `idList`, `name`, `desc`, `pos`,
  `due`, `dueComplete`, `idLabels`, `idBoard`, `closed`, `text`, `value`), and the Card, Action,
  Board, TrelloList and Label schemas.
- Cards reference, https://developer.atlassian.com/cloud/trello/rest/api-group-cards/; Boards,
  https://developer.atlassian.com/cloud/trello/rest/api-group-boards/; Lists,
  https://developer.atlassian.com/cloud/trello/rest/api-group-lists/; Members,
  https://developer.atlassian.com/cloud/trello/rest/api-group-members/; Search,
  https://developer.atlassian.com/cloud/trello/rest/api-group-search/; Actions,
  https://developer.atlassian.com/cloud/trello/rest/api-group-actions/: the HTML pages built from the
  same document.
- The `Authorization: OAuth oauth_consumer_key="...", oauth_token="..."` header, and 401
  `invalid token` for a revoked token,
  https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
- API key on the Power-Up's Trello Auth tab, token, and paging with `before` and `since`,
  https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/
- Rate limits (300 per 10 seconds per key, 100 per 10 seconds per token, 100 per 900 seconds on
  `/1/members/` but not its nested routes, a stricter limit on `/1/search`),
  https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/
