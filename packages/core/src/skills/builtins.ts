import type { Skill } from "./types.js";

const BUGFIX_CONTENT = `# Bugfix

Reproduce first, locate the root cause, fix minimally, prove it stays fixed.

## When to Use

- The user reports broken behavior: an error, a crash, wrong output, or
  "it does not work" / "no response".
- A specific code path, command, or test is known (or discoverable) to fail.

## Do Not Use When

- The request is a new feature or an intentional behavior change.
- A test itself is failing and the question is whether the test or the code is
  wrong — prefer the test-failure-fix skill.
- The cause is clearly environmental (missing install, wrong Node version).

## Required Context

- The exact error message, or expected vs. actual behavior.
- Project layout and how to run it: call detect_project and list_scripts first.

## Procedure

1. Reproduce first. Use search_text on the error message or symptom to find the
   failing path, then run the failing command or test with run_command. Do not
   edit anything until you have seen the failure yourself.
2. Locate the root cause. Use search_text and read_file on the involved files;
   follow the data flow rather than trusting only the top stack frame.
3. Apply the smallest fix that addresses the cause, not the symptom, using
   apply_patch (oldString must match uniquely — include surrounding lines).
4. If list_scripts shows a test setup, add or adjust a regression test that
   fails before the fix and passes after it (write_file or apply_patch).
5. Re-run the original reproduction and the test suite with run_command.

## Verification

- The originally failing command or test now passes via run_command.
- The project's test/check script passes.
- git_diff shows only changes related to this fix.

## Common Mistakes

- Editing code before reproducing — you may "fix" the wrong thing.
- Patching the symptom (e.g. adding a null check) instead of the cause.
- Bundling refactors into the fix; keep the diff minimal.
- Skipping the regression test when the project already has tests.
`;

const TEST_FAILURE_FIX_CONTENT = `# Test Failure Fix

Run the failing test first and read the real error, then decide whether the
test or the production code is wrong before touching either.

## When to Use

- A test or CI run is failing and the user wants it green again.
- The user pastes a failing test name, assertion diff, or CI log excerpt.

## Do Not Use When

- The failure is flaky infrastructure (network, timeouts) unrelated to code.
- The user asks for brand-new tests for untested code.
- The product bug is already understood — use the bugfix skill instead.

## Required Context

- Which test fails and how to run it: call detect_project and list_scripts to
  find the test runner and its script names.

## Procedure

1. Run the failing test in isolation with run_command (use the runner's file or
   name filter) and read the actual error output — never rely on a paraphrase.
2. read_file both the test and the code under test. Use git_status and git_diff
   to see what changed recently; the failure usually points at the newest edit.
3. Decide which side is broken:
   - broken code: the test encodes the intended behavior and the code drifted;
   - broken test: the behavior changed on purpose and the assertion is stale.
4. Fix only the broken side with apply_patch. Never weaken an assertion just to
   make it pass; if intent is unclear, search_text for related docs or usages.
5. Re-run the specific test with run_command, then the whole suite.

## Verification

- The previously failing test passes when run in isolation.
- The full test suite passes — the fix did not break neighbors.
- git_diff shows edits only on the side you judged broken.

## Common Mistakes

- Changing the assertion to match buggy output instead of fixing the code.
- Fixing based on the failure summary without reading the full error text.
- Re-running only the whole suite and missing the specific test's output.
- Deleting or skipping the test to get CI green.
`;

const SMALL_CODE_CHANGE_CONTENT = `# Small Code Change

Find every occurrence first, edit them all consistently, verify with the
project's own check command.

## When to Use

- Renames, small text/copy updates, constant tweaks, signature adjustments,
  or any localized edit the user describes precisely ("change X to Y").

## Do Not Use When

- The change ripples through architecture or public APIs across packages.
- The user is actually reporting a defect — use the bugfix skill.
- Requirements are vague enough that the target text cannot be pinned down.

## Required Context

- The exact current text/name and the desired new one.
- How the project is checked: detect_project and list_scripts reveal the
  lint/typecheck/test commands.

## Procedure

1. Locate all occurrences with search_text, including tests, docs, comments,
   and config files — not just the first hit. Use list_files when the term is
   too generic to search reliably.
2. read_file around each hit to confirm it is the same concept, not a
   coincidental name collision.
3. Make targeted edits with apply_patch; keep oldString unique per edit and
   preserve the surrounding style (quotes, naming convention, formatting).
4. If a file is renamed or created, use write_file and update its importers.
5. Run the project's check command (typecheck/lint/test from list_scripts)
   with run_command.

## Verification

- search_text for the old text returns no unintended leftovers.
- The project's typecheck/lint/test scripts pass via run_command.
- git_diff contains only the requested change.

## Common Mistakes

- Renaming code but forgetting tests, docs, or string literals.
- Editing a coincidental match that only shares the name.
- Reformatting untouched lines and bloating the diff.
- Skipping verification because the change "looked trivial".
`;

