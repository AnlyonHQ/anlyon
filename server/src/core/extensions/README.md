# Server extensions

Code that is not part of the core server registers at boot through one typed API, and core never
names it. With no extension present the server is the self-host core, and every hook below
answers its default.

## Where extensions live

An extension is a directory under the server's own `extensions/` directory whose `index` module
default-exports a `ServerExtension` (`registry.ts`):

| Running from | Looked for at |
| --- | --- |
| source (`tsx src/index.ts`) | `src/extensions/<name>/index.ts` |
| the build (`node dist/index.js`) | `dist/extensions/<name>/index.js` |

`tsup.config.ts` compiles every `src/extensions/*/index.ts` next to `dist/index.js`, with shared
chunks, so an extension uses the server's own module instances (one database pool, one Redis
client, one module registry). `loader.ts` imports each one in name order at boot, before the
module registry is read and before the first request, and calls its `register(api)`. A directory
whose name starts with `_` or `.` is skipped. A module that does not default-export a
`ServerExtension`, or a registration that throws, stops the boot.

An extension may also default-export its module table from `<name>/modules.ts` (plain data), so
tools read the module registry without loading it (`directory.ts`, `defineExtensionModules`; used
by `scripts/openapi-edition.ts`).

## The edition: an extension's manifest

`<name>/extension.json` is the extension's manifest, plain data read synchronously
(`manifest.ts`). Its one key, `edition`, takes one value, `"cloud"`: the build that carries an
extension declaring it runs the cloud edition, whatever `EDITION` says, and no build without one can
(`core/edition/edition.ts`; `EDITION=cloud` there stops the boot). It is a manifest, not a call in
`register(api)`, because the edition is read while modules load, before any extension registers,
and by scripts that load none. The build copies each manifest next to the compiled `index`
(`tsup.config.ts`); an extension without an `index` declares nothing. `api.edition` is the decided
edition, so the extension that declared cloud always sees `cloud`.

`ANLYON_EXTENSIONS=none` loads no extension and reads no manifest: the core alone, as the public
tree runs, for a developer of a tree that carries extensions.

An extension that serves operations carries their API contract too, at the same relative paths as
the server: `<name>/openapi.yaml` (a fragment: `tags`, `paths`, `components` and
`x-anlyon-extends`), `<name>/contracts/sdk-operation-support.json`,
`<name>/contracts/breaking-change-acknowledgements.json`, `<name>/docs/generated/api-examples.json`
and `<name>/docs/API_CHANGELOG.md`. `scripts/contract.ts` merges them after the core's, in name
order, and every contract tool reads the merged contract; the server's own `openapi.yaml` holds only
what core modules serve (`docs/API_CONTRACT.md`).

Tests do not load extensions on their own, and run under the edition test override
(`tests/support/edition.ts`): `EDITION` alone decides, cloud included. A core test that needs a plan, a sink or a brake
registers one it defines (`tests/support/plan-fixture.ts`); an extension's tests register the
extension themselves.

## The API

