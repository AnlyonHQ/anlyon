# Self-hosting Anlyon

This guide runs Anlyon `1.0.0` on one machine with Docker Compose: the server, the console, Postgres, Redis and Caddy in front of them. One command installs it; everything else is configured in the console.

## Requirements

- Linux: Ubuntu 22.04 or 24.04, or Debian 12 (others usually work, untested), x86_64 or arm64
- 2 CPU cores, 4 GB of memory (2 GB works with swap, which the installer offers to add), 20 GB of free disk
- Docker 24 or later with Compose 2.24 or later (the installer offers to install it)
- For anyone other than you to reach it: a domain name pointing at the machine, with ports 80 and 443 open (Caddy obtains the certificate)

No third-party account is needed. Email, file storage, OAuth apps and the Slack app are optional and set in the console.

## 1. Install on a server: one command

```bash
curl -fsSL https://anlyon.com/install | sudo sh
```

That installs the latest release; `https://anlyon.com/install@1.0.0` installs this one. Pass flags after `sh -s --`, for example `curl -fsSL https://anlyon.com/install | sudo sh -s -- --domain anlyon.example.com`. To read the script first, download it, read it, then run `sudo sh bootstrap.sh`.

The installer looks before it changes anything. It prints a table of what it found, each line marked ✓ or ✗: the OS, architecture, CPUs, memory, free disk, ports 80 and 443, Docker and Compose, clock synchronisation, privileges, and whether your domain points at this server. Then it **asks before each change**, one at a time, defaulting to no for the invasive ones (Docker, swap, the firewall, the docker group):

| Change | When it is offered |
|---|---|
| Install Docker Engine and Compose from Docker's apt repository (or its convenience script, `--docker-method script`) | Docker is missing, stopped or too old |
| Add a swap file and list it in `/etc/fstab` | less than 4 GB of memory |
| Allow the two ports in ufw | ufw is already on. It never turns ufw on and never touches SSH rules |
| Create `/opt/anlyon` | always (`--dir` to choose another) |
| Add your sudo user to the `docker` group | you ran it with sudo. Membership is equivalent to root on the server; the installer says so and defaults to no |
| Install the `anlyon-selfhost` command in `/usr/local/bin` | always |

`--yes` answers yes to each question, except the docker group (`--add-docker-group`), for unattended installs; `--no-docker-install`, `--no-swap`, `--no-firewall` and `--no-cli` decline single changes.

**Your domain.** The installer finds this server's public IP address (by asking ifconfig.co and ipify, which see only that request) and checks your domain against it. If the domain does not point here yet, it prints the exact record to create (type `A`, the name within your zone, the IP address, TTL automatic; an `AAAA` record too if the server has IPv6), recognises your DNS provider from the domain's nameservers and links its instructions (Cloudflare, Vercel, Namecheap, GoDaddy, Porkbun, Squarespace, AWS Route 53, DigitalOcean, Hostinger, Gandi), and waits, re-checking every 10 seconds: press Enter to check now, `s` to continue on the IP address over plain HTTP, `q` to stop and come back later. On Cloudflare, set the record to **DNS only (grey cloud)**: behind the proxy (orange cloud) this server cannot get its own certificate. With a Cloudflare API token limited to the zone's DNS, the installer can create the record for you; the token is used for that one request and never stored. Without a domain, press Enter at the domain question and it runs at `http://<server IP>:8080`.

Then it puts the install in `/opt/anlyon`, writes `/opt/anlyon/.env` exactly as `install.sh` does below (new secrets, readable by root only), builds or pulls the images, starts the containers (each restarts on its own after a crash or reboot), waits for the server to report ready, and prints the setup URL. If the server does not come up, it shows the last 50 lines of its log. If the certificate does not arrive, check the provider's firewall in front of the server as well as the server's own: ports 80 and 443 must be reachable from the internet.

Run it again on an installed server and it says so and offers an upgrade instead; it never replaces an install or its `.env`.

Images: until published images exist, the installer builds them on the server from the release's source (`--images build`, a few minutes the first time). Once they are published it pulls `ghcr.io/anlyonhq/anlyon-server` and `anlyon-dashboard` for the release instead (`--images ghcr`).

