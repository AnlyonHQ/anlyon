# anlyon/stripe

The Stripe toolset an agent needs for customers, payments, refunds, invoices and subscriptions. This
is the **catalogue pack** for the Stripe integration: the console offers its actions one by one
after you connect Stripe, and you can install any subset from the CLI.

Stripe is connected with a restricted API key you create in your own account, not by signing in.
Anlyon checks the key with Stripe before it stores it, binds it to `api.stripe.com` in a request
header, and makes every call itself; the agent never holds the key.

Reads return Stripe's response to the agent and are logged. Writes are governed: each declares its
impact, counts against a limit, can be put behind an approval, and gets a receipt. Every declared
write is read back from Stripe. The refund is the built-in `stripe.refund` adapter, which counts
money and uses Stripe's idempotency key.

Requests send `Stripe-Version: 2026-09-30.endive`, so responses keep this shape whatever your
account's default API version is. (The refund adapter uses your account's default version.)

## Restricted key permissions

In Stripe, open Developers, API keys, Create restricted key, and set:

| Resource | Permission | Used by |
| --- | --- | --- |
| Customers | Write | `create-customer`, `update-customer`, `delete-customer`, and the customer reads |
| PaymentIntents | Read | `list-payment-intents`, `get-payment-intent`, and the refund's preview |
| Charges | Read | `list-charges`, `get-charge`, and the refund's preview (it expands the latest charge) |
| Refunds | Write | `refund-payment`, `list-refunds`, `get-refund` |
| Invoices | Write | `finalize-invoice`, `void-invoice`, and the invoice reads |
| Subscriptions | Write | `cancel-subscription`, `set-subscription-cancel-at-period-end`, and the subscription reads |
| Balance | Read | `get-balance`, `list-balance-transactions` |

Write includes Read. Leave everything else at None. Install only the actions you want, and you can
lower a permission to match: for example, Invoices Read is enough if you do not install
`finalize-invoice` or `void-invoice`. The refund also reads your account (`GET /v1/account`) to
check that the key belongs to the configured account. Stripe groups some of these resources
differently in the Dashboard (refunds can appear next to charges), and a refused call names the
permission it needs in its error, so add that one if a call is refused. Use a test-mode key
(`rk_test_...`) until you have run the exercise.

## Reads

Lists are newest first. Page through them by passing the last item's id as `starting_after`, until
`has_more` is false. Search pages use `page` with the `next_page` value instead.

| Action | What it does | Inputs | Page size |
| --- | --- | --- | --- |
| `list-customers` | Lists customers, optionally with exactly this email (case-sensitive) | `email`, `starting_after` | 20 |
| `get-customer` | One customer; a deleted one returns only `id` and `deleted: true` | `customer_id` | |
| `search-customers` | Searches customers with Stripe's search query language | `query`, `page` | 20 |
| `list-payment-intents` | Lists payment intents, optionally for one customer | `customer`, `starting_after` | 10 |
| `get-payment-intent` | One payment intent: amount, amount received, status, latest charge | `payment_intent_id` | |
| `list-charges` | Lists charges, optionally for one customer or payment intent | `customer`, `payment_intent`, `starting_after` | 10 |
| `get-charge` | One charge: amounts, refunded, disputed, outcome, card details | `charge_id` | |
| `list-refunds` | Lists refunds, optionally for one charge or payment intent | `charge`, `payment_intent`, `starting_after` | 20 |
| `get-refund` | One refund: amount, status, reason | `refund_id` | |
| `list-invoices` | Lists invoices, optionally by customer, subscription or status | `customer`, `subscription`, `status`, `starting_after` | 5 |
| `get-invoice` | One invoice with its line items | `invoice_id` | |
| `list-subscriptions` | Lists subscriptions, optionally by customer, price or status (`all` for every status) | `customer`, `price`, `status`, `starting_after` | 10 |
| `get-subscription` | One subscription: status, cancellation fields, items and current period | `subscription_id` | |
| `get-balance` | The available and pending balance per currency | none | |
| `list-balance-transactions` | Lists balance transactions, optionally by type, payout or source | `type`, `payout`, `source`, `starting_after` | 25 |

## Writes

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `refund-payment` | Refunds part or all of a payment intent (adapter `stripe.refund`) | `paymentIntent`, `amount` (minor units), `currency`, `reason` | The refund, by id or by the effect id in its metadata, until it is `succeeded` |
| `create-customer` | Creates a customer | `email`, `name`, `description`, `phone`, `metadata` | The new customer; `email` must match |
| `update-customer` | Changes email, name, description or phone, or merges metadata | `customer_id`, `email`, `name`, `description`, `phone`, `metadata` | The customer; `id` must match, and `email` and `name` must equal Stripe's answer to the update |
| `delete-customer` | Deletes a customer permanently, cancelling its active subscriptions | `customer_id` | The customer; `deleted` must be true |
| `cancel-subscription` | Cancels a subscription now | `subscription_id`, `invoice_now`, `prorate`, `comment` | The subscription; `status` must be `canceled` |
| `set-subscription-cancel-at-period-end` | Sets whether a subscription ends at the end of its period | `subscription_id`, `cancel_at_period_end` | The subscription; `cancel_at_period_end` must match |
| `finalize-invoice` | Finalizes a draft invoice with automatic collection off | `invoice_id` | The invoice; `status` must be `open` |
| `void-invoice` | Voids a finalized, unpaid invoice | `invoice_id` | The invoice; `status` must be `void` |

