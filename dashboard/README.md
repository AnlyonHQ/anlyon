# Anlyon console

The web console for Anlyon: workspaces and environments, connected accounts, actions and the
policies, limits and approvals that govern them, receipts, MCP servers and API keys. It is a
single-page React app (TanStack Router and Query, Tailwind CSS, Base UI and Radix components) that
talks only to the Anlyon API.

## Run it locally

Start the API first (it listens on `http://localhost:4000`), then, from the repository root:

```bash
pnpm install
pnpm --filter anlyon-scheduler-ui dev
```

The console opens on `http://localhost:3000` and calls the API on `localhost:4000`. To use another
API, set `VITE_API_BASE_URL` (for example in `dashboard/.env.local`).

## Check and build

```bash
pnpm --filter anlyon-scheduler-ui test    # Vitest
pnpm --filter anlyon-scheduler-ui check   # Biome: format and lint
pnpm --filter anlyon-scheduler-ui build   # Vite build and type check, into dist/
```

## The container image

`Dockerfile` builds the console as a static site served by Caddy. Build it from the repository root:

```bash
docker build -f dashboard/Dockerfile -t anlyon-dashboard .
```

Nothing about an install is built into the image. At start, `docker/entrypoint.sh` writes
`/config.js` from two variables, so one image serves any install:

| Variable | Meaning |
| --- | --- |
| `ANLYON_API_URL` | The API origin, such as `https://api.example.com`. Empty (the default) means the console's own origin, with the API behind the same proxy, as in `deploy/self-host`. |
| `ANLYON_EDITION` | `community` (the default), `team` or `enterprise`. |

The page's Content-Security-Policy allows only its own origin, plus `ANLYON_API_URL` when it is set.

## Extensions

Code outside the console's core plugs in as an extension: a folder `src/extensions/<name>/` whose
`index.ts` or `index.tsx` default-exports a `ConsoleExtension` (`src/lib/extensions.ts`). It can add
pages at their own URLs, top-bar items, banners and MCP vendors, and Content-Security-Policy sources
through a `csp.json` beside it. With no extension, the console is its core alone.