### Running it: `anlyon-selfhost`

| Command | What it does |
|---|---|
| `anlyon-selfhost status` | containers, readiness, the running version, backups |
| `anlyon-selfhost logs [server\|dashboard\|caddy\|postgres\|redis] [-f]` | recent logs |
| `anlyon-selfhost backup [--keep 7]` | the database, the server's files (the `anlyon_data` volume) and `.env` without its keys in `/opt/anlyon/backups`, and the root key in its own file in `/opt/anlyon/backup-keys`, both readable by root only; keeps the newest 7 |
| `anlyon-selfhost backup --schedule daily\|weekly\|off [--at 03:17] [--keep 7]` | runs that backup by itself (a systemd timer, or cron where systemd does not run), or stops it |
| `anlyon-selfhost upgrade --version <x.y.z>` | backs up, fetches and starts the new version (migrations run as it starts), checks it is ready, and goes back to the previous images automatically if it is not |
| `anlyon-selfhost restore <file>` | restores a backup into this install after you type `restore`; refuses a backup made under a different root key unless you pass `--force` |
| `anlyon-selfhost uninstall [--purge]` | stops and removes the containers and keeps everything else; `--purge` deletes the data, `.env` and backups too, after you type `purge` |

A backup is two files kept apart: the archive (`backups/anlyon-<time>.tar.gz`) never holds the root key, and its keys file (`backup-keys/anlyon-<time>.keys`, mode 0600) holds only that. Copy the archive off the server, and the keys file somewhere else, such as a password manager: whoever has both can read the stored secrets and connected accounts. The installer offers a daily backup at the end; with `--yes`, pass `--backup-schedule daily` for one.

## 1b. Install with Docker already set up

From a clone of this repository:

```bash
npx @anlyonhq/cli self-host init        # or, without Node: ./deploy/self-host/install.sh
```

It asks one question, the public domain (`anlyon.example.com`, or Enter for `localhost:8080`), and then:

- generates a root key, a one-time setup token and a database password with a cryptographically secure random generator;
- writes `deploy/self-host/.env`, readable by you only. It never prints the root key or the password, and never replaces an existing `.env` unless you pass `--force`;
- offers to start everything with `docker compose up -d --build`;
- prints the **setup URL**.

Non-interactive: `npx @anlyonhq/cli self-host init --domain anlyon.example.com --yes --up` (or `./deploy/self-host/install.sh --domain anlyon.example.com --yes --up`).

The `.env` holds only what the server needs before it can reach its database: the edition, the public address, the root key, the setup token, and the bundled Postgres and Redis. `deploy/self-host/.env.example` shows its shape.

## 2. Create the owner

Open the setup URL. It carries the setup token, which works once: whoever reaches the server first cannot claim it without the token, and every sign-up is refused until the owner exists. If you lost the URL, the token is `ANLYON_SETUP_TOKEN` in `.env`; open `https://<your domain>/setup` and paste it.

The setup page then walks through:

1. **Back up your root key.** Copy `ANLYON_ROOT_KEY` from `.env` to a password manager or vault, somewhere other than this server. Every key the server uses is derived from it. If it is lost, stored secrets and connected accounts can never be read again; if it changes, everyone is signed out and every API key stops working. The console never shows it.
2. **Optional settings**, each skippable: email (SMTP, with a test send), file storage (a directory on the server or any S3-compatible store, with a test), who may sign up, a licence key (verified offline, showing its tier, seats and expiry), telemetry (below), OAuth apps for connected accounts, and the Slack app.

Everything there is also in **Settings, Instance**, for instance admins. Changes apply at once, without a restart. The owner is an instance admin and can make others.

## 3. Configure later

Settings, Instance shows each setting and where its value comes from. Any setting can instead be set in `.env` (for example `SMTP_URL`, `SIGNUP_MODE`, `ANLYON_LICENSE_KEY`, `HUBSPOT_OAUTH_CLIENT_ID`): the environment wins, and the console shows the value read-only, "set by environment". Two things are environment-only on purpose: `EDITION` (it decides which parts of the server exist when it starts: `community`, `team` or `enterprise`; any other value stops the server at start) and `ENFORCE_HTTPS` (it follows the scheme of your public address; turning it on over plain HTTP would lock you out of the console).

