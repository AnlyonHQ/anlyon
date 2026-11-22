# @anlyon/known-vendors

The hand-checked list of vendors whose own remote MCP server Anlyon may name, and the rule that
checks each one (`publisherVerdict`). One list, read by:

| reader | what it does with it |
| --- | --- |
| the API (`server`) | the integration resolver (`core/connections/integration-route.ts`, which re-exports the list from its old path `known-vendors.ts`), and the public `GET /api/v2/mcp-vendors` |
| the console (`dashboard`) | `/mcp-servers/new?server=<slug>`: a slug is looked up here and nowhere else, so a link can only prefill a server from this list |
| anlyon.com (the marketing site) | the directory at `/mcp-servers` and one page per vendor |
| anlyon.dev | reads the list from `GET /api/v2/mcp-vendors` |

A server extension may add vendors of its own at boot (`api.vendors.add`,
`server/src/core/extensions/README.md`), and a console extension through its `vendors`
(`dashboard/src/lib/extensions.ts`). The resolver, the public endpoint and the console's links
then read the list and the added vendors together; every rule below applies to both.

## The trust root

`domains` and `githubOrgs` are set by hand from the vendor's own site. A server is the vendor's
when both hold:

- its MCP Registry namespace is one the registry verified as the vendor's: `io.github.<org>` for
  one of `githubOrgs`, or a reverse-DNS name under one of `domains`;
- its endpoint is plain https on one of `domains`, with no credentials, port or fragment.

An entry that fails is a mistake in this file: the resolver does not suggest it, the public
endpoint and anlyon.com leave it out.

## Slugs

`slug` is the vendor's id in links. Each was made from the name by `slugify` (lowercase, each run
of anything but a letter or digit becomes one hyphen: `monday-com`, `hugging-face`), and it never
changes afterwards, because links to it are already out. Unique, tested.

## `proven`

The only field that lets a surface say a vendor's server works with Anlyon. Set it only after a
recorded live run against that vendor's server passes, with a signed-in person: consent, the code
exchange and refresh, and listing and calling its tools through Anlyon. Only Linear is set (it
passed on 2026-11-05).

## `signIn` and `oauthClient`

Optional, and read only by anlyon.com's vendor pages. `signIn` says how the server signs a client
in, and `oauthClient: "preregistered"` that its authorization server offers a client no way to
register itself. Set either only with `signInSource`: a recorded answer of the endpoint
(`SIGN_IN_RECORD`, six vendors), or a page of the vendor's own documentation on one of its
`domains` that states the method plainly (fifteen vendors, read 2026-11-13; the test checks the
host). Never from memory, and no endpoint is probed for it. Unset means no record: Exa, Figma,
Hugging Face and PayPal today. Neither says a sign-in through Anlyon has been run: that is
`proven`. Neither is in the public list.

## `products`

Optional display names of the vendor's products that its one server serves (Atlassian: Jira,
Confluence), so its page on anlyon.com can carry the names people search. It makes no new page:
`/mcp-servers/jira` redirects to `/mcp-servers/atlassian` (`vendorByProductSlug`). A product's
slug must not be a vendor's slug; tested.

## Changing it

Edit `src/index.ts`, then `pnpm --filter @anlyon/known-vendors test`. The server and console pick
it up on their next build.
