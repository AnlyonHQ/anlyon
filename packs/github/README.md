# anlyon/github

The operations an agent can be allowed to perform on GitHub issues, pull requests and repositories.
This is the **catalogue pack** for the GitHub integration: the console offers its actions one by one
after you connect GitHub ("What may your agent do here?"), and you can install any subset from the
CLI.

GitHub is connected with a token you create, not by signing in. Anlyon checks the token with GitHub
before it stores it, and binds it to `api.github.com` in a request header. The agent never holds the
token: Anlyon makes every call.

## Token permissions

Create a **fine-grained personal access token** limited to the repositories your agent should work
in, with these repository permissions:

| Permission | Access | Needed by |
| --- | --- | --- |
| Issues | Read and write | Every issue read and write, labels, assignees, issue comments |
| Pull requests | Read and write | Pull request reads, `create-pull-request`, `comment-on-pull-request`, `create-review`, `request-reviewers` |
| Contents | Read and write | Read: `list-branches`, `get-file-contents`, `list-commits`, `search-code`. **Write: only `merge-pull-request`** |
| Metadata | Read | `get-repository` (GitHub adds it to every fine-grained token) |

Contents: Read and write also lets the token push commits. If your agent should not merge, grant
Contents: Read only and do not install `merge-pull-request`; everything else works. If you install
only issue actions, Issues: Read and write is enough.

## Reads

Plain tools: the token stays with Anlyon, GitHub's response goes back to the agent, and every call
is logged. A response is cut at 64 KB, so page sizes are fixed below what a typical page weighs.

| Action | What it does | Inputs | Page |
| --- | --- | --- | --- |
| `search-issues` | Search issues and pull requests with GitHub search syntax | `q`, `sort`, `order`, `page` | 5, bodies included |
| `list-issues` | Issues in one repository (pull requests included, with a `pull_request` key) | `owner`, `repo`, `state`, `labels`, `assignee`, `creator`, `milestone`, `sort`, `direction`, `since`, `page` | 5 |
| `get-issue` | One issue by number | `owner`, `repo`, `issue_number` | |
| `list-issue-comments` | Comments on an issue or pull request conversation | `owner`, `repo`, `issue_number`, `since`, `page` | 10 |
| `list-labels` | Labels defined in a repository | `owner`, `repo`, `page` | 100 |
| `list-pull-requests` | Pull requests in one repository | `owner`, `repo`, `state`, `head`, `base`, `sort`, `direction`, `page` | 3 (each carries two repository objects) |
| `get-pull-request` | One pull request: branches, SHAs, `merged`, `mergeable`, requested reviewers | `owner`, `repo`, `pull_number` | |
| `list-pull-request-files` | Files a pull request changes, with patches | `owner`, `repo`, `pull_number`, `page` | 10 |
| `list-reviews` | Reviews on a pull request | `owner`, `repo`, `pull_number`, `page` | 10 |
| `list-review-comments` | Comments on a pull request's diff | `owner`, `repo`, `pull_number`, `sort`, `direction`, `since`, `page` | 10 |
| `get-repository` | One repository: default branch, visibility, topics | `owner`, `repo` | |
| `list-branches` | Branches with head SHA and protection | `owner`, `repo`, `protected`, `page` | 50 |
| `get-file-contents` | One file (base64) or directory listing at a ref | `owner`, `repo`, `path`, `ref` | |
| `list-commits` | Commits from a branch or SHA | `owner`, `repo`, `sha`, `path`, `author`, `since`, `until`, `page` | 8 |
| `search-code` | Search code on default branches | `q`, `page` | 8 |

## Writes

Governed: each declares one resource mutation counted against a limit, can be put behind an approval
policy, and gets a receipt. Where GitHub has a GET that shows the change, the receipt is graded
`confirmed` by that read-back; otherwise `acknowledged`.

