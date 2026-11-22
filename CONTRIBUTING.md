# Contributing to Anlyon

Thank you for helping. Bug reports, fixes, new packs and documentation improvements are all welcome.

## How changes reach this repository

This repository is published from Anlyon's own repository on every release, as one commit per release. That changes one thing for you:

1. Open your pull request here as usual. It is reviewed here, in public.
2. Once it is approved, a maintainer applies it to the upstream repository with you credited as the author (your name, email and sign-off are kept).
3. The next release carries your change back here. We then close your pull request with a link to that release.

Your pull request is therefore closed rather than merged, but your commit, authorship and sign-off are preserved.

## Developer Certificate of Origin

Every commit must be signed off, certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```text
Developer Certificate of Origin
Version 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Sign off by adding a line to each commit message, which `git commit -s` does for you:

```text
Signed-off-by: Your Name <you@example.com>
```

A check on every pull request refuses commits without it.

In the certificate, "the open source license indicated in the file" means the licence of the directory your change lands in, listed below.

## Licences and SPDX headers

Your contribution is licensed under the licence of the directory it lands in, the same terms the rest of that directory is under:

| Where | Licence | SPDX identifier |
|---|---|---|
| `server/`, `dashboard/`, `packs/`, `packages/`, `deploy/`, including any `ee/` directory | Elastic License 2.0 | `Elastic-2.0` |
| `sdks/` | MIT | `MIT` |

Start every new source file with an SPDX header naming that licence, as its first line (after a shebang, if there is one):

```ts
// SPDX-License-Identifier: Elastic-2.0
```

```python
# SPDX-License-Identifier: MIT
```

Do not move code between these areas in a pull request: code copied from an Elastic-licensed directory into `sdks/` would change its licence. Please open an issue before changing anything under an `ee/` directory, because we may need a separate contributor agreement before we can accept it.

## Before you open a pull request

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

- Keep a pull request to one change. Small ones are reviewed fastest.
- Add or update tests with the change.
- For a change to a published package under `sdks/`, add a changeset (`pnpm changeset`).
- For anything large (a new API surface, a schema change), open an issue first so we can agree on the shape before you spend the time.

## Reporting bugs

Open an issue with the version, how you run Anlyon, what you did, what you expected and what happened. Please do not report security problems in issues: see [SECURITY.md](SECURITY.md).
