# Boundary-defect checklist

> **English** | [简体中文](boundary-checklist.zh-CN.md)

A running list of the boundary/edge-case bug *classes* found in this repo, so we
stop reintroducing them. Each entry is a reusable pattern: the anti-pattern, the
fix, and the real site it was caught. Use it two ways:

- **Writing** parsing / matching / cursor / cache / serialization / lifecycle /
  classification code — check the relevant entries before you commit.
- **Reviewing** a change that touches those areas — walk the list as a checklist.

Most of these pass `typecheck` and even the happy-path tests. They only bite on a
specific boundary input, so they need a deliberate look, not just a green run.

---

## 1. `parse` functions return `NaN`, and every `NaN` comparison is `false`

`Date.parse(x)`, `parseInt(x)`, `parseFloat(x)`, `Number(x)` return `NaN` on bad
input. `NaN >= cutoff`, `NaN < limit`, `NaN === n` are **all** `false`, so a guard
written as "recent → keep" silently takes the *else* branch on unparseable input.

- **Do:** `const n = Date.parse(x); if (Number.isNaN(n) || n >= cutoff) …` — decide
  what an unparseable value means and handle it explicitly.
- **Caught:** `packages/core/src/memory/compact.ts` — a corrupt `addedAt` made
  `NaN >= cutoff` false, so an unknown-age memory fact was silently archived.
- **Also caught:** session metadata accepted offset timestamps but sorted their
  source strings; parse epochs before `keepLast` chooses what pruning retains.

## 2. Prefix matching needs a separator boundary

`subject.startsWith(match)` lets `src/foo` match `src/foobar.ts` and
`npm run build` match `npm run build-all` — a sibling smuggled past the gate.

- **Do:** for an **allow / authorize** decision, require a boundary: `subject ===
  match`, or the match already ends at a separator, or `subject[match.length]` is a
  separator (`" "` for commands, `/` or `path.sep` for paths). For a **deny**
  decision, keep the broad `startsWith` — over-matching a deny fails closed.
- **Caught:** `packages/core/src/tools/permissions.ts` (`ruleMatches` /
  `boundaryPrefix`); the same rationale already lived in `sessionAllowed`.
- **Also caught:** `packages/core/src/hooks/index.ts` (`hookApplies`) — hook
  `pattern: "npm run build"` matched `npm run build-all`, and `src/foo` matched
  `src/foobar.ts`.
- **Also caught:** `apps/tui/src/app.tsx` (`/memory edit`) — a raw
  `target.startsWith(memoryDir)` let `../memory2/project.md` pass because
  `memory2` shares the same string prefix.
- **Also caught:** `packages/core/src/agent/trace.ts` — session ids were joined
  directly into read/write/delete paths, relying on each caller to reject path
  traversal before reaching Core.
- **Also caught:** `packages/core/src/agent/trace.ts` — rewind checkpoint paths
  used lexical containment and could escape through a symlinked parent directory.
- **Also caught:** `packages/core/src/memory/store.ts` — `@import` and the root
  memory file used lexical containment but reads followed symlinks outside the workspace.
- **Also caught:** `apps/server/src/files.ts` — the upload directory could be a
  symlink outside the workspace even though the returned relative path looked safe.
- **Also caught:** `packages/core/src/skills/manage.ts` — enable/disable/remove
  joined an unvalidated skill id and could mutate a directory outside the skill root.
- **Also caught:** `apps/cli/src/authorized-dirs.ts` — ancestor matching used a
  hard-coded separator and mishandled Windows paths and filesystem roots.

## 3. A cache / memo key must include every input that affects the output

If two different requests hash to the same key, the second silently gets the
first one's answer.

- **Do:** hash **all** output-affecting fields, not just the obvious ones.
- **Caught:** `packages/core/src/provider/cache.ts` — the key omitted
  `temperature` and `maxTokens`, so a follow-up call with a larger `maxTokens`
  replayed the earlier truncated reply.
- **Also caught:** `apps/tui/src/statusline-scheduler.ts` — the cache key omitted
  the status-line command, so replacing or re-enabling it reused stale output.
- **Also caught:** provider response caches keyed only by model/request could
  replay data across endpoints or tenants; include an opaque identity derived
  from every response-affecting provider setting.
- **Also caught:** normalized MCP prompt names can collide (`foo_bar`/`foo-bar`);
  assign deterministic unique command names and use the same mapping for lookup.
- **Also caught:** subagent dispatch ids restart within a new manager/run. A
  transcript must update only the latest active matching dispatch, not an older
  completed card that happens to reuse the same local id.
- **Also caught:** Finding ids that include source line numbers duplicate the
  same vulnerability after unrelated lines are inserted. Prefer stable rule,
  path, and normalized evidence identity while keeping line numbers as location.

## 4. Serialize and deserialize must be exact inverses