const GITHUB_ISSUE_PR_CONTENT = `# GitHub Issue → PR

Take a GitHub issue from report to reviewed fix: understand it with gh,
reproduce it, fix it on a dedicated branch, and open a PR that links back.

## When to Use

- The user points at a GitHub issue (a number, a URL, or "修复 issue #N")
  and wants it fixed and submitted as a pull request.
- The user asks to open a PR for work that addresses a tracked issue.

## Do Not Use When

- The repository is not hosted on GitHub or \`gh\` is not authenticated.
- The user only wants a local fix with no PR — use the bugfix skill.
- The "issue" is a vague idea, not a tracked GitHub issue.

## Required Context

- The issue number or URL, and a checkout of the target repository.
- How the project is tested: call detect_project and list_scripts first.

## Procedure

1. Read the issue with run_command: \`gh issue view <number>\` (add --comments
   when the discussion matters). Extract the expected behavior and repro steps.
2. Reproduce the problem first: use search_text and read_file to find the
   involved code, then run the failing command or test with run_command.
3. Create a work branch with run_command: \`git checkout -b fix/<issue>\`.
   Never commit fixes to the default branch directly.
4. Apply the smallest fix that addresses the root cause with apply_patch, and
   add or adjust a regression test where the project has a test setup.
5. Run the project's test/check scripts with run_command until green.
6. Commit, push the branch, and open the PR with run_command:
   \`gh pr create\` with a body that links the issue (e.g. "Fixes #<number>")
   and summarizes the change and how it was verified.

NOTE on permissions: read-only \`gh\` runs without a prompt — \`gh issue view\`,
\`gh issue list\`, \`gh pr view/list/diff/checks\`, \`gh repo view\`, and \`gh api\`
GET requests are classified read-only and auto-allow. Mutating commands that
write to GitHub or the remote — \`gh pr create\`, \`gh pr merge/close\`,
\`gh issue create/comment\`, \`gh pr checkout\`, and \`git push\` — will ask for
approval and must NEVER auto-run. If approval is not granted, stop after the
local commit and tell the user the exact commands to run themselves.

## Verification

- The reproduction from step 2 now passes via run_command.
- The full test/check script passes on the branch.
- \`gh pr view\` (or the URL printed by gh pr create) shows a PR whose body
  references the issue.

## Common Mistakes

- Fixing without reading the issue thread — comments often narrow the cause.
- Working on the default branch instead of a fix/<issue> branch.
- Opening the PR before the tests pass locally.
- Pushing or creating the PR without explicit user approval (gh pr create and
  git push always prompt; if denied, hand the commands to the user).
- A PR body that never mentions the issue, breaking the auto-close link.
`;

/** Skills are procedure suggestions only — they never grant permissions. */

const CODE_REVIEW_CONTENT = `# Code Review

Review changes for correctness bugs first, quality second - report findings,
do not fix them unless asked.

## When to Use

- The user asks to review a diff, a branch, recent changes, or a PR.
- Before merging: "review this", "check these changes for problems".

## Do Not Use When

- The user wants the problems FIXED, not listed - review, then ask before fixing.
- There are no pending changes (git_diff empty and no range given).

## Required Context

- What to review: git_diff (uncommitted) by default; a branch/range if named.

## Procedure

1. Collect the change set with git_diff (and git_status); read every touched
   file's surrounding context with read_file - never judge a hunk in isolation.
2. First pass - correctness only: logic errors, off-by-ones, broken error paths,
   race conditions, missing await, wrong types crossing boundaries, behavior
   changes the diff does not mention.
3. Second pass - safety: injection, path traversal, secrets in code or logs,
   unvalidated input reaching exec/fs/network.
4. Third pass - quality, only where it matters: dead code, duplicated logic the
   repo already has a helper for, misleading names, missing tests for changed
   behavior.
5. If the diff claims a behavior ("fixes X", "tests pass"), confirm it: run the
   relevant test or command with run_command rather than trusting the message.
6. For each finding: severity (bug / risk / style), file:line, one-line why,
   and the smallest suggested fix. Skip nitpicks a formatter would catch.

## Verification

- Every finding cites a real file:line from the diff.
- Re-read each "bug" finding once before reporting - drop any you cannot
  defend concretely; false alarms destroy trust in reviews.

## Common Mistakes

- Rewriting the author's style instead of reviewing the change.
- Listing 30 nitpicks that bury the one real bug.
- Reviewing only the diff text without reading the surrounding file.
`;

