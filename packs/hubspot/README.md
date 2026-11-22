# anlyon/hubspot

The HubSpot CRM toolset an agent can be allowed to use. This is the **catalogue pack** for the
HubSpot integration: the console offers its actions one by one after you connect HubSpot ("What
may your agent do here?"), and you can install any subset from the CLI. Workflow packs such as
[`anlyon/support-refunds`](../support-refunds/README.md) reuse its actions by reference.

HubSpot is connected by signing in (OAuth). Anlyon holds the token, binds it to `api.hubapi.com` in
a request header and makes every call: the agent never holds it.

Reads (search, get, list) return HubSpot's response to the agent and are logged; approval and deny
policies can still apply. Writes are governed: each declares its impact, counts against a limit you
can set, can be put behind an approval policy, and gets a receipt, read back from HubSpot where
HubSpot has a read that shows the change.

## Reads

| Action | What it does | Inputs | Page size and next page |
| --- | --- | --- | --- |
| `search-contacts` | Searches contacts by name, email, phone or company, or lists all, most recently modified first (POST, changes nothing) | `query?`, `after?` | 20; `paging.next.after` as `after` |
| `get-contact` | One contact's main properties and the ids of its companies and deals | `contactId` | one contact |
| `get-contact-by-email` | The same, looked up by email; 404 when no contact has it | `email` | one contact |
| `search-companies` | Searches companies by name, domain, website or phone, or lists all (POST, changes nothing) | `query?`, `after?` | 20; `paging.next.after` as `after` |
| `get-company` | One company's main properties | `companyId` | one company |
| `search-deals` | Searches deals by name, description, type, pipeline or stage id, or lists all (POST, changes nothing) | `query?`, `after?` | 20; `paging.next.after` as `after` |
| `get-deal` | One deal's main properties and the ids of its contacts and companies | `dealId` | one deal |
| `list-deal-pipelines` | Every deal pipeline with its stages (id, label, order, probability, closed) | none | all; HubSpot does not page it |
| `get-property` | One property's definition and, for a dropdown, its options (the account's lifecycle stages, lead statuses, industries, deal types) | `objectType`, `propertyName` | one property |
| `list-associations` | The contacts, companies or deals associated with one record, with association labels | `objectType`, `objectId`, `toObjectType`, `after?` | 100; `paging.next.after` as `after` |
| `list-notes` | The notes on one contact, company or deal, newest first (POST, changes nothing) | `objectType` (`contact`, `company`, `deal`), `objectId`, `after?` | 10; `paging.next.after` as `after` |

The properties each read returns are fixed in the request: contacts `email`, `firstname`,
`lastname`, `phone`, `mobilephone`, `company`, `jobtitle`, `lifecyclestage`, `hs_lead_status`,
`hubspot_owner_id`, `city`, `country` and dates; companies `name`, `domain`, `website`, `phone`,
`industry`, `city`, `state`, `country`, `numberofemployees`, `annualrevenue`, `lifecyclestage`,
`hubspot_owner_id` and dates; deals `dealname`, `amount`, `dealstage`, `pipeline`, `closedate`,
`dealtype`, `hs_priority`, `description`, `hubspot_owner_id` and dates.

## Writes

