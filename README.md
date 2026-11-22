# Anlyon

**Shared limits, bound approvals and receipts for the actions AI agents take. Self-hosted.**

Your agent names an action and passes input. Anlyon holds the credential, checks the shared limit, asks a human when the policy says so, makes the call, and returns a receipt with a grade.

```text
Without Anlyon   agent  ->  an API credential in your process  ->  production API
With Anlyon      agent  ->  a named action  ->  Anlyon  ->  production API
```

- **A shared limit.** Every agent, session and key in an environment draws from the same limit, reserved before dispatch. A new session or key does not get a new allowance.
- **A bound approval.** The human approves the exact change, and that exact change is what runs.
- **A receipt with a grade.** Confirmed means a read-back matched. Acknowledged means the provider accepted the request and nothing read it back. Unknown means no usable response, and Anlyon does not send the request again. Failed, refused and denied mean it did not run.

This repository is release `1.0.0`. It is published from Anlyon's own repository on every release, so issues and pull requests here are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Run it

On a fresh Linux server (Ubuntu 22.04 or 24.04, or Debian 12; 2 CPUs, 4 GB of memory, 20 GB of disk):

```bash
curl -fsSL https://anlyon.com/install | sudo sh
```

It checks the server first and shows what it found, then asks before each change: installing Docker, adding swap, opening ports in ufw. It asks for your domain and tells you exactly which DNS record to create, and where, then waits for it. It writes `/opt/anlyon/.env` with fresh secrets, starts the containers, and prints a one-time setup URL. Open it to create the owner; email, storage, sign-up, the licence key and OAuth apps are then set in the console. Afterwards `anlyon-selfhost` runs the install: `status`, `logs`, `upgrade`, `backup`, `restore`, `uninstall`. To pin a release: `curl -fsSL https://anlyon.com/install@1.0.0 | sudo sh`.

On a machine that already has Docker with Compose, from a clone of this repository:

```bash
npx @anlyonhq/cli self-host init     # or ./deploy/self-host/install.sh, without Node
```

[SELF_HOSTING.md](SELF_HOSTING.md) covers the details, upgrades and backups.

**Telemetry.** A self-hosted install sends one anonymous report a day: a random instance id, the version, the edition, and counts (workspaces, members, actions, and the last day's invocations by receipt grade and approvals). Never names, emails, hostnames or payloads. [SELF_HOSTING.md](SELF_HOSTING.md#telemetry) lists every field. Turn it off in Settings, Instance, or with `ANLYON_TELEMETRY=off`.

## What is in this repository

| Path | What it is | Licence |
|---|---|---|
| `server/` | The API, workers and MCP endpoint (Node, Postgres, Redis) | Elastic License 2.0 |
| `dashboard/` | The web console | Elastic License 2.0 |
| `packs/` | Declared actions and approval policies for common APIs | Elastic License 2.0 |
| `packages/` | Code shared by the server and the dashboard | Elastic License 2.0 |
| `deploy/` | Docker Compose install for a single machine, with its installer | Elastic License 2.0 |
| any `ee/` directory | Enterprise features, switched on by a licence key | Elastic License 2.0 |
| `sdks/typescript/` | `@anlyonhq/sdk`, `@anlyonhq/cli`, `@anlyonhq/mcp-server`, `@anlyonhq/ai-sdk`, `@anlyonhq/react` | MIT |
| `sdks/python/` | `anlyon`, `anlyon-langchain`, `anlyon-llamaindex` | MIT |

## Licence

Anlyon is source-available under the [Elastic License 2.0](LICENSE). You may use, copy, modify and run it, in production and inside your company, for free. You may not offer Anlyon to third parties as a hosted or managed service, and you may not remove or work around the licence-key checks.

Code in `ee/` directories is under the same licence. It is switched off unless a valid licence key is configured. The community edition never needs it.

The SDKs, the CLI and the MCP server under `sdks/` are MIT-licensed. Each package carries its own `LICENSE`, so you can use them in any project, open or closed.

Third-party material included in this repository, and its licences, is listed in [NOTICE](NOTICE).

The name "Anlyon" and the Anlyon logo are trademarks and are not licensed for use by forks.

## Use it from an agent

```bash
npm install @anlyonhq/sdk        # TypeScript
pip install anlyon               # Python
```

Point the SDK, CLI or MCP server at your own server with `ANLYON_BASE_URL` (for example `http://localhost:4000`). Everything else in the [documentation](https://docs.anlyon.com) applies unchanged.

## Develop

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

Node >=22 and pnpm (pinned in `package.json`) are required. The server's integration tests need a Postgres and a Redis you can throw away; the `integration` job in `.github/workflows/ci.yml` shows the environment they run with.

## Hosted

If you would rather not run it yourself, the same software runs at [anlyon.com](https://anlyon.com).

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