If the writer uses `JSON.stringify` but the reader only strips the outer quotes,
any value containing `"` or `\` is corrupted on a render→reload round-trip.

- **Do:** pair the encoder and decoder deliberately; when the writer JSON-encodes,
  the reader must `JSON.parse`. Add a round-trip test with a quote/backslash value.
- **Caught:** `packages/core/src/subagents/frontmatter.ts` vs `import.ts`.
- **Also caught:** Git paths may contain newlines, so line-delimited worktree
  porcelain is not reversible; request `git worktree list --porcelain -z` and
  parse NUL-delimited fields end to end.
- **Also caught:** aliases in a structured numeric grammar must be normalized
  after parsing values, not by replacing characters in the source; cron DOW
  replacement of `7` corrupted valid ranges and steps such as `5-7` and `*/7`.

## 5. Cursor / index math must be surrogate-pair & multibyte aware

Astral characters (emoji, CJK-ext) are two UTF-16 code units. A bare `cursor ± 1`
lands *between* the halves and corrupts the text on the next edit.

- **Do:** step by whole code points (`stepLeft`/`stepRight`/`moveLeft`/`moveRight`)
  and `snapToBoundary` any clamped position. Test with `"😀"`.
- **Caught:** `apps/tui/src/vim.ts` (insert-mode Escape, charwise `p`) — the
  helpers already existed in `editor.ts`; vim just bypassed them.
- **Also caught:** `apps/tui/src/components/MultilineComposer.tsx` — cursor
  rendering indexed a single UTF-16 unit and split emoji surrogate pairs.
- **Also caught:** Vim word/end motions used direct string indexing and could
  stop inside a surrogate pair; classify and advance by editor code-point helpers.
- **Also caught:** TUI vertical movement used UTF-16 offsets as terminal columns,
  and tab titles sliced graphemes; compute display width and truncate only at
  grapheme boundaries.

## 6. Every `addEventListener` needs a matching `removeEventListener`

`{ once: true }` only removes the listener *if it fires*. On the normal
settle/cleanup path it never fires, so a listener attached to a long-lived signal
leaks once per operation.

- **Do:** name the handler and `removeEventListener` it in a `finally` / settle
  callback (or use `AbortSignal.any`). Same for timers, streams, child processes.
- **Caught:** `packages/core/src/subagents/manager.ts` — abort listener on the
  shared parent `AbortSignal`.
- **Also caught:** `packages/core/src/agent/trace.ts` — cached append file
  descriptors had to be closed before deleting a session, or recreating the same
  id kept writing to the unlinked inode.

## 7. Enforce protocol invariants at the serialization / request boundary

State persisted mid-operation (cancel / error / limit hit between two writes) can
violate an invariant a downstream consumer requires. Fixing only the one write
path leaves every other path exposed.

- **Do:** enforce the invariant centrally where the data leaves the system, so it
  holds no matter how the data got there. Make it a no-op for well-formed input.
- **Caught:** `packages/core/src/provider/mapping.ts` (`toWireMessages`) — an
  assistant `tool_calls` with no matching `tool` results (turn cancelled/capped
  mid-flight) 400'd the OpenAI-compatible API on `/resume`. Now unanswered
  tool_calls and orphan tool results are dropped before the request is built.
- **Also caught:** streaming EOF was finalized without the required `[DONE]`
  terminator, turning a dropped connection into a successful partial response.
- **Also caught:** tool-call ids are not guaranteed unique across a whole
  session. Pair results within each assistant turn; a global responded-id set
  can make an interrupted call look complete when an earlier turn reused its id.
- **Also caught:** session-audit exports paired tool results through a global
  id map, so a later turn reusing an id rewrote the earlier call's evidence.
  Audit/report code must preserve the same per-assistant-turn pairing boundary.
- **Also caught:** an optional security field that is present but malformed must
  reject the request. Invalid WebSocket `selectedHunks` previously widened a
  partial permission response into approval of the complete patch.
- **Also caught:** unknown subagent modes defaulted to writable `edit`; enum-like
  security settings must reject unknown values instead of choosing a permissive
  fallback.

## 8. `JSON.parse` succeeding does not mean you got an object

`null`, `42`, `"x"`, `[]` are all valid JSON. Code that then spreads
`...parsed.field` throws an opaque `TypeError`.

- **Do:** after parsing config-shaped input, assert it's a non-null, non-array
  object before using it; return `{}` or throw a descriptive error otherwise.
- **Caught:** `apps/cli/src/config.ts` (`readJson` / `readSettingsFile`).
- **Also caught:** `apps/cli/src/mcp-config.ts` (`readConfigDoc`) — JSON
  `null` / `[]` / `"x"` was returned as a config document and later crashed on
  `doc.mcpServers`.
- **Also caught:** `apps/server/src/routes/settings.ts` (`readConfigDoc` /
  `mutateMcpServers`) — non-object project config JSON crashed settings routes
  such as `/api/hooks` and `/api/mcp`.
- **Also caught:** `apps/cli/src/commands/run.ts` (`--mcp-config`),
  `apps/cli/src/commands/config.ts` (`config set`), and
  `apps/server/src/config.ts` (`setConfigValue`) — non-object JSON passed the
  parse step but later failed during MCP merge or config mutation.
- **Also caught:** `packages/core/src/runtime/client.ts` — valid JSON such as
  `null` or a forged response shape could crash the readline callback or settle
  a pending runtime request with invalid data.
- **Also caught:** `packages/core/src/agent/trace.ts` — unvalidated session
  metadata could crash listing or forge an id used later by pruning.
- **Also caught:** `packages/core/src/agent/trace.ts` — valid JSON scalars and
  arrays in `messages.jsonl` were replayed as forged `ChatMessage` values.
- **Also caught:** `packages/core/src/mcp/http.ts` — plain JSON transport accepted
  `null` and responses for a different JSON-RPC request id.
- **Also caught:** `packages/core/src/provider/sse.ts` and `mapping.ts` — valid
  JSON non-objects crashed streaming, while non-finite token counts poisoned cost
  and budget accounting.
- **Also caught:** `packages/core/src/tools/lsp/client.ts` — framed JSON `null`
  reached the stdout event dispatcher and could throw outside the request promise.
- **Also caught:** `packages/core/src/mcp/tools.ts` — malformed `tools/list`
  data escaped a per-server failure boundary during the later mapping loop.
- **Also caught:** `apps/server/src/config.ts` and CLI doctor — JSON `null`
  reached object spread/property access even though parsing itself succeeded.
- **Also caught:** `packages/eval-harness/src/config.ts` cast arbitrary JSON to
  `EvalConfig`; scalars crashed provider selection and malformed nested pricing
  could poison cost accounting. Filter scalar fields and validate every price.
- **Also caught:** `packages/core/src/skills/manage.ts` — non-object `skill.json`
  values crashed enable/disable instead of being repaired.
- **Also caught:** `apps/tui/src/config.ts` — unlike the CLI and server, a valid
  JSON scalar or array was passed into layered merging and `null` crashed TUI
  startup on the first property access.
- **Also caught:** `packages/shared/src/config-layers.ts` — an object-shaped
  config could still supply non-array permission rules, non-object MCP maps, or
  malformed MCP entries/hooks and crash merging or downstream consumers.
  Validate every structured field and retain lower-precedence valid values.
- **Also caught:** safely ignoring a non-object config is not enough if doctor
  still reports it as valid merely because `JSON.parse` succeeded. Configuration
  diagnostics must validate the expected top-level shape too.

## 9. "Read-only vs mutating" classification: check each command's real effect

Empty-args ≠ listing. Bare `git stash` is `git stash push` and mutates the working
tree; treating "no args = read-only" auto-ran it with no confirmation.

- **Do:** classify by the command's actual side effect, per subcommand. When in
  doubt, treat as mutating (require confirmation) — fail closed.
- **Caught:** `packages/core/src/tools/run-command.ts` (`classifyGit`).
- **Also caught:** `packages/core/src/tools/run-command.ts` (`classifyGh`) —
  `gh api --method=POST` / `-XPOST` and `--field=...` forms were not parsed as
  mutating, so they could be misclassified as read-only GET requests.
- **Also caught:** repeated `gh api -X/--method` flags — inspecting only the
  first let a later POST override an auto-approved GET classification.
- **Also caught:** `apps/server/src/routes/git.ts` — client filenames were passed
  as Git pathspecs, so names beginning with pathspec magic changed command scope.
- **Also caught:** an allowlisted prefix does not authorize a shell program with
  unquoted control operators. Reject compound syntax and redirection before
  builtin, user, session, or rule-based auto-approval.

## 10. Clamp externally-supplied numbers that feed ranking / sizing / budgets

An unbounded value from a user-authored file can dominate a score meant to be a
tie-breaker, or blow past a budget.

- **Do:** clamp to the intended range at the load boundary (`Math.max(lo,
  Math.min(hi, x))`) rather than trusting the input.
- **Caught:** `packages/core/src/skills/load.ts` — a crafted `priority: 500`
  outweighed genuine match signal (priority is meant to be `[0,100]`).

## 11. Handle empty / unborn / zero states in parsers

Fresh repo (no commits), empty collection, empty string, single element, zero
trials — these produce output shapes the happy path never sees.

- **Do:** enumerate the zero/one/unborn cases for any parser or stats function and
  test them.
- **Caught:** `apps/server/src/rest.ts` (`gitStatus`) — `## No commits yet on main`
  parsed the branch as `"No"`. (See also empty-set guards across
  `packages/eval-harness`.)
