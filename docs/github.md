# Autonomous GitHub issue → PR (`seekforge resolve`)

> **English** | [简体中文](github.zh-CN.md)

`seekforge resolve <issue>` reads a GitHub issue, fixes it on a fresh work
branch with a headless, cost-bounded agent run, verifies the result, and opens a
draft pull request — the OpenHands-style "give it an issue, get a PR" flow.

**Maturity:** implemented and usable, with an explicit human-initiated push/PR
boundary. Issue fixes run in an isolated worktree by default, `--wait-ci` can
wait for hosted checks, and `seekforge resolve-review` can address review
feedback. Existing local `seekforge/issue-<n>` branches are reused when they are
not checked out elsewhere. `--wait-ci` can perform one bounded CI repair pass.

```
seekforge resolve <issue-number-or-url> --max-cost <n> [--base <branch>] [--model <m>] [--no-draft] [--no-worktree] [--wait-ci] [--dry-run] [-y]
```

## The moat: the agent fixes, the command pushes

`resolve` is a **user-initiated command**, so the `git push` and `gh pr create`
are *your* explicit action — performed by the command itself, not by the agent.
The agent only edits files during the headless fix run; it never pushes and
never opens a PR. SeekForge's push-approval gate is therefore fully intact: an
autonomous agent still cannot get code onto your remote without an explicit human
command.

## What "headless" means here

The fix run is genuinely unattended — it can never stop and ask you something:

- **Every approval that would prompt is auto-denied.** The run uses a machine
  output format for exactly the reason `schedule run` does, so anything outside
  `acceptEdits` (shell execution, environment changes, denied-by-policy calls)
  is refused rather than escalated to a human. A guardrail that only holds
  because somebody is watching the terminal is not a guardrail.
- **Only file edits apply autonomously** (`acceptEdits`), inside the work branch.
- **Per-step agent output is not streamed.** You get resolve's own progress lines
  (worktree, verify, PR URL), not a live tool-by-tool render.
- **Folder consent still applies.** SeekForge must be authorized for the
  directory it edits. An already-authorized repository carries that consent into
  the temporary worktree it creates for this run; a checkout that has never been
  authorized (a fresh CI clone) must pass `-y`, because a headless run has no
  prompt to fall back on and fails fast instead.

## Flow

1. **Fetch the issue** (read-only): `gh issue view <n> --json title,body,number`.
   A full issue URL is accepted too — the number is extracted from it.
2. **Create an isolated worktree and work branch** from the selected base, or
   reuse the existing local issue branch. Pass
   `--no-worktree` only when you intentionally want to change the current checkout.
3. **Run the agent headless** to fix it. The task prompt is built from the issue:

   > Resolve GitHub issue #\<n>: \<title>
   >
   > \<body>
   >
   > Make the minimal change that fixes it and ensure tests pass.

   The run is `edit` mode with `acceptEdits` (file edits apply autonomously) and
   is bounded by the **required** `--max-cost` budget.
4. **Verify**: if a `verifyCommand` (and/or `lintCommand`) is configured in
   **your user config** (`~/.seekforge/config.json` or a `--settings` file), it
   is run. **If it fails, no PR is opened** — the fix is left on the branch and
   the failure is reported. These are user-owned settings: a value in a
   repository's `.seekforge/config.json` is stripped as repository input, so a
   clone cannot make `resolve` run a command of its choosing.
5. **Commit + push + open the PR** (the command does this directly):
   `git add -A` → `git commit -m "Resolve #<n>: <title>"` →
   `git push -u origin seekforge/issue-<n>` →
   `gh pr create --base <base> --head <branch> --title "…" --body "Resolves #<n> …" --draft`
   (`--draft` is appended last, and omitted with `--no-draft`).
6. **Print the PR URL.** With `--wait-ci`, a failed check triggers at most one
   repair: the newest failed Actions run's failed-step logs are capped at 20,000
   characters, fenced as untrusted data, fed to the agent, verified, committed,
   pushed, and checked once more.
7. **Copy the session trace back into the repository** before the temporary
   worktree is deleted, so the run stays auditable (see below).

If the agent made no changes, `resolve` stops before committing (nothing to PR).

### What the isolated worktree sees

`.seekforge/` is normally gitignored, so a fresh worktree would not contain it
and the run would fall back to your global config alone. `resolve` therefore
carries the repository's project layer in: the project's preferences (model,
edit format, …), its `deny` permission rules, and its `.seekforge/skills`,
`agents`, `commands`, `output-styles` and `memory/project.md`.

It carries in exactly that and no more. The config is projected through the same
reduction the base checkout applies to a repository layer, so credentials,
`baseUrl`, `verifyCommand` and hooks cannot reach the temporary directory.
`mcpServers` is excluded — repository entries are never trusted and so can never
connect in a headless run, while their `env`/`headers` could hold a secret.
`.seekforge/plugins` is excluded because a plugin can grant a trusted MCP server
and hooks. Nothing is written unless git ignores the destination, so the seeded
files can never end up in the pull request. `resolve-review` does the same.

