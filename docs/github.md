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
   `.seekforge/config.json`, it is run. **If it fails, no PR is opened** — the
   fix is left on the branch and the failure is reported.
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