- **Also caught:** line-delimited Git porcelain parsing treated ` -> ` inside an
  ordinary filename as rename syntax; use the NUL-delimited machine format.

## 12. Decide the sign of a formatted number *after* rounding

`value >= 0 ? "+"+fixed : fixed` prints `+0` for an unchanged delta and `-0.0000`
for a tiny negative that rounds to zero — both misleading.

- **Do:** round first, then if the rounded value is `0` emit an unsigned zero.
- **Caught:** `packages/eval-harness/src/{report,ab}.ts` (`signed`).

## 13. When a comment/doc and a test disagree, the test is the spec

A doc comment claimed "solo-run task = tie" while a test asserted it's credited to
the variant that ran it. Don't "fix" the code to match the comment — confirm intent
(the test encodes it) and fix the comment.

- **Caught:** `packages/eval-harness/src/ab.ts` (`AbSummary` doc vs
  `compareVariants` behavior).

## 14. Parsed numeric metadata must be finite, not just a number

JSON can parse huge numeric literals such as `1e999` to `Infinity`; `typeof` is
still `"number"`, but freshness checks and cursor/index arithmetic become wrong.

- **Do:** use `Number.isFinite` for cache timestamps, TTLs, indexes, cursors, and
  other parsed numeric metadata before arithmetic.
- **Caught:** `packages/core/src/provider/cache.ts` — a non-finite cache `ts`
  could make a poisoned entry look fresh.
- **Also caught:** `apps/cli/src/version-check.ts` — an infinite `checkedAt`
  timestamp made the update cache fresh forever.
- **Also caught:** `apps/server/src/recents.ts` — an infinite `lastOpened`
  timestamp permanently dominated recent-workspace sorting.
- **Also caught:** `apps/cli/src/schedule.ts` — an infinite persisted job budget
  disabled the cost stop because no finite spend can reach `Infinity`.
- **Also caught:** `apps/server/src/ws.ts` — `selectedHunks` validated only the
  outer array, allowing negative, non-integer, and unbounded indices into Core.

## 15. Shared security guards may need a narrower capability-specific exception

Reusing a strict guard can silently make the new capability unusable. A web fetcher
must reject loopback, while a browser verification tool must be able to inspect a
user-confirmed local development server.

- **Do:** keep the strict shared default and add the smallest explicit exception
  at the capability boundary; do not broaden the shared guard.
- **Caught:** `packages/core/src/tools/builtins/browser.ts` — reusing
  `checkFetchUrl` made the documented `http://localhost:5173` workflow impossible.

## 16. Validate every network hop, not only the initial URL

An approved public URL can redirect to a private address, and a loaded page can
request private subresources. Checking only the first URL leaves the SSRF guard
open after navigation begins.

- **Do:** enforce the URL policy at the browser/network request boundary for
  redirects and subresources as well as the initial navigation.
- **Caught:** `packages/core/src/tools/builtins/browser.ts` — the initial URL was
  checked, but Playwright followed later requests without reapplying the policy.

## 17. Enforce guardrails at the finest observable boundary

Checking a budget or cancellation signal only between high-level iterations lets
one iteration continue making calls long after the stop condition is observable.
Likewise, cancelling a parent operation without signalling its child process
leaves the user waiting for timeout.

- **Do:** check budgets on each usage update, propagate cancellation into active
  subprocess trees, and check an already-aborted signal before preflight work.
- **Caught:** `packages/core/src/agent/auto-loop.ts` and
  `packages/core/src/tools/run-command.ts` — loop budget/cancellation previously
  took effect only after a full agent run or verification timeout.