| Action | What it does | Inputs | Impact | Read-back |
| --- | --- | --- | --- | --- |
| `create-contact` | Creates one contact with an email and a name | `email`, `firstname`, `lastname` | 1 | The contact by the id HubSpot returns; the email must match |
| `update-contact` | Changes a contact's name, email, phone, company name, job title, website, address or owner (not its stage or lead status) | `contactId`, any of `email`, `firstname`, `lastname`, `phone`, `mobilephone`, `company`, `jobtitle`, `website`, `address`, `city`, `state`, `zip`, `country`, `hubspot_owner_id` | 1 | none: every property is optional (graded `acknowledged`) |
| `update-contact-stage` | Sets one contact's lifecycle stage | `contactId`, `lifecyclestage` | 1 | The contact; the stage must match |
| `set-lead-status` | Sets one contact's lead status | `contactId`, `leadStatus` | 1 | The contact; the status must match |
| `add-note` | Adds a note to one contact | `contactId`, `body`, `timestamp` | 1 | The note by id; its body must match |
| `create-company` | Creates one company with a name and domain | `name`, `domain` | 1 | The company by id; the name must match |
| `update-company` | Changes a company's name, domain, website, phone, address, size, revenue, description or owner | `companyId`, any of `name`, `domain`, `website`, `phone`, `address`, `city`, `state`, `zip`, `country`, `numberofemployees`, `annualrevenue`, `description`, `hubspot_owner_id` | 1 | none: every property is optional (graded `acknowledged`) |
| `add-company-note` | Adds a note to one company | `companyId`, `body`, `timestamp` | 1 | The note by id; its body must match |
| `create-deal` | Creates one deal in the default pipeline | `dealname`, `amount`, `dealstage` | 1 | The deal by id; the name must match |
| `update-deal` | Changes a deal's name, amount, close date, type, priority, description or owner (not its stage or pipeline) | `dealId`, any of `dealname`, `amount`, `closedate`, `dealtype`, `hs_priority`, `description`, `hubspot_owner_id` | 1 | none: every property is optional (graded `acknowledged`) |
| `update-deal-stage` | Moves one deal to a stage of the default pipeline | `dealId`, `dealstage` | 1 | The deal; the stage must match |
| `add-deal-note` | Adds a note to one deal | `dealId`, `body`, `timestamp` | 1 | The note by id; its body must match |
| `associate-records` | Associates two records (contact, company, deal) with HubSpot's default unlabeled association | `fromObjectType`, `fromObjectId`, `toObjectType`, `toObjectId` | 1 | none: HubSpot has no read of one pair (graded `acknowledged`) |
| `remove-association` | Removes every association between two records; both records stay | `objectType`, `objectId`, `toObjectType`, `toObjectId` | 1 | none: HubSpot has no read of one pair (graded `acknowledged`) |
| `delete-note` | Moves one note to the recycling bin | `noteId` | 1 | The note with `archived=true`; it must show archived |
| `archive-contact` | Moves one contact to the recycling bin (restorable for 90 days) | `contactId` | 1 | The contact with `archived=true`; it must show archived |
| `archive-company` | Moves one company to the recycling bin (restorable for 90 days) | `companyId` | 1 | The company with `archived=true`; it must show archived |
| `archive-deal` | Moves one deal to the recycling bin (restorable for 90 days) | `dealId` | 1 | The deal with `archived=true`; it must show archived |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| hubspot: approve a stage change to customer | Requires approval when `input.lifecyclestage == 'customer'` |
| hubspot: approve closing a deal | Requires approval when the deal moves to `closedwon` or `closedlost` |
| hubspot: approve archiving a contact | Every contact archive requires approval |
| hubspot: approve archiving a company | Every company archive requires approval |
| hubspot: approve archiving a deal | Every deal archive requires approval |
| hubspot: approve deleting a note | Every note deletion requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| hubspot: contacts created per day | 100 |
| hubspot: contact updates per day (`update-contact-stage`) | 200 |
| hubspot: lead status changes per day | 200 |
| hubspot: notes per day (`add-note`) | 500 |
| hubspot: companies created per day | 50 |
| hubspot: deals created per day | 50 |
| hubspot: deal stage changes per day | 100 |
| hubspot: contact property updates per day | 200 |
| hubspot: company property updates per day | 100 |
| hubspot: deal property updates per day | 100 |
| hubspot: associations created per day | 200 |
| hubspot: associations removed per day | 100 |
| hubspot: company notes per day | 200 |
| hubspot: deal notes per day | 200 |
| hubspot: notes deleted per day | 50 |
| hubspot: contacts archived per day | 20 |
| hubspot: companies archived per day | 10 |
| hubspot: deals archived per day | 20 |

## Exercise

`exercise.json` drives `anlyon packs exercise ./packs/hubspot` against your own HubSpot account (use
a developer test account). It needs nothing made by hand: connect HubSpot and turn the actions on.

The run lists the deal pipelines, reads the lead status options, creates a contact (`anlyon-exercise-<run>@example.com`), a company
and a deal in the default pipeline, reads each back by id and by search (and the contact by email),
updates their properties, moves the contact's stage and lead status and the deal to
`qualifiedtobuy`, adds a note to each, associates contact, company and deal, lists the contact's
companies and notes, removes the contact-deal association, deletes the three notes and archives the
deal, the company and the contact. Everything it creates ends in the recycling bin; nothing it did
not create is changed. The searches may not show the run's own records yet (HubSpot indexes search
a few seconds behind writes); they pass on HubSpot's answer, not on finding them.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **No provider idempotency for creates.** Anlyon sends each write once and never repeats it. After
  an `unknown` outcome, reconcile before invoking again (`get-contact-by-email` for a contact), or a
  second contact, note, company or deal can appear. HubSpot itself refuses a second contact with the
  same email (409).
- **The property updates have no read-back.** `update-contact`, `update-company` and `update-deal`
  take any subset of their properties, and a read-back can only compare values each call is sure to
  set; matching the record's modification time instead would fail when HubSpot recalculates a
  property a moment after the write. Their receipts are graded `acknowledged`; `get-contact`,
  `get-company` or `get-deal` shows the result. They cannot clear a property (values must be
  non-empty).
- **Stage and lead status changes stay with their own actions.** `update-contact` cannot set
  `lifecyclestage` or `hs_lead_status`, and `update-deal` cannot set `dealstage` or `pipeline`, so
  the stage policies above cannot be bypassed through a property update.
- **HubSpot only moves a lifecycle stage forward.** Setting an earlier stage fails until the stage is
  cleared in HubSpot.
- **Deal stages are the default pipeline's ids.** `create-deal` and `update-deal-stage` take the
  seven default stage ids; a portal with custom pipelines uses other ids (see `list-deal-pipelines`),
  which these actions do not accept.