| Hook | What it does | Without an extension |
| --- | --- | --- |
| `modules.define(id, definition)` | Adds a module to the registry (`core/edition/modules.ts`). Routes, sweeps, start tasks and the edition's OpenAPI document gate on it exactly as on a core module. An id is defined once and never shadows a core module. | Only core modules exist; an unknown id is never enabled. |
| `routes.mount(module, path, router)` | Mounts a Hono router at `path` when the edition enables `module`; `path` must be one the module declares (`api/mount-module.ts`). Extension routes come after every core route and before the 404 handler (`api/index.ts`, `bindExtensionRoutes`). | No extra routes. |
| `sweeps.add(sweep)` | Adds a periodic maintenance sweep to the worker manager (`workers/manager.ts`), gated by its `module` and its own `enabled()`. | Core's sweeps only. |
| `lifecycle.onStart(task)` | Work run once at boot, before workers start and before traffic, in the editions its `module` enables. A failure stops the boot. | Nothing. |
| `lifecycle.onStop(task)` | Work run at shutdown, before the HTTP server closes. Errors are logged, never thrown. | Nothing. |
| `plans.provide(provider)` | The limits of each plan (`core/plans/limits.ts`): `limits(plan, workspace)`, `purchasable()` (whether a larger plan can be bought now; limit messages and plan-feature gates read it) and `epoch()` (changes when cached limits are stale). | Every workspace gets `SELF_HOSTED_LIMITS`; nothing can be bought; epoch 0. |
| `productEvents.provide(sink)` | Where product events go (`lib/product-events.ts`): `capture`, `captureMilestoneOnce`, `captureUserSignedUp`, `captureMcpToolCall`, and `enabled()`. Core calls them fire-and-forget; a sink failure never reaches a request. | Every event is a no-op, and MCP calls are not timed. |
| `workAdmission.provide(brake)` | The emergency brake (`core/billing/work-admission.ts`): `expensiveWorkPaused()` refuses new expensive work with 503 `EXPENSIVE_WORK_PAUSED` (`api/middleware/expensive-work.ts`, function calls); `modelCallsPaused()` refuses model-provider calls (`core/billing/memory-admission.ts`). | Nothing is paused. |
| `logPartitions.add(spec)` | A partitioned log table the extension's migrations leave to the partition setup (`core/archival/partitioned-logs.ts`): the log partition sweep keeps it a week ahead and the archival worker archives and drops its expired partitions, like core's message log. The same description must be in its database manifest (below). | Core's message log only. |
| `vendors.add(vendor)` | A vendor whose own MCP server this edition may name, beside the checked-in list (`packages/known-vendors`; `core/connections/known-vendors.ts`). The integration resolver, the shared client identity for a verified vendor's endpoint and `GET /api/v2/mcp-vendors` read the list and the added vendors together. It must pass `publisherVerdict` and take a slug no other vendor has, or the boot stops. | The checked-in list only. |
| `oauth.retireScopes(scopes)` | OAuth consent groups the edition once issued and no longer does (`core/auth/oauth-unknown-scopes.ts`). On authorize, consent and the token endpoint, a request naming one beside live scopes has it dropped and goes on, so a client still configured with it keeps its grant; a request naming only retired groups, and registration, are refused by name. | Every scope we do not issue is refused by name. |

`api.name` is the extension's name and `api.edition` the edition this process runs.

## The database

Core's schema is `src/db/schema`, its migration stream `src/db/migrations` (bookkept in
`drizzle.__core_migrations`). An extension that owns tables, or columns of core's tables, describes
them in a **database manifest**, `<name>/db/database.json`: plain data, read before boot by the
migrator (`src/db/migrate.ts`), the partition setup (`src/scripts/setup-log-partitions.ts`) and
`pnpm check:migrations`, always from `src/extensions` under the server's root (the image keeps
`src/`). Core reads it with `extensionDatabaseManifests` (`directory.ts`).

| Key | What it is |
| --- | --- |
| `migrations: { folder, table, baselineOfHistory? }` | The extension's migration stream, applied after core's, in extension name order; `table` is its bookkeeping table in the `drizzle` schema (`__<name>_migrations`). Its own drizzle-kit config sits next to it (`<name>/db/drizzle.config.ts`); `pnpm db:generate` runs every stream. `baselineOfHistory` marks a first migration that is a baseline of the earlier single history (`src/db/migration-streams.ts`). |
| `history: { folder }` | The earlier single history, for the one extension that keeps it: the migrator finishes it on a database that has not adopted the streams. |
| `partitionedLogs: [...]` | Partitioned log tables the setup creates; registered at boot too, with `logPartitions.add`. |

An extension's columns on a core table are declared in the extension as its own view of that
table (core exports the column builders, for example `workspaceColumns` in
`db/schema/workspaces.ts`); core's definition never lists them. A core function that writes a core
table takes core's columns only: a key it does not know is dropped silently, so an extension writes
its own columns through its view, in the same transaction where core offers one
(`setWorkspacePlan(..., alsoInTransaction)`). Plans,
product events and the brake take one registration per process; a second one throws.

Settings only an extension reads are not in `config/env.ts`: the extension parses its own, with
the same rules (an empty value is unset; an invalid value stops the boot).

## Proof that the surface is unchanged

`src/api/edition-surface.test.ts` pins the community edition's route table and sweeps with no
extension (`src/api/fixtures/routes-community.json`). An extension that changes what an edition
serves pins its own tables the same way.