- **Also caught:** `packages/core/src/provider/http.ts` — caller cancellation was
  treated as a retryable network error and retry backoff ignored the abort signal.
- **Also caught:** `packages/core/src/agent/loop.ts` — finalize auto-verify and
  auto-lint commands omitted the run signal and delayed cancellation until exit.
- **Also caught:** `apps/tui/src/app.tsx` — Ctrl+C aborted the run controller but
  left the frontend `ask_user` promise unresolved, so the run never observed it.
- **Also caught:** the agent loop did not put its signal on `ToolContext`, so an
  in-flight foreground command outlived cancellation despite executor support.
- **Also caught:** a successful non-streaming provider response cleared its
  timeout after headers, leaving a stalled JSON body uncancellable; retain the
  timeout and caller signal through body consumption.
- **Also caught:** response-body consumption happened after the retry helper
  returned, so a stalled, truncated, or malformed `200` body neither retried nor
  reached model fallback; parsing must remain inside the attempt boundary.
- **Also caught:** fallback error handling rethrew the primary model failure even
  when the caller cancelled the fallback attempt; caller abort must take priority
  over preserving an earlier retryable error.
- **Also caught:** `DOMException.code` is numeric, so forwarding arbitrary error
  codes classified an in-flight `AbortError` as a failed session; an aborted run
  signal must force the stable string code `cancelled`.
- **Also caught:** TUI async MCP prompts did not reserve a run until after the
  prompt resolved, and Ctrl+C counts were global; reserve before awaiting and
  bind interrupt state to the originating tab/run identity.

## 18. Exclude internal state from convergence inputs

Persisting orchestration state inside a workspace can make every iteration look
like progress when that state is also included in the workspace fingerprint.

- **Do:** exclude internal traces, uploads, and loop-state files from content
  fingerprints, and independently bound live-output event count and chunk size.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — persisted loop updates and
  unlimited verifier chunks could defeat no-progress detection or grow clients.

## 19. Numeric option parsers must consume the full string

`parseInt("2x")` and `parseFloat("1.5usd")` silently accept a valid prefix. They
also permit non-finite values unless checked separately.

- **Do:** validate the complete numeric grammar first, then convert and require a
  safe integer or finite float as appropriate.
- **Caught:** `apps/cli/src/index.ts` — global positive integer/float option parsers.
- **Also caught:** `apps/cli/src/schedule.ts` — cron fragments used `parseInt`,
  accepting values such as `1x`, `1-2x`, and `*/2x`.
- **Also caught:** CLI `serve --port` and `sessions prune` accepted junk suffixes
  because `parseInt("12junk")` returns `12`.
- **Also caught:** CLI permission-hunk and `ask_user` selections accepted trailing
  junk such as `1abc`; validate every token completely and against the offered
  indices before approving or selecting it.

## 20. Lifecycle cleanup must prove ownership before deleting shared state

A stale worker can finish after its lease was replaced and accidentally remove
the new owner's lock, allowing concurrent mutation of the same persisted state.

- **Do:** identify leases with unguessable ownership tokens, recover only dead
  owners, and compare the token again before cleanup removes a lock.
- **Caught:** `packages/core/src/agent/loop-state.ts` — autonomous-loop leases.
- **Also caught:** `apps/cli/src/loop-worktree.ts` — cleanup now requires both
  the retained worktree root and the Loop-only `seekforge/loop-*` branch prefix,
  so it cannot delete another SeekForge workflow's checkout.
- **Also caught:** concurrent first LSP calls reused a session inserted into the
  registry before its initialize handshake completed; share the startup promise.
- **Also caught:** the LSP registry was keyed only by language, so concurrent
  workspaces disposed each other's server; include workspace identity in the key.
- **Also caught:** cached LSP documents were not refreshed before definition or
  reference requests; track the last text and send `didChange` after disk edits.
- **Also caught:** concurrent diagnostics for one URI overwrote a single waiter;
  coalesce the in-flight request or retain all waiters for that identity.
- **Also caught:** top-level agent cleanup globally disposed shared LSP and
  browser processes while concurrent runs still used them; retain a token per
  run and tear down only after the final matching owner releases it.
- **Also caught:** LSP server exit/disposal resolved pending diagnostics as an
  empty successful result; lifecycle failure must reject every affected waiter.
- **Also caught:** two connections could resume the same persisted session and
  interleave JSONL, metadata, and checkpoints; acquire a run-scoped session lease.
- **Also caught:** server shutdown closed HTTP listeners without aborting active
  trigger runs; track managed run handles and await their cleanup before close.
- **Also caught:** webhook delivery IDs were reserved before payload validation,
  so one malformed request permanently consumed a valid retry identifier.
- **Also caught:** a foreground shell could exit while a background descendant
  retained output pipes, making reader joins bypass the command timeout; clean
  up the owned process group before joining pipe readers.
- **Also caught:** a descendant can call `setsid()` and escape that process group
  while retaining stdout/stderr; output drainage itself needs a deadline and
  must not unconditionally join a reader that may never see EOF.
- **Also caught:** adding cancellation support at the provider boundary is not
  sufficient unless the agent loop passes its run signal into every active model
  request, including streaming reads and non-streaming body consumption.
- **Also caught:** stale-lock recovery itself needs an exclusive recovery lease;
  otherwise two recoverers can race and the second can rename the first one's
  newly acquired lock after validating the old owner.
- **Also caught:** JSON-RPC request order is not response order. Serializing all
  MCP requests lets one long tool call block ping/list/cancellation even though
  request IDs permit independent in-flight handlers.
- **Also caught:** cancellation must remove the matching pending request, timer,
  and listener on the client, send `notifications/cancelled`, and abort only the
  server-side tool context with the same request ID.
- **Also caught:** a subprocess runtime cannot observe cancellation while its
  stdin loop is blocked executing one request; dispatch through a bounded worker
  pool, keep request IDs active through output drainage, and let cancel/EOF set
  the matching command's termination flag.
