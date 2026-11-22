# anlyon/discord

The toolset an agent needs to work in a Discord server, as a bot. This is the **catalogue pack** for
the Discord integration: the console offers its actions one by one after you connect Discord ("What
may your agent do here?"), and you can install any subset from the CLI.

Discord is connected with a bot token you create, not by signing in. Anlyon checks the token with
Discord before it stores it, binds it to `discord.com` in a request header, and makes every call
itself; the agent never holds the token. All calls use API v10.

## Reads

Plain tools: the response is returned to the agent (cut at 64 KB), every call is logged, no limit,
no receipt.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `list-channels` | Every channel in a server (no threads). Discord has no paging here | `guild_id` | none |
| `get-channel` | One channel or thread: name, type, topic, parent, thread state, the bot's thread membership | `channel_id` | none |
| `list-messages` | 20 messages in a channel, newest first | `channel_id`, `before` or `after` (message id cursor) | none |
| `get-message` | One message: text, author, reactions, pinned, reply reference, thread | `channel_id`, `message_id` | none |
| `list-pinned-messages` | Up to 20 pins, most recent first, with `has_more` | `channel_id`, `before` (the last item's `pinned_at`) | none |
| `list-active-threads` | Every active thread in a server, with the bot's memberships. Discord has no paging here | `guild_id` | none |
| `list-archived-threads` | Up to 20 archived public threads of a channel, with `has_more` | `channel_id`, `before` (the last thread's `archive_timestamp`) | none |
| `list-thread-messages` | 20 messages in a thread, newest first | `thread_id`, `before` or `after` | none |

## Writes

Governed: one resource mutation each, counted against a limit, a receipt, and an approval policy you
can turn on.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `post-message` | Posts one message to a channel | `channel_id`, `content` | The message by id; the text must match |
| `reply-to-message` | Posts one message as a reply (refused if the original is gone) | `channel_id`, `message_id`, `content` | The reply by id; the text and the replied-to id must match |
| `edit-message` | Replaces the text of one of the bot's messages | `channel_id`, `message_id`, `content` | The message; the text must match |
| `delete-message` | Deletes one message (the bot's own; others need Manage Messages) | `channel_id`, `message_id` | none: Discord does not document what reading a deleted message returns |
| `add-reaction` | Adds the bot's reaction | `channel_id`, `message_id`, `emoji` | none: a read cannot tie an emoji to the bot's own reaction |
| `remove-reaction` | Removes the bot's own reaction | `channel_id`, `message_id`, `emoji` | none: as above |
| `pin-message` | Pins one message | `channel_id`, `message_id` | The message; `pinned` must be true |
| `unpin-message` | Unpins one message | `channel_id`, `message_id` | The message; `pinned` must be false |
| `start-thread` | Starts one thread from a message | `channel_id`, `message_id`, `name` | The thread by id; its name must match |
| `join-thread` | Adds the bot to a thread | `thread_id` | The thread; it must list the bot as a member |
| `post-thread-message` | Posts one message in a thread | `thread_id`, `content` | The message by id; the text must match |
| `archive-thread` | Archives one thread | `thread_id` | The thread; `thread_metadata.archived` must be true |

`emoji` is the Unicode character itself (`👍`) or a custom emoji as `name:id`. Anlyon URL-encodes it.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| discord: approve editing a message | Every edit requires approval |
| discord: approve deleting a message | Every deletion requires approval |
| discord: approve archiving a thread | Every archive requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| discord: messages per day | 200 |
| discord: edits per day | 100 |
| discord: threads started per day | 50 |
| discord: replies per day | 200 |
| discord: thread messages per day | 200 |
| discord: deletions per day | 50 |
| discord: reactions added per day | 200 |
| discord: reactions removed per day | 200 |
| discord: pins per day | 30 |
| discord: unpins per day | 30 |
| discord: threads joined per day | 50 |
| discord: threads archived per day | 30 |

## Bot permissions

The bot is invited with **View Channel, Send Messages, Read Message History and Create Public
Threads**. That covers the reads and `post-message`, `reply-to-message`, `edit-message`,
`delete-message` (own messages), `remove-reaction`, `start-thread` and `join-thread`. The rest need
more, granted on the bot's role or the channel:

| Permission | Needed for |
| --- | --- |
| Send Messages in Threads | `post-thread-message`. Discord ignores Send Messages inside threads |
| Add Reactions | `add-reaction` with an emoji nobody has used on that message yet |
| Pin Messages | `pin-message`, `unpin-message` |
| Manage Messages | `delete-message` on someone else's message (otherwise refused) |
| Manage Threads | `archive-thread` on a thread the bot did not start (Discord's threads guide lets the creator archive its own) |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Without Read Message History a read returns nothing and a read-back is refused**, so the receipt stays `acknowledged`.
- **`list-channels` and `list-active-threads` have no paging.** Discord returns everything in one response; on a very large server it can be cut at 64 KB. From 2026-11-16 Discord leaves out channels the bot cannot view.
- **Pass at most one of `before` and `after`** to `list-messages` and `list-thread-messages`.
- **The bot edits only its own messages** and deletes only its own unless it has Manage Messages.
- **Deletions and reactions have no read-back**, so their receipts are `acknowledged`, not `confirmed`.
- **A message in an archived thread unarchives it** (unless locked); a deletion in an archived thread is refused.
- **No provider idempotency for posts and replies.** Anlyon sends each write once and never repeats it; a retry after an unknown outcome can post twice. A message holds only one thread, so a repeated `start-thread` is refused by Discord.
- **Ids are Discord's numeric ids.** Turn on Developer Mode in Discord to copy a server's, channel's or message's id.
- **Left out on purpose:** members, roles, bans, server and channel settings, webhooks, invites, deleting channels or threads, bulk deletion, and removing other people's reactions.

## Exercise

`anlyon packs exercise ./packs/discord` runs `exercise.json` against your test server. It needs:

- `guild_id`: the test server's id.
- `channel_id`: a text channel where the bot has the four invite permissions plus Add Reactions, Pin Messages and Send Messages in Threads.

The run posts, edits, replies, reacts and un-reacts, pins and unpins, starts a thread, joins it,
posts in it, then deletes its thread message, archives the thread and deletes its reply and its
first message. It touches nothing it did not create. One archived thread named
`Anlyon exercise <run>` stays behind: deleting a thread needs Manage Threads and is outside this pack.

## Install

```bash
anlyon packs plan ./packs/discord
anlyon packs install ./packs/discord --yes --action post-message --action list-messages
```

Every action sends `{{connection:discord}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Discord account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/discord`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Discord account (`anlyon connections add discord --secret DISCORD`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name DISCORD=<your secret>`. Do this when the environment has more than one Discord account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## Sources

Sources: https://docs.discord.com/developers/resources/message, https://docs.discord.com/developers/resources/channel, https://docs.discord.com/developers/resources/guild, https://docs.discord.com/developers/topics/threads, https://docs.discord.com/developers/topics/permissions (discord.com/developers/docs/* redirects here), checked 2026-10-15.

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:discord}}` instead of `{{secret:DISCORD}}`. A call made for one of your users acts in their own Discord account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full toolset: eight reads and nine new writes (reply, post in a thread, delete, add and
  remove a reaction, pin, unpin, join and archive a thread). The three existing actions are unchanged
  apart from `"kind": "write"`.
- 0.1.0: first version.