## Flags

| Flag | Meaning |
| --- | --- |
| `--max-cost <usd>` | **Required.** Per-run cost cap in USD (an autonomous fix must be bounded, exactly like `schedule`). |
| `--base <branch>` | Base branch the PR targets. Default `main`. |
| `--model <m>` | Model override for the headless fix run. |
| `--no-draft` | Open a ready-for-review PR instead of a draft (draft is the default). |
| `--dry-run` | Do steps 1–4 (fetch + branch + fix + verify), then **print** the exact commit/push/PR commands that *would* run — without pushing or opening a PR. |
| `--no-worktree` | Use the current checkout instead of the default temporary isolated worktree. |
| `--wait-ci` | Wait **up to 15 minutes** for hosted PR checks; on failure, allow one bounded failed-log repair and check once more. Hitting the 15-minute limit is reported as a warning, **not** a failure: the PR is already open, so the command still exits successfully and prints the `gh pr checks` command to follow it yourself. |
| `-y`, `--yes` | Pre-authorize the working directory (folder-access consent). Only needed on a checkout SeekForge has never been authorized for — typically CI. It does **not** widen the run's approvals: the fix run stays `acceptEdits`. |

## Prerequisites

- The **GitHub CLI** (`gh`) must be installed and authenticated (`gh auth login`;
  check with `gh auth status`). `resolve` fails early with an actionable hint if
  `gh` is missing.
- The repository must have an **`origin` remote** (`git remote add origin <url>`).
- A provider API key must be configured (same as any `seekforge run`).

## Examples

```bash
# Fix issue 42 and open a draft PR against main, capped at $1.00.
seekforge resolve 42 --max-cost 1.00

# From a URL, targeting a release branch, ready for review.
seekforge resolve https://github.com/owner/repo/issues/42 \
  --max-cost 2.00 --base release/1.4 --no-draft

# See what it would do without pushing or opening a PR.
seekforge resolve 42 --max-cost 1.00 --dry-run

# In CI, on a checkout SeekForge has not been authorized for.
seekforge resolve 42 --max-cost 1.00 --wait-ci -y
```

## Auditing a run afterwards

Each fix is a normal SeekForge session. The fix runs *inside* the temporary
worktree, which is deleted when the run succeeds — so `resolve` copies the
session trace back into your repository's `.seekforge/sessions/` before removing
it. `seekforge sessions` and `seekforge audit`, run from the repository,
therefore show the fix run exactly like any other session, worktree or not.

`seekforge rewind` is the exception: it restores files in the checkout it is run
*in*. With the default worktree the fix never touched your checkout — it lives on
the pushed `seekforge/issue-<n>` branch, so you undo it by closing the PR and
deleting that branch. Under `--no-worktree` the changes *are* in your checkout,
and `seekforge rewind` undoes them there.

## Review feedback

`seekforge resolve-review <pr> --max-cost <usd>` checks out an existing PR in an
isolated worktree, gives its comments and reviews to a bounded headless agent
run, verifies the changes, then commits and pushes them. It supports
`--no-worktree`, `--dry-run`, `--wait-ci`, `--model`, and `-y`.

It shares `resolve`'s boundaries — the agent only edits files, the command
performs the push, the run is cost-bounded, non-interactive, and auditable —
with two deliberate differences:

- **`--wait-ci` does not repair CI here.** It waits (same 15-minute limit) and
  reports a check failure; it never starts a second agent run against the failed
  logs. Re-run `resolve-review` after pushing a fix if you want another pass.
- **It pushes with a plain `git push`**, to the upstream `gh pr checkout`
  configured — which for a PR from a fork is *that fork's* branch, not your
  repository. Check whose PR you are fixing before you run it.

## GitHub Action: answer or fix on a comment

`.github/actions/seekforge` is a reusable composite action that runs SeekForge
in CI when a collaborator mentions it. A comment such as
`@seekforge why does startup take ten seconds?` on an issue or pull request
gets an answer as a comment; `@seekforge fix` on an issue runs `resolve` and
links the draft pull request it opened. A ready-to-copy workflow is in
[`examples/github-action/seekforge.yml`](../examples/github-action/seekforge.yml).

### What triggers it

- Events: `issue_comment` (created), `pull_request_review_comment` (created),
  and `issues` (opened; the title and body are searched). Edits never trigger
  a run.
- The text must contain the trigger phrase (input `trigger-phrase`, default
  `@seekforge`) as a whole token, case-insensitively: `@seekforge-bot` and
  `me@seekforge.dev` do not count.
