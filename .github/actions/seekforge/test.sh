#!/usr/bin/env bash
# Self-test for seekforge-action.sh: runs the real gate/run steps against
# synthetic event payloads with `curl`, `seekforge`, and `npm` replaced by
# recording stubs. Needs bash, node, and git. Run: bash .github/actions/seekforge/test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/seekforge-action.sh"
WORK="$(mktemp -d)"
if [[ -z "${KEEP_WORK:-}" ]]; then trap 'rm -rf "$WORK"' EXIT; else echo "keeping $WORK"; fi
FAILURES=0
TOKEN="ghs_testtoken_1234567890"
API_KEY="sk-test-key-abcdef123456"

mkdir -p "$WORK/bin"
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Records each call and answers like the GitHub REST API would.
method=GET body="" accept="" url=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -X) method="${args[i + 1]}" ;;
    --data-binary) body="${args[i + 1]#@}" ;;
    -H) [[ "${args[i + 1]}" == Accept:* ]] && accept="${args[i + 1]#Accept: }" ;;
    http*) url="${args[i]}" ;;
  esac
done
printf '%s\n' "$*" >>"$STUB_LOG/curl-argv.log"
path="${url#"$GITHUB_API_URL"}"
printf '%s %s\n' "$method" "$path" >>"$STUB_LOG/api.log"
if [[ -n "$body" ]]; then cp "$body" "$STUB_LOG/body-$(wc -l <"$STUB_LOG/api.log" | tr -d ' ').json"; fi
case "$method $path" in
  "GET "*/collaborators/*/permission) printf '{"permission":"%s"}' "${STUB_PERMISSION:-write}" ;;
  "POST "*/reactions) printf '{}' ;;
  "POST "*/replies) printf '{"id":556,"html_url":"https://github.com/o/r/pull/3#discussion_r556"}' ;;
  "POST "*/comments) printf '{"id":555,"html_url":"https://github.com/o/r/issues/7#issuecomment-555"}' ;;
  "PATCH "*) printf '{}' ;;
  "GET /repos/o/r/pulls/"*)
    if [[ "$accept" == *diff* ]]; then printf 'diff --git a/x b/x\n+added\n'; else
      printf '{"head":{"label":"o:feature","repo":{"full_name":"%s"}},"base":{"ref":"main"}}' "${STUB_HEAD_REPO:-o/r}"
    fi ;;
  *) echo "unexpected $method $path" >&2; exit 22 ;;
esac
STUB
cat >"$WORK/bin/seekforge" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG/seekforge-argv.log"
case "${1:-}" in
  --version) echo "1.0.0"; exit 0 ;;
  config) env >"$STUB_LOG/config-env.txt"; exit 0 ;;
  resolve | resolve-review)
    env >"$STUB_LOG/fix-env.txt"
    echo "worktree ready"
    [[ "$1" == resolve ]] && echo "PR: https://github.com/o/r/pull/9"
    exit "${STUB_EXIT:-0}" ;;
esac
cat >"$STUB_LOG/prompt.md"
env >"$STUB_LOG/run-env.txt"
if [[ -n "${STUB_RESULT:-}" ]]; then
  printf '%s' "$STUB_RESULT"
else
  printf '%s' '{"type":"result","is_error":false,"result":"It is slow because of X.","session_id":"s-1","total_cost_usd":0.0123}'
fi
exit "${STUB_EXIT:-0}"
STUB
cat >"$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG/npm-argv.log"
STUB
chmod +x "$WORK/bin/"*

fail() {
  echo "FAIL [$CASE]: $*" >&2
  FAILURES=$((FAILURES + 1))
}
expect_contains() { # FILE NEEDLE
  grep -qF -- "$2" "$1" 2>/dev/null || fail "$1 does not contain: $2"
}
expect_absent() { # FILE NEEDLE
  if grep -qF -- "$2" "$1" 2>/dev/null; then fail "$1 unexpectedly contains: $2"; fi
}
output() { # NAME — reads a step output written in the heredoc format
  node -e '
    const text = require("fs").readFileSync(process.argv[1], "utf8");
    const re = new RegExp(`^${process.argv[2]}<<(\\S+)\\n([\\s\\S]*?)\\n\\1$`, "gm");
    let last = "";
    for (const match of text.matchAll(re)) last = match[2];
    process.stdout.write(last);
  ' "$OUT" "$1"
}

