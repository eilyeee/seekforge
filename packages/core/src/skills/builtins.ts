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

/** Skills are procedure suggestions only — they never grant permissions. */
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
];
