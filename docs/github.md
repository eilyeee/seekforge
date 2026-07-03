# Autonomous GitHub issue → PR (`seekforge resolve`)

`seekforge resolve <issue>` reads a GitHub issue, fixes it on a fresh work
branch with a headless, cost-bounded agent run, verifies the result, and opens a
draft pull request — the OpenHands-style "give it an issue, get a PR" flow.

```
seekforge resolve <issue-number-or-url> --max-cost <n> [--base <branch>] [--model <m>] [--no-draft] [--dry-run]
```

## The moat: the agent fixes, the command pushes

`resolve` is a **user-initiated command**, so the `git push` and `gh pr create`
are *your* explicit action — performed by the command itself, not by the agent.
The agent only edits files during the headless fix run; it never pushes and
never opens a PR. SeekForge's push-approval gate is therefore fully intact: an
autonomous agent still cannot get code onto your remote without an explicit human
command.

## Flow

1. **Fetch the issue** (read-only): `gh issue view <n> --json title,body,number`.
   A full issue URL is accepted too — the number is extracted from it.
2. **Create a work branch**: `git checkout -b seekforge/issue-<n>`.
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
   `gh pr create --draft --base <base> --head <branch> --title "…" --body "Resolves #<n> …"`.
6. **Print the PR URL.**

If the agent made no changes, `resolve` stops before committing (nothing to PR).

## Flags

| Flag | Meaning |
| --- | --- |
| `--max-cost <usd>` | **Required.** Per-run cost cap in USD (an autonomous fix must be bounded, exactly like `schedule`). |
| `--base <branch>` | Base branch the PR targets. Default `main`. |
| `--model <m>` | Model override for the headless fix run. |
| `--no-draft` | Open a ready-for-review PR instead of a draft (draft is the default). |
| `--dry-run` | Do steps 1–4 (fetch + branch + fix + verify), then **print** the exact commit/push/PR commands that *would* run — without pushing or opening a PR. |

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
```

Each fix is a normal, auditable SeekForge session — inspect it with
`seekforge sessions` / `seekforge audit`, or undo it with `seekforge rewind`.