# new_case NAME EVENT_NAME PAYLOAD_JSON — fresh runner directories and environment.
new_case() {
  CASE="$1"
  local dir="$WORK/$1"
  mkdir -p "$dir/temp" "$dir/log"
  printf '%s' "$3" >"$dir/event.json"
  : >"$dir/output"
  OUT="$dir/output"
  LOG="$dir/log"
  export STUB_LOG="$LOG" RUNNER_TEMP="$dir/temp" GITHUB_OUTPUT="$OUT" GITHUB_EVENT_NAME="$2"
  export GITHUB_EVENT_PATH="$dir/event.json" GITHUB_REPOSITORY="o/r" GITHUB_RUN_ID="42"
  export GITHUB_SERVER_URL="https://github.com" GITHUB_API_URL="https://api.test" GITHUB_REF="refs/heads/main"
  export GITHUB_TOKEN="$TOKEN" INPUT_TRIGGER_PHRASE="@seekforge" INPUT_ALLOW_FIX="true"
  export INPUT_SEEKFORGE_VERSION="1.0.0" INPUT_PROVIDER="deepseek" INPUT_MODEL="" INPUT_API_KEY="$API_KEY"
  export INPUT_MAX_COST="1.00" INPUT_MAX_DURATION="900" INPUT_PERMISSION_MODE="default"
  export INPUT_ALLOWED_TOOLS="" INPUT_DISALLOWED_TOOLS="" INPUT_BASE_BRANCH="" INPUT_WAIT_CI="false"
  unset STUB_PERMISSION STUB_RESULT STUB_EXIT STUB_HEAD_REPO
}

step() { # STEP — runs one action step with the stubs first on PATH; sets STATUS
  STATUS=0
  PATH="$WORK/bin:$PATH" bash "$SCRIPT" "$1" >"$LOG/$1.stdout" 2>"$LOG/$1.stderr" || STATUS=$?
}

comment_event() { # ACTION BODY [LOGIN] [TYPE] [IS_PR]
  LOGIN="${3:-maintainer}" TYPE="${4:-User}" IS_PR="${5:-false}" ACTION="$1" BODY="$2" node -e '
    const pr = process.env.IS_PR === "true" ? { pull_request: { url: "x" } } : {};
    process.stdout.write(JSON.stringify({
      action: process.env.ACTION,
      comment: { id: 91, body: process.env.BODY, user: { login: process.env.LOGIN, type: process.env.TYPE } },
      issue: { number: 7, title: "Slow startup", body: "It takes `10s`.", ...pr },
      repository: { full_name: "o/r", default_branch: "main" },
    }));
  '
}

# 1. A writer asks a question.
new_case question issue_comment "$(comment_event created $'Hey @SeekForge why is startup slow? $(touch '"$WORK"$'/pwned) ````')"
step gate
[[ "$STATUS" == 0 ]] || fail "gate exited $STATUS"
[[ "$(output proceed)" == true ]] || fail "gate did not proceed"
[[ "$(output mode)" == question ]] || fail "mode was $(output mode)"
[[ "$(output comment-url)" == *issuecomment-555 ]] || fail "no comment url"
expect_contains "$LOG/api.log" "GET /repos/o/r/collaborators/maintainer/permission"
expect_contains "$LOG/api.log" "POST /repos/o/r/issues/comments/91/reactions"
expect_contains "$LOG/api.log" "POST /repos/o/r/issues/7/comments"
[[ -e "$RUNNER_TEMP/seekforge-action/headers" ]] && fail "the token header file outlived the gate step"
step install
expect_contains "$LOG/npm-argv.log" "install --global --no-fund --no-audit seekforge@1.0.0"
step run
[[ "$STATUS" == 0 ]] || fail "run exited $STATUS: $(cat "$LOG/run.stderr")"
expect_contains "$LOG/seekforge-argv.log" "-p -y --permission-mode default --output-format json --max-cost 1.00 --max-duration 900 --ask"
expect_contains "$LOG/prompt.md" 'why is startup slow? $(touch'
expect_contains "$LOG/prompt.md" '`````text'
expect_contains "$LOG/prompt.md" "Request from @maintainer:"
expect_contains "$LOG/run-env.txt" "DEEPSEEK_API_KEY=$API_KEY"
expect_contains "$LOG/run-env.txt" "HOME=$RUNNER_TEMP/seekforge-action/home"
[[ -e "$WORK/pwned" ]] && fail "comment text was executed"
expect_contains "$LOG/api.log" "PATCH /repos/o/r/issues/comments/555"
last_body="$(ls "$LOG"/body-*.json | sort -V | tail -n 1)"
expect_contains "$last_body" "It is slow because of X."
expect_contains "$last_body" '$0.0123'
expect_contains "$last_body" 'session `s-1`'
expect_contains "$last_body" "https://github.com/o/r/actions/runs/42"
[[ "$(output session-id)" == s-1 ]] || fail "session-id output"
[[ "$(output cost-usd)" == 0.0123 ]] || fail "cost-usd output"
expect_absent "$LOG/curl-argv.log" "$TOKEN"
expect_absent "$LOG/seekforge-argv.log" "$API_KEY"