- **Also caught:** a client-side JSON-RPC timeout is cancellation too; send
  `notifications/cancelled` with the original request ID before rejecting so
  the server does not keep doing abandoned work.
- **Also caught:** an HTTP cancellation notification must not be awaited to
  completion; an unresponsive server could otherwise add a second full timeout
  before the original cancellation or timeout reaches the caller.
- **Also caught:** LSP request cancellation must remove the pending request,
  timer, and abort listener, then send `$/cancelRequest` with the original ID.
- **Also caught:** an SSE peer can stream one unterminated event forever; cap
  both complete event size and the incomplete buffer, and cancel the reader on
  overflow so memory use and transport lifetime stay bounded.
- **Also caught:** marking a lease released before filesystem cleanup succeeds
  turns a transient cleanup failure into a live orphan. Keep local ownership and
  make `release()` retryable until the token-owned directory is actually gone.
- **Also caught:** server shutdown aborted sockets but did not await detached
  WebSocket/REST operations; track every launched operation and drain the set.
- **Also caught:** a shared mutable retry callback routed concurrent AgentCore
  runs into whichever queue registered last. Bind retry delivery to the
  originating asynchronous run context.
- **Also caught:** runtime disposal forced down a newly spawned child before it
  could consume queued cancellation under parallel load. Keep shutdown bounded,
  but allow a realistic grace window for ordered stdin messages to drain.

## 21. Checkpoint at the event that makes cost or ownership observable

Persisting only after a whole agent run loses the session id and billed usage if
the process exits between provider events and the final report.

- **Do:** checkpoint session identity immediately and persist cumulative usage
  updates idempotently; final writes should repeat the same absolute totals.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — crash recovery could open a
  new session and undercount the Loop budget.

## 22. Never replay a request after declaring it interrupted

A reconnect queue can outlive the UI operation that created it. Replaying the
request later starts invisible work and desynchronizes controls from the server.

- **Do:** clear connection-bound queued requests when that connection fails;
  requests intentionally submitted while disconnected belong to the next attempt.
- **Caught:** `apps/desktop/src/lib/ws.ts` — a queued Loop could start after the
  store had already cleared its running state.
- **Also caught:** `apps/desktop/src/store.ts` — resetting a session while its
  socket run was active let late events populate the newly cleared transcript.
- **Also caught:** Desktop backtrack and continue callbacks resolved against the
  then-active tab/workspace instead of the identity captured before the await.
- **Also caught:** workspace-scoped view requests could repaint a newly selected
  workspace; remount views by workspace and invalidate chat-scoped callbacks.
- **Also caught:** a delayed image upload read the next tab's draft from a shared
  component instance; key async composer state by tab identity.
- **Also caught:** a tab-bound home view accepted a workspace prop but its recent
  sessions/skills/agents calls still fell back to the global active workspace;
  pass the captured tab workspace through every scoped request.
- **Also caught:** detail requests for sessions, agents, and skills committed
  after selection changed; bind each response to a generation and selected id.
- **Also caught:** Git status and hooks loads committed after workspace changes,
  then destructive actions or saves targeted the newly active workspace. Capture
  workspace identity and guard both response commits and mutations.
- **Also caught:** TUI drafts and run settings crossed tab boundaries because
  editor state was global and model/approval were read after an awaited MCP load;
  key drafts by tab and snapshot all run inputs before the first await.

## 23. A PID is not a durable process identity

Operating systems reuse PIDs. A stale lock containing a live-but-reused PID can
remain permanently active, while a partially written lock can be mistaken for a
dead owner and stolen.

- **Do:** persist a process start identity with the PID, compare both during
  recovery, and treat fresh malformed locks as active for a bounded grace period.
- **Caught:** `packages/core/src/agent/loop-state.ts` — persisted Loop leases.
- **Also caught:** `apps/cli/src/schedule.ts` repeated the PID-only check for
  scheduler leases; persist and compare process start identity there as well.
- **Also caught:** a recovery lock can itself be abandoned if its owner crashes;
  give malformed recovery state a grace period and reclaim it after expiry.

## 24. Count completed units, not merely started units

Checkpointing an iteration number at `iteration.start` consumes the slot if the
process crashes before that iteration produces a result.

- **Do:** checkpoint recoverable session and cost events immediately, but advance
  the unit counter only at the event that proves completion.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — interrupted Loop iterations.

## 25. Append-only logs recover to the longest valid prefix

Skipping a malformed JSONL record and accepting later records can combine events
that were never adjacent, violating protocol ordering after a partial write.

- **Do:** stop at the first malformed record and replay only the longest valid
  prefix; keep metadata replacement atomic with temp-file + rename.
- **Caught:** `packages/core/src/agent/trace.ts` — session resume traces.
- **Also caught:** checkpoint recovery skipped malformed rows and accepted later
  snapshots, allowing rewind to trust state with a missing causal prefix.

## 26. Logical path equality is not physical workspace equality

Symlink aliases and platform aliases such as `/var` and `/private/var` can name
the same directory while failing a string equality check.

- **Do:** canonicalize existing workspace roots with `realpath` before persisting,
  keying leases, or validating loaded state.
- **Caught:** `packages/core/src/agent/loop-state.ts` — non-Git Loop management.

## 27. A bounded file prefix is not a content fingerprint

Hashing only the first chunk plus file size misses same-size edits later in a
large file and can trigger a false no-progress stop.

- **Do:** stream the complete file through the hash in bounded-memory chunks.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — Loop convergence detection.

## 28. Validate arithmetic results, not only their operands

Two finite positive numbers can overflow to `Infinity`. If a later layer treats
non-finite values as "unset", an overflow can silently remove a guardrail.

- **Do:** validate the result after additions and multiplications that produce
  budgets, limits, timestamps, or sizes.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — additive resume budget.
- **Also caught:** schedule interval counts were finite but their conversion to
  milliseconds could exceed the safe-integer range; validate the product too.

## 29. Metadata calls may follow symlinks across a sandbox boundary

