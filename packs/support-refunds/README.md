# anlyon/support-refunds

A support agent refunds a payment, leaves a note on the customer's HubSpot record, and tells the
team in Slack. Each step is a governed action: previewed, bound to an approval when a policy asks
for one, counted against a shared limit, and read back where the provider allows it.

## What it installs

| Action (installed name) | What it does | Impact | Read-back |
| --- | --- | --- | --- |
| `support-refunds-refund-payment` | Refunds part or all of one Stripe payment (the built-in `stripe.refund` adapter) | money, exact | Stripe's own refund record |
| `support-refunds-note-customer` | Adds a note to one HubSpot contact | 1 resource mutation | The note by id; its body must match |
| `support-refunds-post-to-support` | Posts one message to the support channel fixed at install | 1 resource mutation | The channel's latest message at the post's timestamp; its text must match |

`note-customer` is a reference to [`anlyon/hubspot#add-note`](../hubspot/README.md): the installer
copies that action's definition under this pack's name, so the two never drift apart.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| support-refunds: approve refunds over 100.00 | Requires approval when `input.amount > 10000` (minor units) |

| Suggested limit (created only with `--with-limits`) | |
| --- | --- |
| support-refunds: refunds per day | 500.00 USD |
| support-refunds: customer notes per day | 500 |
| support-refunds: support posts per day | 200 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **Slack answers HTTP 200 on most errors.** `chat.postMessage` returns `200` with `ok: false` when
  it refuses a post (a wrong channel, a revoked token). A declared action grades on the HTTP status,
  so a refused post is recorded `succeeded` and graded `acknowledged`. Only the read-back, which finds
  no message, keeps it from `confirmed`. The error is in the direction of "it happened". Treat an
  `acknowledged` Slack post as unconfirmed.
- **No provider idempotency for the note and the post.** Anlyon sends each write once and never
  repeats it. After an `unknown` outcome, reconcile before invoking again, or a second note or post
  can appear.
- **The note's read-back reads by the id HubSpot returns.** If the response is lost, the read-back
  cannot run and the effect stays `unknown` until an operator resolves it. The same holds for the
  Slack post, whose read-back needs the post's timestamp.
- **Stripe refunds are in one currency per install** (the `currency` parameter), and the key must
  match the `stripe_mode` parameter.

## Install

```bash
anlyon packs plan ./packs/support-refunds \
  --param stripe_account=acct_... --param slack_channel=C0123456789
anlyon packs install ./packs/support-refunds --yes \
  --param stripe_account=acct_... --param slack_channel=C0123456789 \
  --secret STRIPE_KEY=rk_test_...
```

The HubSpot note and the Slack post send `{{connection:hubspot}}` and `{{connection:slack}}`, so
nothing needs connecting before install. A call made for one of your users (`Anlyon-End-User`)
uses their own HubSpot and Slack accounts. Any other call uses this environment's connected ones
(`anlyon connections add hubspot --secret HUBSPOT`, `anlyon connections add slack --secret SLACK`).
Add `--credential secret` to bind them to those secrets by name. The refund always uses the stored
`STRIPE_KEY` and the account fixed at install, so it refunds from your own Stripe account whoever
the call is for.

Then review and enable the policy (`anlyon policies list`, or the console). Add `--with-limits` to
create the limits (needs `impact-limits:write`).

| Parameter | Meaning |
| --- | --- |
| `stripe_account` | The Stripe account refunds are made from (`acct_...`) |
| `stripe_mode` | `test` (default) or `live`. The key must be of this mode |
| `currency` | Lowercase ISO code, default `usd` |
| `slack_channel` | The channel id posts go to. Fixed at install; the agent cannot choose it |

## History

- 0.2.0 (2026-10-24): `note-customer` and `post-to-support` send `{{connection:hubspot}}` and
  `{{connection:slack}}`, from the catalogue packs they reference. An installed action keeps its form(
)  until `--update`; `--credential secret` installs the previous form.
- 0.1.0: first version.