# 2. Anyone without write access is ignored silently.
new_case reader issue_comment "$(comment_event created '@seekforge spend your budget')"
export STUB_PERMISSION=read
step gate
[[ "$(output proceed)" == false ]] || fail "a reader was allowed"
[[ "$(output mode)" == skipped ]] || fail "mode should be skipped"
expect_absent "$LOG/api.log" "POST"

# 3. Bots, edits, and look-alike mentions do not trigger.
new_case bot issue_comment "$(comment_event created '@seekforge hi' 'renovate[bot]' Bot)"
step gate
[[ "$(output proceed)" == false ]] || fail "a bot triggered a run"
[[ -e "$LOG/api.log" ]] && fail "a bot comment reached the API"
new_case edited issue_comment "$(comment_event edited '@seekforge hi')"
step gate
[[ "$(output proceed)" == false ]] || fail "an edit triggered a run"
for text in '@seekforge-bot hi' 'mail me@seekforge.dev' 'no mention at all' '@seekforger hi'; do
  new_case lookalike issue_comment "$(comment_event created "$text")"
  step gate
  [[ "$(output proceed)" == false ]] || fail "'$text' triggered a run"
done
new_case punctuated issue_comment "$(comment_event created '(@seekforge, explain this)')"
step gate
[[ "$(output proceed)" == true ]] || fail "a mention followed by punctuation did not trigger"

# 4. A new issue asking for a fix runs resolve against the default branch.
new_case fix-issue issues "$(node -e 'process.stdout.write(JSON.stringify({
  action: "opened",
  issue: { number: 7, title: "Crash on start", body: "@seekforge fix please", user: { login: "maintainer", type: "User" } },
  repository: { full_name: "o/r", default_branch: "trunk" },
}))')"
step gate
[[ "$(output mode)" == fix ]] || fail "mode was $(output mode)"
expect_contains "$LOG/api.log" "POST /repos/o/r/issues/7/reactions"
step run
[[ "$STATUS" == 0 ]] || fail "fix run exited $STATUS: $(cat "$LOG/run.stderr")"
expect_contains "$LOG/seekforge-argv.log" "resolve 7 --max-cost 1.00 -y --base trunk"
expect_contains "$LOG/fix-env.txt" "GH_TOKEN=$TOKEN"
expect_contains "$LOG/fix-env.txt" "GIT_AUTHOR_NAME=github-actions[bot]"
[[ "$(output pull-request-url)" == https://github.com/o/r/pull/9 ]] || fail "pull-request-url output"
last_body="$(ls "$LOG"/body-*.json | sort -V | tail -n 1)"
expect_contains "$last_body" "Opened https://github.com/o/r/pull/9"
expect_absent "$last_body" "worktree ready"

# 5. A review comment on a fork's pull request is refused; the same repository runs resolve-review.
review_event() { # HEAD_BODY
  BODY="$1" node -e 'process.stdout.write(JSON.stringify({
    action: "created",
    comment: { id: 77, body: process.env.BODY, path: "src/a.ts", line: 12, diff_hunk: "@@ -1 +1 @@\n-a\n+b", user: { login: "maintainer", type: "User" } },
    pull_request: { number: 3, title: "Add feature", body: "desc" },
    repository: { full_name: "o/r", default_branch: "main" },
  }))'
}
new_case fork-review pull_request_review_comment "$(review_event '@seekforge fix this')"
export STUB_HEAD_REPO="someone/fork"
step gate
expect_contains "$LOG/api.log" "POST /repos/o/r/pulls/comments/77/reactions"
expect_contains "$LOG/api.log" "POST /repos/o/r/pulls/3/comments/77/replies"
step run
[[ "$STATUS" != 0 ]] || fail "a fork fix should fail the step"
expect_absent "$LOG/seekforge-argv.log" "resolve-review"
expect_contains "$LOG/api.log" "PATCH /repos/o/r/pulls/comments/556"
last_body="$(ls "$LOG"/body-*.json | sort -V | tail -n 1)"
expect_contains "$last_body" "someone/fork"
new_case same-review pull_request_review_comment "$(review_event '@seekforge fix this')"
step gate
step run
[[ "$STATUS" == 0 ]] || fail "resolve-review exited $STATUS"
expect_contains "$LOG/seekforge-argv.log" "resolve-review 3 --max-cost 1.00 -y"
new_case review-question pull_request_review_comment "$(review_event '@seekforge is this line right?')"
step gate
step run
expect_contains "$LOG/api.log" "GET /repos/o/r/pulls/3"
expect_contains "$LOG/prompt.md" 'The comment is on `src/a.ts` line 12'
expect_contains "$LOG/prompt.md" "+added"
expect_contains "$LOG/prompt.md" 'merges `o:feature` into `main`'

