# anlyon/vercel

The Vercel tools an agent can be given. This is the **catalogue pack** for the Vercel integration: the
console offers its actions one by one after you connect Vercel ("What may your agent do here?"), and
you can install any subset from the CLI. Anlyon holds the token and makes every call; the agent never
sees it.

The pack is for the deployment work an agent does for a user: find a project's deployments, read one
and its build log, see which deployment a production domain serves, check a domain's DNS, and then
redeploy, promote, roll back, cancel a build or delete a deployment.

Vercel is connected with an access token you create, not by signing in. Anlyon checks the token with
Vercel before it stores it, and binds it to `api.vercel.com` in a request header. Every call uses
Vercel's REST API (`https://api.vercel.com`).

Actions install as `vercel-<name>` unless `--no-prefix`.

## The token

Create it in Vercel under Account Settings, Tokens. Set its scope to the team your agent works in, and
give it an expiration. A Vercel token has no finer permissions: it can do what its owner can do in
that team, including what this pack leaves out. So create it from an account whose role in the team
fits what your agent should do. Rolling back production needs a role that can (on Pro and Enterprise:
Owner, Member or Developer, or a Project Administrator).

## Team ids

Every action except `list-teams` takes `team_id` (`team_...`). Vercel's API needs it to reach a
team's projects, and a Hobby account is a team too. Get it from `list-teams`, or from Team Settings,
General, Team ID.

## Reads

Reads change nothing. The response goes back to the agent (cut at 64 KB), every call is logged, and
approval or deny policies can still match them. Lists return a fixed page size; when Vercel has more,
the response carries `pagination.next`, which the agent passes back as `until`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `list-teams` | Teams the token can reach, 20 per page: id, slug, name | `until`? | none (read) |
| `list-deployments` | A team's deployments, newest first, 20 per page: uid, project name, url, state, target, projectId, creator, Git metadata | `team_id`, `project`? (id or name), `target`?, `state`?, `branch`?, `sha`?, `until`? | none (read) |
| `get-deployment` | One deployment: state, target, url, aliases, a failed build's error, Git source, timings. Environment variable names only, never values | `team_id`, `deployment_id` | none (read) |
| `list-deployment-events` | A deployment's build log, 50 events, oldest or newest first | `team_id`, `deployment_id`, `direction`?, `since`?, `until`? | none (read) |
| `list-deployment-aliases` | The hostnames assigned to a deployment | `team_id`, `deployment_id` | none (read) |
| `list-project-domains` | A project's domains, 20 per page: verified, redirect, branch, TXT records still needed | `team_id`, `project`, `production`?, `verified`?, `until`? | none (read) |
| `get-domain-config` | Whether a domain's DNS points at Vercel, and the records it recommends | `team_id`, `domain` | none (read) |
| `get-alias` | The deployment a hostname serves, and its project | `team_id`, `alias` | none (read) |
| `list-promote-aliases` | Each alias of the project's latest promote, with its status | `team_id`, `project_id`, `failed_only`?, `until`? | none (read) |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Where Vercel has a GET that shows the change, the receipt is
graded `confirmed` by a read-back; otherwise `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `redeploy` | Builds an existing deployment again, as a preview or with `target=production` | `team_id`, `project_name`, `deployment_id`, `target`? | The new deployment by id; its id and project name must match |
| `promote-deployment` | Points the production domains at an existing production deployment, without a rebuild | `team_id`, `project_id`, `deployment_id`, `domain` | The production domain's alias; it must serve this deployment, in this project |
| `rollback-deployment` | Instant Rollback to an earlier production deployment | `team_id`, `project_id`, `deployment_id`, `domain`, `reason`? | The production domain's alias; it must serve this deployment, in this project |
| `cancel-deployment` | Cancels a queued or building deployment | `team_id`, `deployment_id` | The deployment; its readyState must be `CANCELED` |
| `delete-deployment` | Deletes a deployment; it cannot be restored | `team_id`, `deployment_id` | none: Vercel does not document reading a deleted deployment |

`promote-deployment` and `rollback-deployment` take `domain`, one of the project's production domains
(`list-project-domains` with `production=true`). Vercel answers them with no body, so the read-back
asks which deployment that domain now serves.

| Policy (installed **disabled**) | Effect |
| --- | --- |
| vercel: approve redeploying | Every redeploy requires approval: each one starts a build, and with `target=production` it replaces what users see |
| vercel: approve promoting a deployment to production | Every promote requires approval |
| vercel: approve rolling back production | Every rollback requires approval |
| vercel: approve cancelling a deployment | Every cancellation requires approval |
| vercel: approve deleting a deployment | Every deletion requires approval: it cannot be undone |

Turn them on for any environment where the agent works on a project with real users. To hold only
production redeploys, add the condition `has(input.target) && input.target == 'production'` to the
redeploy policy.

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| vercel: redeploys per day | 20 |
| vercel: promotions per day | 10 |
| vercel: rollbacks per day | 10 |
| vercel: cancellations per day | 20 |
| vercel: deployments deleted per day | 20 |

The amounts are suggestions for one agent on a few projects: a normal day of releases, retries and
cleanups stays under them, and a loop that keeps deploying or deleting stops there. Change them to fit
how often your team ships.

## Exercise

`anlyon packs exercise ./packs/vercel` runs every action once against your test team, in the order of
`exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `team_id` | The test team's id (`team_...`) |
| `project` | A test project's name, with at least two production deployments, whose production domain may point at the previous deployment for a minute |
| `project_id` | That project's id (`prj_...`) |
| `production_deployment_id` | The project's current production deployment |
| `previous_production_deployment_id` | The production deployment just before it |
| `production_domain` | One of the project's production domains, such as its `.vercel.app` production domain |

