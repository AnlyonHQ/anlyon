# anlyon/outbound-sales

A sales agent qualifies a contact in HubSpot, books a meeting on Google Calendar and announces the
win in a Slack channel. Each step is a governed action: previewed, bound to an approval when a
policy asks for one, counted against a shared limit, and read back.

## What it installs

| Action (installed name) | What it does | Impact | Read-back |
| --- | --- | --- | --- |
| `outbound-sales-update-contact` | Sets one HubSpot contact's lifecycle stage | 1 resource mutation | The contact; its stage must match |
| `outbound-sales-book-meeting` | Creates one event on the primary Google Calendar and invites the attendees | 1 resource mutation | The event by id; its summary must match |
| `outbound-sales-announce-win` | Posts one message to a public Slack channel the app is in | 1 resource mutation | The channel at the message's timestamp; the text must match |

`update-contact` is a reference to [`anlyon/hubspot#update-contact-stage`](../hubspot/README.md) and
`announce-win` to [`anlyon/slack#post-message`](../slack/README.md): the installer copies those
actions' definitions under this pack's names, so they never drift apart.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| outbound-sales: approve a stage change to customer | Requires approval when `input.lifecyclestage == 'customer'` |
| outbound-sales: approve meetings with more than three attendees | Requires approval when `size(input.attendees) > 3` |

| Suggested limit (created only with `--with-limits`) | |
| --- | --- |
| outbound-sales: contact updates per day | 200 |
| outbound-sales: meetings per day | 50 |
| outbound-sales: announcements per day | 50 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **No email.** This pack sends none. Governed email, counted per recipient, is the Resend adapter.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown`
  outcome, reconcile before invoking again, or a second event or message can be created.
- **The Slack limitations apply to `announce-win`.** Slack answers HTTP 200 on most errors, and its
  history read-back is rate-limited for an app outside the Slack Marketplace: see
  [`anlyon/slack`](../slack/README.md#limitations).
- **The contact read-back can match a stage the contact already had.** It proves the stage is now
  what was asked, not that this call changed it.
- **The event read-back reads by the id Google returns.** If the response is lost, the read-back
  cannot run and the effect stays `unknown` until an operator resolves it.

## Install

```bash
anlyon packs plan ./packs/outbound-sales
anlyon packs install ./packs/outbound-sales --yes
```

Every action sends `{{connection:<integration>}}`, so nothing needs connecting before install. A
call made for one of your users (`Anlyon-End-User`) uses their own HubSpot, Google Calendar and
Slack accounts. Any other call uses this environment's connected ones (`anlyon connections add
hubspot --secret HUBSPOT`, and the same for `google-calendar` and `slack`). Add
`--credential secret` to bind them to the secrets `HUBSPOT`, `GOOGLE_CALENDAR` and `SLACK` by name.

Then review and enable the policies (`anlyon policies list`, or the console). Add `--with-limits`
to create the limits (needs `impact-limits:write`).

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:<integration>}}`, so it acts in the calling
  end user's own account, or this environment's connected account. An installed action keeps its form(
)  until `--update`; `--credential secret` installs the previous form.
- 0.2.0 (2026-10-13): `send-email` removed with its policy and limit, and the pack no longer needs
  a Gmail account. A confirmed Gmail read-back needs a restricted Google scope, which Anlyon's app
  does not request. `announce-win` added, by reference to `anlyon/slack#post-message`.
- 0.1.0: first version.
