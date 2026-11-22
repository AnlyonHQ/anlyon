# anlyon/gitlab

The GitLab tools an agent can be given, for projects on gitlab.com. This is the **catalogue pack**
for the GitLab integration: the console offers its actions one by one after you connect GitLab
("What may your agent do here?"), and you can install any subset from the CLI. Anlyon holds the
token and makes every call; the agent never sees it.

GitLab is connected with an access token you create, not by signing in. Anlyon checks the token with
GitLab (`GET /api/v4/user`) before it stores it, and binds it to `gitlab.com` in a request header
(`Authorization: Bearer`). Every call uses GitLab's REST API v4 (`https://gitlab.com/api/v4`).

Projects are named by numeric id or by full path (`my-group/my-project`); Anlyon encodes the
slashes. Issues and merge requests are named by their number inside the project (`iid`, the number
after `#` or `!` in GitLab). Actions install as `gitlab-<name>` unless `--no-prefix`.

## Token

Create one of these on gitlab.com:

| Token | Where | Scope and role |
| --- | --- | --- |
| Personal access token | User settings, Access tokens | Scope `api`. It acts as you in every project you can reach |
| Project access token | The project's Settings, Access tokens | Scope `api`, role Developer. It reaches that project and nothing else. Use Maintainer if your agent merges into protected branches |
| Group access token | The group's Settings, Access tokens | Scope `api`, role Developer. It reaches the group's projects |

`read_api` is enough if you install just the reads. A project access token is the narrowest choice.
What each action may do still depends on the token's role in the project: closing an issue, merging,
and retrying or canceling a pipeline follow GitLab's own permissions and branch protection.

## Reads

Plain tools: the token stays with Anlyon, GitLab's response goes back to the agent, and every call
is logged. A response is cut at 64 KB, so page sizes are fixed below what a typical page weighs.
Lists take `page`; GitLab returns the next page number in the `x-next-page` header, and an empty
page means there are no more.

| Action | What it does | Inputs | Page |
| --- | --- | --- | --- |
| `list-projects` | Projects the token's user is a member of, most recently active first, short form; archived left out | `search`, `page` | 20 |
| `get-project` | One project: path, default branch, visibility, open issues, the token's access level | `project` | |
| `search-issues` | Issues across every project the token can see | `scope`, `state`, `labels`, `search`, `page` | 10, descriptions included |
| `list-issues` | Issues in one project | `project`, `state`, `labels`, `search`, `assignee_username`, `author_username`, `milestone`, `updated_after`, `order_by`, `sort`, `page` | 10 |
| `get-issue` | One issue by number | `project`, `issue_iid` | |
| `list-issue-notes` | Comments and system notes on an issue | `project`, `issue_iid`, `activity_filter`, `sort`, `page` | 20 |
| `list-labels` | Labels of a project, with counts | `project`, `search`, `page` | 50 |
| `list-merge-requests` | Merge requests in one project | `project`, `state`, `labels`, `search`, `author_username`, `reviewer_username`, `target_branch`, `order_by`, `sort`, `page` | 5 |
| `get-merge-request` | One merge request: branches, head `sha`, draft, `detailed_merge_status`, reviewers, latest pipeline | `project`, `merge_request_iid` | |
| `list-merge-request-diffs` | Files a merge request changes, with diffs | `project`, `merge_request_iid`, `page` | 5 |
| `list-merge-request-notes` | Comments and system notes on a merge request | `project`, `merge_request_iid`, `sort`, `page` | 20 |
| `list-pipelines` | CI/CD pipelines of a project, newest first | `project`, `status`, `ref`, `sha`, `page` | 20 |
| `get-pipeline` | One pipeline: status, ref, sha, who started it, duration | `project`, `pipeline_id` | |
| `get-file` | One file (base64) at a branch, tag or commit | `project`, `file_path`, `ref` | |
| `list-branches` | Branches with their latest commit and protection | `project`, `search`, `page` | 30 |
| `list-commits` | Commits on a branch or tag | `project`, `ref_name`, `path`, `since`, `until`, `page` | 20 |

## Writes

Writes are governed: each declares 1 resource mutation counted against a limit, can be put behind an
approval policy, and gets a receipt. Where GitLab has a GET that shows the change, the receipt is
graded `confirmed` by a read-back; otherwise `acknowledged`.