# 6. With fixes disabled, a fix request is answered instead.
new_case no-fix issue_comment "$(comment_event created '@seekforge fix the crash')"
export INPUT_ALLOW_FIX=false
step gate
[[ "$(output mode)" == question ]] || fail "allow-fix=false still ran a fix"
step run
expect_contains "$LOG/prompt.md" "Changing code is disabled"
expect_absent "$LOG/seekforge-argv.log" "resolve"

# 7. Bad inputs stop the run and still close out the "working on it" comment.
new_case bad-input issue_comment "$(comment_event created '@seekforge hi')"
step gate
export INPUT_MAX_COST='1; touch /tmp/x'
step run
[[ "$STATUS" != 0 ]] || fail "an invalid max-cost was accepted"
expect_contains "$LOG/run.stderr" "max-cost must be a positive number"
expect_absent "$LOG/seekforge-argv.log" "-p"
last_body="$(ls "$LOG"/body-*.json | sort -V | tail -n 1)"
expect_contains "$last_body" "stopped unexpectedly"
for bad in "INPUT_PROVIDER=openai" "INPUT_PERMISSION_MODE=bypassPermissions" "INPUT_ALLOWED_TOOLS=read_file;id" \
  "INPUT_MODEL=a b" "INPUT_BASE_BRANCH=--force" "INPUT_MAX_DURATION=0" "INPUT_MAX_COST=0" "INPUT_API_KEY="; do
  new_case "bad-${bad%%=*}" issue_comment "$(comment_event created '@seekforge hi')"
  step gate
  export "${bad?}"
  step run
  [[ "$STATUS" != 0 ]] || fail "$bad was accepted"
done
new_case bad-version issue_comment "$(comment_event created '@seekforge hi')"
export INPUT_SEEKFORGE_VERSION='latest && curl evil'
step install
[[ "$STATUS" != 0 ]] || fail "a non-exact version was accepted"
[[ -e "$LOG/npm-argv.log" ]] && fail "npm ran with a bad version"

# 8. A failed answer is reported, secrets are scrubbed, and the trigger is defused.
new_case failed issue_comment "$(comment_event created '@seekforge hi')"
step gate
export STUB_EXIT=1
export STUB_RESULT="{\"type\":\"result\",\"is_error\":true,\"result\":\"boom $API_KEY and $TOKEN, ask @seekforge again\",\"session_id\":\"s-2\",\"total_cost_usd\":0}"
step run
[[ "$STATUS" != 0 ]] || fail "a failed answer should fail the step"
last_body="$(ls "$LOG"/body-*.json | sort -V | tail -n 1)"
expect_contains "$last_body" "could not finish"
expect_absent "$last_body" "$API_KEY"
expect_absent "$last_body" "$TOKEN"
expect_absent "$last_body" "ask @seekforge again"
expect_contains "$last_body" "boom ***"

# 9. Another provider gets its own key variable and user config.
new_case ark issue_comment "$(comment_event created '@seekforge hi')"
step gate
export INPUT_PROVIDER=ark INPUT_MODEL=glm-5.2 INPUT_PERMISSION_MODE=acceptEdits INPUT_ALLOWED_TOOLS=read_file,apply_patch
step run
[[ "$STATUS" == 0 ]] || fail "ark run exited $STATUS"
expect_contains "$LOG/seekforge-argv.log" "config set provider ark --global"
expect_contains "$LOG/config-env.txt" "HOME=$RUNNER_TEMP/seekforge-action/home"
expect_contains "$LOG/run-env.txt" "ARK_API_KEY=$API_KEY"
expect_contains "$LOG/seekforge-argv.log" "--permission-mode acceptEdits --output-format json --max-cost 1.00 --max-duration 900 --model glm-5.2 --allowedTools read_file,apply_patch"
expect_absent "$LOG/seekforge-argv.log" "--ask"
expect_contains "$LOG/prompt.md" "You may edit files in the checkout"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo "seekforge action self-test: all checks passed"
