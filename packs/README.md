# Action Packs

A pack is an integration's tools, or a governed workflow, in one file: the secrets it needs, the
actions it adds (reads, and writes with a declared impact and, where the provider allows, a
read-back), the approval policies it suggests (installed **disabled**) and the impact limits it
suggests. Installing a pack makes the same API calls you could make by hand. Nothing about a pack
is enforced by the pack itself: every rule is the one Anlyon enforces for any declared action.

```bash
anlyon packs plan ./packs/outbound-sales            # what install would do; nothing is sent
anlyon packs install ./packs/outbound-sales --yes   # install
anlyon packs install ./packs/hubspot --yes \
  --action create-company --secret-name HUBSPOT=HUBSPOT_SALES   # one operation, your secret name
```

| Option | Meaning |
| --- | --- |
| `--action <name>` | Install only these actions (repeatable). Only the secrets, parameters, policies and limits they use come with them |
| `--credential connection\|secret` | How a connected account is sent. `connection` (the default): chosen at each call, see [Credentials](#credentials). `secret`: the workspace secret the pack names, which must exist |
| `--secret-name PACK=WORKSPACE` | Use a different secret name in your workspace (repeatable). Every `{{secret:PACK}}` is rewritten, and a renamed connected account is used by name |
| `--no-prefix` | Install actions under their own names, not `<short-name>-<name>` |
| `--with-limits` | Create the suggested limits instead of printing them |
| `--update` | Install a changed action as a new version instead of refusing |

The SDK takes the same options on `client.packs.install(manifest, { actions, credential, secretNames, noPrefix, withLimits, resolvePack })`.

## Credentials

Decided 2026-10-24. A pack's actions act in **the calling end user's own account** when the call is
made for one, and in the environment's connected account otherwise.

- Every connected account a catalogue or workflow pack uses is sent as
  `{{connection:<integration>}}`, for example `"Authorization": "Bearer {{connection:attio}}"`. The
  manifest declares it with its one secret of `kind: "connection"` for that `integrationId`. That
  secret's `hosts` must equal the catalogue entry's hosts.
- **Installed as it is** (the default), nothing needs to exist in the workspace. A call with the
  `Anlyon-End-User` header (`anlyon.forUser(id)` in the SDK) uses that end user's account for the
  integration, or answers `409 END_USER_NOT_CONNECTED`. A call without it uses the environment's
  connected account for the integration. With none, it fails before anything is sent. With more
  than one, it is refused as ambiguous.
- **Installed with `--credential secret`**, each `{{connection:<integration>}}` becomes
  `{{secret:<NAME>}}`, the secret the manifest declares. That connected account must exist, as
  before this decision. A call for an end user still uses the end user's account, because the secret
  is bound to the integration. Use it when an environment has more than one account for an
  integration. `--secret-name` does the same for the secret it renames.
- **The catalogue fixes where a connection may go.** At create and at every call the API checks a
  `{{connection:<integration>}}` against the catalogue entry's hosts, and sends it in a header and nowhere else.
  The installer refuses an action whose host is not among the declared secret's hosts.
- **A key made of several values** (an email and an API token, an Account SID and an auth token, a
  key and a token) is still one connection. The person gives each field at connect; Anlyon stores
  them encrypted together as one credential and never returns them. At dispatch they are composed as
  the catalogue entry declares: HTTP Basic (`base64(user:password)`) or the provider's own documented
  header form. The pack writes the header as for any key, for example
  `"Authorization": "Basic {{connection:jira}}"`. Every field is checked against the entry's pattern
  again when it is composed, and a provider that echoes a raw token has it redacted.
- **A per-account host** (`{subdomain}.zendesk.com`, `{site}.atlassian.net`, `{store}.myshopify.com`)
  is addressed as `https://{{connection.host}}/…`, in the URL and its read-back. The manifest's
  connection secret declares `"accountHost": "{subdomain}.zendesk.com"` (the catalogue's template)
  and `"hosts": []`. The host is the one the account was connected with: one DNS label under the
  provider's fixed domain, checked against the template at connect and again at every call. An
  action on it sends exactly one per-account connection and nothing else, and `{{connection.host}}`
  may only be the URL's whole host. Arbitrary customer hosts (self-managed GitLab) are not offered.
- **Adapters name a workspace secret.** `stripe.refund` and `resend.email_send` are fixed at install
  to one Stripe account or one sending domain, so their `credentialSecret` stays a secret name and
  that connected account must exist. They are for the workspace's own account.
- **A static secret** (`kind: "static"`, `{{secret:NAME}}`) is always the workspace's own value.
- **Existing installs are untouched.** The packs that adopted this bumped their version. An action
  installed earlier keeps `{{secret:NAME}}` until it is installed again with `--update`, and
  `--credential secret` installs the earlier form. An installer older than this decision refuses a
  pack that uses `{{connection:…}}` ("references no secret") and writes nothing.

The console's install dialog offers both (Accounts: chosen at each call, or connected accounts by
name). The operations screen after connecting an account installs bound to that account by name.

There are two kinds of pack. A **catalogue pack** is the full toolset of one integration
(`anlyon/hubspot`, `anlyon/github`): every read and write an agent routinely needs on that product's
objects, so a customer needs no other tool for it and the agent never holds the key. Account
administration (members, billing, permissions, webhooks) is left out. The console offers its actions
one by one after you connect the account, with **Turn on all reads**, and the catalogue names it as
the integration's `operationsPack`. A **workflow pack**
assembles a task across integrations and reuses catalogue actions by reference; the catalogue lists
it under each integration's `workflowPacks`.

| Pack | Kind | What it does | Reads / writes | Integrations |
| --- | --- | --- | --- | --- |
| [`anlyon/hubspot`](hubspot/README.md) | catalogue | Contacts, companies, deals, notes and associations: search and read them, create, update, move stages, archive | 11 / 18 | HubSpot |
| [`anlyon/github`](github/README.md) | catalogue | Issues, comments, labels and pull requests: search and read code and history, open, comment, review, merge | 15 / 17 | GitHub (API key) |
| [`anlyon/notion`](notion/README.md) | catalogue | Search, read pages, blocks and databases; create pages and database rows, write blocks, comment, archive | 9 / 14 | Notion (API key) |
| [`anlyon/intercom`](intercom/README.md) | catalogue | Contacts, conversations, companies and Help Center: search and read them, reply, note, assign, snooze, close | 14 / 16 | Intercom (API key) |
| [`anlyon/attio`](attio/README.md) | catalogue | People, companies, lists, notes and tasks: query and read them, create, update, add to lists, complete, delete | 11 / 15 | Attio (API key) |
| [`anlyon/asana`](asana/README.md) | catalogue | Workspaces, projects, sections and tasks: read them, create, update, comment, complete, follow, tag | 10 / 14 | Asana (API key) |
| [`anlyon/discord`](discord/README.md) | catalogue | Channels, messages, pins and threads: read them, post, reply, edit, react, pin, start and archive threads | 8 / 12 | Discord (bot token) |
| [`anlyon/pagerduty`](pagerduty/README.md) | catalogue | Incidents, services, on-call and maintenance: read them, open, acknowledge, note, reassign, snooze, resolve | 12 / 10 | PagerDuty (API key) |
| [`anlyon/sentry`](sentry/README.md) | catalogue | Projects, issues, events and releases: read them, resolve, reopen, assign, archive, prioritise | 7 / 11 | Sentry (API key) |
| [`anlyon/stripe`](stripe/README.md) | catalogue | Customers, payments, refunds, invoices, subscriptions and balance: read them, refund, manage customers, cancel | 15 / 8 | Stripe (API key) |
| [`anlyon/resend`](resend/README.md) | catalogue | Emails, domains, contacts and segments: read them, send, reschedule or cancel, manage contacts | 9 / 9 | Resend (API key) |
| [`anlyon/sendgrid`](sendgrid/README.md) | catalogue | Send an email or a template email; contacts, lists, templates, unsubscribes and bounces: read them, add and update contacts, manage lists, honour unsubscribes | 12 / 12 | SendGrid (API key) |
| [`anlyon/postmark`](postmark/README.md) | catalogue | Sent and received email, bounces, suppressions, templates and stats: read them, send to one recipient, reactivate a bounce, suppress or unsuppress an address | 12 / 5 | Postmark (API key) |
| [`anlyon/pipedrive`](pipedrive/README.md) | catalogue | Deals, people, organizations, activities and notes: search and read them, create, update, move stages, mark won or lost, log activities and notes, delete | 13 / 12 | Pipedrive (API key) |
| [`anlyon/front`](front/README.md) | catalogue | Conversations, messages, comments, tags and contacts: search and read them, reply, draft, comment, assign, archive, reopen, tag, manage contacts | 13 / 12 | Front (API key) |
| [`anlyon/airtable`](airtable/README.md) | catalogue | Bases, tables, records and comments: read and search them, create, update, upsert, delete, comment | 6 / 7 | Airtable (API key) |
| [`anlyon/mailchimp`](mailchimp/README.md) | catalogue | Audiences, members, tags, notes, segments and campaigns: search and read them, add or update members, change status, tag, note, archive, segment, send a test, schedule or unschedule a campaign | 12 / 12 | Mailchimp (API key) |
| [`anlyon/slack`](slack/README.md) | catalogue | Post, edit, react, set a channel's topic or purpose | 0 / 5 | Slack |
| [`anlyon/clickup`](clickup/README.md) | catalogue | Spaces, lists, tasks, comments, tags and checklists: find and read them, create, update, set status, assign, comment, tag, delete | 12 / 12 | ClickUp (API key) |
| [`anlyon/todoist`](todoist/README.md) | catalogue | Projects, sections, labels, tasks and comments: read and filter them, create, update, complete, reopen, move, delete, comment | 10 / 10 | Todoist (API key) |
| [`anlyon/calcom`](calcom/README.md) | catalogue | Event types, free slots, schedules and bookings: read them, book, reschedule, cancel, confirm, decline, mark no-shows, add guests | 9 / 8 | Cal.com (API key) |
| [`anlyon/calendly`](calendly/README.md) | catalogue | Event types, open times, meetings, invitees and no-shows: read them, book, share a single-use link, cancel, mark no-shows | 11 / 5 | Calendly (API key) |
| [`anlyon/gitlab`](gitlab/README.md) | catalogue | Projects, issues, merge requests and pipelines: read them, open, edit, comment, close, approve and merge, retry and cancel pipelines | 16 / 12 | GitLab (API key) |
| [`anlyon/vercel`](vercel/README.md) | catalogue | Deployments, build logs, aliases and domains: read them, redeploy, promote, roll back, cancel, delete | 9 / 5 | Vercel (API key) |
| [`anlyon/jira`](jira/README.md) | catalogue | Projects, issues, transitions and comments: search with JQL and read them, create, rename, label, prioritise, assign, transition, comment, delete | 9 / 9 | Jira (site, email and API token) |
| [`anlyon/zendesk`](zendesk/README.md) | catalogue | Tickets, comments, users and groups: search and read them, create tickets, reply, add internal notes, set status and priority, assign, tag | 8 / 7 | Zendesk (subdomain, email and API token) |
| [`anlyon/linear`](linear/README.md) | catalogue | Teams, workflow states, labels, issues and comments, over GraphQL: read and search them, create, update, assign, move, label, comment, archive | 7 / 8 | Linear |
| [`anlyon/linear-key`](linear-key/README.md) | catalogue | The same actions as `anlyon/linear`, for Linear connected with a personal API key | 7 / 8 | Linear (API key) |
| [`anlyon/monday`](monday/README.md) | catalogue | Boards, groups, items and updates, over GraphQL: read and search them, create items, set column values, move, post updates, archive, delete | 8 / 7 | monday.com (API token) |
| [`anlyon/trello`](trello/README.md) | catalogue | Boards, lists, labels, cards and comments: read and search them, create, update, move, archive, restore, delete, comment, label | 9 / 9 | Trello (API key and token) |
| [`anlyon/close`](close/README.md) | catalogue | Leads, contacts, opportunities, notes, tasks and activities: search and read them, create, update, delete leads, add notes, create and complete tasks | 11 / 9 | Close (API key) |
| [`anlyon/twilio`](twilio/README.md) | catalogue | Messages, media, phone numbers and calls: read them, send a text message, redact or delete a message, rename a number | 7 / 4 | Twilio (Account SID and Auth Token) |
| [`anlyon/google-calendar`](google-calendar/README.md) | catalogue | Events in a time range: list and read them, create, change and cancel events. Not offered in production until Google verifies Anlyon's app | 2 / 3 | Google Calendar |
| [`anlyon/gmail`](gmail/README.md) | catalogue | Send an email from the connected address (send only; graded `acknowledged`). Not offered in production until Google verifies Anlyon's app | 0 / 1 | Gmail |
| [`anlyon/support-refunds`](support-refunds/README.md) | workflow | Refund a payment, note it on the customer's CRM record, tell the support channel | 0 / 3 | Stripe (stored key), HubSpot, Slack |
| [`anlyon/outbound-sales`](outbound-sales/README.md) | workflow | Update a CRM contact, book a meeting, announce the win | 0 / 3 | HubSpot, Google Calendar, Slack |

## Manifest reference: `anlyon-pack/v1`

A pack is a directory with a `pack.json` and a `README.md`. The JSON Schema is
[`schema/anlyon-pack.v1.json`](schema/anlyon-pack.v1.json); the installer also enforces the rules
below that a schema cannot express.

```jsonc
{
  "format": "anlyon-pack/v1",
  "pack": "acme/crm-hygiene",          // <publisher>/<short-name>, lowercase
  "version": "0.1.0",                  // semantic version
  "description": "What the workflow does, in one sentence.",
  "parameters": [ ... ],               // optional: values fixed at install
  "secrets": [ ... ],                  // every credential an action uses
  "actions": [ ... ],                  // declared actions, or a built-in adapter
  "policies": [ ... ],                 // optional: installed disabled
  "limits": [ ... ]                    // optional: created only with --with-limits
}
```

### `parameters`

Values the person installing supplies once (`--param name=value`), such as a Slack channel id or a
Stripe account. `{{param:name}}` may appear in an action's URL path or query, body, read-back URL, or
adapter config. It may not appear in a header, and it can never set a host.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | `^[a-z][a-z0-9_]*$` |
| `description` | yes | Shown when the value is missing |
| `default` | no | Used when no value is given |
| `enum`, `pattern` | no | The value must be one of these, or match this |

### `secrets`

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Referenced as `{{secret:NAME}}`. `^[A-Z0-9_]+$`. For a connected account sent as `{{connection:<integration>}}`, the secret it binds to with `--credential secret` |
| `kind` | yes | `connection`: a connected account (by sign-in or with a key). `static`: a value the installer stores |
| `integrationId` | for `connection` | The integration, e.g. `hubspot`. See `anlyon connections integrations`. One `connection` secret per integration when actions use `{{connection:<integration>}}` |
| `hosts` | yes | The API hosts the secret may be sent to. Every action using the secret must address one of them. Empty with `accountHost` |
| `accountHost` | for a per-account host | The catalogue's host template, e.g. `{subdomain}.zendesk.com`. Actions using it address `https://{{connection.host}}/…` |
| `description` | no | Shown when a value is asked for |

A connected account sent as `{{connection:<integration>}}` needs nothing at install (see
[Credentials](#credentials)). One an action names (`{{secret:NAME}}`, an adapter's
`credentialSecret`) must exist before install; the installer stops and prints the command that
connects it (`anlyon connections add hubspot --secret HUBSPOT`). A static secret takes its value
from `--secret NAME=value`, or a prompt when interactive, and is bound to its hosts and to headers.
An existing secret is never overwritten.

### `actions`

An action is a **read** or a **write** (`kind`, `write` when omitted).

- A **read** (`"kind": "read"`) returns the provider's response to the caller and changes nothing. It
  declares no `impact` and no `verify`, is `GET` (or `POST` for a search that changes nothing, which
  its description says), and is logged like any call. Approval policies can still match it. The
  response is cut at 64 KB, so a list fixes its page size in the template and takes the provider's
  cursor as an input.
- A **write** is governed: it declares an `impact`, counted against limits, and can be held for an
  approval. Where the provider has a GET that shows the change it declares a `verify` read-back and its
  receipt is graded `confirmed`. Where it has none it omits `verify`, its description says
  `No read-back:` and why, and its receipt is graded `acknowledged`.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | `^[a-z0-9][a-z0-9-]{0,59}$`. Installed as `<short-name>-<name>` unless `--no-prefix` |
| `description` | yes | What a reviewer reads in the preview. **Put the action's limitations here** |
| `kind` | no | `read` or `write` (the default) |
| `method` | yes | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. A read is `GET` or `POST` |
| `urlTemplate` | yes | `https://` with a fixed host. May use `{{input.x}}` in the path and query. A query pair whose whole value is one input (`&cursor={{input.cursor}}`) is left out when that input is absent |
| `headers` | no | Credentials go here and nowhere else: `"Authorization": "Bearer {{connection:hubspot}}"` for a connected account, `"Bearer {{secret:NAME}}"` for a static secret |
| `bodyTemplate` | no | JSON. `"{{input.x}}"` alone as a value keeps the input's type |
| `inputSchema` | yes | The subset Anlyon supports: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `pattern`, `default`. No `maxLength`: bound a string with a `pattern` |
| `requiresApproval` | no | Every call waits for a person. Prefer a policy with a condition |
| `impact` | writes | `{ dimension, amount, bound }`: what one call changes. `amount` is an integer, `input.<path>` or `count(input.<path>)`. Not on a read |
| `verify` | writes, where possible | `{ url, status, match }`: one GET on the action's own host that reads the write back. `match` compares up to 10 paths (`messages.0.text`) with literals, `{{input.x}}` or `{{response.x}}`. A `*` segment matches any item of a list (`labels.*.name`); `"absent": true` holds only when none equals, for a removal. For a GraphQL API, `graphql: { query, variables }` makes it a POST of that fixed query instead: no placeholder in the query, no `mutation` or `subscription` anywhere in it, and each variable a literal or one `{{input.x}}` or `{{response.x}}`. Not on a read |
| `graphql` | no | `true` for a GraphQL operation: a `POST` whose `bodyTemplate` is `{ query, variables }`. The query is fixed text; only the variables take inputs. A read's query must be read-only (no `mutation` or `subscription`). A GraphQL API answers most errors with HTTP 200, so a write's receipt rests on its read-back |

An action may instead be a **reference** to another pack's action:
`{ "name": "note-customer", "ref": "anlyon/hubspot#add-note" }`. The installer copies the referenced
action under the new name before anything else runs, so a workflow pack never carries a second copy
of a definition. The CLI resolves `anlyon/<x>` to the sibling directory `../<x>/pack.json`; the SDK
takes a `resolvePack(id)` option. An unresolved reference is refused.

An action may instead use a built-in adapter (`stripe.refund`, `github.file_update`,
`resend.email_send`) with `adapter: { type, config, credentialSecret }`. The adapter's own hosts must
be among the credential secret's hosts.

### `policies`

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique per workspace environment. Installing again leaves an existing policy alone |
| `matchKind` | yes | `action` |
| `matchActionName` | yes | An action in this pack, unprefixed |
| `condition` | no | CEL over the input, checked against the action's input schema: `input.amount > 10000` |
| `effect` | yes | `require_approval` or `auto_deny`. **`auto_approve` is refused** |
| `requiredApprovals` | no | How many people must approve |

Policies always install **disabled**, whatever `enabled` says. The install summary lists them;
review and enable them yourself.

### `limits`

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | |
| `dimension` | yes | `money`, `resource_mutations`, or a unit the actions declare |
| `currency` | for `money` | Lowercase ISO code |
| `period` | yes | `day`, `month`, `total` |
| `amount` | yes | Positive integer (minor units for money) |
| `actionName` | no | An action in this pack, unprefixed |

Limits are created only with `--with-limits`, which needs the `impact-limits:write` scope.
Otherwise they are printed as suggestions.

## What the installer guarantees

- It decides everything from reads before it writes anything. A refused install changes nothing.
- An action whose host is not among the hosts of a secret or connection it uses is refused before any call.
- A `{{connection:<integration>}}` is listed in the plan as a `connection` step. Nothing is read or written for it.
- Installing twice is a no-op: an identical action is skipped. A changed one is refused unless
  `--update`, which installs it as a new action version.
- It never prints a secret value.

## Writing a pack

Write the limitations first, give every action a read-back that matches a value
this request set, and add recorded read-back responses under `fixtures/`. Then run the pack's
exercise (below) against a sandbox account at the provider, and expect every write to come back
graded `confirmed`.

## Exercising a pack against the real provider

Every catalogue pack has an `exercise.json`: one run through all of its actions, in an order that can
work, against your own test account. It creates what it needs, carries ids from one step to the next,
and cleans up after itself where the provider allows.

```bash
anlyon packs install ./packs/notion --yes                      # all of its actions
anlyon packs exercise ./packs/notion --need parent_page_id=...  # every action once, then a table
```

`--need` supplies what the run cannot create itself (the pack README lists each one). The run stops
at the first step that does not succeed and names it; turn off any approval policy you enabled, or
approve the request, before running. The table gives each step's outcome, receipt grade and effect
id.

```jsonc
{
  "needs": { "parent_page_id": "A page shared with the integration" },
  "steps": [
    { "action": "create-page", "input": { "parent_page_id": "{{needs.parent_page_id}}", "title": "Anlyon exercise {{run}}" }, "save": { "page_id": "id" } },
    { "action": "get-page", "input": { "page_id": "{{saved.page_id}}" } },
    { "action": "archive-page", "input": { "page_id": "{{saved.page_id}}" } }
  ]
}
```

`{{needs.x}}`, `{{saved.x}}` and `{{run}}` (a short id unique to the run) are filled inside strings;
a string that is exactly one of them takes the value whole, converted to the type the action's input
asks for. `save` reads a dot path from the provider's response.