- **Associations have no read-back.** HubSpot has no read of one pair of records, and
  `list-associations` gives record ids as numbers where these actions take them as text, so a
  read-back cannot compare them; `associate-records` and `remove-association` are graded
  `acknowledged`, and `list-associations` shows the result.
  Associating records that already are associated changes nothing.
- **Associations use HubSpot's v4 paths.** HubSpot supports `/crm/v4/` until its `2027-03` API
  release. The date-versioned `2026-03` API has the same create and remove calls but no single-record
  list (only a batch read), so all three association actions stay on v4 and must move before then.
  The object, note and pipeline actions use `/crm/v3/`, which HubSpot has not set an end date for.
- **Archive read-backs use the documented `archived=true` read.** A record archived earlier also
  matches.
- **Search is a few seconds behind writes and stops at 10,000 results.** HubSpot limits search to five
  requests a second per account.
- **Responses are cut at 64 KB.** Pages are sized for that (20 records, 100 associations, 10 notes); a
  very long note body can still fill a `list-notes` page.
- **A deal's amount is recorded, not moved.** It counts as one mutation, never as money.

## Install

```bash
anlyon packs plan ./packs/hubspot
anlyon packs install ./packs/hubspot --yes
```

Every action sends `{{connection:hubspot}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own HubSpot account. Send them to a connect link (`POST /api/v2/end-users/{endUserId}/connect-links`). A user who has not connected gets `409 END_USER_NOT_CONNECTED`, with a connect link when the environment has a default redirect URL. Any other call uses this environment's connected HubSpot account (`anlyon connections add hubspot --secret HUBSPOT`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name HUBSPOT=<your secret>`. Do this when the environment has more than one HubSpot account. A call made for one of your users still uses their own account.

Install only some operations, under a secret name your workspace already uses, without the prefix:

```bash
anlyon packs install ./packs/hubspot --yes \
  --action search-contacts --action get-contact --action add-note \
  --secret-name HUBSPOT=HUBSPOT_SALES --no-prefix
```

Then review and enable the policies (`anlyon policies list`, or the console). Add `--with-limits` to
create the limits (needs `impact-limits:write`).

## Scopes

The HubSpot app requests `crm.objects.contacts.write crm.objects.contacts.read
crm.objects.companies.write crm.objects.companies.read crm.objects.deals.write
crm.objects.deals.read`, listed in the catalogue and shown before consent. Every action here works
within them: HubSpot's notes endpoints take the contacts scopes, and the associations, pipelines
and property reads accept any of the object scopes.

Left out because they need a scope the app does not request:

| Operation | Needs |
| --- | --- |
| Owners (resolve `hubspot_owner_id` to a person) | `crm.objects.owners.read` |
| Tickets | `tickets` |

Left out although the scopes allow them: tasks (HubSpot's tasks endpoints take the contacts
scopes) and calls, emails and meetings logged on the timeline. They are the next candidates.

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:hubspot}}` instead of `{{secret:HUBSPOT}}`. A call made for one of your users acts in their own HubSpot account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the full CRM toolset. Eleven reads (search and get contacts, companies and deals, contact
  by email, deal pipelines, property definitions, associations, notes) and eleven new writes (property updates for contacts,
  companies and deals, notes on companies and deals, note deletion, associate and remove
  associations, archive contacts, companies and deals), with approval policies for archive and
  delete and a limit for each. `update-contact-stage` now says HubSpot only moves a stage forward.
  Existing actions are marked `kind: write`.
- 0.1.0: first version. `add-note` and `update-contact-stage` moved here from the workflow packs,
  which now reference them.

Sources, checked 2026-10-15:
[contacts search](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/search/search-contacts),
[get](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/get-contact),
[create](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/create-contact),
[update](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/update-contact),
[archive](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/delete-contact),
[contacts guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide);
[companies search](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/companies/search/search-companies),
[get](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/companies/get-company),
[update](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/companies/update-company),
[archive](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/companies/delete-company);
[deals search](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/search/search-deals),
[get](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/get-deal),
[update](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/update-deal),
[archive](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/delete-deal),
[deals guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide);
[notes guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/guide),
[create](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/create-note),
[delete](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/delete-note),
[search](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/search/search-notes);
[CRM search](https://developers.hubspot.com/docs/api-reference/legacy/crm/search-the-crm);
[associations guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/associations/associate-records/guide),
[list](https://developers.hubspot.com/docs/api-reference/legacy/crm/associations/associate-records/get-associations),
[associate (default)](https://developers.hubspot.com/docs/api-reference/legacy/crm/associations/associate-records/update-association),
[remove](https://developers.hubspot.com/docs/api-reference/legacy/crm/associations/associate-records/delete-association),
[2026-03 associations](https://developers.hubspot.com/docs/api-reference/2026-03/crm/associations/associate-records/guide);
[pipelines](https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/get-pipelines);
[property](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/get-property);
[tasks scopes](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/tasks/create-task);
[date-based versioning](https://developers.hubspot.com/changelog/introducing-date-based-api-versioning).