const SECURITY_REVIEW_CONTENT = `# Security Review

Audit the change (or module) for exploitable issues; report by severity with
concrete attack paths, not generic advice.

## When to Use

- The user asks for a security review/audit of changes, a module, or an endpoint.
- Before exposing something to untrusted input (HTTP handlers, file parsing,
  command construction).

## Do Not Use When

- The user wants general code review - use the code-review skill.

## Required Context

- The attack surface: what input is untrusted, what privileges the code runs with.

## Procedure

1. Map untrusted inputs: search_text for entry points (HTTP routes, argv, env,
   file reads, network responses) feeding the code under review.
2. Trace each input to a sink: command execution, file paths (traversal: search
   for path joins with user input), SQL/queries, HTML output (XSS),
   deserialization, eval.
3. Check authn/authz on every state-changing path; check secrets handling
   (hardcoded keys, secrets in logs or error messages).
4. Check dependency risk only where the diff touches it (new deps, version
   pins loosened); where a finding depends on runtime behavior, confirm it
   with a targeted run_command instead of speculating.
5. Report each finding: severity (critical/high/medium/low), the attack path
   ("attacker controls X, reaches Y, causes Z"), file:line, minimal fix.
   No finding without a plausible attacker story.

## Verification

- Every critical/high finding has a concrete input that triggers it.
- The report states what was checked and found clean, not just the problems.

## Common Mistakes

- Cargo-cult findings ("use HTTPS") with no attack path in THIS code.
- Flagging trusted-input paths as injection risks.
- Missing the boring ones: secrets in logs, world-writable file modes.
`;

const VERIFY_CHANGE_CONTENT = `# Verify Change

Prove a change actually works by running the code, not by reading it.

## When to Use

- After implementing a change, before reporting it done.
- The user asks to verify/confirm the change works.

## Do Not Use When

- Nothing was changed (nothing to verify).

## Required Context

- What behavior changed, and the command that exercises it (detect_project /
  list_scripts if unknown).

## Procedure

1. Identify the narrowest command that exercises the changed behavior: the
   specific test file, a CLI invocation, a request against a dev server.
   If unsure what changed, read_file the touched files (git_diff lists them).
2. Run it with run_command. For servers/watchers use background:true, poll
   task_output until ready, exercise the endpoint, then task_kill.
3. If it fails: that is the result - report the failure honestly with output,
   do not paper over it or claim partial success.
4. Run the project's standard check (test/lint script) to catch fallout
   beyond the targeted path.
5. Report exactly what was run and what each command output proved.

## Verification

- The report quotes real command output, not assumptions.
- Both the targeted check AND the project-wide check ran.

## Common Mistakes

- "The code looks correct" - reading is not verification.
- Testing only the happy path the change was written for.
- Leaving background processes running after verification.
`;