- **Only people with write, maintain, or admin access** start a run, checked
  with the repository collaborator-permission API. Anyone else is ignored
  without a reply, so a drive-by comment can neither spend the model budget nor
  steer a run. Comments from bots, including the action's own replies, are
  ignored too.

The action first reacts with 👀 and posts a "working on it" comment that links
the workflow run, then rewrites that comment with the result (a review comment
gets its reply in the same thread). If the run fails or stops early, the same
comment says so.

### What runs

A request is a **fix** when the text after the phrase starts with `fix`,
`resolve`, or `implement` (and `allow-fix` is `"true"`); everything else is a
**question**.

- **Question** — the request, the issue or pull request title and description,
  the review comment's file, line and diff hunk, and (on a pull request) its
  diff capped at 200 KB are written to a prompt, each inside a fence longer than
  any backtick run in it and labeled as user-written data. The prompt goes to
  SeekForge on stdin:

  ```bash
  seekforge -p -y --permission-mode default --output-format json --ask \
    --max-cost 1.00 --max-duration 900
  ```

  `-y` only records folder consent for the fresh checkout; `--permission-mode`
  takes precedence and decides what the run may do. With the default mode the
  run is read-only, and in the machine output format anything that would
  prompt is denied. `permission-mode: acceptEdits` drops `--ask` so the run can
  edit the checkout; this action never commits or pushes those edits.
  `allowed-tools` and `disallowed-tools` become `--allowedTools` and
  `--disallowedTools`.
- **Fix on an issue** — `seekforge resolve <issue> --max-cost <usd> -y --base <branch>`
  (plus `--model` and `--wait-ci` when set), exactly as described above: the
  agent edits files in a worktree, and the command commits, pushes and opens a
  draft pull request. The comment links that pull request.
- **Fix on a pull request** — `seekforge resolve-review <pr> --max-cost <usd> -y`
  for a pull request whose branch is in the same repository. A pull request
  from a fork is refused with an explanation, because the action cannot push to
  it.

`resolve` works from the issue itself; any words after `fix` are not passed to
it. Pull requests that a workflow opens with `GITHUB_TOKEN` do not start other
workflows (a GitHub rule); push with a GitHub App or personal token if your CI
must run on them.

### Setup

1. Add the provider's API key as a repository secret, for example
   `DEEPSEEK_API_KEY`.
2. Copy the example workflow to `.github/workflows/seekforge.yml` and pin the
   action to a full commit SHA of this repository.
3. Grant the job `contents: write`, `issues: write`, and `pull-requests: write`
   (the example does). A workflow that should only answer can set
   `allow-fix: "false"` and drop `contents: write`.

### Inputs and outputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | — (required) | Provider API key; pass a secret. |
| `provider` | `deepseek` | `deepseek`, `ark`, or `anthropic`; selects the key variable and the provider preset. |
| `model` | provider default | Model id. |
| `max-cost` | `1.00` | Per-run cost cap in USD. |
| `max-duration` | `900` | Wall-clock cap for a question run, in seconds. |
| `permission-mode` | `default` | `default` (read-only) or `acceptEdits`, for question runs. |
| `allowed-tools` / `disallowed-tools` | empty | Comma-separated tool lists for question runs. |
| `allow-fix` | `"true"` | Whether fix requests run `resolve` / `resolve-review`. |
| `base-branch` | repository default branch | Branch fix pull requests target. |
| `wait-ci` | `"false"` | Pass `--wait-ci` to fix runs. |
| `trigger-phrase` | `@seekforge` | Phrase that starts a run. |
| `seekforge-version` | `1.0.0` | Exact npm version to install. |
| `github-token` | `github.token` | Token for permissions, comments, and pushes. |
| `node-version` | `22` | Node.js version. |

Outputs: `mode` (`question`, `fix`, or `skipped`), `result` (the posted text),
`cost-usd` and `session-id` (question runs), `pull-request-url` (fix runs), and
`comment-url`.

### Safety notes

- Every input is passed to the script through the environment and validated
  before use (an exact version, a positive cost, known providers and modes, a
  plain tool list, a valid branch name). Event text is only ever handled as
  data; it is never part of a shell command.
- The API key is exported only under the provider's variable, and the GitHub
  token reaches `curl` through an owner-only header file rather than its
  command line.
- SeekForge runs with a private `HOME` under the runner's temp directory, so
  its user config and folder consent never touch the runner account's own
  `~/.seekforge`.
- Posted text has the API key and token scrubbed, the trigger phrase broken up
  so the answer cannot start another run, and is truncated to fit a comment.
  Fix runs never quote their log into the comment; the details stay in the
  access-controlled run log.
- The issue text a fix run reads is still written by whoever opened the issue.
  The run applies file edits only, inside a draft pull request a person reviews.

`bash .github/actions/seekforge/test.sh` exercises the action script against
synthetic events with `curl`, `seekforge`, and `npm` stubbed out.