| Action | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `create-issue` | Opens one issue | `project`, `title`, `description`?, `labels`?, `assignee_id`?, `milestone_id`?, `due_date`?, `confidential`? | The issue by its returned number; the title must match |
| `update-issue` | Changes title, description, labels (replace, add or remove), assignees, milestone or due date | `project`, `issue_iid`, any of those fields | The issue; title and update time must equal GitLab's response to this update |
| `close-issue` | Closes an issue | `project`, `issue_iid` | The issue; its state must be `closed` |
| `reopen-issue` | Reopens an issue | `project`, `issue_iid` | The issue; its state must be `opened` |
| `comment-on-issue` | Adds one comment (optionally internal) | `project`, `issue_iid`, `body`, `internal`? | The comment by id; the text must match |
| `create-merge-request` | Opens a merge request between two branches of a project | `project`, `source_branch`, `target_branch`, `title`, `description`?, `labels`?, `assignee_ids`?, `reviewer_ids`?, `remove_source_branch`?, `squash`? | The merge request by its returned number; title and source branch must match |
| `update-merge-request` | Changes title, description, labels, assignees, reviewers or target branch, or closes or reopens it | `project`, `merge_request_iid`, any of those fields, `state_event`? | The merge request; title, state and update time must equal GitLab's response to this update |
| `comment-on-merge-request` | Adds one comment to a merge request's overview | `project`, `merge_request_iid`, `body`, `internal`? | The comment by id; the text must match |
| `approve-merge-request` | Approves as the token's user, at the head commit reviewed | `project`, `merge_request_iid`, `sha` | The approval state; `user_has_approved` must be true |
| `merge-merge-request` | Merges now, at the head commit reviewed | `project`, `merge_request_iid`, `sha`, `squash`?, `should_remove_source_branch`?, `merge_commit_message`?, `squash_commit_message`? | The merge request; its state must be `merged` |
| `retry-pipeline` | Retries a pipeline's failed and canceled jobs | `project`, `pipeline_id` | none: the jobs start afterwards, so the status is not settled |
| `cancel-pipeline` | Cancels a pipeline's running and pending jobs | `project`, `pipeline_id` | none: the pipeline passes through `canceling`, and GitLab answers 200 in any state |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| gitlab: approve closing an issue | Every `close-issue` call waits for a person |
| gitlab: approve closing a merge request | `update-merge-request` with `state_event: close` waits for a person |
| gitlab: approve approving a merge request | Every approval waits for a person: an approval can be what lets a merge through |
| gitlab: approve merging a merge request | Every merge waits for a person |
| gitlab: approve retrying a pipeline | Every retry waits for a person: retried jobs can deploy |
| gitlab: approve canceling a pipeline | Every cancel waits for a person: it can stop a deploy halfway |

Turn on the merge and pipeline policies before an agent works on a project that deploys from its
pipelines. Turn on the others when closing or approving should stay a person's decision.

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| gitlab: issues opened per day | 50 |
| gitlab: issues updated per day | 100 |
| gitlab: issues closed per day | 50 |
| gitlab: issues reopened per day | 50 |
| gitlab: issue comments per day | 200 |
| gitlab: merge requests opened per day | 20 |
| gitlab: merge requests updated per day | 50 |
| gitlab: merge request comments per day | 200 |
| gitlab: merge requests approved per day | 50 |
| gitlab: merge requests merged per day | 20 |
| gitlab: pipelines retried per day | 20 |
| gitlab: pipelines canceled per day | 20 |

The amounts are the same as the GitHub pack's for the same kinds of write. They are suggestions: a
normal day of an agent triaging issues and helping with reviews stays under them, and a loop that
opens or comments without stopping hits them within the day. Change them to fit your projects.

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **gitlab.com, not self-managed.** The token is bound to `gitlab.com`. A self-managed GitLab has its own host for
  each account, and an API-key integration is bound to fixed hosts, so self-managed instances cannot
  be connected yet. To use one now, import its API as your own actions on that host.
- **The token decides which projects can be reached.** Anlyon does not narrow it further: every
  action takes `project` as an input, so a policy on that input is how you restrict it inside what
  the token allows. `search-issues` reaches every project the token's user can see.