**Network** decides whether audit sinks and secret stores may reach addresses on your private network, such as an internal Splunk or a Vault at 10.0.0.5. By default each workspace's admins decide for their own workspace (off until they turn it on); set it to off (or `PRIVATE_NETWORK_DESTINATIONS=off` in `.env`) to keep every workspace on public addresses. Link-local and cloud metadata addresses are never reachable.

Without email, invitation links are shown in the console for you to pass on, and new accounts skip address confirmation.

## Connected accounts

To let members connect accounts (HubSpot, Slack, Google, Linear, Salesforce), register an OAuth app with each provider, set its redirect URL to `https://<your domain>/api/v2/connection-consent/callback`, and paste its client id and secret in Settings, Instance. Providers without credentials are hidden.

## Telemetry

Once a day the server sends one small anonymous report to `https://telemetry.anlyon.com/v1/ping`, so we can tell how many installs exist and which parts are used. It contains exactly:

| Field | What it is |
|---|---|
| `schema` | `anlyon.telemetry.v1` |
| `instanceId` | a random id made for this install on its first report, not derived from anything about it |
| `version` | the build's commit |
| `edition` | community, team or enterprise |
| `day` | the date the counts end on |
| `counts.workspaces`, `counts.members`, `counts.actions` | how many exist |
| `counts.invocations` | action invocations in the last 24 hours |
| `counts.effectsByGrade` | effects in the last 24 hours by receipt grade (confirmed, acknowledged, unknown, failed, refused, denied, pending) |
| `counts.approvalsRequested`, `counts.approvalsDecided` | approvals in the last 24 hours |

Never names, email addresses, hostnames, IP addresses, URLs, payloads, action names or licence details. The report does not contain your server's IP address, though like any HTTPS request the connection that carries it does. Settings, Instance shows the exact next report. A report that cannot be delivered is dropped after five seconds; nothing waits for it and nothing retries.

Turn it off in Settings, Instance, or with `ANLYON_TELEMETRY=off` in `.env`.

## Upgrade

Installed with the one-line installer: `sudo anlyon-selfhost upgrade --version <x.y.z>`. It backs up first and goes back to the previous images if the new version does not become ready; if the new version had already changed the database, it prints the `anlyon-selfhost restore` command for the backup it took.

From a clone:

```bash
git pull
cd deploy/self-host && docker compose up -d --build
```

Migrations run on start. Read the release notes before a major version.

## Back up

With the one-line installer: `sudo anlyon-selfhost backup`, or `sudo anlyon-selfhost backup --schedule daily` to run it every day at 03:17 server time (`--at` another time, `--keep` how many to keep, `--schedule off` to stop). Each backup writes the archive to `/opt/anlyon/backups` and the root key to its own file in `/opt/anlyon/backup-keys`. Copy both off the server, to different places. `anlyon-selfhost status` shows the latest backup, its keys file and the schedule.

To restore, `sudo anlyon-selfhost restore <archive>`. It checks that the archive was made under the root key in `.env` (the archive records a fingerprint of the key, never the key); if not, put the key from the archive's keys file in `.env` first.

Otherwise back up Postgres (`pg_dump`), the `anlyon_data` volume (the server's files, such as local file storage), `deploy/self-host/.env`, and above all `ANLYON_ROOT_KEY`, kept apart from the rest. Redis holds short-lived state (limit reservations in flight, queues) and is rebuilt on start; back it up too if you cannot tolerate losing in-flight work.

## Locked out

On the server, in the install directory (`/opt/anlyon` with the one-line installer, else `deploy/self-host`), `docker compose exec -e ANLYON_ADMIN_PASSWORD='<a long password>' server node dist/scripts/create-admin.js --email you@example.com --name "Your Name"` creates an account that is an instance admin.

## Support

Community support is through GitHub issues and discussions. Paid support and the licensed editions are available from [anlyon.com](https://anlyon.com).