`stat` follows a symlink, so code that intends to fingerprint a workspace entry
can accidentally read a target outside the workspace. Ignoring symlinks entirely
also misses changes to the link itself.

- **Do:** use `lstat` to classify entries and hash `readlink` output for symlinks;
  never open the target as workspace content.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — convergence fingerprinting.
- **Also caught:** cached server search results and project config/trigger paths
  were re-opened without physical-path revalidation, allowing a later symlink
  swap to escape the workspace; reject symlinks and open with `O_NOFOLLOW`.
- **Also caught:** internal state roots need stricter semantics than ordinary
  workspace resolution. Session traces and Git worktree roots must reject every
  symlinked directory component, revalidate physical containment, and use
  no-follow leaf opens or atomic replacement before reading or writing.
- **Also caught:** a predictable root under the shared temporary directory is a
  security boundary. Create each component without following symlinks and
  require the current OS owner plus private (`0700`) directory permissions.
- **Also caught:** validating a path and reopening it later leaves a swap window.
  Open leaves and parents with no-follow flags, compare descriptor/path identity,
  and delay truncation until the opened file passes physical revalidation.
- **Also caught:** task `@path` expansion used lexical containment before `stat`
  and `readFile`, so a symlink inside an allowed workspace or extra read-only
  directory could inject a file from outside that root. Resolve both roots and
  referenced files physically, then re-check containment before reading.
- **Also caught:** unauthenticated static serving followed symlinks inside its
  root. Canonicalize the static root and use no-follow descriptor reads with
  path/descriptor identity checks for every requested asset.
- **Also caught:** the server raw-upload boundary treated the physical target of
  a symlinked uploads directory as trusted, and directory listings reopened a
  verified path without rechecking identity after enumeration.
- **Also caught:** project Skill discovery opened a symlinked `SKILL.md` outside
  the workspace; validate the physical content file against its owning root.

## 30. Related mutations must share one serialization domain

Separate locks for operations that mutate the same underlying resource do not
prevent races. A Git worktree create changes the same base repository metadata
as merge and remove even though their API routes and target ids differ.

- **Do:** identify the physical resource being mutated, key one lock by that
  identity, and acquire the same workspace/session guard for every operation in
  the family.
- **Caught:** `apps/server/src/worktrees.ts` — create, merge, and remove now
  share the base-repository lock; create also holds the base workspace guard.
- **Also caught:** REST stage/unstage/discard/commit mutated the same index and
  refs outside that lock; Git routes and worktree operations must use one
  coordinator keyed by the physical common Git directory.
- **Also caught:** `PUT /api/file` wrote workspace files without the active
  session guard, allowing the editor to overwrite concurrent Agent changes.
  Every independent workspace mutation surface must acquire the same guard.
- **Also caught:** Desktop Git stage/unstage/discard and commit used independent
  pending flags, allowing conflicting writes to be issued concurrently.
- **Also caught:** backtrack restored files and truncated trace as separate
  mutations, and memory compaction removed facts before archive persistence.
  Perform the fallible prerequisite first, then commit the destructive update
  while holding the shared guard.
- **Also caught:** TUI `/rewind` lacked the active-run guard used by adjacent
  history commands, allowing checkpoint restoration to race Agent writes.

## 31. Derived syntax semantics belong to parsed values

Textual spelling is not semantic restriction. `*` and `*/1` cover the same cron
domain even though their source strings differ.

- **Do:** derive unrestricted/restricted flags from the normalized value set.
- **Caught:** `apps/cli/src/schedule.ts` — DOM/DOW OR semantics made `*/1` run a
  day-specific autonomous job every day.

## 32. Mutable ordinals are not persistent identities

An index changes after insertion/deletion. Queuing two mutations by displayed
index can apply the second action to a different item after renumbering.

- **Do:** use a stable id/content fingerprint, serialize mutations, and fail
  closed when identity is ambiguous.
- **Caught:** `apps/desktop/src/views/MemoryView.tsx` — concurrent fact deletes.

## 33. Untrusted data must not contain its own fence delimiter

Labeling a prompt section as untrusted does nothing if payload text can close
the section and resume instruction-like text outside it.

- **Do:** encode every interpolated key and value for the delimiter grammar.
- **Caught:** `apps/server/src/triggers.ts` — webhook titles could inject
  `</untrusted-event-data>` into a headless edit task.

## 34. Aggregate cost at every observable usage update

Completion-only accounting loses already-billed work when a background child is
aborted or outlives the parent.

- **Do:** merge monotonic cumulative deltas immediately and never add the same
  child total again at completion.
- **Caught:** `packages/core/src/agent/loop.ts` — background subagent usage.

## 35. A synchronous call cannot enforce an external wall-clock budget

Checking `Date.now()` around a potentially catastrophic regex or blocking child
wait cannot interrupt the call while it owns the thread.

- **Do:** reject unsafe regex grammars before execution; run subprocess methods
  in owned process groups with bounded output drainage, cancellation polling,
  and an internal deadline.
- **Caught:** `apps/server/src/files.ts` regex search and Rust runtime Git calls.
- **Also caught:** Core `search_text` ran arbitrary regular expressions on the
  Node main thread; reject backreferences and ambiguous nested quantifiers before
  constructing the expression.
- **Also caught:** custom-command timeouts killed only the shell and accepted
  captured stdout as success. Own the process group, bound output, terminate the
  descendants, and reject every timeout or nonzero exit.

## 36. Persisted cache hits need full contract validation

A valid timestamp does not make the cached payload valid. Partial objects and
non-finite or impossible counters can crash consumers or poison budgets.

- **Do:** validate the complete response shape and numeric invariants; treat any
  mismatch as a cache miss.
- **Caught:** `packages/core/src/provider/cache.ts` — cached `ChatResponse` data.

## 37. A successful transport is not a successful verification

A valid tool-result envelope can describe a failed or still-running process.

- **Do:** require operation-specific success, including foreground completion
  and exit code zero, before recording verification or lint success.
- **Caught:** `packages/core/src/agent/loop.ts` — nonzero and background commands
  satisfied verify/lint completion gates.