const SIMPLIFY_CONTENT = `# Simplify

Reduce the change (or module) to its essential form: reuse what exists,
delete what is not needed, without changing behavior.

## When to Use

- After a working change: "clean this up", "can this be simpler".
- A diff that grew helpers/abstractions the repo may already have.

## Do Not Use When

- The code is broken - fix first (bugfix skill), simplify after.
- The user asked for a behavior change.

## Required Context

- The scope: the current diff (git_diff) by default.

## Procedure

1. For every new helper/abstraction in the diff, search_text the repo for an
   existing equivalent - reuse beats reimplementation.
2. Delete: unused params, dead branches, premature configuration, comments
   that narrate the code, layers that only forward calls.
3. Inline single-use abstractions; extract only what is used twice or more.
4. Keep names and idioms consistent with the surrounding file - match the
   repo, not your taste.
5. After each simplification, re-run the relevant tests (run_command); revert
   any "simplification" that changes behavior.

## Verification

- Tests pass identically before and after.
- git_diff is NET SMALLER (or equal with clear readability wins) than before.

## Common Mistakes

- Clever one-liners that are shorter but harder to read - simpler is not
  the same as shorter.
- Refactoring beyond the requested scope.
- Removing error handling because the happy path works.
`;

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "bugfix",
    scope: "builtin",
    name: "Bugfix",
    description:
      "Fix a reported defect: reproduce the failure, find the root cause, apply a minimal fix, and guard it with a regression test.",
    tags: ["bug", "fix", "debug"],
    triggers: ["fix", "bug", "修复", "报错", "不工作", "无响应"],
    priority: 50,
    enabled: true,
    risk: "low",
    content: BUGFIX_CONTENT,
  },
  {
    id: "test-failure-fix",
    scope: "builtin",
    name: "Test Failure Fix",
    description:
      "Get a failing test green the right way: run it to read the real error, decide whether the test or the code is broken, fix that side, re-verify.",
    tags: ["test", "ci"],
    triggers: ["test fail", "测试失败", "failing test", "挂了"],
    priority: 60,
    enabled: true,
    risk: "low",
    content: TEST_FAILURE_FIX_CONTENT,
  },
  {
    id: "small-code-change",
    scope: "builtin",
    name: "Small Code Change",
    description:
      "Make a precise, localized edit: find every occurrence including tests and docs, change them consistently, and run the project's checks.",
    tags: ["change", "refactor", "text"],
    triggers: ["改成", "修改", "rename", "change", "update", "调整"],
    priority: 30,
    enabled: true,
    risk: "low",
    content: SMALL_CODE_CHANGE_CONTENT,
  },
  {
    id: "github-issue-pr",
    scope: "builtin",
    name: "GitHub Issue → PR",
    description:
      "Fix a GitHub issue end-to-end: read it with gh, reproduce, fix on a dedicated branch, run the tests, and open a PR that links the issue. gh and git push always need user approval.",
    tags: ["github", "workflow"],
    triggers: ["github", "issue", "pull request", "pr", "修复 issue", "提 pr"],
    priority: 40,
    enabled: true,
    risk: "low",
    content: GITHUB_ISSUE_PR_CONTENT,
  },
  {
    id: "code-review",
    scope: "builtin",
    name: "Code Review",
    description:
      "Review a diff/branch for correctness bugs first, then safety and quality; report severity + file:line + minimal fix, without rewriting the author's style.",
    tags: ["review", "quality"],
    triggers: ["review", "code review", "check the changes", "look for problems"],
    priority: 40,
    enabled: true,
    risk: "low",
    content: CODE_REVIEW_CONTENT,
  },
  {
    id: "security-review",
    scope: "builtin",
    name: "Security Review",
    description:
      "Audit changes for exploitable issues: trace untrusted input to sinks, report severity with a concrete attack path, never cargo-cult advice.",
    tags: ["security", "review"],
    triggers: ["security", "audit", "vulnerability", "injection"],
    priority: 45,
    enabled: true,
    risk: "low",
    content: SECURITY_REVIEW_CONTENT,
  },
  {
    id: "verify-change",
    scope: "builtin",
    name: "Verify Change",
    description:
      "Prove a change works by running it - targeted command plus the project-wide check; report real output, failures included.",
    tags: ["verify", "test"],
    triggers: ["verify", "confirm it works", "test it", "make sure it works"],
    priority: 35,
    enabled: true,
    risk: "low",
    content: VERIFY_CHANGE_CONTENT,
  },
  {
    id: "simplify",
    scope: "builtin",
    name: "Simplify",
    description:
      "Reduce a working change to its essential form: reuse existing helpers, delete the unneeded, behavior identical, diff net smaller.",
    tags: ["refactor", "quality"],
    triggers: ["simplify", "clean up", "make it simpler", "reduce"],
    priority: 30,
    enabled: true,
    risk: "low",
    content: SIMPLIFY_CONTENT,
  },
];
