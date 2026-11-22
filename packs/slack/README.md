# anlyon/slack

The operations an agent can be allowed to perform in Slack's public channels. This is the
**catalogue pack** for the Slack integration: the console offers its actions one by one after you
connect Slack ("What may your agent do here?"), and you can install any subset from the CLI.

## What it installs

| Action (installed name) | What it does | Impact | Read-back |
| --- | --- | --- | --- |
| `slack-post-message` | Posts one message to a public channel the app is in | 1 resource mutation | The channel at the message's timestamp; the text must match |
| `slack-update-message` | Replaces the text of one message the app posted | 1 resource mutation | The channel at that timestamp; the text must match |
| `slack-add-reaction` | Adds an emoji reaction to one message | 1 resource mutation | The message's reactions |
| `slack-set-channel-topic` | Sets one channel's topic | 1 resource mutation | The channel; the topic must match |
| `slack-set-channel-purpose` | Sets one channel's purpose | 1 resource mutation | The channel; the purpose must match |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| slack: approve editing a message | Every edit requires approval |
| slack: approve changing a channel's topic | Every topic change requires approval |
| slack: approve changing a channel's purpose | Every purpose change requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| slack: messages per day | 200 |
| slack: edits per day | 100 |
| slack: reactions per day | 500 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Slack answers HTTP 200 on most errors.** Every Web API method returns `200` with `ok: false`
  when it refuses (a wrong channel, a revoked token, a missing scope). A declared action grades on
  the HTTP status, so a refused call is recorded `succeeded` and graded `acknowledged`. Only the
  read-back keeps it from `confirmed`. Treat an `acknowledged` Slack effect as unconfirmed.
- **No provider idempotency.** A retry after an `unknown` outcome can post twice.
- **Message read-backs are rate-limited by Slack.** `slack-post-message` and `slack-update-message`
  read the channel's history to check the text. For an app that is distributed but not listed in
  the Slack Marketplace, Slack allows that call once a minute per workspace (and 15 messages per
  call, which one-message read-backs stay under). A second post or edit within the same minute has
  its read-back refused and stays `acknowledged`. The message itself is still posted. A Marketplace
  listing lifts the limit.
- **The reaction read-back checks the message's first reaction**, so a reaction added after another
  one stays `acknowledged`.
- **Public channels only.** The app's scopes do not cover private channels or direct messages.

## Install

```bash
anlyon packs plan ./packs/slack
anlyon packs install ./packs/slack --yes --action post-message --action add-reaction
```

Every action sends `{{connection:slack}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Slack account. Send them to a connect link (`POST /api/v2/end-users/{endUserId}/connect-links`). A user who has not connected gets `409 END_USER_NOT_CONNECTED`, with a connect link when the environment has a default redirect URL. Any other call uses this environment's connected Slack account (`anlyon connections add slack --secret SLACK`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name SLACK=<your secret>`. Do this when the environment has more than one Slack account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## Scopes

The Slack app requests `chat:write channels:history channels:read channels:write.topic
reactions:write reactions:read`, listed in the catalogue and shown before consent.

## History

- 0.2.0 (2026-10-24): every action sends `{{connection:slack}}` instead of `{{secret:SLACK}}`. A call made for one of your users acts in their own Slack account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.1.0: first version.