- **Also caught:** numeric option parsers must throw on invalid input rather than
  return `undefined`, which Commander treats as an omitted option.

## 38. Environment command strings need an argv parser

`EDITOR="code --wait"` is a command plus arguments, not one executable filename.
Whitespace splitting also corrupts quoted paths and arguments.

- **Do:** parse quoting and escaping into argv without invoking a shell; reject
  malformed quoting and launch the executable with the resulting arguments.
- **Caught:** `apps/tui/src/app.tsx` — `/memory edit` and `/config edit` passed the
  complete `$EDITOR` value as the executable.

## 39. Internal errors must be translated at a public boundary

Refactoring a facade can preserve return values while accidentally exposing a
new exception type. Callers that map domain errors to HTTP status or CLI output
then turn a handled client error into an unknown server failure.

- **Do:** catch lower-level policy, filesystem, and transport errors at the
  owning service boundary and translate them to the established domain error;
  keep status, code, and message semantics covered by contract tests.
- **Caught:** `apps/server/src/file-upload-raw.ts` — the shared path guard's
  `ToolError` escaped `saveUpload` instead of the documented `UploadError(400)`.

## 40. Convenience decoders may accept malformed encodings

Many standard-library decoders are intentionally forgiving. Successful decode
does not prove that untrusted input obeyed the advertised wire format.

- **Do:** validate the grammar and compare against a canonical round trip before
  accepting encoded input.
- **Caught:** `apps/server/src/file-upload-raw.ts` — `Buffer.from(..., "base64")`
  ignored invalid characters and accepted malformed image uploads.

## 41. Effect cleanup runs on dependency changes, not only unmount

Putting process-wide teardown in an effect that depends on mutable state also
runs that teardown before every rerun. A sibling effect may not rerun to restore
what was cleared.

- **Do:** keep dependency-change cleanup scoped to that effect's resource and
  put component-wide teardown in a separate unmount effect.
- **Caught:** `apps/tui/src/use-terminal-lifecycle.ts` — toggling mouse capture
  cleared the terminal title until another title dependency changed.

## 42. Render must not mutate an existing async coordinator

Concurrent React renders can be abandoned. Mutating a long-lived coordinator
during render lets an uncommitted render invalidate the state still on screen.

- **Do:** create identity-bound coordinators with `useMemo`, update callback refs
  without changing ownership, and invalidate the old instance in effect cleanup.
- **Caught:** `apps/desktop/src/views/use-workspace-async.ts` — workspace changes
  mutated the previous coordinator before the render committed.
- **Also caught:** workspace opens, memory mutations/statistics, and balance
  requests committed after their owning workspace changed; bind every completion
  and rollback to a generation or workspace identity.
- **Also caught:** security, settings/MCP, agent, session, diagnostics,
  evolution, skills, files, diff, todos, and nested memory controls let late
  success, error, cleanup, or timer handlers mutate the newly active workspace
  UI. Scope every completion, not only the request URL, and include browser-side
  effects such as report downloads.

## 43. Fallback branches must preserve request predicates

A slow path or cache bypass still implements the same request. Returning its raw
intermediate result can silently drop filters, sorting, or pagination.

- **Do:** share post-processing across cached and uncached branches, or repeat
  every predicate explicitly with a boundary test.
- **Caught:** `apps/server/src/file-scan-search.ts` — an expanded uncached walk
  ignored the caller's `q` filter.

## 44. Authenticate before revealing resource state

Looking up a resource or checking whether it is enabled before authentication
can turn status codes into an enumeration oracle even when the protected action
itself never runs.

- **Do:** verify credentials against a non-revealing fallback first, and return
  the same authentication failure for missing, disabled, and enabled resources.
- **Caught:** `apps/server/src/routes/triggers.ts` — forged GitHub webhook headers
  distinguished unknown, disabled, and enabled trigger ids before HMAC validation.

## 45. Alternate execution backends must preserve security policy

A faster backend is not interchangeable when its protocol cannot express the
active sandbox, permission, cancellation, or resource policy.

- **Do:** route through a policy-capable backend or reject; never silently drop
  the unsupported constraint.
- **Caught:** `packages/core/src/tools/builtins/command.ts` — the Rust Runtime
  path bypassed an active OS command sandbox.

## 46. Opaque pagination needs progress guards

Ignoring `nextCursor` silently hides data; trusting it forever lets a malformed
server create an infinite loop.

- **Do:** consume every opaque cursor, including the valid empty string; only an
  absent cursor ends pagination. Reject repeats and impose a documented page/item bound.
- **Caught:** `packages/core/src/mcp/client.ts` — tool, resource, and prompt
  discovery returned only the first page.

## 47. Advertised capabilities are executable promises

Declaring a protocol capability can cause the peer to send requests and wait for
answers. Advertising a partially implemented feature is worse than omitting it.

- **Do:** advertise only capabilities the active transport can service; retain
  negotiated version/capability state for later requests.
- **Caught:** `packages/core/src/mcp/http.ts` — HTTP advertised roots but could
  discard a request-scoped `roots/list`, deadlocking a conforming server.

## 48. A memoized startup promise must reset on every failure path

Using the two-callback form of `promise.then(success, failure)` does not send an
exception thrown by `success` to that `failure` callback. The rejected promise
can remain cached forever even though the transport intends the next call to
retry initialization.

- **Do:** attach a final `.catch(...)` after handshake validation, and clear all
  partial lifecycle state (session id, negotiated version, cached promise).
- **Caught:** `packages/core/src/mcp/http.ts` — a malformed initialize result
  permanently poisoned the client and retained the server's partial session id.

## 49. A broad writable parent can override a protected nested root

Allowing a temporary directory to stay writable also allows every workspace
below it unless the nested workspace is explicitly protected again.

- **Do:** order mount/profile rules so the narrower workspace policy wins over
  broad temp allowances, and test the workspace-inside-temp case directly.