- **No GitLab quick actions.** GitLab runs commands such as `/merge`, `/close` and `/approve` on
  lines that start with a slash in descriptions and comments. That would let a comment do what a
  governed action does, unlimited and unreviewed. Every description and comment input refuses a line
  that starts with a slash (after spaces or tabs), a carriage return, and trailing whitespace, so the
  text GitLab stores is the text sent and the read-back can compare it.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown`
  outcome, reconcile before invoking again, or a second issue or comment can be created.
  `create-merge-request` is the exception: GitLab refuses a second open merge request for the same
  branches.
- **`update-issue` and `update-merge-request` read back GitLab's own response.** Their read-back
  compares the record with what GitLab returned for this update, including its update time, so it
  fails if someone else edits it in between.
- **The close, reopen and merge read-backs can match a record that was already in that state.** They
  prove the state now, not that this call changed it.
- **Approving.** GitLab refuses an approval the project's rules do not allow, such as the author
  approving their own merge request when the project prevents it. A project that asks for a password
  to approve cannot be approved here. The read-back checks that the token's user has approved; it
  does not check that the approval rules are satisfied.
- **Merging does not wait.** Auto-merge (merge when the pipeline succeeds) is left out, because the
  merge happens later and could not be read back. GitLab answers 405 when the merge request cannot be
  merged yet (draft, required pipeline, missing approvals, conflicts), 409 when the branch moved past
  `sha`, and 422 when the merge fails. Branch protection still applies.
- **Pipelines have no read-back.** `retry-pipeline` and `cancel-pipeline` are graded `acknowledged`;
  check the outcome later with `get-pipeline`.
- **GitLab Free accepts one assignee and one reviewer.** `assignee_ids` and `reviewer_ids` with more
  than one id need GitLab Premium or Ultimate. `create-issue` takes a single `assignee_id`.
- **Large responses.** A file over about 45 KB is cut by the 64 KB response limit once base64-encoded,
  and a page of large diffs can be cut too. GitLab itself collapses very large diffs.
- **Not included.** Deleting issues, comments, branches or projects. Creating a pipeline, which can
  deploy. Creating or changing files and commits. Members, access tokens, deploy keys, webhooks,
  CI/CD variables (they hold secrets), runners, registries, uploads (multipart), and project or group
  settings: account administration or outside day-to-day issue and review work.
- **Written by hand.** GitLab's official `openapi_v2.yaml` is Swagger 2, which the draft does not
  read, and it does not describe notes, labels or the current user. The pack follows the REST
  reference; the spec's paths for the other operations match it.

## Exercise

`anlyon packs exercise ./packs/gitlab` runs every action once against a test project, in the order
in `exercise.json`. It needs:

| Need | What to give |
| --- | --- |
| `project` | A test project on gitlab.com the token reaches with at least the Developer role |
| `file_path` | A file on its default branch, such as `README.md` |
| `default_branch` | Its default branch, such as `main` |
| `target_branch` | A scratch branch that is not the default branch and can be merged into; the run merges into it |
| `source_branch` | A branch with at least one commit `target_branch` lacks. The run squash-merges it, so make a fresh one for each run |
| `pipeline_id` | A finished pipeline with at least one failed or canceled job. The run retries it and then cancels it |

The run opens an issue with the label `anlyon-exercise` (GitLab creates the label if the project does
not have it), edits it, comments, closes and reopens it, and closes it again at the end. It opens a
merge request, comments on it, edits its title, approves it and merges it into the scratch branch.
The approval needs a token user who may approve: if the project prevents authors from approving their
own merge requests, use a token of a second member. The pack does not delete issues, so closed
exercise issues stay in the project.

## Install

```bash
anlyon packs plan ./packs/gitlab
anlyon packs install ./packs/gitlab --yes --action list-issues --action get-issue --action create-issue --action comment-on-issue
```

Every action sends `{{connection:gitlab}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own GitLab account. Store their own token with `PUT /api/v2/end-users/{endUserId}/connections/gitlab`. A user with no token stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected GitLab account (`anlyon connections add gitlab --secret GITLAB`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name GITLAB=<your secret>`. Do this when the environment has more than one GitLab account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.1.0 (2026-10-24): 16 reads and 12 writes on gitlab.com projects, issues, merge requests and
  pipelines.

Sources, checked 2026-10-24: https://docs.gitlab.com/api/rest/authentication/,
https://docs.gitlab.com/api/rest/, https://docs.gitlab.com/api/users/, https://docs.gitlab.com/api/projects/,
https://docs.gitlab.com/api/issues/, https://docs.gitlab.com/api/notes/, https://docs.gitlab.com/api/labels/,
https://docs.gitlab.com/api/merge_requests/, https://docs.gitlab.com/api/merge_request_approvals/,
https://docs.gitlab.com/api/pipelines/, https://docs.gitlab.com/api/repository_files/,
https://docs.gitlab.com/api/branches/, https://docs.gitlab.com/api/commits/,
https://docs.gitlab.com/user/project/quick_actions/,
https://docs.gitlab.com/user/project/settings/project_access_tokens/. Spec reviewed and not used:
https://gitlab.com/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v2.yaml (Swagger 2, fetched
2026-10-24).