The refund takes three install parameters: `stripe_account` (the `acct_...` the key must belong to),
`stripe_mode` (`test` or `live`, which the key must match) and `currency` (the one currency it
refunds in, `usd` by default).

| Policy (installed **disabled**) | Effect |
| --- | --- |
| stripe: approve refunds over 100.00 | A refund above 10000 minor units requires approval |
| stripe: approve deleting a customer | Every customer deletion requires approval |
| stripe: approve canceling a subscription | Every cancellation requires approval |
| stripe: approve scheduling a subscription to end | Setting `cancel_at_period_end` to true requires approval |
| stripe: approve voiding an invoice | Every void requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| stripe: refunds per day | 500.00 USD (money) |
| stripe: customers created per day | 100 |
| stripe: customers updated per day | 200 |
| stripe: customers deleted per day | 10 |
| stripe: subscriptions canceled per day | 10 |
| stripe: subscription renewals changed per day | 20 |
| stripe: invoices finalized per day | 50 |
| stripe: invoices voided per day | 10 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **No idempotency on declared writes.** Stripe accepts an `Idempotency-Key`, but a declared action
  has no per-call key to send. After an `unknown` outcome, reconcile before invoking again, or
  `create-customer` can create a second customer. The refund adapter does send a key.
- **`update-customer` proves the update was stored, not which fields changed.** Every field is
  optional, so the read-back compares the stored email and name with Stripe's answer to the update.
- **Cancel, void and delete read-backs can match a resource that was already in that state.**
- **`finalize-invoice` on a zero-amount invoice** marks it paid, so its read-back does not match and
  the receipt stays acknowledged. It sets `auto_advance=false`, so Stripe neither charges nor emails
  the customer because of it; the customer can still pay the hosted invoice.
- **Search lags writes** by up to a minute (more during an outage) and is not available to accounts
  in India. Use `get-*` or `list-*` to check a change.
- **The money limit is in USD.** If you install with another `currency`, edit the limit's currency.
- **Reads return full Stripe objects**, cut at 64 KB. A payment intent includes its `client_secret`.

## Left out

- Creating charges, payment intents, payouts, transfers, top-ups, or confirming or capturing a
  payment: these move money, and the only money movement here is the refund adapter.
- Creating subscriptions, invoices or invoice items, and changing a subscription's prices or
  quantities: they bill a customer and can charge them at once.
- Sending an invoice (`/send`): it emails the customer, and nothing on the invoice shows it was sent,
  so it cannot be read back.
- Payment methods, disputes, products and prices, Connect accounts, webhooks, API keys and account
  settings: account administration or out of the day-to-day scope.

## Exercise

`exercise.json` drives `anlyon packs exercise ./packs/stripe` with a **test-mode** key. It creates its
own customer and deletes it at the end. It needs, made by hand in test mode:

| Need | What |
| --- | --- |
| `payment_intent_id` | A succeeded payment intent in the pack's currency with at least 1.00 refundable; the run refunds 1.00 |
| `draft_invoice_id` | A draft invoice made for this run only, collection method "send invoice", with at least one line item; the run finalizes and voids it |
| `subscription_id` | A subscription made for this run only (a trial on a test customer is enough); the run sets and clears `cancel_at_period_end`, then cancels it |

Make a new draft invoice and subscription for each run.

## Install

```bash
anlyon packs plan ./packs/stripe --param stripe_account=acct_... --param stripe_mode=test
anlyon packs install ./packs/stripe --yes --param stripe_account=acct_... --param stripe_mode=test \
  --action list-customers --action get-customer --action refund-payment
```

Every action sends `{{connection:stripe}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Stripe account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/stripe`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Stripe account (`anlyon connections add stripe --secret STRIPE`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name STRIPE=<your secret>`. Do this when the environment has more than one Stripe account. A call made for one of your users still uses their own account.

`refund-payment` uses Anlyon's Stripe refund adapter, which is fixed at install to one account (`stripe_account`). It names the `STRIPE` secret, so it needs that connected account before it installs, and it is for your own account. Called for one of your users, it would use their key, and it refuses because the account differs.

Then review and enable the policies you want. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.2.0 (2026-10-24): every action sends `{{connection:stripe}}` instead of `{{secret:STRIPE}}`. A call made for one of your users acts in their own Stripe account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.1.0: first version.

Sources: https://docs.stripe.com/api/versioning, https://docs.stripe.com/api/customers/list,
https://docs.stripe.com/api/customers/retrieve, https://docs.stripe.com/api/customers/search,
https://docs.stripe.com/api/customers/create, https://docs.stripe.com/api/customers/update,
https://docs.stripe.com/api/customers/delete, https://docs.stripe.com/api/metadata,
https://docs.stripe.com/api/payment_intents/list, https://docs.stripe.com/api/charges/list,
https://docs.stripe.com/api/refunds/list, https://docs.stripe.com/api/invoices/list,
https://docs.stripe.com/api/invoices/finalize, https://docs.stripe.com/api/invoices/void,
https://docs.stripe.com/api/subscriptions/list, https://docs.stripe.com/api/subscriptions/update,
https://docs.stripe.com/api/subscriptions/cancel, https://docs.stripe.com/api/balance/balance_retrieve,
https://docs.stripe.com/api/balance_transactions/list, https://docs.stripe.com/keys/restricted-api-keys,
checked 2026-10-15. The single-object `get-*` reads follow the same objects these pages document.