| Action (installed name) | What it does | Inputs | Read-back |
| --- | --- | --- | --- |
| `github-create-issue` | Opens one issue | `owner`, `repo`, `title`, `body` | The issue by number; the title must match |
| `github-comment-on-issue` | Comments on an issue or pull request conversation | `owner`, `repo`, `issue_number`, `body` | The comment by id; the text must match |
| `github-close-issue` | Closes one issue | `owner`, `repo`, `issue_number` | The issue; state must be `closed` |
| `github-reopen-issue` | Reopens one issue | `owner`, `repo`, `issue_number` | The issue; state must be `open` |
| `github-update-issue` | Changes title, body, state and reason, milestone, and replaces labels and assignees | `owner`, `repo`, `issue_number`, `title`, `body`, `state`, `state_reason`, `milestone`, `labels`, `assignees` | The issue; number, title, state and body must equal GitHub's answer to the update |
| `github-add-labels` | Adds labels to an issue or pull request | `owner`, `repo`, `issue_number`, `labels` | The issue; the first label named must be among its labels |
| `github-remove-label` | Removes one label from an issue or pull request | `owner`, `repo`, `issue_number`, `name` | The issue; the label must no longer be among its labels |
| `github-add-assignees` | Adds up to 10 assignees | `owner`, `repo`, `issue_number`, `assignees` | The issue; the first login named must be among its assignees |
| `github-update-comment` | Replaces a comment's text | `owner`, `repo`, `comment_id`, `body` | The comment; the text must match |
| `github-delete-comment` | Deletes a comment | `owner`, `repo`, `comment_id` | The comment; GitHub must answer 404 |
| `github-create-label` | Creates a label in a repository | `owner`, `repo`, `name`, `color`, `description` | The label by name; the id must be the new label's |
| `github-delete-label` | Deletes a label from a repository (and from every issue) | `owner`, `repo`, `name` | The label by name; GitHub must answer 404 |
| `github-comment-on-pull-request` | Comments on a pull request conversation | `owner`, `repo`, `pull_number`, `body` | The comment by id; the text must match |
| `github-create-review` | Approves, requests changes or comments, with optional line comments | `owner`, `repo`, `pull_number`, `event`, `body`, `commit_id`, `comments` | The review by id; id, state and commit must equal GitHub's answer |
| `github-request-reviewers` | Requests reviews from people or teams | `owner`, `repo`, `pull_number`, `reviewers`, `team_reviewers` | none (see limitations) |
| `github-merge-pull-request` | Merges a pull request at the reviewed head SHA | `owner`, `repo`, `pull_number`, `sha`, `merge_method`, `commit_title`, `commit_message` | The pull request; `merged` must be true and `merge_commit_sha` the returned SHA |
| `github-create-pull-request` | Opens a pull request from a head branch into a base branch | `owner`, `repo`, `title`, `head`, `base`, `body`, `draft`, `maintainer_can_modify` | The pull request by number; title and base branch must match |

| Policy (installed **disabled**) | Effect |
| --- | --- |
| github: approve closing an issue | Every `close-issue` requires approval |
| github: approve closing an issue by update | `update-issue` with `state: closed` requires approval |
| github: approve deleting a comment | Every `delete-comment` requires approval |
| github: approve deleting a label | Every `delete-label` requires approval |
| github: approve approving a pull request | `create-review` with `event: APPROVE` requires approval |
| github: approve merging a pull request | Every `merge-pull-request` requires approval |

| Suggested limit (created only with `--with-limits`) | Per day |
| --- | --- |
| github: issues opened per day | 50 |
| github: comments per day | 200 |
| github: issues closed per day | 50 |
| github: issues reopened per day | 50 |
| github: issues updated per day | 100 |
| github: label additions per day | 200 |
| github: label removals per day | 200 |
| github: assignee additions per day | 100 |
| github: comments edited per day | 100 |
| github: comments deleted per day | 50 |
| github: labels created per day | 20 |
| github: labels deleted per day | 10 |
| github: pull request comments per day | 200 |
| github: reviews per day | 50 |
| github: review requests per day | 50 |
| github: pull requests merged per day | 20 |
| github: pull requests opened per day | 20 |

## Limitations

These are also in each action's description, which the preview shows a reviewer as "Action notes".

- **The token decides which repositories can be reached.** Anlyon does not narrow the token further:
  every action takes `owner` and `repo` as inputs, so a policy on those inputs is how you restrict it
  inside what the token allows. The two searches reach every repository the token can read, and
  public repositories.
- **No provider idempotency.** Anlyon sends each write once and never repeats it. After an `unknown`
  outcome, reconcile before invoking again, or a second issue, comment or review can be created.
  `create-pull-request` is the exception: GitHub refuses a second open pull request for the same
  head and base.
- **The label and assignee read-backs check one name.** `add-labels` and `add-assignees` check only
  the first label or login named, by its exact spelling; `remove-label` checks that the label is gone.
  Their responses list the labels or assignees after the change.
- **`request-reviewers` has no read-back.** Its people and teams are both optional, and a read-back can
  only compare an input every call gives; GitHub also drops a person from the requested reviewers once
  they review. It is graded `acknowledged`; its response lists the reviewers after the change.