- **Caught:** `packages/core/src/tools/os-sandbox.ts` — `read-only` workspaces
  below `/tmp` or `TMPDIR` inherited the parent's write permission.

## 50. Interactive prompts are a serialized resource unless the UI queues them

Launching concurrent operations that each await a confirmation can overwrite a
single pending-prompt slot and leave the displaced Promise unresolved forever.

- **Do:** serialize interactive authorization, then run already-approved work
  with the requested concurrency; use a completion-driven scheduler so a slow
  sibling does not hold an unrelated ready branch behind a batch barrier.
- **Caught:** `packages/core/src/agent/loop.ts` — concurrent edit team members
  raced one-slot permission UIs and `Promise.all` stalled newly ready branches.

## 51. Async results need the complete mutable destination identity

Checking only a workspace id is insufficient when a result writes into a tab:
the user can switch tabs in one workspace, or switch A→B→A before completion.

- **Do:** capture workspace and tab identity, support cancellation, omit empty
  optional arguments, and retain retry state when a request fails.
- **Caught:** `apps/desktop/src/views/SettingsView.tsx` — a slow MCP Prompt could
  overwrite another tab's draft and treated empty optional arguments as values.

## 52. External context must remain visibly data at the model boundary

Appending third-party text directly to a user task gives embedded directives the
same visual authority as the user's request, even when tool permissions remain gated.

- **Do:** serialize external content inside an explicit untrusted-data envelope,
  omit untrusted transport errors from prompts, and reinforce the system rule.
- **Caught:** `apps/server/src/agent.ts` and `apps/tui/src/app.tsx` — MCP Resource
  content was concatenated directly onto the task message.

## 53. Startup cancellation and cleanup begin before the main operation

Cancellation attached only to the final run cannot stop provider/tool discovery
that happens while assembling that run. A later construction failure can also
leak resources acquired earlier.

- **Do:** thread the run signal through discovery, dispose partial clients on
  every throw, and isolate malformed entries before constructing clients.
- **Caught:** `packages/core/src/mcp/tools.ts` and `apps/server/src/agent.ts` — MCP
  discovery ignored cancellation and partial Agent assembly could leak clients.

## 54. Cancellation observability starts only after request dispatch

An abort during initialization can correctly prevent the real request from ever
being sent. A test that uses a fixed timer may then expect a cancellation
notification for a request id the server never observed.

- **Do:** when asserting transport cancellation side effects, synchronize on the
  server receiving the target request before aborting it; measure latency from
  the abort edge, not from client construction or handshake startup.
- **Caught:** `packages/core/tests/mcp/http.test.ts` — a 25 ms timer raced the
  initialize handshake and made the notification assertion nondeterministic.

## 55. Budget the complete wire request, not only the obvious payload

Messages are not the whole model request: tool definitions and their JSON
schemas are serialized on every turn and can dominate the context window.

- **Do:** estimate messages plus advertised tools at the provider boundary;
  reserve room for both and deterministically narrow oversized tool catalogs.
- **Caught:** `packages/core/src/agent/loop.ts` — context compaction considered
  only messages, so a large MCP catalog could exceed the window after the UI
  reported ample space.

## 56. Every model call belongs to usage and budget accounting

Auxiliary summarization, extraction, ranking, or review calls still consume
tokens and money even when they are not the main agent turn.

- **Do:** return usage from every successful provider response, including a
  malformed semantic response, and aggregate it before the final report.
- **Caught:** `packages/core/src/agent/context.ts` and `memory/extract.ts` — LLM
  compaction and memory extraction discarded usage and understated Loop cost.

## 57. Exposure is not evidence of use

Putting a record in a prompt does not prove that it affected the model's work.
Treating exposure as use makes retention and quality metrics self-fulfilling.

- **Do:** record passive exposure, explicit retrieval, and established use as
  separate counters; prune and evaluate against the signal actually intended.
- **Caught:** `packages/core/src/agent/loop.ts` — every injected memory fact was
  marked used even when it was irrelevant to the task.

## 58. An append-only log recovers only its longest valid prefix

Skipping a malformed JSONL record and accepting later lines lets state after a
torn or corrupted write override the last durable state. Valid JSON scalars and
schema-invalid objects are corruption too, not harmless records to ignore.

- **Do:** parse and validate each record in order, stop at the first JSON or
  schema failure, and enforce monotonic sequence/timestamp invariants before
  accepting the next event. Before a later append, atomically truncate the
  invalid suffix; otherwise all future valid records remain unreachable.
- **Caught:** `apps/server/src/run-ledger.ts` — run snapshots and WS replay events
  originally skipped malformed middle records and continued reading later state.

## 59. Terminal lifecycle states must reject late async transitions

Cancellation can race a provider, child process, or detached completion. The
late callback still runs, but it no longer owns the lifecycle decision.

- **Do:** enforce allowed state transitions in the central store; once a run is
  succeeded, failed, or cancelled, ignore a conflicting terminal update.
- **Caught:** `apps/server/src/run-ledger.ts` — a background run could be marked
  cancelled and then overwritten as succeeded by a late completion event.

## 60. Autonomous mutation entry points require a finite explicit budget

A background or UI-triggered edit path can bypass the CLI's cost guard even when
it ultimately calls the same Agent implementation.

- **Do:** validate a finite positive budget at every autonomous mutation
  boundary, watch cumulative usage events, and propagate cancellation into the
  active provider/tool graph.
- **Caught:** Desktop Security Center automatic fixes initially accepted
  verification commands but no `maxCostUsd`, leaving the edit Agent unbounded.

## 61. Failure-aware UI completion must not run success cleanup

An async helper that catches an error and resolves normally makes downstream
`.then(...)` handlers indistinguishable from success.

- **Do:** return an explicit success result (or rethrow), and only close dialogs
  or clear user input after confirmed success.
- **Caught:** failed Finding lifecycle/fix requests closed their Desktop dialogs,
  discarding the user's inputs while only showing an error behind the modal.

---

*Add an entry whenever a boundary defect is fixed: the pattern, the fix, and the
file — not just the one-off.*