The run reads everything, then redeploys the current production deployment as a preview, cancels that
build and deletes it. It rolls production back to the previous deployment and promotes the current one
again, which undoes the rollback. The production domain serves the previous deployment in between, and
the run counts one build toward the team's usage.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token can do more than the pack.** A Vercel token has no per-action permissions: it acts as its owner in the team it is scoped to. Scope it to one team, give it an expiration, and create it from an account whose role fits.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown` outcome, reconcile before invoking again, or `redeploy` can start a second build.
- **`redeploy` is read back when the deployment exists, not when its build finishes.** Follow it with `get-deployment` or `list-deployment-events`. Each redeploy counts toward the team's build usage.
- **`promote-deployment` can grade a mismatch on a promote that is still running.** Vercel answers 202 while the domains are moving. Check with `list-promote-aliases` or `get-alias`. It does not rebuild; to put a preview build in production, use `redeploy` with `target=production`.
- **After a rollback, new production builds do not go live.** Vercel turns off assigning the production domains to new production deployments until one is promoted again. A rollback keeps the environment variables the old deployment was built with. On the Hobby plan, Vercel rolls back to the deployment just before the current one only.
- **`delete-deployment` is not read back** (receipt graded `acknowledged`), and cannot be undone.
- **Build logs hold what the build printed.** A build that prints a secret shows it in `list-deployment-events`.
- **Large responses are cut at 64 KB.** A deployment with a very large route table can be cut in `get-deployment`.
- **Not included.** Projects are read through their deployments and domains: Vercel's project responses include the project's environment variables, and an agent should not read those, so `get-project` and `list-projects` are left out. Pausing a project is left out with them, because its read-back is the project. Environment variables, creating a deployment from files (an upload), tokens, webhooks, members, access groups, billing, log drains, integrations, Edge Config, DNS records and domain purchase are secrets, account administration or outside deployment work.

## Install

```bash
anlyon packs plan ./packs/vercel
anlyon packs install ./packs/vercel --yes --action list-deployments --action get-deployment --action list-deployment-events --action redeploy
```

Every action sends `{{connection:vercel}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own Vercel account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/vercel`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected Vercel account (`anlyon connections add vercel --secret VERCEL`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name VERCEL=<your secret>`. Do this when the environment has more than one Vercel account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): first version. Nine reads (teams, deployments, build events, aliases, project domains, domain config, promote status) and five writes (redeploy, promote, roll back, cancel, delete).

Sources: Vercel's OpenAPI document, https://openapi.vercel.sh/ (fetched 2026-10-24; operations getTeams, getDeployments, getDeployment, getDeploymentEvents, listDeploymentAliases, getProjectDomains, getDomainConfig, getAlias, listPromoteAliases, createDeployment, requestPromote, requestRollback, cancelDeployment, deleteDeployment, getProject, getAuthUser); https://vercel.com/docs/instant-rollback and https://vercel.com/docs/deployments/promoting-a-deployment, checked 2026-10-24.