- **GitHub silently drops what the token may not set.** Labels, assignees and milestone on
  `update-issue`, and assignees on `add-assignees`, need push access; without it GitHub answers 200
  and ignores them. Check the returned issue.
- **No assignee removal by itself, and no milestone removal.** Anlyon sends no body with a DELETE, so
  GitHub's remove-assignees call cannot be declared; use `update-issue` with the full `assignees`
  list. `update-issue` can set a milestone but not clear it.
- **The close and reopen read-backs can match an issue that was already in that state.** They prove
  the state now, not that this call changed it.
- **Merging needs Contents: Read and write**, and branch protection and required checks still apply.
  `merge-pull-request` takes the head `sha` you reviewed and GitHub refuses the merge if the branch
  has moved since.
- **Reviews of your own pull request.** GitHub refuses `APPROVE` and `REQUEST_CHANGES` from the pull
  request's author, and a review request to the author.
- **Large responses are cut at 64 KB.** Page sizes are set for typical repositories; a page of very
  long bodies or patches, or a file over about 45 KB from `get-file-contents`, can still be cut.
- **Search rate limits.** GitHub allows 30 issue searches and 10 code searches a minute, returns at
  most the first 1,000 results, and searches code only on default branches in files under 384 KB.
- **A fine-grained token expires.** When it does, GitHub answers 401 and the action fails; connect
  the integration again with a new token.

Left out on purpose: repository administration (settings, collaborators, webhooks, deploy keys,
rulesets), deleting repositories or branches, Actions, releases, and writing files (the
`github.file_update` adapter covers one designated branch).

## Exercise

`anlyon packs exercise ./packs/github` runs every action once against a test repository, in the
order in `exercise.json`. It needs:

| Need | What to create |
| --- | --- |
| `owner`, `repo` | A test repository the token reaches, with a `README.md` on its default branch |
| `base_branch` | A scratch branch that is not the default branch; the run merges into it |
| `head_branch` | A branch with at least one commit `base_branch` lacks. The run squash-merges it, so make a fresh one for each run |
| `reviewer_login` | A collaborator on the repository other than the token's owner |

The run creates a label, an issue and a pull request, and cleans up what GitHub lets it: the label
and one comment are deleted, the issue is closed, and the pull request is merged into the scratch
branch. GitHub has no REST call to delete an issue, so closed exercise issues stay in the repository.

## Install

```bash
anlyon packs plan ./packs/github
anlyon packs install ./packs/github --yes --action create-issue --action comment-on-issue
```

Every action sends `{{connection:github}}`, so nothing needs connecting before install. A call made for one of your users (the `Anlyon-End-User` header, or `anlyon.forUser(id)` in the SDK) uses that user's own GitHub account. Store their own key with `PUT /api/v2/end-users/{endUserId}/connections/github`. A user with no key stored gets `409 END_USER_NOT_CONNECTED`. Any other call uses this environment's connected GitHub account (`anlyon connections add github --secret GITHUB`).

To bind the actions to that account by name instead, add `--credential secret`, or `--secret-name GITHUB=<your secret>`. Do this when the environment has more than one GitHub account. A call made for one of your users still uses their own account.

Then review and enable the policies. Add `--with-limits` to create the limits (needs
`impact-limits:write`).

## History

- 0.3.0 (2026-10-24): every action sends `{{connection:github}}` instead of `{{secret:GITHUB}}`. A call made for one of your users acts in their own GitHub account, and any other call in this environment's connected account, so nothing needs connecting before install. Action names and requests are unchanged. An installed action keeps its form until `--update`; `--credential secret` installs the previous form.
- 0.2.0: the complete toolset: 15 reads and 14 more writes. `owner` and `repo` patterns tightened so
  neither can be `.` or `..`.
- 0.1.0: first version.

Sources: https://docs.github.com/en/rest/issues/issues, https://docs.github.com/en/rest/issues/comments,
https://docs.github.com/en/rest/issues/labels, https://docs.github.com/en/rest/issues/assignees,
https://docs.github.com/en/rest/pulls/pulls, https://docs.github.com/en/rest/pulls/reviews,
https://docs.github.com/en/rest/pulls/comments, https://docs.github.com/en/rest/pulls/review-requests,
https://docs.github.com/en/rest/repos/repos, https://docs.github.com/en/rest/repos/contents,
https://docs.github.com/en/rest/branches/branches, https://docs.github.com/en/rest/commits/commits,
https://docs.github.com/en/rest/search/search,
https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens,
https://docs.github.com/en/rest/about-the-rest-api/api-versions, checked 2026-10-15.
