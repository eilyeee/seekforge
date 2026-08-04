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
- **Also caught:** Loop DAG and speculation summaries sorted valid offset
  timestamps lexicographically, so recency order could be wrong. Compare parsed
  epochs and retain deterministic tie behavior.
- **Also caught:** Graph scheduling intelligence treated append order as event
  order, so a delayed valid observation could replace the true latest outcome.

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
- **Also caught:** a repository-config sanitizer copied allegedly safe preferences
  without validating their value types, and a selected `null` profile crashed
  before sanitization. Validate each retained field and treat only object-valued
  profile entries as selectable layers.

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
- **Also caught:** `web_fetch` delegated redirects to `fetch(..., redirect:
  "follow")` and checked no DNS answers, so a public-looking URL could resolve or
  redirect to loopback after its one lexical check. Resolve and reject every
  non-public answer, and manually validate every redirect before following it.

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
- **Also caught:** eval `--repeat` used `Number()`, accepting hexadecimal and
  exponent forms even though the option is a decimal iteration count.

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
- **Also caught:** `packages/core/src/agent/auto-loop.ts` — verifier output was
  concatenated into Loop continuation prompts without an explicit untrusted-data
  envelope, so repository-controlled diagnostics looked like user instructions.

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

## 62. Derive aggregate decisions from validated detail, not model assertions

A structured model response can claim `complete: true` while its own criterion
records are unmet, missing, duplicated, or unknown.

- **Do:** validate exact identifier coverage and derive the aggregate outcome
  from required detail records. Reject inconsistent aggregates and fail closed
  when structured evidence cannot be parsed.
- **Caught:** `packages/core/src/agent/loop-requirements.ts` — acceptance review
  completion must be computed from the frozen required criteria, not trusted
  from the model-provided boolean.

## 63. Intermediate output is not a completed phase result

A model can emit plausible text and then fail during a later tool/provider turn.
Retaining the earlier text without the terminal event turns an incomplete phase
into a false success.

- **Do:** accept analysis/review output only after the same run emits its
  successful terminal event; cancellation, budget abort, and `session.failed`
  must leave the phase incomplete.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — failed requirement reviews
  could still pass from an earlier `model.message`, and cancelled analysis could
  persist fallback requirements that a resume would never re-analyze.

## 64. Approval applies only to a previously observable artifact

An approval flag sent before an artifact exists cannot prove that the caller saw
the exact artifact being approved.

- **Do:** bind approval to an identifier/version loaded from persisted state;
  newly generated artifacts must be surfaced before a later approval call.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — confirm-mode requirements
  could be generated and approved in one invocation.

## 65. Progress fingerprints must include clean committed changes

Working-tree status is unchanged before and after a run that edits and commits.
A fingerprint limited to dirty paths therefore misclassifies real progress as a
no-op.

- **Do:** include repository `HEAD`/tree identity as well as dirty and untracked
  content; keep a non-Git content fallback.
- **Caught:** `packages/core/src/agent/auto-loop.ts` — a committed fix with
  unchanged verifier diagnostics could trigger `no_progress`.

## 66. Bounded event feeds are not durable UI state

Evicting old progress events must not erase the current specification, result,
or session identity needed for later actions.

- **Do:** reduce durable workflow fields independently from the capped display
  feed and rehydrate them from terminal snapshots.
- **Caught:** `apps/desktop/src/lib/loop.ts` and `tabs.ts` — long Loop output
  could evict requirements and leave follow-up chat detached from the Loop
  session.

## 67. Equivalent numeric values do not imply equivalent input grammar

`Number()` accepts hexadecimal and other syntaxes that a CLI's documented
decimal parser rejects, producing cross-surface behavior drift.

- **Do:** validate the complete textual grammar before numeric conversion, then
  enforce finite/range constraints.
- **Caught:** TUI and Desktop Loop controls accepted `0x10` iterations while the
  CLI rejected them.

## 68. Stale-lock recovery is itself a coordination operation

Comparing lock contents and deleting the path are separate filesystem actions.
Two recoverers can both validate the old owner, then one can delete the other's
new lock.

- **Do:** serialize stale recovery with an exclusive recovery marker, re-read
  under that ownership, and make new candidates yield while recovery is active.
- **Caught:** `packages/core/src/agent/loop-state.ts` — concurrent recovery of a
  dead Loop lease could admit two owners.

## 69. Normalize aliases before applying path permission rules

Lexical aliases such as `src/../secrets/key` can cross an allow/deny boundary
while preserving a misleading prefix.

- **Do:** normalize both the classified path and configured rule path before
  exact-or-descendant matching.
- **Caught:** `packages/core/src/tools/permissions.ts` — an allowed `src` prefix
  could authorize an aliased path outside `src`, or hide a denied directory.

## 70. Revalidate a filesystem target at the mutation boundary

Path validation and file mutation are separate operations. A target can become
an external symlink after validation but before a pathname-based write.

- **Do:** open with no-follow semantics, compare parent/file identities around
  the final checkpoint, and mutate through the verified file descriptor.
- **Caught:** `write_file` and `apply_patch` could follow a leaf symlink swapped
  in after workspace validation.

## 71. Internal persistence needs the same physical confinement as tools

A workspace-local state pathname is not workspace-local when an intermediate
state directory is a symlink.

- **Do:** resolve every persistence write through the physical write-target
  guard, including append and atomic-rewrite paths.
- **Caught:** memory and evolution stores could write through symlinked
  `.seekforge/memory` or `.seekforge/evolution` directories.

## 72. Tool approval cannot authorize an earlier plugin startup

Discovering a plugin can itself spawn a process or contact a remote endpoint.
A later permission prompt around a tool call does not authorize that startup.

- **Do:** require connection trust before automatic discovery; keep explicit
  management probes separate and user initiated.
- **Caught:** untrusted MCP stdio servers started while assembling an Agent,
  before any tool-level confirmation was possible.
- **Also caught:** Server prompt resolution started a configured MCP server
  without requiring the trust flag used by prompt/resource discovery.

## 73. One terminal cause must map to one protocol status

Recording cancellation in durable state while emitting a generic failure on
the live channel gives reconnecting and connected clients different outcomes.

- **Do:** derive ledger state and emitted error codes from the same terminal
  cause.
- **Caught:** an aborted WS Agent that threw was stored as `cancelled` but sent
  to the active client as `agent_error`.

## 74. Wrapper options must not hide a classified subcommand

Command classifiers that inspect only the first positional token miss dangerous
subcommands preceded by global options, especially options with separate values.

- **Do:** consume the wrapper's complete global-option grammar before matching
  the effective subcommand.
- **Caught:** `git -C . push` and `git -c core.pager=cat push --force` bypassed
  push/force-push classification.

## 75. Process-local counters do not create persistent identifiers

Timestamps combined with an in-memory count can collide when separate processes
append to the same persistent store in the same clock tick.

- **Do:** use a collision-resistant process-independent identifier for durable
  records.
- **Caught:** manually added memory facts could receive the same id across CLI
  processes.

## 76. Independent mutation surfaces must join one repository coordinator

Per-connection busy flags prevent overlap only inside that connection. A WS
Agent, background Loop, webhook, and security fix can still target one checkout.

- **Do:** schedule every server-owned mutating operation through the same
  physical-repository coordinator, while registering cancellation before queueing.
- **Caught:** separate WS connections and background REST runs could edit the
  same workspace concurrently with security/Git operations.

## 77. Persisted deduplication still needs an atomic claim

A read-check-write JSON file survives restart but two processes can both read
the absent key before either atomic rename becomes visible.

- **Do:** protect the entire claim/rollback transaction with a cross-process,
  stale-recoverable lease.
- **Caught:** two Server instances could both accept one GitHub delivery id.

## 78. Reconnectable clients must retain the server replay cursor

Automatic socket reconnection alone cannot recover frames lost after a run was
accepted. The client needs the durable run identity and last applied sequence.

- **Do:** persist `runId + seq` in workflow state, subscribe with `afterSeq` on
  reconnect, and ignore stale or duplicate run frames.
- **Caught:** Desktop could lose a terminal Agent/Loop event during disconnect
  and leave the result or session identity incomplete.

## 79. Detached work retains ownership of its result destination

Detaching execution from foreground control does not detach its terminal output
from the tab or document that receives it.

- **Do:** keep the destination alive until detached completion, or explicitly
  migrate ownership before allowing it to close.
- **Caught:** TUI allowed the originating tab to close after detaching a Loop,
  so its final outcome was silently dropped.

## 80. A size check after full buffering is not a memory limit

Reading `arrayBuffer()` or `text()` and checking its length afterward allows an
untrusted peer to consume arbitrary memory before the guard runs.

- **Do:** consume the stream incrementally, count bytes before retaining each
  chunk, cancel on overflow, and keep the timeout active through body reading.
- **Caught:** `web_fetch`, `web_search`, and MCP HTTP plain JSON/OAuth responses
  applied limits only after full buffering, or had no limit at all.

## 81. Delimited protocols need a bound while searching for the delimiter

A line or frame limit enforced only after finding its delimiter cannot stop an
unterminated input from growing the parser buffer indefinitely.

- **Do:** cap accumulation during reads; after overflow, discard in fixed chunks
  through the delimiter so later frames remain usable.
- **Caught:** the Rust runtime used unbounded `read_until('\n')` for JSONL
  requests, so one oversized line could exhaust the subprocess.

## 82. A transport finish reason is part of payload validity

Text content alone does not prove a model response is complete when the provider
reports that generation stopped at its output-token limit.

- **Do:** treat a length-limited response as incomplete, request a self-contained
  replacement, and fail explicitly if no turn remains.
- **Caught:** the Agent accepted a `finishReason: "length"` response as its final
  report and silently persisted truncated output.

## 83. Cancellation must cover human-interaction waits

Checking an abort signal before an approval or question is not enough when the
human-facing promise can remain pending indefinitely.

- **Do:** race every permission and question wait against the run's abort signal
  and detach the listener when either side settles.
- **Caught:** cancelling an Agent while it awaited permission or `ask_user` left
  the run and its workspace lease stuck.

## 84. Absent and explicitly empty security policy are different states

Normalizing an empty allowlist to an absent value can widen access when absence
means "use the unrestricted default."

- **Do:** preserve an explicit empty collection through parsing, merging, and
  serialization; default only when the field is truly absent.
- **Caught:** a subagent `tools: []` whitelist became `undefined`, granting every
  tool instead of none.

## 85. Closing an iterator is a terminal lifecycle path

An async generator can be closed by its consumer without throwing or reaching
the producer's normal completion branch.

- **Do:** settle durable status and release owned resources from `finally`, while
  preserving any status already written by a normal terminal path.
- **Caught:** closing an Agent event iterator early left the session persisted as
  `running` after all execution had stopped.

## 86. Redact structured data before serialization

A text redactor may insert newlines or consume JSON quoting syntax when it runs
over an already serialized record.

- **Do:** recursively redact string leaves first, then serialize the resulting
  structure exactly once.
- **Caught:** run-event redaction after `JSON.stringify` corrupted JSONL and
  failed to remove multiline PEM material reliably.

## 87. Sensitive-path policy must cover every model read ingress

Protecting file tools alone leaves alternate context builders and auto-approved
search commands able to read the same secret.

- **Do:** apply the shared basename and relative-path policy to file tools,
  `@path` expansion, workspace-directory expansion, and command auto-approval.
- **Caught:** `.seekforge/config.json` and `triggers.json` could reach the model
  through task references or an explicitly targeted `rg` command.

## 88. Credential-name matching needs semantic boundaries

An unbounded substring such as `TOKEN` both misses alternate credential names
and removes ordinary build settings that merely contain the word.

- **Do:** share credential categories across environment scrubbing and output
  redaction, matching separator/camel-case boundaries and testing non-secrets.
- **Caught:** `GITHUB_PAT` leaked while `MAX_TOKENS` and
  `TOKENIZERS_PARALLELISM` were silently removed.

## 89. Deletion must validate every physical parent

A safe filename does not make `root/subdir/file` safe when `subdir` can be a
symlink to an external directory.

- **Do:** route deletion through the same physical project-path guard as reads
  and writes, and reject symlinked parents and leaf nodes.
- **Caught:** run-ledger compaction could unlink an external `run-*.jsonl`
  through `.seekforge/run-events`.

## 90. Process-level teardown registration must be disposable

Per-instance signal listeners outlive short-lived clients unless normal
disposal unregisters them.

- **Do:** return an idempotent disposer from teardown registration and invoke it
  when the owning client is permanently disposed.
- **Caught:** each RuntimeClient left four process listeners and retained its
  closure after shutdown.

## 91. Option parsers must consume each option's complete arity

Skipping a flag without its separate value promotes that value to a subcommand
and can hide the real operation from policy classification.

- **Do:** encode which global options require a following argument, including
  both short and long spellings, and keep TS/Rust parity fixtures exhaustive.
- **Caught:** Rust treated the path after `git --git-dir PATH` as the subcommand,
  allowing a later destructive Git operation through.

## 92. Atomic replacement still requires complete writes

Atomic rename guarantees which file becomes visible, not that one `write`
system call consumed the whole buffer.

- **Do:** loop until all bytes are written, advance by the reported byte count,
  and fail if a writer makes no progress before fsync and rename.
- **Caught:** `writeFileAtomic` could replace durable state with a truncated temp
  file after a short write.

## 93. Compound-command flags belong to one invocation

Searching an entire shell line for a dangerous flag can assign an argument from
one command to a later command and make independent classifiers disagree.

- **Do:** tokenize command boundaries and classify flags only within their
  owning invocation; pin cross-language behavior with compound fixtures.
- **Caught:** Rust attributed `--force` from `echo --force && git push` to the
  Git push while TypeScript did not.

## 94. Policy normalization must match shell line continuation

A backslash-newline outside single quotes is removed before shell tokenization,
so treating it as whitespace can hide a dangerous command across two lines.

- **Do:** remove shell line continuations before policy matching and word
  parsing, preserve them inside single quotes, and pin cross-runtime parity.
- **Caught:** `r\\<newline>m -rf` and `git pu\\<newline>sh --force` executed as
  denied commands but evaded both TypeScript and Rust classifiers.

## 95. Parent cancellation must cover every network phase

An operation-local timeout does not make a tool responsive to cancellation of
the Agent run that owns it, especially while DNS is still unresolved.

- **Do:** connect the parent signal to the request controller and race DNS,
  request, and body consumption; detach listeners when the operation settles.
- **Caught:** cancelled `web_fetch`, `web_search`, `image_analyze`, and Browser
  actions continued until their independent timeout; Vision also cleared its
  timeout after headers, leaving response-body parsing unbounded.

## 96. Repository configuration must not trigger startup execution

Configuration precedence does not imply that every layer has equal trust; a
checked-out repository is untrusted before the user has approved any action.

- **Do:** source startup shell commands only from user-owned configuration and
  launch them with a minimal allowlisted environment.
- **Caught:** a project `.seekforge/config.json` could run `statusLine` as soon
  as the TUI opened and inherit provider API keys from `process.env`.

## 97. Delimited streams need a pre-delimiter frame limit

A parser that checks size only after finding a newline can buffer an unbounded
unterminated record even when every parsed record is later validated.

- **Do:** cap the pending buffer before waiting for the delimiter, also reject
  oversized terminated frames, and fail or terminate the producer promptly.
- **Caught:** CLI stream-json input and Runtime stdout JSONL could each consume
  unbounded host memory with one line that never ended; ordinary piped CLI text
  accumulated every chunk without a total-size limit.

## 98. Async UI results must remain bound to their request identity

Changing props does not cancel promises started by an earlier render; a late
result can otherwise overwrite state that now belongs to another resource.

- **Do:** capture a generation or resource identity, invalidate it in effect
  cleanup, and guard success, error, and finalization callbacks. Within one
  resource, capture an edit revision so a save response cannot hide newer input.
- **Caught:** a late file read could place file A's content in file B's editor,
  and a subsequent save wrote that content to B; file-index loads had the same
  workspace-switch race. A save completion could also close the editor after
  the user had typed a newer, unsaved revision.

## 99. Apply response-size limits before generic JSON parsing

`Response.json()` buffers the complete body and cannot enforce an
application-level cap while bytes arrive.

- **Do:** read untrusted API responses incrementally through the shared bounded
  body reader, then parse the bounded buffer.
- **Caught:** Vision API responses bypassed the web response cap and could
  consume unbounded memory before JSON parsing completed.

## 100. Snapshot replacement and append must share one cross-process lease

Atomic rename prevents torn files, but it does not stop a compactor from
replacing a snapshot after another process appended to the old file. A cached
line count also becomes stale when a peer appends or replaces the file.

- **Do:** put every append and compaction under the same cross-process lease;
  compare a cheap file identity under that lease and recount after peer writes.
- **Caught:** concurrent Server run-ledger compaction could permanently discard
  another process's run record.

## 101. Background polling must own failure and terminal cleanup

Exceptions thrown by timer callbacks escape the request promise, and polling
that never unregisters retains connection state after the resource is done.

- **Do:** catch every polling iteration, unregister on failure, socket close,
  and observed terminal frames, and expose only a generic transport error.
- **Caught:** WS run subscriptions could crash on a replay read error or poll
  forever after delivering the terminal event.

## 102. A polling cursor must make idle and incremental work cheap

Polling a growing append log from byte zero on every timer tick is O(N) while
idle and O(N^2) over a long run, even if the response page is bounded.

- **Do:** deliver process-local appends through direct notifications; use a
  low-frequency cross-process fallback that checks O(1) file identity first and
  reads bounded pages only after a change.
- **Caught:** live WS subscriptions reparsed the complete run-event JSONL every
  25 ms, including periods with no new event.

## 102. Cancellation owns every descendant operation until cleanup completes

An abort check at the start of a turn does not cover hooks, post-response work,
or a tool that remains active after an async iterator is closed.

- **Do:** bridge caller cancellation into a run-owned signal, pass it to every
  descendant operation, re-check after externally observed usage events, race
  provider promises that may ignore signals, and await active tool/subagent
  cleanup before releasing the session lease. Even an already-aborted race must
  observe the producer promise so a synchronous rejection cannot escape.
- **Caught:** budget cancellation could still run memory extraction and complete
  a session, while `iterator.return()` released the lease before its tool exited;
  tool-level pre/post hooks also ignored the run signal, and background dispatch
  launch promises were tracked instead of the underlying child runs.

## 103. Generated agent state is not workspace progress

Progress fingerprints that include an agent's own logs, memory candidates, or
session state change even when no product source or verifier result changed.

- **Do:** exclude all generated state roots from both Git-backed and fallback
  workspace fingerprint paths.
- **Caught:** memory extraction changed `.seekforge/memory/candidates.jsonl` on
  every Loop iteration and prevented the `no_progress` guard from firing.

## 104. Concurrent writers need workspace isolation or serialization

Two agents can both successfully write from the same stale snapshot while the
later write silently replaces the earlier result.

- **Do:** use isolated worktrees or content-version CAS; when neither is already
  available, conservatively serialize edit-mode agents sharing one workspace
  while retaining concurrency for read-only agents.
- **Caught:** independent `dispatch_team` edit members could overwrite each
  other's changes and both report success.

## 105. Configured child processes receive a least-privilege environment

A command being user-configured does not make every provider token and host
credential in the parent process relevant to that command.

- **Do:** construct child environments through the shared secret scrubber, then
  add only the explicit metadata variables required by the child protocol.
- **Caught:** hooks inherited the complete `process.env`, exposing provider API
  keys before any tool permission boundary.

## 106. Authorization must pin the physical resource identity

Approving a logical path does not approve every future target of a symlink at
that path.

- **Do:** canonicalize an authorized directory once and retain that physical
  path for later reads instead of resolving the logical alias again.
- **Caught:** an `/add-dir` symlink could be rebound after approval, allowing
  `@` references to read from a different external directory.

## 107. Auxiliary workspace state needs confinement and coordination

Small convenience files are still mutation surfaces: plain read-modify-write
can follow repository symlinks, expose external content, or race active runs.

- **Do:** reject symlinked state parents and leaves, read through no-follow file
  descriptors, replace complete files atomically, and acquire the shared
  workspace/repository guard at every UI or API mutation surface.
- **Caught:** TUI and Server todo operations could read or overwrite an external
  `.seekforge/todos.md` target and mutate without the Agent workspace guard;
  the TUI also reported failed writes as successful changes.

## 108. Configured subprocesses need bounded tree ownership

A timeout on the direct shell is incomplete when descendants retain pipes, and
an error event is not successful EOF.

- **Do:** run owned process groups asynchronously, cap captured bytes, destroy
  pipes on failure, terminate then escalate the complete group, and cancel any
  delayed force-kill timer only after confirming the complete group is gone.
- **Caught:** REPL shell expansion and TUI status-line commands could hang on
  descendant pipes or consume unbounded output; stdin errors returned partial
  prompts and status-line execution blocked rendering; successful CLI/TUI shell
  parents could also leave detached-output descendants running. Hook shells and
  Server command expansion had the same leak after both successful and failed
  exits, and Windows teardown only targeted the direct child instead of the tree.

## 109. Enforce wire limits before destructive client state changes

Server-only frame limits let a client clear or append local state for a request
that can never cross the transport boundary.

- **Do:** share protocol constants, measure the exact serialized frame, reject
  before sending or clearing drafts, and preflight binary size before encoding.
- **Caught:** oversized Desktop task/Loop frames cleared drafts before the
  WebSocket rejected them, while oversized images were base64-expanded first.

## 110. Bind asynchronous UI results to an edit revision

Tab identity alone does not prove that delayed transformed text still belongs
to the current draft.

- **Do:** capture a per-resource revision before async work and apply the result
  only when both identity and revision still match.
- **Caught:** delayed custom-command expansion overwrote text typed later in the
  same Desktop tab.

## 111. Own a child from the instant spawn succeeds

A process is live before readiness succeeds; recording it only after startup
creates a window where exit/cleanup cannot find it.

- **Do:** register a starting state under the lifecycle lock immediately after
  spawn, then transition that same owned child to running or terminate it.
- **Caught:** Desktop startup could leak the sidecar when Exit raced readiness.

## 112. Terminal events require cleanup-safe iterator closure

Yielding from an async generator's `finally` can make `return()` resolve with
`done:false`, suspending release work indefinitely.

- **Do:** await cleanup without yielding in `finally`; explicitly drain child
  events before success/failure so the terminal session event remains last.
- **Caught:** background dispatch usage/files could miss the final report or
  arrive after completion, and early consumers could strand leases and hooks.

## 113. Rewritten tool input is the effective security subject

Validating and authorizing only the original tool arguments makes hook-rewritten
paths and commands disagree with execution, audit, and verification.

- **Do:** schema-validate, reclassify, reauthorize, execute, report, and audit
  the replacement as one effective input; reject invalid replacements.
- **Caught:** `preToolUse.updatedInput` retained original permission metadata and
  verification commands, while malformed replacements silently ran originals.

## 114. Structured state needs validation, serialization, and physical writes

JSON parse success does not make persisted values finite or bounded, and a
logical path check does not survive concurrent writers or symlink rebinding.

- **Do:** validate every persisted field, saturate counters, serialize
  read-modify-write transactions across processes, read through verified
  no-follow descriptors, and atomically replace through a revalidated parent.
- **Caught:** memory metadata accepted non-finite values, concurrent updates were
  lost, and memory/candidate/archive/summary writes retained symlink TOCTOU gaps;
  treating oversized or corrupt durable state as missing could overwrite it.

## 115. Streaming protocols need cumulative and temporal budgets

Per-line limits do not bound a progressing response, and numeric JSON fields can
still carry unsafe integers or non-finite arithmetic.

- **Do:** cap raw bytes and every accumulated field, bound item counts, enforce
  both idle and total deadlines, cancel the reader on failure, and validate
  usage before cost arithmetic.
- **Caught:** provider SSE could grow indefinitely across valid lines or run
  forever while progressing; non-streaming/error bodies buffered without a
  byte cap, and malformed token usage produced unsafe costs.

## 116. A canonical path must stay bound to the opened file

Resolving a path physically and then calling `stat`/`readFile` by pathname leaves
a swap window; truncating after `readFile` also is not a memory limit.

- **Do:** open the canonical parent and leaf with no-follow flags, compare path
  and descriptor identities, and read only a bounded byte prefix from the fd.
- **Caught:** shared workspace and extra-directory `@path` expansion could follow
  a file swapped after validation and buffered the complete file before its 30k
  cap; Rust runtime reads/listing reopened validated paths and `apply_patch`
  buffered an unbounded target. Skill/agent imports, security evidence, Loop and
  session leases, tool checkpoints/searches, and vision input repeated the same
  preflight-stat or post-read-limit pattern.

## 117. Rejected request bodies still own a drain lifecycle

Rejecting a body promise does not stop the socket from emitting data or errors.
Removing every error listener before the discarded body closes can crash on a
late transport error; leaving normal listeners attached leaks them per request.

- **Do:** single-settle the body reader, detach normal listeners on every terminal
  path, keep a drain-only error sink through `close`, and preflight Content-Length.
- **Caught:** Server REST body reads could hang on an aborted request and retained
  listeners after settlement; early route rejections left bodies unread, and the
  first oversize fix left a late-error window.

## 118. Persisted protocol limits belong on the writer

A replay reader's line cap cannot repair an oversized record already appended;
the first unreadable line hides every later valid event.

- **Do:** serialize and byte-count the exact persisted envelope before append,
  advance sequence state only after success, and avoid duplicate catch-up queues.
- **Caught:** Server run events could poison durable replay, while WS catch-up
  retained an unbounded second copy of locally appended events.

## 119. Settings are security-sensitive mutation surfaces

Hooks, sandbox policy, and MCP startup configuration affect later execution even
though they are not product source files. Independent read/merge/write routes can
lose updates or change policy while an Agent owns the workspace.

- **Do:** hold the repository/workspace guard across the complete project-layer
  transaction and a shared cross-process lease across global-layer transactions.
- **Caught:** Server hooks, config, and MCP writes bypassed session coordination;
  masked-secret preservation also read the old MCP entry before acquiring a lock.

## 120. Transport type and method semantics are protocol data

Bytes containing JSON are not necessarily a WebSocket text frame, and accepting
`HEAD` does not permit sending a GET response body.

- **Do:** reject binary frames explicitly; for HEAD, send GET-equivalent headers
  including Content-Length and suppress the body on success and error paths.
- **Caught:** Server WS accepted binary JSON and static HEAD handling emitted the
  same body path as GET without a stable length.

## 121. Prompt-bearing configuration needs physical and byte boundaries

Files that become system prompts or tool metadata are untrusted input. A lexical
join, a pre-read `stat`, or later prompt truncation does not bound what is read.

- **Do:** validate names, reject linked config roots/leaves, bind reads to
  verified no-follow descriptors, enforce per-file and cumulative byte limits,
  and skip oversized structured files instead of parsing partial content.
- **Caught:** output-style traversal; linked command/rules/subagent roots;
  unbounded AGENTS/AGENT files; and package/repo-map reads that could outgrow a
  stale size check before entering prompt construction.

## 122. Authorization results and execution context are operation-local

Structured denial objects are truthy, and mutable fields on a shared tool
context can be overwritten by another concurrent execution.

- **Do:** normalize every permission result through its explicit `allow` field
  and copy approval-derived state into a fresh per-call context.
- **Caught:** sandbox fallback could run unsandboxed after `{allow:false}`, and
  concurrent edit approvals could exchange `selectedHunks` selections.

## 123. Schema and correlation boundaries must encode exact domains

Numeric coercion and globally keyed correlation silently accept values or pair
records outside the domain their consumer assumes.

- **Do:** require integer minima/maxima in schemas, preserve those constraints
  in the JSON Schema advertised to the model, validate deserialized field
  shapes, and scope tool-call/result correlation to one assistant turn.
- **Caught:** negative/fractional timeouts, tails, depths, ranges and limits;
  a schema converter dropping numeric and collection bounds; malformed package
  metadata; reused tool-call ids clearing the wrong turn; and regex predicates
  coercing non-string Loop DAG ids into apparently valid strings.

## 124. An evaluation workspace is adversarial input

An Agent can shape the files and processes that its own checks inspect. A
lexically safe check path or direct shell timeout does not make the score sound.

- **Do:** reject linked assertion files and command directories, bind file reads
  to verified descriptors, cap assertion bytes/output, own the complete check
  process group, and fail the sample when cleanup fails.
- **Caught:** Eval `file_not_contains` could pass through a symlink, command `cwd`
  could escape the fixture, timed-out checks leaked descendants, and disposer
  errors rejected the harness instead of producing a failed result.

## 125. CI values are data, never shell source

Manual workflow inputs and action outputs can contain shell metacharacters even
when the operator intends them to be a tag or version.

- **Do:** pass expressions through environment variables, validate the complete
  domain before producing outputs, and quote variables at every use.
- **Caught:** the npm release workflow interpolated a dispatch tag into shell
  source, allowing workspace modification before a later credentialed publish.

## 126. A `file:` URL pathname is not a filesystem path

URL pathnames retain percent encoding and have platform-specific leading/path
rules, so they fail for spaces, Unicode, and Windows paths.

- **Do:** convert file URLs with `fileURLToPath`; only then call path utilities.
- **Caught:** package-smoke and live server E2E scripts derived the repository
  path from `import.meta.url.pathname`.

## 127. Line framing limits must run before line buffering

Checking a line's length in a `readline` callback is too late: a peer can send an
unbounded stream without a newline, and the framing layer has already retained it.

- **Do:** count raw bytes while consuming chunks, enter a discard state as soon
  as a frame crosses the limit, discard through its newline, then resume with the
  next frame. A client that cannot correlate the rejected frame must fail its
  pending requests and restart the transport deterministically.
- **Caught:** MCP stdio server input and client stdout/stderr used unbounded
  `readline` framing; a malicious peer could grow memory without completing a
  JSON-RPC message.

## 128. A file limit must cover growth and preserve oversized durable state

A pre-read size check followed by a whole-file read is still vulnerable to file
growth, while treating oversized state as missing can destroy it on the next write.

- **Do:** read descriptors incrementally with overflow detection, stream responses
  over a fixed verified range, fail closed before mutating oversized state, and
  publish reports by atomic replacement.
- **Caught:** Server static assets/settings/recents, shared config/todos, and Eval
  suite/task/baseline/trend/metadata files had unbounded reads; state mutations
  could overwrite oversized files and report readers could observe partial output.

## 129. A run reservation owns terminal state before scheduled execution begins

Persisting `running` before entering a scheduler leaves a gap: cancellation or a
coordinator failure can reject before the operation's own `try/finally` runs.

- **Do:** attach terminal ledger, event, and connection cleanup to the scheduled
  promise itself; every pre-execution rejection must become failed or cancelled.
- **Caught:** REST background Loop and WebSocket Agent/Loop runs could remain
  permanently `running` when repository coordination rejected before execution.

## 130. Validate special files without blocking on open

A size check or post-open regular-file check cannot protect a reader if opening
a FIFO waits indefinitely for a writer first.

- **Do:** open untrusted read paths with `O_NONBLOCK` and `O_NOFOLLOW`, then
  validate the descriptor is a regular file before reading. Mutations must treat
  every read failure except `ENOENT` as state that must not be replaced.
- **Caught:** bounded config, state, trace, static-asset, dataset, and todo reads
  could block on a FIFO; todo mutations could also treat non-missing read errors
  as an empty list before attempting replacement.

## 131. A cursor must carry a validated physical position, not just a logical id

Replaying page N by scanning from byte zero until logical sequence N makes a
complete traversal quadratic, even when every individual page is bounded.

- **Do:** cache the byte offset immediately after the last validated record,
  bind it to every input affecting the parse (workspace, run id, sequence, and
  file identity), and fall back to byte zero whenever that identity changes.
  Bound the cursor cache as carefully as the returned page.
- **Caught:** Server run-event REST/WS replay re-read the complete JSONL prefix
  for every `afterSeq` page.

## 132. A higher-trust secret must not inherit its destination from a lower-trust layer

Scalar precedence can combine values that were safe separately into an unsafe
credential route: a user-owned key plus a repository-owned endpoint.

- **Do:** keep destination provenance through config merging, or pin credential
  verification and other secret-bearing bootstrap calls to a user-owned/official
  endpoint. Never let project configuration redirect a newly submitted secret.
- **Caught:** Server onboarding loaded project `baseUrl` before verifying a
  DeepSeek key, so a checked-out repository could receive the key as Bearer auth.
- **Also caught:** pinning to *an* official endpoint is not enough when there is
  more than one vendor. The pinned probe stayed on DeepSeek's account endpoint
  whatever provider was configured, so onboarding sent an Ark or Anthropic key
  to a vendor that never issued it — and then reported the inevitable rejection
  as an invalid key. Derive the destination from the selected provider's own
  compiled-in preset, which is trusted for the same reason the pin was.

## 133. Security identity comes from registration, not a naming convention

Prefixes and generated-looking strings are classifications, not proof of origin;
ordinary hashes and attacker-chosen inputs can satisfy them.

- **Do:** query the authoritative registry/owner map when behavior depends on an
  object's identity. Treat names and prefixes as display/serialization details.
- **Caught:** background isolation treated any workspace id beginning with `wt-`
  as a managed worktree, and a normal hashed workspace id could match that prefix.
- **Also caught:** workspace removal rejected every `wt-*` id instead of asking
  the worktree manager whether that exact workspace was registered as one.

## 134. Fail-open degradation must match one explicit benign failure

Catching a broad error family around a security boundary turns operational
failures into permission or isolation widening.

- **Do:** inspect the typed error code and degrade only for the documented benign
  case; propagate busy, conflict, infrastructure, and unknown failures.
- **Caught:** automatic run isolation fell back to the base workspace for every
  `WorktreeError`, not only `not_a_git_repo`.

## 135. Defaults must not replace a missing cross-system correlation id

A compatibility default is safe only when the caller intentionally omitted the
identifier. It is unsafe when a client tried to resolve an external resource and
resolution failed.

- **Do:** distinguish omission from failed lookup, bind async follow-up state to
  the selected resource, and fail closed before sending a mutating request.
- **Caught:** the VS Code client omitted `ws` after a workspace-path mismatch, so
  the Server selected its unrelated default workspace.

## 136. Every request on a long-lived transport still needs its own deadline

The lifetime of an SSE/WebSocket session is not a valid timeout for a nested HTTP
request; awaiting that request can block the stream dispatcher forever.

- **Do:** give each nested request an operation-local controller and timer, link
  it to the transport's parent signal, and remove both timer and listener on settle.
- **Caught:** Streamable HTTP MCP `roots/list` responses reused the standalone GET
  stream signal and could wait forever while all later SSE messages backed up.

## 137. Authority is not ordinary mergeable configuration data

Layer precedence describes value selection, not who is allowed to grant trust.
A lower-trust repository layer can otherwise combine with user secrets or policy
defaults to gain capabilities no individual field reveals on its own.

- **Do:** sanitize each layer before merging according to its provenance. Keep
  safe preferences and restrictive rules from repositories, but require a
  user-owned layer for secret destinations, execution hooks/runtime commands,
  allow rules/allowlists, sandbox policy, budgets, retention, and trust flags.
- **Caught:** project/local config and profiles could route a user API key to a
  repository endpoint, start hooks/runtime/MCP, auto-allow commands, weaken the
  sandbox, or mark their own MCP server trusted.

## 138. Bidirectional HTTP protocol messages need symmetric transport checks

A client answering a server-initiated request is still making an authenticated
HTTP request. Treating the response POST as fire-and-forget silently loses
server requests after token expiry or a rejected response.

- **Do:** apply the same OAuth refresh, non-2xx rejection, cancellation, and
  timeout behavior to protocol response POSTs as to ordinary request POSTs.
- **Caught:** Streamable HTTP MCP refreshed OAuth for client requests and the
  standalone GET stream, but not for `roots/list` responses sent back to the server.

## 139. Validate a transport URL before rewriting its scheme or path

URL mutation does not prove that the input named the expected transport. A
`file:`, `ftp:`, or credential-bearing URL can otherwise be transformed into a
plausible WebSocket string and fail late or connect with unintended authority.

- **Do:** parse once, allowlist the original schemes, discard unrelated query
  and fragment state, then derive the HTTP/WebSocket endpoint from that
  validated value. Reject unsupported protocols before opening a connection.
- **Caught:** the VS Code bridge rewrote every configured server scheme to
  `ws:`/`wss:` without first requiring an HTTP(S) server URL.

## 140. Best-effort maintenance must not own the foreground result

Housekeeping runs after a user-visible mutation has already succeeded. If its
config, state, lease, or write fails, propagating that error reports the original
operation as failed even though its durable effect already happened; rewriting
malformed housekeeping state can also destroy the only diagnostic evidence.

- **Do:** validate maintenance policy at the trust boundary, use the domain's
  shared transaction lease, preserve corrupt state, return a typed maintenance
  outcome, and keep foreground success independent from that outcome. Persist a
  throttle timestamp only after maintenance itself succeeds.
- **Caught:** `packages/core/src/memory/maintenance.ts` and its CLI/TUI/Server/
  Agent callers needed automatic compaction without making an approved memory
  write fail or allowing repository config to opt into stale-fact archival.

## 141. Idle work needs non-blocking lock order and lifecycle ownership

Background work is not idle if it waits behind a foreground lock, and a broad
workspace guard can deadlock when the housekeeping operation later acquires a
domain lease that the guard itself blocks. Recurring timers can also outlive the
server or UI that owns their workspace/config identity.

- **Do:** claim the narrow domain lease without waiting, use proof of that held
  lease when acquiring the broader idle guard, re-check process-local idleness,
  skip on any conflict, and cancel the next timer during owner shutdown. Re-read
  dynamic targets/config on every tick and prevent overlapping ticks.
- **Caught:** the first idle memory scheduler acquired the workspace guard before
  the memory lease, so its own memory transaction waited 30 seconds and failed;
  Server/TUI/REPL timers also needed explicit disposal and current-target lookup.

## 142. An allowlist must gate the final runtime namespace

A static list of known built-ins is not an allowlist when tools can also arrive
from MCP, dispatch synthesis, plugins, or future registrations. Filtering only
the familiar names advertises and executes everything outside that list.

- **Do:** carry the exact allowed-name set to the final assembled tool catalog,
  filter definitions before the model sees them, and fail closed again at call
  execution to cover stale or fabricated calls.
- **Caught:** CLI `--allowedTools` generated deny rules from a hard-coded builtin
  roster, leaving MCP and synthesized dispatch tools available.

## 143. Names used as registry keys need validation and collision rejection

Map assignment is not safe registration: a duplicate silently replaces an
earlier handler while catalogs, permissions, or traces may still describe both.
Normalization can create the same defect from two distinct external names.

- **Do:** validate names at the registry boundary, reject duplicates before
  construction, and use one deterministic collision-resistant external-name
  mapping for advertisement and invocation.
- **Caught:** the tool registry silently overwrote duplicate names, and MCP names
  needed a bounded hashed fallback for ambiguous or invalid server/tool pairs.

## 144. Extension approval must bind content, provenance, and activation

Discovering repository extension files is not consent to execute them. A boolean
approval also goes stale when installed content changes underneath it.

- **Do:** separate discovery from installation, install into a user-owned store
  disabled, bind approval to a digest of every bounded regular file, reject links,
  and contribute nothing after any digest change until explicit re-approval.
- **Caught:** the first-class plugin lifecycle in `packages/core/src/plugins`
  needed project discovery without repository-granted hook/MCP authority.

## 145. Resumed execution must rebuild every task-scoped prompt contribution

Reusing a conversation trace does not make task-dependent system context valid
for the new user turn.

- **Do:** reconstruct mode, plan, memory, skills, and other current-task prompt
  inputs before both fresh and resumed requests; keep persisted history separate.
- **Caught:** `packages/core/src/agent/loop.ts` selected skills only in the fresh
  session branch, so later Auto-Loop iterations silently lost their procedures.

## 146. The advertised request catalog is an execution capability boundary

A registered tool can be absent from one provider request because of policy or
context-budget selection. Registry membership alone must not authorize a stale
or fabricated call.

- **Do:** bind execution to the exact post-filter tool-name set sent with that
  request, in addition to global allowlists and dispatcher permission checks.
- **Caught:** context trimming could omit a large MCP tool while the dispatcher
  would still execute a model-supplied call to its known name.

## 147. Mutable extension stores need physical identities and transactions

Validation at load time is insufficient when enable/import/remove can follow a
linked component, race an Agent, or expose half of a multi-file installation.

- **Do:** validate every parent and leaf as physical, serialize across processes,
  acquire the workspace mutation guard, and publish multi-file updates by atomic
  rename with rollback. Bind metadata ids to directory names.
- **Caught:** `packages/core/src/skills` lifecycle operations wrote files directly
  and could race or follow unsafe skill store paths.

## 148. Best-effort telemetry must be bounded, non-blocking, and non-authoritative

An observability sink can be a FIFO, link, oversized file, or concurrent writer;
none may stall or fail the foreground operation it observes.

- **Do:** use no-follow/non-blocking regular-file checks, bounded records and
  storage, writer serialization, rotation, and catch failures outside the domain
  result.
- **Caught:** skill selection usage appended without a size limit or physical-file
  validation and could grow forever or target a special file.

## 149. Progress fingerprints must have an explicit uncertainty state

Synchronously hashing an unbounded workspace can freeze the Agent, while treating
an incomplete hash as equality can stop useful work.

- **Do:** fingerprint asynchronously with file/byte/time caps and return `null`
  when the sample is incomplete; only compare two complete samples for no-progress.
- **Caught:** Auto-Loop convergence synchronously read dirty workspace content
  without a total budget.

## 150. Learned ranking signals must remain bounded and non-authoritative

Success telemetry is correlated, sparse, and sometimes stale. Treating a raw
success rate as authority lets a few lucky runs dominate selection or security.

- **Do:** require a minimum sample count, shrink by confidence, cap the score
  adjustment, and keep it outside permission and risk decisions.
- **Caught:** adaptive skill effectiveness in `packages/core/src/skills` needed
  to improve ranking without turning telemetry into an execution grant.

## 151. Filesystem signal caches must validate the scanned frontier

A root directory timestamp does not change when a file is added inside an
already-existing nested directory, so a root-only cache key silently goes stale.

- **Do:** retain and validate physical identities and modification stamps for
  every scanned directory plus separately-read manifests; bound cache entries.
- **Caught:** the skills workspace-language/path cache could otherwise miss a
  newly-added nested source file indefinitely.

## 152. Dependency selection must resolve as one bounded graph operation

Selecting a procedure before discovering its missing, cyclic, risky, or
conflicting prerequisite can inject an unusable half-plan or exceed prompt caps.

- **Do:** resolve dependencies before committing a candidate, count the whole
  bundle against one budget, reject invalid bundles, and topologically order the
  final set with deterministic tie-breakers.
- **Caught:** skill `dependsOn`/`conflictsWith` orchestration in
  `packages/core/src/skills/select.ts`.

## 153. New observability files must be excluded from progress signals

Adding bounded telemetry is still a workspace mutation. If convergence hashes
it, every no-op iteration looks like product progress and loop guards never fire.

- **Do:** classify every new agent-generated state file at the progress boundary
  and add a regression that changes only that file.
- **Caught:** skill outcome rows in `.seekforge/skills-usage.jsonl` prevented
  Auto-Loop `no_progress` detection.

## 154. Orchestrators must consume explicit child terminal events

An async event stream can end normally after reporting `session.failed`. Treating
stream exhaustion as success sends broken work into later gates and destroys the
original failure classification.

- **Do:** record completed/failed terminal events explicitly, retry only a bounded
  transient taxonomy, and preserve the original error in the orchestration result.
- **Caught:** Auto-Loop ignored edit-agent `session.failed` and still ran the verifier.

## 155. Progress persistence must not turn telemetry frequency into write frequency

Cumulative usage updates can arrive once per model turn. Atomically rewriting the
whole state snapshot for every update amplifies foreground filesystem latency.

- **Do:** merge frequent snapshots behind a short bounded checkpoint interval and
  force a synchronous flush at iteration, cancellation, error, and terminal boundaries.
- **Caught:** Auto-Loop rewrote its state file on every `usage.updated` event.

## 156. Observability callbacks are not lifecycle authority

A rendering or embedding callback can throw. Letting that exception escape abandons
the operation while its durable state still says `running`.

- **Do:** isolate observer exceptions, disable the broken observer, record a bounded
  warning, and continue the authoritative operation.
- **Caught:** an Auto-Loop `onEvent` exception could interrupt the loop and release its lease.

## 157. Bounded event counts also need a byte budget and retention policy

An event-count cap does not bound storage when each event carries a large payload;
an append-only file remains unbounded across iterations and resumes.

- **Do:** cap payload bytes, batch writes, rotate by total bytes, retain a fixed
  number of segments, and flush at lifecycle boundaries.
- **Caught:** verifier output could append roughly 1.6 MiB per check to an unlimited Loop log.

## 158. Structured plans must be validated at every public ingress

Checking only that a plan is an array lets malformed ids, duplicate stages, empty
commands, and invalid timeouts reach a deeper executor under a trusted type cast.

- **Do:** validate shape, bounds, unique safe ids, optional booleans, and positive
  timeouts before constructing the typed request.
- **Caught:** REST background Loop accepted unvalidated `verificationPlan` entries
  while the WebSocket path rejected them.

## 159. Delivery artifacts must cover the whole branch delta

A dirty-worktree diff omits already committed work and cannot represent untracked
files, so a successful-looking patch can silently be empty or incomplete.

- **Do:** checkpoint the retained worktree, then generate a binary patch for the
  complete branch relative to the base checkout.
- **Caught:** Loop `--deliver patch` originally diffed only worktree `HEAD`.

## 160. Parallel graph workers need distinct physical workspaces and partitioned budgets

A callback name is not isolation: two nodes can resolve to the same checkout, and
giving every concurrent node the full remaining budget multiplies the intended cap.

- **Do:** resolve and compare physical workspace identities before each batch and
  divide shared cost/token capacity across simultaneously scheduled nodes.
- **Caught:** Loop DAG concurrency initially trusted `workspaceForNode` without
  checking its results and duplicated the remaining shared budget.

## 161. Replay cursors must survive retention and writer restarts

An index recomputed from retained rows shifts when the oldest segment rotates,
so a previously issued cursor can skip every newer event.

- **Do:** persist a monotonic sequence on each row, recover the last sequence when
  reopening a writer, and retain a bounded legacy-row fallback.
- **Caught:** Loop history originally numbered only the currently retained JSONL rows.

## 162. Orchestration iterations are not conversation turns

Retries, analysis sessions, and resumed runs make an orchestration counter diverge
from the user-message index used by checkpoints and trace truncation.

- **Do:** capture the actual session user-turn boundary before the operation and
  use that same boundary for filesystem rewind and trace truncation.
- **Caught:** Loop regression rollback initially derived a session turn from the
  Loop iteration number.

## 163. Every nonterminal persisted status needs orphan recovery

Recovering only `running` records strands a process that crashed after persisting
`paused`: no owner remains to resume it, but startup recovery ignores it.

- **Do:** enumerate every lease-owned nonterminal state when detecting orphaned work.
- **Caught:** Loop recovery initially omitted durable `paused` records.

## 164. A local timeout and a global duration budget are different stop causes

Using the per-operation timeout as a stand-in for an absent global deadline makes
an ordinary timeout look like budget exhaustion.

- **Do:** track whether a global duration limit actually exists before mapping an
  abort to `budget`; otherwise preserve the operation's timeout/error taxonomy.
- **Caught:** Auto-Loop classified a verifier's normal timeout as `budget: duration`
  when no `maxDurationMs` was configured.

## 165. Rollback must restore derived orchestration state, not only files

Diagnostics, pass streaks, snapshots, and continuation prompts describe a specific
workspace version. Rewinding files while retaining the rejected version's derived
state makes the next decision operate on a workspace that no longer exists.

- **Do:** re-run authoritative verification after rollback, replace the convergence
  baseline, and persist that restored result before another iteration.
- **Caught:** Loop regression rollback retained the regressed diagnostic/snapshot
  baseline after restoring the prior worktree contents.

## 166. Writers must stay within the reader's durable byte limit

Bounding each nested item and the number of items does not bound their product.
A writer can emit a valid multi-megabyte snapshot that its own bounded reader later
rejects.

- **Do:** remove repeated payloads from historical snapshots, enforce a total byte
  budget before atomic replacement, and keep the last readable file on overflow.
- **Caught:** 100 Loop snapshots could repeat 16 verifier commands and output tails,
  exceeding the 1 MiB state-reader limit.
- **Also caught:** Loop verification intelligence bounded entry count and each
  command but did not evict by total UTF-8 bytes before its 512 KiB write.
- **Also caught:** Graph scheduling history bounded observation count but could
  write more than its own 128 KiB reader accepted.

## 167. Evidence existence is not evidence relevance

An existing repository path proves only that a path exists. Treating it as proof of
an acceptance criterion lets an evaluator cite any unrelated file.

- **Do:** require content-anchored evidence and verify the cited symbol/text or line
  range inside a bounded, non-symlink regular file.
- **Caught:** Loop acceptance accepted an unanchored existing path as sufficient evidence.

## 168. Durable controls must target a lifecycle generation

A command can pass an "active" check just as its owner finishes. If the durable
mailbox identifies only the logical job, that late pause or guidance can be replayed
by a later resume and affect a different run.

- **Do:** assign each live ownership period a persisted generation id, bind commands
  to it, and ignore entries for every other generation. Recheck liveness after enqueue
  for accurate caller feedback.
- **Caught:** cross-process Loop controls could otherwise leak across a completion/resume race.

## 169. Terminal side effects still belong to the entity lifecycle

A job reaching `passed` does not make its post-pass delivery atomic. A concurrent
delete or second delivery can remove its state or duplicate irreversible Git/PR
operations while the first delivery is still active.

- **Do:** hold the same entity lease across state transitions and the complete
  external side effect, and persist failed attempts for explicit retry.
- **Caught:** Loop delivery originally ran after releasing the Loop lease and had
  no durable failure state.

## 170. Directory suffixes do not identify one record kind

A directory can contain state snapshots, mailboxes, logs, and temporary files
whose names share a broad suffix. Passing every `*.json` basename into a strict id
parser lets an adjacent record type break listing and recovery.

- **Do:** filter directory entries by the exact id/filename grammar for the record
  being enumerated before calling its reader.
- **Caught:** Loop state listing treated `<id>.control.json` as a state id containing
  a dot and threw instead of listing Loops.

## 171. Idle checks need a reservation before the first asynchronous gap

Checking an in-process queue and only reserving it after another `await` lets a
foreground operation enter between the observation and the background start.
Likewise, a process-local check alone cannot prove that another process has no
active session.

- **Do:** resolve the physical repository identity, synchronously install a local
  reservation, then acquire the cross-process coordination lease and workspace
  guard before declaring background work idle. If any layer is busy, skip rather
  than queue the idle task.
- **Caught:** background Loop recovery originally had no atomic idle-start gate
  spanning the server repository queue and process-visible sessions.

## 172. Owner shutdown and user cancellation are different durable outcomes

The same AbortSignal mechanism may represent either an explicit user decision
or teardown of the process that owns background work. Persisting both as a
terminal cancellation makes lifecycle-managed work impossible to resume.

- **Do:** carry the abort intent into the operation, persist owner teardown as a
  resumable interruption, and avoid recording infrastructure interruption as a
  negative quality outcome.
- **Caught:** shutting down idle Loop recovery changed its durable state to
  `cancelled` and recorded a failed skill outcome, so the next server skipped it.

## 173. Persist success after the irreversible effect, then finalize idempotently

A durable `delivered` marker written before a Git, file, or remote side effect
can survive a crash even though the advertised artifact was never produced.

- **Do:** persist an in-progress attempt, perform the primary side effect, then
  write success and idempotently publish that final metadata. On retry, verify
  or repair an existing success marker before returning it.
- **Caught:** checkpoint, merge, and patch Loop delivery persisted `delivered`
  immediately before their action, creating a crash window with false success.

## 174. Every competing transition must acquire the same lifecycle lock

Checking another lock once does not prevent its owner from starting immediately
after the check. Separate run and delivery locks therefore still permit overlap.

- **Do:** define one outer lifecycle lease and require run, resume, delivery,
  and deletion to acquire it in a consistent order before narrower locks.
- **Caught:** Loop delivery sampled the run lease once, while a resume could
  acquire only that run lease after the sample and race Git/state mutations.

## 175. An idle guard must cover the work and grant only owned child sessions

Releasing an idle guard before awaiting the background operation turns an atomic
idle-start check into a stale snapshot. Holding it naively can also block the
background operation's own Agent and nested-Agent session leases.

- **Do:** retain the guard through completion and pass an authenticated,
  in-process guard capability only to child sessions owned by that operation.
- **Caught:** Server Loop recovery released its workspace guard before resume,
  allowing an external CLI session to overlap the background edit.
- **Also caught:** Loop and Graph recovery bookkeeping acquired child lifecycle
  leases without forwarding the held guard capability, so the guard rejected
  its own backoff write or successful cleanup.
- **Also caught:** the Graph runner forwarded an idle guard to child work but not
  to its own primary lifecycle lease, so real idle recovery rejected itself.

## 176. Resumable status does not prove ownership is gone

A record may already say `interrupted` while its owner is still unwinding or
continuing. Returning it solely by status can launch a second recovery.

- **Do:** apply the live-owner filter to every resumable status, including
  already-interrupted records, immediately before adding a recovery candidate.
- **Caught:** Loop recovery filtered live leases for `running` and `paused` but
  returned every persisted `interrupted` record unconditionally.

## 177. Idle ownership needs an explicit preemption handshake

A foreground operation that merely waits on an idle-maintenance guard can be
starved by long background work, while deleting the guard would violate its
owner's mutual-exclusion guarantee.

- **Do:** mark only idle guards as preemptible, create an owner-scoped request,
  let the owner abort at a cooperative boundary, and use a bounded abortable wait
  before reacquiring normally.
- **Caught:** foreground Loop/session starts could not displace an automatic
  recovery that had correctly retained its guard for the whole edit.

## 178. Incremental verification cannot establish global success

Selecting verifiers by changed paths is an optimization based on incomplete
dependency knowledge. Treating a selected subset's pass as final can miss an
unmapped cross-package regression.

- **Do:** use path selection only while a subset is failing; whenever it passes
  with any stage skipped, run the complete pipeline before incrementing the
  stable-pass counter or returning success.
- **Caught:** the first incremental Loop design could have accepted a local pass
  without proving that unselected stages remained green.

## 179. Retention must revalidate resumability and side-effect state

Age and count alone do not make an orchestration record disposable. Interrupted
work or a passed run with an unfinished delivery still owns future work, and its
status can change between listing and deletion.

- **Do:** exclude active/resumable states and non-final delivery phases, then
  re-read the record and acquire its lifecycle locks immediately before removal.
- **Caught:** automatic Loop pruning needed a terminal-state predicate that
  would not erase recovery or delivery work.

## 180. Explicit artifact publication must account for ignore rules

Writing durable state inside an ignored directory and then running an ordinary
`git add` does not publish it. The surrounding delivery may succeed while the
audit record remains only in a disposable worktree.

- **Do:** validate an exact repository-relative path and force-add only that
  caller-selected artifact before merging or pushing; keep unrelated ignored
  files excluded.
- **Caught:** finalized Loop delivery state under ignored `.seekforge/` was not
  included in checkpoint, merge, patch-state, or pull-request commits.

## 181. Ancestor evidence does not authorize a moving branch or worktree

A verified revision remaining in a branch's history says nothing about later
commits or uncommitted worktree changes. Publishing either can include content
the verifier never saw.

- **Do:** compare the evidenced tree with the publication tip, index, tracked
  worktree, and untracked paths; allow only exact, explicitly expected metadata
  paths after the evidence revision.
- **Caught:** Loop merge and PR retries accepted any descendant of the recorded
  revision and could publish later unverified commits or local changes.

## 182. Container cleanup must join every contained lifecycle

Checking only the worker lock does not cover delivery or another lifecycle
phase that temporarily runs without that narrower lock.

- **Do:** acquire the workspace guard before rechecking contained owners and
  keep it through destructive checkout removal.
- **Caught:** retained Loop worktrees could be removed while their delivery
  lifecycle lease was active.

## 183. Durable graph identity includes execution placement

The same node definition run in another physical workspace is not the same
completed operation, even if its task and verifier strings are unchanged.

- **Do:** resolve node workspaces once and include their physical identities in
  the checkpoint fingerprint used by resume.
- **Caught:** Loop DAG resume reused a completed node after `workspaceForNode`
  remapped it to another checkout.

## 184. Whole-container cleanup must not invalidate its own precondition

Deleting tracked child records before checking whether their containing
worktree is clean manufactures a dirty checkout and makes cleanup fail.

- **Do:** revalidate the complete container under its guard and remove it as one
  operation; prune individual records only when retaining the container.
- **Caught:** `loop-prune --worktrees` deleted tracked Loop state first and then
  refused the resulting dirty worktree.

## 185. Legacy success without evidence remains unfinished

A migrated success label cannot establish that an older irreversible action
actually happened when the old format contains no supporting evidence.

- **Do:** normalize evidence-free legacy success to a protected intermediate
  phase, repair it explicitly, and serialize metadata edits with the lifecycle.
- **Caught:** old Loop `delivered` records were considered finalized for pruning,
  while concurrent priority writes could also be overwritten by the owner.

## 186. Validate before deriving a narrower integer budget

A positive finite fractional duration can become zero when a downstream
per-attempt budget is rounded, violating the callee's contract after validation.

- **Do:** require a positive safe integer at the outer boundary before
  subtracting elapsed time and flooring a derived budget.
- **Caught:** Loop DAG accepted fractional `maxDurationMs` values that could
  produce an invalid zero-millisecond node budget.

## 187. Delivery evidence must descend from the verifier, not only Git

Checkpointing the current tree after a prior pass can legitimize changes made
between verification and delivery without testing them.

- **Do:** rerun the complete persisted verification contract against the exact
  checkpointed publication tree before creating or finalizing delivery evidence.
- **Caught:** first-time Loop delivery committed post-pass files and treated the
  resulting revision as verified.

## 188. Validate again after metadata commits and publish an immutable object

A pre-commit scope check does not cover files or commits created by commit hooks,
nor a branch ref that moves before merge or push.

- **Do:** check scope after the final metadata commit and merge/push the checked
  object id rather than the mutable branch name; do not auto-commit dirt there.
- **Caught:** a finalized-state post-commit hook could add a file that
  `mergeWorktree` then checkpointed and merged.

## 189. A clean checkout can still own unmerged commits

Working-tree cleanliness says nothing about whether deleting its branch loses
committed history.

- **Do:** require the retained branch to be reachable from the base checkout
  before non-force cleanup, and recheck conservatively before deleting the ref.
- **Caught:** automatic Loop worktree pruning deleted the only ref to commits
  created after finalized merge delivery.

## 190. Durable identity must cover injected executable behavior

JSON serialization omits functions, so hashing an options object cannot detect
that an injected verifier implementation or captured configuration changed.

- **Do:** require a stable caller-managed verifier identity for persisted nodes
  with custom executable behavior and include it in the resume fingerprint.
- **Caught:** Loop DAG resume reused a passed node after `options.verify` changed.

## 191. A finalized label is not complete delivery evidence

Explicit phase labels can survive partial writes, migrations, or malformed state;
the label alone cannot prove an irreversible side effect completed.

- **Do:** normalize finalized delivery without mode-complete evidence back to a
  protected intermediate phase before retention decisions.
- **Caught:** evidence-free explicit `finalized` Loop records remained pruneable.

## 192. Reopened durable work must clear stale completion markers

A completed checkpoint can become active again through rerun or invalidation. If
an optional completion timestamp survives the transition, readers may treat a
paused or partially rerun graph as finished.

- **Do:** explicitly clear terminal metadata whenever a durable operation is
  reopened, and write it again only after every new terminal condition holds.
- **Caught:** Loop DAG `rerunFrom` retained the old `completedAt` when the graph
  subsequently paused at a new approval gate.

## 193. Discovery markers must be physical files inside the selected root

Existence checks follow symbolic links. A linked manifest or lockfile can make
an automatic discovery path select commands based on state outside the workspace.

- **Do:** inspect the root entry itself, accept only regular non-symlink files,
  and keep any manifest reads bounded and no-follow.
- **Caught:** automatic Loop verification treated symlinked Cargo and package
  manager markers as project-owned discovery evidence.

## 194. Post-side-effect policy must survive process and retry boundaries

A required closure step held only in a callback or CLI flag disappears after an
interruption, allowing a retry to finalize an already-published side effect.

- **Do:** persist the frozen policy and progress with the side-effect evidence,
  and refuse finalization until the durable closure state passes.
- **Caught:** retrying PR delivery could bypass the original `--wait-ci` gate.

## 195. Long external watches must be asynchronous and cancellation-owned

A synchronous child-process wait blocks cooperative cancellation and lifecycle
cleanup even when the surrounding orchestration accepts an AbortSignal.

- **Do:** spawn asynchronously, bound output and time, subscribe with
  `onAbortOnce`, and terminate the complete process tree on abort.
- **Caught:** `gh pr checks --watch` could block Ctrl-C for its full timeout.

## 196. Concurrent schedulers must react to individual completion

Waiting for a whole launch batch creates an implicit barrier: fast work cannot
unlock downstream work until an unrelated slow peer finishes.

- **Do:** retain resource and budget reservations per running node, race individual
  completions, release only that node's reservations, and immediately reschedule.
- **Caught:** Loop DAG throughput was bounded by its slowest node in every batch.

## 197. Declared artifacts require physical containment validation

An apparently relative output path may be a symlink or resolve outside the node
workspace after execution.

- **Do:** validate portable relative syntax, reject symlinks and non-files, resolve
  the physical target, and prove it remains beneath the physical workspace root.
- **Caught:** Loop DAG dependency outputs had no validated file-artifact contract.

## 198. Cached verification evidence is bound to the verified state

A stage id and iteration identify an invocation slot, not the workspace contents
that passed. Reusing that result after another verifier or rollback changes files
can bypass the authoritative full gate.

- **Do:** scope reuse to one incremental-to-full transition, bind it to a complete
  workspace fingerprint, and disable reuse when the fingerprint is uncertain or changed.
- **Caught:** Auto-Loop verification cached only by iteration and stage id, so a
  rollback could reuse success from the rejected workspace.

## 199. Persist authorization before starting the authorized side effect

An in-memory approval followed immediately by execution has a crash window: the
side effect may start while durable state still says approval is pending.

- **Do:** persist a distinct approved-but-not-completed state first, restore it
  without prompting again, and replace it only with the terminal execution result.
- **Caught:** Loop DAG approval was not checkpointed before node execution and
  resume deleted every waiting record, allowing duplicate approval or execution.

## 200. Discovery output must independently satisfy the consumer contract

One root detector failing to produce a command must not suppress valid child
detectors, and independently bounded sources can still overflow a shared limit.

- **Do:** run applicable discovery roots independently, reserve capacity for
  authoritative global gates, and enforce the final consumer limit after combining.
- **Caught:** monorepo package tests required a recognized root script, while
  package, Cargo, Go, and Python stages together could exceed Loop's 16-stage cap.

## 201. Optional repair prerequisites are lazy dependencies

A configured repair policy does not prove repair will be needed. Loading provider
credentials, trust prompts, MCP processes, or profiles before observing failure can
break a successful no-repair path and create unrelated side effects.

- **Do:** evaluate the external gate first and initialize repair-only dependencies
  only after a failed result is eligible for repair.
- **Caught:** `loop-deliver --wait-ci` eagerly initialized Agent/MCP configuration
  even when PR checks were already green.

## 202. Every async UI commit is bound to the selected resource generation

Filtering, polling, selecting, and paging can overlap. Request order is not response
order, so an old success, error, or `finally` can overwrite the current resource.

- **Do:** give each independent request stream a latest-generation token, capture
  the selected resource id, and guard success, failure, append, and busy cleanup.
- **Caught:** Desktop Loop management could show an older filter result or append
  history from a previously selected Loop.
- **Also caught:** Desktop Graph template discovery and preview shared one token,
  so starting a preview could discard an otherwise current template response,
  while a workspace switch could leave stale busy state behind.

## 203. Cancellation errors remain control flow across wrapper layers

Returning an abort inside a generic command-result envelope lets the next wrapper
interpret it as an ordinary nonzero exit and persist a domain failure.

- **Do:** rethrow cancellation before interpreting command status and keep durable
  retryable state distinct from a real external-check failure.
- **Caught:** cancelled `gh` CI watches were recorded as failed checks or missing logs.

## 204. Acquire coordination before provisioning derived workspaces

Deterministic names do not make worktree creation race-free, and a matching Git
branch does not prove its checkout still occupies the managed path expected by
the orchestration state.

- **Do:** derive the scheduler identity without mutation, acquire its lease first,
  then provision; on resume bind both branch identity and the exact physical path.
- **Caught:** managed Loop DAG worktrees were created before the DAG lease and
  resumed by branch name alone, allowing concurrent creation or path rebinding.

## 205. Invalidate derived aggregate evidence with its inputs

A persisted fan-in, summary, or aggregate verification is valid only for the
exact node results and orchestration policy that produced it. Rerunning an input
or changing integration policy makes the old aggregate stale.

- **Do:** include behavior-affecting policy in the durable fingerprint and clear
  aggregate evidence whenever any contributing result is invalidated.
- **Caught:** Loop DAG `rerunFrom` retained a passed fan-in, while the dependency
  integration switch was absent from the resume fingerprint.

## 206. Failed aggregate work still consumes shared budgets

Accounting only after a successful terminal check drops the cost of failed or
exhausted aggregate repair, so later work can exceed the advertised shared cap.

- **Do:** charge usage immediately after the bounded child returns, preserve its
  result on either status, and isolate observer callback failures from completion.
- **Caught:** failed Loop DAG fan-in runs were omitted from persisted cost/token
  totals, and a throwing `onFanIn` observer could discard the completed checkpoint.

## 207. Overlapping path prefixes require most-specific classification

The first matching prefix may be a broad parent while a later, narrower prefix
carries the actual dependency or ownership meaning. Selection remains executable
but its explanation and policy classification become wrong.

- **Do:** normalize all candidates, choose the longest matching path boundary,
  then apply direct/dependency classification to that most-specific prefix.
- **Caught:** Loop verification could label a dependency edit as direct when a
  broader direct prefix appeared before the nested dependency prefix.

## 208. Destructive resource identity must have typed provenance

A generic artifact string can resemble a managed branch name. Inferring ownership
from a prefix can make archive, merge, or prune act on an unrelated checkout.

- **Do:** persist the managed branch in a dedicated validated field and rebind its
  physical path under the exact managed root immediately before every mutation.
- **Caught:** Loop DAG resource cleanup inferred branches from user-declared
  artifact paths beginning with `seekforge/`.
- **Also caught:** Loop DAG fan-in accepted any string starting with
  `seekforge/` as managed provenance. Validate the complete managed branch
  grammar before resolving or promoting its worktree.

## 209. Repository-wide quotas require repository-wide coordination

Checking a resource count under an operation-specific lease is still racy when
another operation uses a different id and can provision before the first commits.

- **Do:** hold one canonical resource-family lease across count, reservation,
  provisioning, and delayed derived-resource creation; use it for cleanup too.
- **Caught:** concurrent managed Loop DAGs could both pass the worktree limit and
  later create more retained worktrees than the configured cap.

## 210. Nested persisted identifiers keep their own grammar

Parent record ids and nested candidate/node ids often have intentionally different
length limits. Reusing the parent validator can make a freshly written valid state
unreadable, while unchecked optional fields can taint trusted typed state.

- **Do:** validate every nested field with its declared grammar and validate
  references/status relationships before casting the parsed record.
- **Caught:** a valid 57–64 character speculation candidate id was written but
  rejected on reload, and winner/error/timestamp fields were accepted unchecked.

## 211. Composed identifiers need a final grammar check

Individually safe path segments can produce an overlong identifier or carry
characters forbidden by the destination schema after prefixes and separators are added.

- **Do:** normalize the composed value, bound it with a deterministic hash suffix,
  and validate the final consumer grammar rather than only each source segment.
- **Caught:** long or dotted workspace directory names produced auto-discovered
  verification stage ids that the Loop stage validator rejected.

## 212. Decayed evidence needs an effective-mass maturity threshold

Counting raw historical samples as mature after their weights decay to nearly zero
lets ancient data keep overriding a deterministic default through tie-break rules.

- **Do:** require both a raw sample floor and a minimum effective weight, and use
  effective mass—not raw count—for confidence and tie-breaking.
- **Caught:** years-old Loop recovery observations could still select a non-default
  strategy despite the advertised recency decay.

## 213. Empty optional resources bypass their backend

An operation that has no derived resources should not initialize the backend used
only to enumerate or mutate them; the workspace may validly lack that backend.

- **Do:** validate durable state and return the empty result before opening Git,
  database, network, or managed-root resources that are unnecessary for the case.
- **Caught:** inspecting or pruning a completed non-managed Loop DAG failed because
  it still invoked `git worktree list` in a non-Git workspace.

## 214. Validate complete topology before provisioning derived state

Field-valid graph nodes can still form a dependency cycle. Discovering the cycle
inside the scheduler is too late if leases, checkpoints, or worktrees already exist.

- **Do:** run a complete acyclic-topology check after node/reference validation
  and before the first lifecycle acquisition, persisted write, or resource creation.
- **Caught:** Loop DAG cycle detection ran only after runtime initialization and
  its initial checkpoint, so an invalid graph could leave durable side effects.

## 215. Mirrored boundary validators drift across entry points

Two adapters can start from the same contract and silently diverge as fields and
edge cases are added. A stricter CLI does not protect direct Core or Server calls,
while a field omitted by one decoder disappears without an error.

- **Do:** keep transport shape decoding thin, then call one exported semantic
  validator; export reusable field decoders and predicates from that same owner.
- **Caught:** CLI and Core Loop DAG validators disagreed on duplicate dependencies
  and NUL-containing artifact paths, while CLI silently discarded `verifierId`.
- **Also caught:** Loop and Graph separately decoded the same automatic-recovery
  subrecord, but only Graph rejected unknown keys and reversed retry timestamps.

## 216. Nested authorization needs qualified durable state

Reusing a leaf id across parent and nested scopes can make approval intended for one node authorize another node with the same name.

- **Do:** qualify external approvals, persist each child scope independently before its effects, and require an existing matching child checkpoint whenever the parent is resuming it.
- **Caught:** a nested Engineering Graph gate could either inherit a same-named parent approval or force already-completed child effects to run again on resume.

## 217. Timeout is not resource settlement

Winning a timeout race does not mean the losing asynchronous operation has stopped. Retrying immediately can overlap attempts and mutate shared state after the scheduler has recorded failure.

- **Do:** abort the timed operation, await its settlement, and only then retry or release the owner lease.
- **Caught:** a timed-out Engineering Graph function could remain active while its retry started.

## 218. Resume fingerprints include recursively derived locations

Hashing a nested definition without its resolved child locations lets a resumed parent reuse a completed subgraph after the physical workspace mapping changed.

- **Do:** recursively resolve and containment-check every nested physical workspace before lifecycle effects, and include qualified paths in the parent fingerprint.
- **Caught:** an Engineering Graph parent fingerprint originally bound only top-level node workspaces.

## 219. Pausing an owner does not orphan its in-flight children

A scheduler cannot persist `paused` and release its lease while already-started child work is still mutating state.

- **Do:** stop launching new work, settle every in-flight child, checkpoint those results, and only then expose the paused state or release ownership.
- **Caught:** an Engineering Graph gate could return immediately while an independent node kept running without a graph owner.

## 220. Per-item bounds do not imply a bounded aggregate

A valid maximum for each output, event, task, or list item can still exceed the enclosing checkpoint or response limit when multiplied by maximum cardinality.

- **Do:** bound the serialized definition and aggregate retained outputs/events, and make list endpoints omit heavy detail fields.
- **Caught:** individually bounded Engineering Graph node outputs and events could exceed the 1 MiB checkpoint or produce a very large REST list.

## 221. Resolve extension registries before workflow effects

Discovering a missing named handler only when its node becomes ready lets earlier nodes mutate the workspace before an invalid graph fails.

- **Do:** resolve every referenced extension through own data properties, reject getters/prototype fallbacks, and complete this pass before leases or node effects.
- **Caught:** an unregistered Engineering Graph function handler originally failed only during node execution.

## 222. Sparse arrays and timer overflow bypass ordinary range checks

JavaScript array iteration can skip holes, and Node clamps an oversized timer delay to a near-immediate timeout even when the number is a safe integer.

- **Do:** require own entries at every array index and cap delays to the runtime's supported operational range.
- **Caught:** sparse Engineering Graph dependencies/routes and Loop DAG rerun selectors could evade element validation, while an oversized node timeout behaved like an immediate timeout.

## 223. Presentation bounds must not replay completed effects

Serialization, output-size, or display-shaping failures can happen after an effectful operation has already completed successfully. Treating that failure as retryable repeats the effect only because its telemetry was inconvenient.

- **Do:** convert completed outputs into a bounded serializable summary without changing the execution outcome; separately reject streams that never produced a terminal event.
- **Caught:** a successful Engineering Graph Agent or function could be retried when its returned output exceeded the checkpoint limit.

## 224. Concurrent reservations need overlap checks and serialized settlement

Exact-key uniqueness does not prevent an ancestor path from overlapping a descendant, and independently completed promises cannot safely enforce one shared aggregate limit from the same stale snapshot.

- **Do:** reject pairwise ancestor/descendant resource scopes and settle shared quotas at one owner-controlled completion point.
- **Caught:** concurrent Engineering Graph or Loop DAG nodes could mutate nested workspaces, and Graph nodes could collectively exceed the retained-output budget.

## 225. Approval callbacks require exact affirmative values

Truthiness is not an authorization contract. Untyped embedders can accidentally return strings, objects, or numeric status values that should not cross an explicit approval boundary.

- **Do:** treat only the boolean value `true` as callback approval and validate all serialized approval selectors before effects.
- **Caught:** a truthy non-boolean Engineering Graph approval callback result could cross a gate.

## 226. Drained work still needs durable settlement

Aborting and awaiting in-flight work prevents orphan mutation, but it does not make completed or cancelled outcomes resumable unless the owner records them before releasing its lease.

- **Do:** route emergency-drain settlements through the same serialized result and checkpoint path, while preserving the original scheduler error if persistence itself is failing.
- **Caught:** an exceptionally stopped Engineering Graph drained child promises but could resume by repeating their effects because their final results were never recorded.

## 227. Cancellation needs a post-settlement check

A final in-flight item can settle and make both pending and active collections empty before the scheduler reaches the next loop-header cancellation check.

- **Do:** check owner cancellation again after the scheduling loop and before deriving a success/failure terminal status.
- **Caught:** cancelling the last Engineering Graph node could report `failed` instead of `cancelled` because the loop exited immediately after settlement.

## 228. Optional selector decoding must reject malformed presence

Treating a present value of the wrong type like an omitted optional selector can silently turn an approve, rerun, or resume request into a different operation.

- **Do:** distinguish absence from malformed presence, reject ambiguous aliases, then pass the selected array through the shared semantic validator.
- **Caught:** the Graph REST adapter initially treated a string-valued approval or rerun selector as if no selector had been supplied.

## 229. Concurrency guards need dependency reachability

A scheduler concurrency setting describes a maximum, not proof that every pair of nodes can overlap. Rejecting shared resources without considering transitive ordering blocks safe serial workflows.

- **Do:** apply overlap exclusion only to effectful node pairs for which neither node transitively depends on the other.
- **Caught:** a Graph with `maxConcurrency > 1` rejected two nodes sharing a workspace even when one had to complete before the other could start.

## 230. Fresh owners must not adopt stale derived checkpoints

A deterministic child id makes crash recovery possible, but it can also find an orphan from an older deleted or interrupted owner. Retrying a fresh parent after that collision must not turn the stale child into trusted progress.

- **Do:** allow child-checkpoint reuse only for an explicit parent resume or for a child created by the current node attempt sequence; make a pre-existing collision non-retryable until explicit restart.
- **Caught:** a fresh Graph subgraph attempt could fail on an existing child and then adopt it on its automatic retry.

## 231. Resumed child usage is an in-flight reservation

Deleting a parent's waiting result before resume temporarily removes its cost and tokens from the parent checkpoint even though the durable child still owns that usage.

- **Do:** reserve persisted child usage before scheduling, include it in concurrency budget calculations, and replace the reservation atomically with the settled parent result.
- **Caught:** a resumed subgraph could receive a full fresh budget share and let concurrent parent nodes oversubscribe the Graph budget.

## 232. Operational caps are not durable identity

An invocation-specific remaining budget can differ on every parent retry even though the child workflow definition is unchanged.

- **Do:** keep runtime caps outside the durable definition fingerprint and validate them independently.
- **Caught:** a resumed Graph subgraph rejected its own checkpoint because the parent's newly calculated budget share changed its fingerprint.

## 233. Intermediate checkpoints must satisfy the loader's invariants

Publishing a terminal status before its terminal metadata or final verification is durable creates a crash window whose checkpoint the loader must reject.

- **Do:** persist an explicit running phase during fan-in and transition status, evidence, usage, and completion metadata together.
- **Caught:** Graph fan-in emitted `passed` before `completedAt`, making a crash at fan-in start unrecoverable.

## 234. Resource archival belongs to one run generation

An archive marker keyed only by a reusable workflow id can authorize pruning resources created by a later restart.

- **Do:** bind archival markers to an immutable run generation and require an exact match before pruning.
- **Caught:** a pruned and restarted managed Graph inherited the previous run's archived status.

## 235. Internal resource ids need a disjoint namespace

Using an ordinary user node id such as `integration` for an internal worktree lets a valid definition alias its fan-in resource.

- **Do:** use an internal identifier outside the accepted user-id grammar and derive every expected branch through the same helper.
- **Caught:** a Graph node named `integration` could share its managed worktree with fan-in.

## 236. Transparent orchestration nodes must preserve artifact ancestry

Approval gates and routers carry control state but no branch. Looking only at direct dependencies can therefore disconnect downstream work from the last effectful ancestor.

- **Do:** walk through passed non-effectful dependencies until reaching typed managed sources, then merge each source once.
- **Caught:** a managed Graph consumer after a gate did not receive its producer's committed changes.

## 237. Template substitution must fail closed

Replacing an undeclared placeholder with JavaScript `undefined`, accepting an extra value, or iterating a sparse template array can silently materialize a different workflow.

- **Do:** validate own parameter declarations and supplied keys, preserve exact-placeholder types, reject unresolved names, and retain dense-array checks after substitution.
- **Caught:** Graph template interpolation initially had no explicit unknown-placeholder boundary.

## 238. Aggregate prompt context needs an outer bound

Bounding each log, error, or prior attempt independently still permits the combined recovery capsule to grow without limit.

- **Do:** cap the final serialized context before sending it to the model.
- **Caught:** Loop recovery initially bounded each field but not the combined contextual capsule.

## 239. Impact telemetry must distinguish selection from execution

A stage selected by the planner may later be blocked by a prerequisite failure or satisfied by cache reuse.

- **Do:** report run, skip, reuse, and blocked decisions explicitly instead of claiming every selected stage ran.
- **Caught:** Loop impact reporting initially reflected the plan but not the eventual execution outcome.

## 240. Every event checkpoint must satisfy durable state invariants

A terminal or paused status can become invalid while the scheduler is still materializing skipped or waiting results, even when the final checkpoint is valid.

- **Do:** persist preparatory node events under a non-terminal status, switch to `paused` before persisting a waiting result, and publish terminal status only after all required results and timestamps exist.
- **Caught:** Graph cancellation and nested approval events briefly wrote checkpoints that restart validation rejected.

## 241. Validate derived resume state before sibling effects

A parent fingerprint can match while a separately persisted child checkpoint has stale provenance, identity, or resolved locations. Discovering that mismatch only when the child starts allows independent siblings to mutate first.

- **Do:** preflight every retained child checkpoint against expected parent provenance and its independently derived fingerprint before publishing resume or scheduling any node.
- **Caught:** a resumed Graph reserved child usage before proving that the child checkpoint belonged to the current parent definition and workspace mapping.

## 242. Loaders must re-enforce presentation budgets

Writer-side truncation does not protect resume, list, or detail paths from a syntactically valid checkpoint written by an older version, embedder, or local tampering.

- **Do:** enforce both per-item and aggregate serialized-output limits while decoding durable state.
- **Caught:** the Graph loader accepted node outputs that the live scheduler would have truncated, bypassing its retained-output contract.

## 243. Synthesized events must reach every event sink

An observer failure can create a warning after the original event has already been sent to history. Adding it only to the in-memory checkpoint makes the durable trace disagree with the authoritative recent-event window.

- **Do:** route synthesized warnings through every durable event sink while isolating secondary observability failures.
- **Caught:** Graph observer warnings were checkpointed but omitted from rotating JSONL history.

## 244. Cancellation must normalize newly settled waiting work

Awaiting in-flight work after cancellation can produce a fresh `waiting_approval` result. Publishing `cancelled` while any waiting result remains violates the durable status/result invariant.

- **Do:** settle in-flight work, convert every waiting result to a usage-preserving cancelled skip under valid intermediate statuses, then materialize pending skips and publish the terminal checkpoint.
- **Caught:** a subgraph could pause while its parent was draining cancellation, leaving an unloadable cancelled checkpoint.

## 245. Parallel verification requires explicit disjoint resources

A verifier may format files, generate code, update snapshots, or warm a shared cache even when it is described as a read-only gate. Topological independence alone does not make two commands safe to overlap.

- **Do:** keep stages sequential by default; require explicit parallel opt-in and non-overlapping logical resource declarations, settle the started wave, and stop launching new waves after a required failure.
- **Caught:** making every dependency-free Loop verification stage concurrent changed stop-on-failure behavior and let a later workspace-mutating verifier invalidate another stage's cache while both were running.

## 246. Crash journals bracket effects and settlement

A `started` event is observability, not a durable retry contract. After a process dies, an owner must distinguish work that never began from an effect whose result was not published.

- **Do:** persist a stable attempt/idempotency identity before invoking the effect, publish terminal result plus journal removal atomically, reuse the key only for crash recovery (not explicit reruns), and surface interrupted attempts explicitly.
- **Caught:** Engineering Graph resume previously had only a node-start event, so function effects could be repeated without a stable deduplication key.

## 247. Paused states need a durable reason

Approval pause and operator pause have different loader invariants and recovery policies. Inferring both from the presence of a waiting node makes a valid control pause unloadable or lets idle recovery cross an approval boundary.

- **Do:** persist a closed pause-reason enum, require waiting approval only for approval pauses, and auto-resume only the explicitly recoverable pause class.
- **Caught:** adding safe-boundary Graph pause could not reuse the existing `paused implies waiting_approval` invariant.

## 248. Nested resources remain owned by the parent lifecycle

A child workflow may create branches or worktrees whose checkpoint lives below the parent. Inspecting only direct result branches hides those resources from parent archival, pruning, restart, and deletion checks.

- **Do:** derive child identities recursively through the same owner function, exclude separately measured descendants from parent totals, clean descendants before ancestors, and retain every ancestor of a dirty descendant.
- **Caught:** enabling nested Graph managed worktrees initially left child branches outside the parent resource lifecycle.

## 249. Failed parallel batches must settle every started peer

Fail-fast aggregation can return after one operation rejects while sibling effects still run, allowing retry, cleanup, or result publication to overlap orphaned work.

- **Do:** use all-settled aggregation for started effect batches, then publish the first bounded failure only after every peer settles.
- **Caught:** a failed Graph map item let its batch return while other handler effects were still running.

## 250. Durable control must bind to owner liveness, not a process-local registry

A valid workflow owner may run in another process or in idle recovery without appearing in the receiving server's in-memory run map.

- **Do:** authorize durable control against the validated run identity and shared live lease; use local registries only for locally owned cancellation handles.
- **Caught:** Graph pause/steer rejected live cross-process and idle-recovery owners.

## 251. Child checkpoint retention follows the resumable parent

A terminal child is not independently disposable while its parent can still resume and expects that checkpoint for usage and effect recovery.

- **Do:** apply terminal retention to root workflows, preserve descendants of resumable parents, and remove same-root descendants with their terminal owner.
- **Caught:** age/count pruning could delete a passed child underneath a paused Engineering Graph.

## 252. Pointer syntax must be validated before traversal

Checking only a leading slash accepts malformed escape sequences that different JSON Pointer implementations may interpret differently.

- **Do:** validate the complete bounded pointer grammar, then decode only `~0` and `~1` while blocking prototype keys and accessors.
- **Caught:** Graph input bindings accepted `~2` escapes even though the resolver did not define them.

## 253. `allSettled` cannot catch work that throws while its input array is built

Calling an effect directly inside `items.map(...)` evaluates it before `Promise.allSettled` receives the array. A synchronous throw aborts that mapping step, so already-returned promises are neither awaited nor checkpointed.

- **Do:** enter each possibly synchronous effect through `Promise.resolve().then(() => effect())`, then pass those promises to `allSettled`.
- **Caught:** a synchronous Engineering Graph map handler failure bypassed successful sibling settlement and item-level checkpoints.

## 254. Durable mailbox claims need checkpoint-ordered acknowledgement

Removing a claimed event before its workflow result is durable loses the event on a crash; never removing it eventually exhausts a bounded mailbox.

- **Do:** retain a claim through the authoritative workflow checkpoint, then acknowledge and remove it under the mailbox lease.
- **Caught:** completed Graph wait signals accumulated permanently, while eager cleanup would have opened a loss window.

## 255. Dynamic fan-out must partition the parent's remaining budget

Giving every child in a concurrent batch the full parent budget multiplies the advertised allowance by the fan-out width.

- **Do:** subtract committed child usage before each batch and divide the remainder across only the children that will start.
- **Caught:** every Engineering Graph map item received the entire node cost/token budget.

## 256. File verification must rebind the path after reading the descriptor

An opened descriptor remains stable across rename, but the published path may be rebound to another inode while hashing is in progress.

- **Do:** compare device/inode and physical path before and after streaming the descriptor; publish evidence only if both bindings match.
- **Caught:** verified Graph artifact evidence could describe a path that changed after the initial identity check.

## 257. Cancellation sentinels must be handled before numeric coercion

UI prompt cancellation commonly returns `null`, and `Number(null)` silently becomes zero.

- **Do:** branch on cancellation and blank input before parsing or clamping numeric values.
- **Caught:** cancelling a Desktop Graph priority prompt submitted priority `0`.

## 258. Internal scheduler keys must not reuse user-visible hierarchy syntax

Embedding a raw filesystem path in a logical resource id lets ordinary path punctuation acquire scheduler meaning.

- **Do:** encode exact internal identities with a domain-prefixed hash; reserve hierarchical separators for declared logical resources.
- **Caught:** Loop DAG workspaces named `pkg` and `pkg.child` were falsely treated as a parent/child resource conflict.

## 259. Numeric contracts must survive JSON normalization

In-memory numbers such as `NaN`, infinity, and negative zero do not round-trip through JSON with their original meaning. Accepting them in a persisted schema can change fingerprints or validation behavior after resume.

- **Do:** reject non-finite contract numbers and normalize signed zero before fingerprinting or persistence.
- **Caught:** Graph schema enums accepted numbers whose resumed meaning differed from the original definition.

## 260. Terminal live subscriptions need an explicit release point

Reconnect registries outlive individual requests. Keeping a completed background run in such a registry causes every future reconnect to resubscribe to immutable history and leaks entries over long-lived UI sessions.

- **Do:** advance cursors for non-terminal frames and remove the subscription as soon as its terminal frame arrives.
- **Caught:** Desktop retained completed Graph Run Ledger subscriptions until the owning tab closed.

## 261. Cumulative duration budgets must persist active elapsed time

Using only the current invocation timer lets every durable resume reset a workflow's time allowance. Using creation-to-completion wall time has the opposite defect: it charges approval, signal, and offline pauses against execution.

- **Do:** checkpoint cumulative active elapsed time, add only the current owner's runtime, and use that value for scheduling, nested budgets, summaries, and comparisons.
- **Caught:** Loop DAG and Engineering Graph duration budgets reset on resume, so repeated pauses could evade the configured limit.

## 262. Durable events need both wakeup discovery and post-checkpoint reconciliation

Correct claim ordering prevents event loss, but it does not by itself make a paused workflow discoverable or close the crash window after the workflow checkpoint and before mailbox acknowledgement.

- **Do:** let recovery scans inspect durable event readiness, and reconcile claims already represented by committed workflow results before continuing or replacing a run.
- **Caught:** an enqueued Graph signal did not wake idle recovery, while a crash after checkpointing a passed wait could leave its claimed signal permanently retained.

## 263. A durable manual pause is not an orphaned run

Both states lack a live owner after a process exits, but their intent is different: an orphaned running checkpoint requests recovery, while an explicit pause requests inactivity.

- **Do:** classify recovery from the persisted lifecycle reason; recover ownerless running work and ready waits, but require an explicit continue for user/control and approval pauses.
- **Caught:** idle recovery automatically continued explicitly paused Loops and control-paused Engineering Graphs.

## 264. Recovery bookkeeping must accept only known adjacent generations

An automatic attempt can fail before publishing its new run identity or after doing so. Recording against only one identity loses early failures; updating whichever identity is current lets a delayed failure corrupt a later run.

- **Do:** capture the pre-attempt identity, allocate the attempt identity up front, and persist failure metadata only if the checkpoint still matches one of those two known adjacent generations.
- **Caught:** Graph recovery backoff could either miss provider-initialization failures or race with a newer foreground resume.
- **Also caught:** Loop recovery failure bookkeeping had no attempt generation,
  so a delayed failure could overwrite a newer foreground result.

## 265. New identity validation must preserve legacy sentinels

A persisted migration may represent a formerly absent identity with a sentinel that the current identifier validator rejects. Reusing the new validator at a recovery boundary can make valid legacy state permanently unrecoverable.

- **Do:** identify and narrowly accept documented migration sentinels when comparing old state, while requiring newly allocated identities to satisfy the current validator.
- **Caught:** schema-v1 Graph checkpoints use an empty control-run identity, so automatic recovery failures could not persist backoff for those checkpoints.

## 266. Retry metadata belongs to an attempt, not the workflow's history

Backoff is transient scheduler state. Leaving it on a manually resumed or normally completed workflow misreports current health and can delay a later genuinely recoverable interruption.

- **Do:** clear stale retry state when foreground ownership starts, and retire the automatic attempt identity plus backoff when that attempt completes normally. Keep durable failure history in the event log instead.
- **Caught:** successfully resumed Loops retained old recovery errors and next-attempt timestamps indefinitely.

## 267. Secondary failure bookkeeping must not stop a recovery batch

Recording a primary failure can itself fail because its lease or checkpoint changed. Letting that secondary error escape hides the attempted run's original failure and prevents later independent candidates or retention work from running.

- **Do:** isolate bookkeeping with its own error channel, preserve the primary error, and continue the bounded batch whenever the owner has not been cancelled.
- **Caught:** one Loop backoff-write failure could abort the workspace maintenance tick and skip all remaining Loops and pruning.

## 268. Cleanup must use the initiating generation, not a fresh read's identity

Reading the latest checkpoint immediately before cleanup does not prove it still belongs to the operation that just completed. Using that freshly read identity can authorize a stale completion to clear metadata published by an adjacent owner.

- **Do:** carry the pre-attempt identity and allocated attempt identity through the operation, then condition cleanup on either known adjacent generation.
- **Caught:** Server Loop recovery used the latest persisted control-run id for successful cleanup instead of the completed attempt's captured identity.

## 269. A cache file must not change the identity it indexes

Writing an advisory cache inside the workspace can change the workspace fingerprint immediately after the cache key was computed. The new entry is then stale by construction and can invalidate an otherwise reusable in-process result.

- **Do:** exclude narrowly named internal cache files from authoritative workspace identity while still binding every entry to command, content fingerprint, size, age, and full-gate rules.
- **Caught:** the persistent Loop verification cache caused an extra full-stage execution because its own write changed the cached fingerprint.

## 270. Retry delay is durable workflow state

Sleeping only in process forgets the delay after a crash and can retry an external side effect earlier than the declared policy.

- **Do:** checkpoint the settled attempt, bounded error, and absolute next-attempt time before an abortable wait; on recovery, distinguish interrupted execution from a settled retry wait.
- **Caught:** Engineering Graph node retries were immediate and had no recoverable waiting generation.

## 271. A failure created during scheduling must reapply the stop policy

A scheduler may check `failurePolicy` and then create a new zero-attempt failure while processing deadlines, gates, or waits. Continuing the same pass can launch independent work after a stop-policy failure.

- **Do:** after any scheduler-local transition creates a failure, re-evaluate the stop policy before selecting or launching ready work.
- **Caught:** an expired Graph start deadline could fail one node and still launch its independent sibling in the same scheduling pass.

## 272. Time-derived priority needs both bounds

Clock skew or a future persisted timestamp can make a computed wait duration negative. Applying only an upper cap turns starvation prevention into an unbounded priority penalty.

- **Do:** clamp time-derived aging to the declared lower and upper bounds before adding it to a scheduling score.
- **Caught:** Graph priority aging capped bonuses at 20 but allowed negative values.

## 273. Structural equality must not depend on object key insertion order

`JSON.stringify` preserves object insertion order, so semantically identical typed objects can compare as changed when constructed through different adapters.

- **Do:** use structural equality or a shared canonical representation for migration and cache identity decisions.
- **Caught:** Graph migration planning could invalidate unchanged nodes solely because their property insertion order differed.

## 274. An advisory cache hit cannot authorize acceptance

A cross-run cache may be correctly keyed and still be less authoritative than a fresh release gate. Treating a hit as a successful incremental run is unsafe when no unrelated stage happens to trigger the full fallback.

- **Do:** track persistent-cache provenance explicitly and force the complete authoritative pipeline before accepting success.
- **Caught:** an all-cacheable Loop verification plan could pass entirely from persistent hints.

## 275. Advisory persistence is still a deserialization boundary

Ignoring malformed cache files is safe only when unknown fields, sparse arrays, runtime identity, byte limits, and nested result shape are all validated before a record is reused.

- **Do:** parse cache envelopes and entries with dense arrays, exact keys, bounded bytes, strict hashes/timestamps, and the same nested invariants as the producing contract.
- **Caught:** Loop verification cache entries accepted extra result fields and loosely shaped fingerprints.

## 276. Terminalizing recovered work must clear its active marker

A recovered attempt can be skipped without re-entering the execution path when a stop policy, cancellation, or control transition has already decided its outcome. Cleanup that exists only in the normal completion handler will never run.

- **Do:** every terminalization owner must atomically remove both the recovered-attempt lookup and persisted active-attempt marker before publishing the result.
- **Caught:** a persisted Graph retry wait skipped by an existing stop-policy failure could remain active beside its terminal result.

## 277. Nested durable workflows need a stable parent-attempt identity

Persisting a child workflow is not enough when a recovered parent creates a new random child id. A crash after child completion but before the parent checkpoint can duplicate edits and leave orphan histories.

- **Do:** derive the child workflow id from the parent's durable attempt idempotency key and item identity, then resume that exact child on parent recovery; allocate a new child only for a genuinely new parent attempt.
- **Caught:** recovered Graph Loop nodes and dynamic Loop map items started unrelated Loop records instead of continuing their persisted child.

## 278. A missing checkpoint and an invalid checkpoint are different states

A loader that returns `null` for both absence and corruption is convenient for listing, but a deterministic recovery owner must not interpret corruption as permission to create replacement state.

- **Do:** pair validated loading with a physical existence probe at recovery boundaries; create only when absent and fail closed when a file exists but cannot be validated.
- **Caught:** a corrupt deterministic Graph child-Loop checkpoint could otherwise fall through to a new unpersisted child execution.

## 279. New implicit defaults must preserve legacy durable identity

Adding a normalized default property can change a serialized definition even when runtime behavior is unchanged. Older checkpoints then fail their fingerprint check after an upgrade.

- **Do:** keep newly introduced defaults implicit when legacy canonical state omitted them, or provide an explicit fingerprint migration.
- **Caught:** parsing a legacy handler `map` inserted `mapKind: "handler"`, making otherwise compatible Graph checkpoints impossible to resume.

## 280. Aggregate capability predicates must include nested variants

A runtime capability may be requested by a subtype rather than only by the top-level kind. Checking direct kinds alone lets derived execution bypass preflight requirements.

- **Do:** enumerate every variant that can invoke the capability and recurse through nested definitions in the shared predicate.
- **Caught:** dynamic Agent/Loop map nodes bypassed the Server's mandatory Graph cost-budget check.

## 281. Migration invalidation includes graph-level policy

Comparing nodes alone is insufficient when scheduling, failure, budget, workspace, or fan-in policy lives on the definition envelope. Reporting every node as preserved after such a change gives unsafe migration guidance.

- **Do:** compare the graph-level envelope structurally and invalidate every retained node when behavior-affecting policy changes.
- **Caught:** Graph migration planning ignored changes to `failurePolicy`, concurrency, budgets, managed worktrees, and fan-in.

## 282. Active attempt metadata is bounded by its node contract

A globally valid attempt number can still be impossible for a node with fewer configured retries. Accepting it lets corrupted recovery state fabricate attempts or retry waits the definition never allowed.

- **Do:** validate running attempts against `maxRetries + 1` and retry waits against `maxRetries` for the owning node.
- **Caught:** Graph state accepted attempt six, including a retry wait, for a node configured with no retries.

## 283. A stored fingerprint must authenticate the stored payload

Comparing a checkpoint's claimed fingerprint only with the requested definition trusts the claim without proving that the loaded definition produced it. A modified payload can retain the old digest and bypass the resume comparison.

- **Do:** recompute the canonical or explicitly supported legacy digest from the loaded definition, then require that authenticated definition to match the requested canonical identity.
- **Caught:** Graph resume accepted a matching fingerprint string without binding it back to the checkpoint's own definition.

## 284. Every completion gate belongs in convergence identity

A verifier can remain green while acceptance or independent review findings change. Comparing only verifier diagnostics and workspace content can declare no progress even though the remaining completion obligation changed.

- **Do:** include every persisted completion gate in the bounded convergence fingerprint, while keeping untrusted prose out of the identity.
- **Caught:** Loop's independent code-review findings were not part of stuck/cycle detection.

## 285. Recovered working memory must still match the workspace

Task-scoped memory can be valid when written and stale after an external edit or a resume from a changed checkout. Injecting it without revalidation turns old observations into current guidance.

- **Do:** bind working memory to an authoritative workspace fingerprint and discard it before prompt construction when the current fingerprint differs.
- **Caught:** Loop could inject persisted review/failure memory after the workspace changed between invocations.

## 286. A bounded diagnostic window must be the newest window

Reading the first N records from a rotated history does not establish the latest durable outcome. Treating that prefix as the tail can report a false checkpoint mismatch after later generations.

- **Do:** retain strict parsing across the complete bounded log, but keep the last N valid records when a diagnostic decision depends on recency.
- **Caught:** Loop and Graph diagnose initially compared checkpoints with the oldest 2,000 retained events.

## 287. Type coercion is not runtime type validation

Converting an unknown field before testing its syntax can make a value of the wrong runtime type look valid, while later casts preserve the original invalid value.

- **Do:** prove the exact runtime type first, then apply syntax and uniqueness checks without coercion.
- **Caught:** Loop code-review finding ids accepted numbers because validation tested `String(id)` before storing the original value.

## 288. Async completion gates must recheck cancellation and hard budgets

An abort request can race with a provider's final response, and usage accounting can cross a hard limit on that same response. A structurally valid result is not sufficient to authorize success.

- **Do:** after every asynchronous completion gate settles, recheck the authoritative abort signal and cumulative budgets before accepting completion.
- **Caught:** a Loop review could report success after cancellation or review-cost budget exhaustion won the race.

## 289. Durable advisory verdicts are scoped to workspace identity

A review or summary can be valid when written and stale after external edits. Clearing only a derived summary still leaves the stale source verdict available for prompt construction.

- **Do:** invalidate every advisory verdict and its resumable identity when its bound workspace fingerprint no longer matches.
- **Caught:** Loop discarded stale working memory but could still feed old code-review findings into the next edit.

## 290. Diagnostics should use the best validated retained history

New append-only history may be absent for legacy checkpoints even though a bounded event trace is embedded in the checkpoint itself. Treating that as no history loses useful evidence.

- **Do:** prefer the dedicated event log, then fall back to a validated embedded trace with the same sequence semantics.
- **Caught:** Graph diagnose ignored `state.events` whenever its JSONL history had not yet been created.

## 291. Diagnostic code must defend against loosely decoded history

Observability readers may recognize an event discriminator without fully validating every nested payload. A diagnostic must not crash while inspecting the corruption it is meant to report.

- **Do:** validate every nested field before dereferencing it and emit a bounded corruption finding for malformed payloads.
- **Caught:** a malformed retained `loop.done` row could throw while Loop diagnose read `result.status`.

## 292. Advisory-state producers must satisfy their own parser

Bounding array counts alone is insufficient when individual values, allowed enums, uniqueness, and exact keys are part of the persisted contract. Producing an invalid advisory record can make the entire parent checkpoint unloadable.

- **Do:** normalize advisory data through the same field rules used at deserialization, and test producer output with the parser.
- **Caught:** Loop working-memory creation could retain unsafe paths or unknown categories that its state loader later rejected.
- **Also caught:** the public Loop verification-intelligence recorder deferred
  stage/command and flaky-attempt consistency checks until after acquiring a lease.

## 293. A mutation plan expires before its lease is acquired

Another owner can replace a checkpoint between a read-only preview and the mutation lock. Applying the earlier invalidation set can preserve results that are no longer compatible with the authoritative definition.

- **Do:** validate before effects, then acquire the mutation lease, reload the checkpoint, and recompute the complete plan from that generation.
- **Caught:** Graph migration apply initially risked treating its preflight migration plan as authorization to rewrite state.

## 294. Partial checkpoint migration must rebuild aggregate invariants

Filtering result rows is insufficient when totals also include unfinished map items and fan-in usage, while pause reason, completion markers, attempts, fingerprints, and resource generations constrain the same record.

- **Do:** construct the migrated checkpoint from the destination contract, recompute every aggregate from retained components, clear incompatible lifecycle fields, and validate it through the normal loader.
- **Caught:** Graph migration needed to prevent stale usage, terminal markers, fan-in evidence, or active generations from surviving node invalidation.

## 295. Forecasts are observations, not execution authorization

A simulator cannot know future routing, approvals, external signals, failures, or remote latency. Reusing a forecast as a runtime eligibility decision silently bypasses the authoritative scheduler.

- **Do:** keep simulation side-effect free, report uncertainty explicitly, and let execution re-evaluate every dependency, resource, budget, deadline, and external event.
- **Caught:** Graph scheduling forecasts needed a separate contract from live node eligibility and checkpoint mutation.

## 296. Nested durable generations cannot be migrated independently

A child checkpoint is authenticated by the definition and attempt identity stored in its parent. Rewriting either side alone makes the pair inconsistent, while invalidating a parent subgraph node can accidentally resume an old child generation.

- **Do:** migrate parent and child identities atomically under a coordinated protocol, or reject child and subgraph-invalidating migrations until that protocol exists.
- **Caught:** Graph migration initially allowed a nested child checkpoint or an existing subgraph definition to change independently.

## 297. Budget forecasts must use the budget's time domain

Workflow makespan may include durable offline waits that the runtime explicitly excludes from cumulative active duration. Comparing those different clocks produces false exhaustion warnings.

- **Do:** report wall-clock and active-runtime estimates separately, and compare a duration budget only with its defined active-time measure.
- **Caught:** Graph simulation initially charged an offline `notBefore` gap to `maxDurationMs`.

## 298. Alternative readiness conditions use OR semantics

A wait with both a timer and a signal is ready when either input succeeds. Reporting every unavailable input as an independent blocker makes an already-runnable node look blocked.

- **Do:** evaluate the declared readiness expression first, then report blockers only when no alternative is satisfied.
- **Caught:** Graph node explanation reported a pending signal after the wait timer was ready, and vice versa.

## 299. Durable waits are scheduler barriers, not zero-duration work

An unresolved durable wait drains in-flight work and pauses the workflow before other ready nodes launch. Modeling it as an ordinary zero-duration node allows impossible overlap and understates wall-clock completion.

- **Do:** make forecasts and replay models follow the runtime's pause-and-drain transition before advancing the durable timer.
- **Caught:** Graph simulation initially launched an independent sibling before a `notBefore` wait had resumed.

## 300. Observability files must not perturb the identity they describe

A verifier-history write made after a real stage execution can change the workspace
fingerprint before convergence is sampled, manufacturing progress or invalidating a
cache even though product files did not change.

- **Do:** exclude only the exact bounded internal observability file from the
  authoritative content identity; keep its parser, lease, runtime key, age, and
  count limits independent.
- **Caught:** Loop verification intelligence initially wrote inside the workspace
  without an explicit workspace-fingerprint exclusion.
- **Also caught:** Graph scheduling intelligence was another exact observability
  file missing from the same content-identity exclusion.

## 301. Read-modify-write state must be read after ownership is acquired

Two recorders can both read the same aggregate, then serialize their writes under a
lease while the second still commits its stale pre-lease snapshot. Serialization of
writes alone does not prevent the lost update.

- **Do:** acquire the shared mutation lease first, then read, merge, and atomically
  replace the state while ownership is held.
- **Caught:** Loop verification intelligence initially loaded its aggregate before
  acquiring the cross-process lease.
- **Also caught:** Graph scheduling observations used an unleased read-modify-write
  path that could overwrite a newer concurrent outcome with a stale snapshot.

## 302. A new historical consumer needs every producer generation

Adding a field to later iteration snapshots is insufficient when routing or
convergence reads the initial pre-check snapshot too. Missing metadata in generation
zero silently resets a consecutive-history calculation.

- **Do:** enumerate and test initial, resumed, retry, rollback, and ordinary
  producers whenever a new persisted field drives a history-based decision.
- **Caught:** adaptive Loop model routing initially omitted the pre-check failure
  category, delaying escalation by one iteration.

## 303. Diagnostic shape does not prove failure outcome

A successful verifier can still identify its framework, while a separate acceptance
gate keeps the workflow editing. Classifying from framework shape alone then reports
a test failure that never occurred.

- **Do:** determine success/failure from the authoritative exit outcome first; run
  diagnostic-category classification only for actual failures.
- **Caught:** Loop model routing initially categorized a green verifier with unmet
  acceptance as `test` instead of `none`.

## 304. Bounded operands can still overflow during aggregation

Two safe integers do not guarantee that their product or weighted sum remains safe.
Large-but-valid durations multiplied by sample counts can corrupt an average or
scheduler score.

- **Do:** prefer numerically stable incremental averages and clamp heuristic-only
  scores to their declared numeric domain before sorting.
- **Caught:** Loop verification intelligence initially multiplied a safe duration
  by up to 10,000 retained samples.

## 305. Observation history is not action history

A pre-check can classify the same failure as a later edit iteration without having
attempted any recovery. Treating that classification as an executed strategy skips
the first category-specific repair and diversifies too early.

- **Do:** base action diversification on generations that could actually have
  executed the action, not merely on snapshots that share its input category.
- **Caught:** adaptive Loop routing added a category to the iteration-zero snapshot,
  causing the first SARIF recovery to skip `repair_review` and select `replan`.

## 306. Historical advice must bind to the contract generation it measured

A stable Graph and node id can outlive changes to handlers, workspaces, dependencies,
or scheduling policy. Reusing outcomes by id alone makes a new definition inherit
timing and failure evidence from work it never executed.

- **Do:** include the authoritative definition-and-physical-workspace fingerprint in
  every observation key and require an exact match before the history can influence
  scheduling.
- **Caught:** adaptive Graph scheduling originally keyed observations only by Graph
  and node id, so a changed definition consumed stale scheduling evidence.

## 307. A replacement transaction must preserve the state it is about to hide

Writing a new authoritative checkpoint before archiving the old terminal state can
make the source unrecoverable when the process exits between those writes. A journal
that records only fingerprints proves what happened but cannot reconstruct the lost
snapshot.

- **Do:** persist a prepared journal, perform an idempotent source archive, atomically
  replace the checkpoint, and then mark the journal committed. Recovery may safely
  repeat the archive because its identity is stable.
- **Caught:** Graph migration initially committed the replacement checkpoint before
  archiving its source run, leaving a crash window that lost comparison history.

## 308. Advisory predictions must not become eligibility

Historical duration and failure estimates can be stale, sparse, or biased even when
they are keyed correctly. Letting a forecast skip a required verifier or bypass a
dependency turns an observability error into a correctness error.

- **Do:** use learned values only for bounded ordering, retry advice, and pure
  simulation; dependency, resource, budget, permission, and required verification
  gates remain authoritative.
- **Caught:** Graph health and Loop verification reliability needed an explicit
  separation between forecast reports and runtime eligibility.

## 309. Recovery identity must include the resource generation

A definition fingerprint can recur after a resource has been recreated. Treating
that fingerprint alone as proof that a prepared replacement committed can attach an
old journal to a new physical resource generation and authorize the wrong cleanup.

- **Do:** bind replacement recovery to both the logical target fingerprint and an
  unforgeable resource generation; finish a matching transaction before starting the
  next one, and reject a prepared journal that matches neither source nor exact target.
- **Caught:** Graph migration recovery initially compared only its target fingerprint,
  even though its journal already carried a resource generation.

## 310. Version ordering includes prerelease precedence

Comparing only the numeric core of a semantic version treats `1.0.0-beta` as an
advance from `1.0.0`, and cannot order prerelease identifiers. That lets changed
content move backward while an upgrade guard reports compatibility.

- **Do:** compare major, minor, and patch numerically, then apply release-versus-
  prerelease and dot-separated identifier precedence. Keep content identity separate
  from version progression.
- **Caught:** Graph template compatibility initially checked only the three numeric
  components when deciding whether a changed candidate advanced its version.

## 311. Replacement must preserve independent lifecycle metadata

Replacing the content at an existing logical key is not permission to reset metadata
owned by another lifecycle. A generic upsert that reconstructs the whole record can
silently reactivate something that was explicitly deprecated or archived.

- **Do:** identify metadata owned outside the replacement operation and carry it
  forward under the same read-modify-write lease; require a separate explicit action
  to reverse that lifecycle state.
- **Caught:** replacing an exact Graph template version initially discarded its
  `deprecatedAt` marker.

## 312. Forecast error must use a forecast captured before the outcome

Recomputing a baseline after adding the result being evaluated leaks the answer into
the forecast. With one sample, an updated percentile equals the outcome and reports
zero drift regardless of the original prediction.

- **Do:** persist the forecast at dispatch time and join it to the exact completed
  observation. If no pre-outcome forecast exists, omit drift instead of substituting
  a hindsight estimate.
- **Caught:** Graph health initially compared node duration with a P50 that already
  included that same completed node.

## 313. Capacity forecasts must preserve the hard-limit comparator

A runtime that stops at `usage >= limit` cannot describe `remaining / forecast`
whole steps as affordable: a step that lands exactly on the limit is already
rejected. Missing forecast samples also do not restore capacity after the current
usage has exhausted a hard limit.

- **Do:** derive capacity with the same strict comparator as the authoritative
  budget gate, and report zero immediately when remaining capacity is zero.
- **Caught:** Loop health initially reported one affordable verifier iteration when
  its forecast landed exactly on `maxVerifyRuns`, and reported edit capacity after
  an unsampled cost budget was already exhausted.

## 314. Configuration advice must satisfy the advised contract

A pure simulator may accept a hypothetical object that the public parser or
workspace validator would reject. Reporting that result as a recommendation makes
the advice impossible to apply safely.

- **Do:** bound every recommendation by the authoritative configuration constants
  and suppress advice whose physical preconditions cannot be proven from retained
  state; normal validation still remains mandatory when applying it.
- **Caught:** Graph health could recommend concurrent execution for effectful nodes
  sharing one workspace, or add a 65th resource-capacity key.

## 315. Optimistic versions must advance monotonically

Two state transitions can occur within the same clock millisecond. Reusing a raw
wall-clock timestamp as the optimistic version can therefore leave `updatedAt`
unchanged and let a stale reviewer overwrite a newer decision.

- **Do:** allocate `max(now, previous + 1ms)` or use a separate monotonic
  generation; compare the exact retained version under the mutation lease.
- **Caught:** orchestration proposal approval initially assigned `new Date()`
  directly, so an immediate second review could reuse the original version.

## 316. Archived evidence needs the same validators as live evidence

Moving artifact metadata into a run archive does not make its path or digest
safe. A permissive historical parser can turn previously rejected metadata into
a future reuse candidate.

- **Do:** reuse the authoritative relative-path, digest, size, producer, and
  verification validators when writing and reading archives; omit incomplete
  evidence before serialization and require an exact contract-generation match
  before reuse planning.
- **Caught:** Graph run snapshots initially needed the live safe-relative-path
  invariant and could serialize incomplete “verified” evidence that made the
  strict archive reader reject the entire run.

## 317. New history consumers must preserve the authoritative fallback

A durable JSONL file can be absent while a valid checkpoint still retains its
bounded event tail. A new report that reads only JSONL then describes an existing
terminal run as an empty replay, disagreeing with history and diagnostics APIs.

- **Do:** centralize or reproduce the documented fallback from durable history
  to checkpoint events, with the same sequence semantics, before replay.
- **Caught:** the workspace orchestration report initially omitted the Graph
  checkpoint-event fallback already used by the REST history and diagnostic paths.

## 318. Attribute an action to the state that selected it

An outcome often stores the state observed after an action, while a router chose
that action from the preceding state. Grouping by the outcome state teaches the
opposite relationship whenever the action changes the category.

- **Do:** retain or locate the exact pre-action generation and attribute model,
  retry, or policy outcomes to that generation; keep rolled-back attempts in the
  evidence with their selected strategy.
- **Caught:** Loop strategy learning initially grouped an edit model by its
  post-edit failure category and dropped model metadata on rollback snapshots.

## 319. Aggregate rates by evidence, not by entity

A mean of per-node rates gives a one-sample node the same weight as a node with
hundreds of observations. Likewise, one measured stage does not mean a multi-stage
pipeline has complete forecast coverage.

- **Do:** weight rates by their sample counts, report measured/eligible coverage,
  and calculate percentile SLOs from measured samples rather than forecasts.
- **Caught:** orchestration SLOs initially averaged Graph node failure rates
  uniformly and treated any Loop verification intelligence as 100% coverage.

## 320. Child accounting requires durable provenance

Stable generated ids can prevent duplicate execution but do not prove ownership
to later reporting code. Counting both a parent total and its separately stored
child then inflates workspace usage and budgets.

- **Do:** persist validated parent identity on child checkpoints, verify it on
  resume, preserve it in summaries, and exclude child usage only where its parent
  already includes that usage.
- **Caught:** portfolio rollups excluded child Graphs but initially double-counted
  durable Graph-owned Loops.

## 321. Decision stores must fail closed without evicting decisions

A tolerant read view may hide corrupt optional state, but mutation must not turn
that absence into authorization to overwrite the file. Capacity eviction must
also distinguish reviewed decisions from regenerable drafts.

- **Do:** use a strict parser under the mutation lease, preserve reviewed records
  ahead of unreviewed records, and return only records actually retained.
- **Caught:** orchestration proposal refresh could overwrite malformed state or
  evict an older approval in favor of newly generated drafts.

## 322. Numeric transport syntax must be explicit

JavaScript `Number` accepts whitespace, hexadecimal, and exponent forms that may
not belong to a public decimal configuration contract.

- **Do:** validate the complete transport string against the intended grammar
  before numeric conversion, then enforce finite range constraints.
- **Caught:** orchestration CLI and REST SLO parsers initially accepted values
  such as `0x10`.

## 323. Preview state must be bound to its source generation

Finding a checkpoint by a deterministic id does not prove it represents the
definition or parent edge being previewed. Advice derived from an unrelated
checkpoint can incorrectly imply a safe coordinated migration.

- **Do:** compare the full normalized source definition and exact parent
  provenance before using checkpoint state in a migration tree preview.
- **Caught:** Graph tree migration planning initially marked any same-id state as
  available without checking its definition or parent.

## 324. Optimistic versions cover content refreshes too

A record can keep the same identity and review status while its evidence,
rationale, or other reviewed content changes. Leaving its version unchanged lets
a reviewer approve content different from what they fetched.

- **Do:** compare the complete reviewed payload during refresh and advance its
  optimistic version monotonically whenever any field changes.
- **Caught:** orchestration proposal refresh initially preserved `updatedAt` when
  the same proposal id gained new evidence.

## 325. Nested state discovery follows physical workspaces

Child checkpoint identity and child checkpoint location are separate concerns.
Listing only the root workspace misses nested nodes with workspace overrides and
can report a migration preview that disagrees with apply.

- **Do:** resolve each definition generation's physical workspace tree, load
  checkpoints at every level, and key discovered ownership by both runtime id and
  canonical workspace; inspect both source and target trees for orphan collisions.
- **Caught:** Graph migration-tree REST/CLI previews initially supplied only states
  found in the root workspace.

## 326. Transport variants must preserve proven fields

Using one permissive DTO for generated drafts, durable decisions, and verified
evidence makes required lifecycle versions or cryptographic proof appear optional
at consumers that rely on them.

- **Do:** model draft and persisted variants separately, and narrow verified
  outputs so fields proven by validation are required in the public contract.
- **Caught:** the orchestration transport initially made durable proposal versions
  and verified artifact digests optional because drafts shared the same DTO.

## 327. Relative warning bands need a zero-target rule

A percentage band such as “within 10% of the limit” collapses when the limit is
zero. Applying the generic multiplication formula can classify the exact desired
zero observation as warning rather than success.

- **Do:** define zero-target equality explicitly before applying proportional
  warning bands.
- **Caught:** an orchestration SLO with `maxFailureRate: 0` initially reported an
  observed zero failure rate as `at_risk`.

## 328. Child ownership changes recovery and accounting

Persisting a parent id is insufficient if generic recovery can still run the child
independently, or if reports exclude it after the parent checkpoint disappears.

- **Do:** require the parent orchestration path for child resume, exclude children
  from generic recovery and direct deletion, and deduplicate usage only when the
  owning parent is present in the same accounting scope. Guarded terminal
  retention may still remove expired child records.
- **Caught:** Graph-owned Loops could initially be resumed directly, while an
  orphaned child remained excluded from portfolio totals.

## 329. Validate before ranking or truncation

Retention selection is not an input-validation boundary. If invalid low-ranked
items are truncated first, a malformed generated batch can appear valid and hide
an upstream invariant violation.

- **Do:** validate the complete dense batch before deduplication, ranking, lease
  acquisition, or persistence; only then apply retention policy.
- **Caught:** orchestration proposal recording initially validated only the top
  128 selected drafts.

## 330. Busy state must use the same operation owner end to end

Adjacent async features often have similarly named loading flags. Setting one
owner's flag and clearing another's leaves the UI permanently busy and can disable
unrelated controls.

- **Do:** pair each operation's set/clear paths with the same coordinator and
  state owner, including stale-result cleanup and workspace changes.
- **Caught:** the Desktop orchestration refresh and DAG inspection paths briefly
  crossed their `resourceBusy` and `orchestrationBusy` setters.

## 331. Multi-checkpoint activation needs one visible commit point

Writing related child and root checkpoints independently can expose a mixed
generation after a crash even when every individual file write is atomic.

- **Do:** lease participants in canonical order, persist prepared state plus a
  recovery journal, commit inaccessible children first, and activate the root
  last; recovery must deterministically roll forward.
- **Caught:** coordinated Engineering Graph tree migration initially had only a
  preview and could not safely apply subgraph-invalidating changes.

## 332. Approval version and deployment version are separate boundaries

Treating approval as execution allows stale evidence to mutate a newer runtime
generation and provides no recoverable state between effect and record commit.

- **Do:** bind deployment to the exact proposal version and source fingerprint,
  persist `applying` before the effect, detect an already-committed target during
  retry, and retain exact rollback evidence.
- **Caught:** orchestration recommendations originally stopped at approval and
  lacked a safe apply/observe/rollback lifecycle.

## 333. Content-address metadata is not blob authority

A recorded digest can refer to a replaced file, a symlink, or bytes that were
never placed in immutable storage.

- **Do:** reopen physical files with no-follow semantics, stream and verify size
  plus digest, copy into lease-coordinated CAS, re-hash before atomic
  materialization, and scope public restore to an authoritative reuse candidate.
- **Caught:** Graph artifact reuse initially returned metadata-only plans.

## 334. Capacity reservations must release on invalid returns too

Validation performed after a remote reservation is already an effect. Rejecting
malformed metadata without cleanup leaks executor capacity.

- **Do:** if a callable release hook is present, invoke it best-effort on every
  path, including validation rejection, cancellation, handler failure, and
  success; pass a bounded fencing token to the exact attempt.
- **Caught:** Graph remote reservation validation initially threw before release.

## 335. A page is not a global evaluation window

Aggregating only visible page details while labeling the result workspace-wide
can report a healthy SLO even when omitted records breach it.

- **Do:** label page-derived summaries explicitly, keep full portfolio totals
  separate, and use a materialized all-checkpoint index for bounded global
  summaries.
- **Caught:** the orchestration report's new error-budget summary initially had
  no scope marker.

## 336. Bounded indexes must fingerprint omitted records

Hashing only retained summary items means a change beyond the display cap does
not advance the cache generation.

- **Do:** validate and fingerprint the full authoritative source set, compute
  totals before truncation, then retain only the bounded display projection.
- **Caught:** the orchestration materialized index initially derived its
  generation from only the newest 512 items.

## 337. Reference-aware GC still needs a publication barrier

A producer can commit a CAS blob shortly before publishing the checkpoint that
references it. GC between those effects sees a valid but apparently orphaned
blob and can delete it.

- **Do:** coordinate CAS writers and collectors, refresh the publication age
  when a verified blob is reused, and never collect unreferenced blobs inside a
  bounded publication grace interval, even to satisfy quota.
- **Caught:** Graph artifact GC initially trusted only the current checkpoint
  reference scan, leaving a store-to-state publication race.

## 338. Partial multi-lease acquisition must unwind

Canonical acquisition order prevents deadlock but does not prevent a later
participant from being busy after earlier leases were acquired.

- **Do:** acquire iteratively, release every earlier lease in reverse order when
  any acquisition fails, and cover the partial-acquisition path with a busy
  participant test.
- **Caught:** Graph tree migration originally built the lease array with `map`,
  leaking earlier participant leases when a later acquisition threw.

## 339. State-directory caps must follow ownership filtering

Applying a list cap before classifying filenames lets journals, controls, or
attacker-created auxiliary files crowd authoritative records out of discovery.

- **Do:** validate the exact owner filename grammar before truncation, and make
  explicit deletion remove that owner's bounded journals and prepared files too.
- **Caught:** Graph state enumeration counted every `.json` file toward its cap,
  and Graph deletion left tree-transaction artifacts behind.

## 340. Replacement safety requires validation before rename

Validating a newly materialized file only after atomically replacing the target
can destroy a valid older target when the new bytes are corrupt.

- **Do:** fsync and hash the exact sibling temporary file first, then rename its
  already-validated inode over the target and fsync the parent directory.
- **Caught:** CAS materialization originally removed the replaced target when its
  post-rename verification failed.

## 341. Approval belongs to exact proposal content

An identifier can remain stable while its rationale, evidence, risk, or action
changes. Carrying approval across that refresh authorizes content nobody reviewed.

- **Do:** preserve an approval only when the complete generated draft is equal;
  any changed field advances the version and resets the decision to `proposed`.
- **Caught:** proposal refresh originally copied the previous status regardless
  of whether the draft changed.

## 342. Deployment serialization needs the mutation target

Leasing only by proposal id allows two distinct proposals to mutate the same
Loop route or Graph concurrently, and an older rollback can erase newer work.

- **Do:** serialize apply and rollback by a bounded hash of scope plus source,
  reject conflicting active target deployments, and verify the currently applied
  route or Graph fingerprint before rollback.
- **Caught:** orchestration deployment originally coordinated retries for one
  proposal but not competing proposals for the same source.

## 343. Runtime and advisory eligibility need one owner

If preflight and optimization classify executors separately, malformed load
metadata can produce non-finite rankings while runtime accepts an unhealthy or
fully occupied executor.

- **Do:** share one fail-closed eligibility classifier covering contract shape,
  trust, protocol, cancellation, health, capacity, queue, and locality metadata.
- **Caught:** Graph preflight and placement reporting implemented overlapping but
  different executor checks.

## 344. Duration limits and deadlines are different events

`maxDurationMs` limits cumulative active runtime; a node deadline limits when
that node may start. Reporting both as deadline breaches makes forecasts lie
about the violated contract.

- **Do:** calculate and expose separate duration-budget and node/wait-deadline
  probabilities from the same simulated schedule.
- **Caught:** Monte Carlo Graph forecasts originally incremented
  `deadlineBreachProbability` when active duration exceeded `maxDurationMs`.

## 345. A journal read before locking is only a hint

Another owner can finish or replace a transaction between journal discovery and
participant lease acquisition. Acting on that stale object can overwrite a newer
prepared transaction.

- **Do:** after acquiring every participant lease, reread and compare the exact
  journal generation; before preparing a new transaction, reject any unresolved
  journal that appeared during planning.
- **Caught:** Graph tree recovery originally committed the journal object read
  before lease acquisition without revalidating its transaction id and content.

## 346. Authorization candidates must survive until the effect

An exact-generation artifact candidate checked before locking can become stale
when the Graph advances before materialization starts.

- **Do:** acquire the authoritative Graph lease, reload its checkpoint and run
  snapshots, recompute candidate membership, and only then acquire the CAS lease
  through the materialization owner.
- **Caught:** the Graph artifact REST route originally checked candidate scope
  before entering any coordination boundary.

## 347. Effect completion and lifecycle recording can fail separately

An atomic target mutation can succeed while the following deployment-record
write fails. Treating the retry as a fresh mutation either duplicates the effect
or rejects the now-changed source.

- **Do:** persist intent first, recognize both applied and restored target
  fingerprints/routes on retry, and make multi-step route restoration one atomic
  owner write.
- **Caught:** Graph apply and Graph/Loop rollback originally had no recovery path
  when their target committed but the deployment status did not.

## 348. Durable lifecycle parsers must enforce cross-field states

Validating each deployment field independently still accepts impossible records,
such as `applied` without a target fingerprint or `failed` without an error.

- **Do:** validate status-specific required and forbidden fields, timestamp
  ordering, scope/action compatibility, and rollback evidence provenance as one
  invariant.
- **Caught:** the first deployment parser checked field shapes but not lifecycle
  combinations.

## 349. Shared command options still need operation scoping

A command with an operation argument and shared option parser can accept flags
that are syntactically valid but meaningless for the selected operation.

- **Do:** validate the final operation/id/option combination before dispatch and
  reject ignored mutation, concurrency, or pruning flags.
- **Caught:** orchestration `show`/`list` and artifact-store `inspect` initially
  accepted options that only their sibling mutation operations used.

## 350. A bounded discovery list is not an exhaustive safety scan

State listing may intentionally cap display or recovery work, but reuse GC,
retention, and workspace totals cannot silently omit valid owner files beyond
that cap.

- **Do:** filter exact owner names before a deterministic display cap, and offer
  a fail-closed complete-scan mode for deletion, GC, retention, and global
  aggregation owners.
- **Caught:** Graph artifact GC originally reused the 256-item UI listing and
  could classify blobs referenced only by an omitted checkpoint as unreferenced.

## 351. Workspace state topology can cross directory boundaries

Listing only the root `.seekforge/graphs` directory misses reachable child Graph
checkpoints whose nodes resolve to another physical workspace, so portfolio and
index totals become incomplete.

- **Do:** start from complete direct roots, traverse each validated definition
  through the shared physical workspace resolver, merge exact runtime identities,
  and reject conflicts or an excessive total tree.
- **Caught:** the materialized orchestration index initially used only direct
  root-directory Graph state discovery.

## 352. Read-compute-write observation needs the same lifecycle lease as mutation

An observer that reads an active record, computes metrics, and later writes the
record can overwrite a rollback or recovery completed in between.

- **Do:** hold the deployment identity lease across observation, re-read after
  acquiring the target lease, and invoke rollback through the already-locked
  internal owner.
- **Caught:** orchestration deployment observation initially protected only its
  final file write, not the lifecycle transition it was based on.

## 353. A definition fingerprint is not a checkpoint generation

Execution progress can advance while a Graph definition fingerprint remains
unchanged. A prepared tree transaction that compares only definition identity
can therefore overwrite newer results during crash recovery.

- **Do:** bind both source and prepared participants to a complete validated
  checkpoint hash, require canonical physical workspace identities, and reject
  recovery when either exact generation changed.
- **Caught:** Graph tree migration journals initially recorded participant
  definition fingerprints but not their full checkpoint generations.

## 354. Cross-workspace discovery must retain the owner identity

Returning only a child checkpoint after resolving it from another physical
workspace loses the location needed for its history, scheduling evidence, run
snapshots, and content-addressed artifacts.

- **Do:** carry the canonical physical workspace together with every discovered
  state until all owner-specific reads finish; do not emit standalone mutation
  proposals for nested checkpoints that require a root tree transaction.
- **Caught:** the workspace orchestration report found external child Graphs but
  initially read their auxiliary data from the root workspace.

## 355. Intent recovery must precede proposal supersession

A proposal's evidence can refresh after a deployment effect commits but before
its `applying` record advances. Superseding by the new proposal version first
loses the only durable recovery and rollback lineage for the live target.

- **Do:** reconcile an `applying` record from its own persisted action and exact
  target before comparing proposal versions; if recovered, require rollback
  before a newer version can apply.
- **Caught:** orchestration observation initially classified version-lagged
  `applying` records as superseded without checking their committed target.

## 356. A rollback target fingerprint does not authenticate rollback material

A source generation fingerprint proves which Graph was changed, but it does not
prove that a separately persisted rollback definition still contains the exact
source content.

- **Do:** hash the validated rollback definition, persist that hash in the
  deployment intent before applying effects, and verify it during both crash
  reconciliation and rollback.
- **Caught:** Graph deployment rollback initially trusted any valid definition
  found at the expected rollback path.

## 357. Durable capacity checks belong before transaction preparation

A participant count or byte cap enforced only while reading recovery state can
allow the writer to create a prepared checkpoint or journal that its recovery
path will always reject.

- **Do:** build and validate every prepared payload and journal in memory,
  enforce the same participant and byte bounds, persist a `preparing` intent
  before any participant file, and let recovery clean an incomplete preparation.
- **Caught:** Graph tree migration initially bounded journal recovery but not the
  corresponding preparation writes.

## 358. A definition generation is not an evidence generation

A Graph can advance status, results, usage, and control state without changing
its definition fingerprint. A proposal bound only to that fingerprint can apply
evidence from an earlier checkpoint to later execution state.

- **Do:** bind decision identity and apply-time revalidation to a canonical hash
  of the complete validated checkpoint; retain the definition fingerprint as
  separate rollback metadata.
- **Caught:** Graph optimization proposals initially used the definition and
  workspace fingerprint as their claimed exact source generation.

## 359. Rollback safety needs the exact post-effect checkpoint

Checking only the deployed definition cannot tell whether the Graph later
resumed, accumulated results, or changed control state under that same
definition.

- **Do:** record a canonical hash of the complete post-migration checkpoint,
  recover only the quiescent checkpoint proven by the migration journal, and
  require that hash before rollback.
- **Caught:** Graph deployment rollback initially compared only its target
  definition fingerprint.

## 360. Creating derived history must preserve checkpoint fallback events

A read path may fall back to checkpoint events only while its append-only log is
empty. Writing the first migration event without backfilling earlier checkpoint
events makes valid lifecycle history disappear from the public view.

- **Do:** under the Graph lease, append every retained checkpoint event newer
  than the log tail in sequence order, both during normal commit and recovery.
- **Caught:** the first deployment-driven Graph migration made the earlier
  `graph.completed` event disappear from REST history.

## 361. Applying reconciliation has three states, not two

After a crash, a target can equal the exact source, equal the exact committed
effect, or be a third generation changed by another lifecycle. Treating every
non-target state as “not applied” can overwrite or supersede live work.

- **Do:** classify exact source as retryable, exact target as recoverable, and
  every other generation as diverged; preserve diverged intent and require
  manual recovery.
- **Caught:** orchestration apply retry initially treated an advanced
  same-definition Graph as if its deployment effect had never committed.

## 362. Persisted policy lookup belongs after pure option validation

A durable policy read can influence provider selection, but performing it before
validating the caller's explicit options makes malformed requests inspect
workspace state and can change which error wins.

- **Do:** validate explicit request shape first, then load the exact scoped
  policy, merge it with documented precedence, and only then initialize the
  providers selected by the combined configuration.
- **Caught:** Auto-Loop initially loaded an applied route before validating its
  task, verification, recovery, and routing options.

## 363. Atomic rename is not atomic no-clobber

Checking that a target is absent and then renaming a temporary file leaves a
window where an unrelated writer can create the target and be silently
overwritten on POSIX.

- **Do:** when overwrite is disabled, publish with an atomic same-filesystem
  hard-link operation that fails with `EEXIST`; reserve rename replacement for
  explicit overwrite requests.
- **Caught:** CAS materialization initially used an existence check followed by
  `rename`, despite exposing no-overwrite as its default contract.

## 364. Observation and verdict form one persisted state

Validating an observation and a verdict independently permits impossible
records such as a terminal observation with `pending`, or an unobserved
deployment marked `improved`.

- **Do:** validate the pair by lifecycle state: unobserved or non-terminal
  applied records are pending, terminal observations have a terminal verdict,
  and rolled-back records retain only stable/regressed outcomes.
- **Caught:** orchestration deployment decoding initially accepted every valid
  metric and verdict combination independently.

## 365. A no-op transaction still owes a complete result

Skipping mutation because the root definition is unchanged does not justify
returning a plan built from only the root when the public result describes the
whole reachable tree.

- **Do:** take the same complete ownership-aware snapshot used by changing
  transactions before constructing a no-op result; skip only leases and writes.
- **Caught:** an idempotent Graph tree migration initially reported existing
  child checkpoints as missing.

## 366. “Exact generation” hashes cannot redact durable evidence

Replacing evidence fields with placeholders before hashing makes two distinct
persisted checkpoints share a decision generation, even if timestamps normally
advance with writes.

- **Do:** hash the complete validated durable value with canonical key ordering;
  a digest does not need to retain or expose the underlying evidence text.
- **Caught:** the Loop orchestration fingerprint initially blanked verifier
  commands and output tails before claiming to identify the exact generation.

## 367. A materialized refresh lease must cover its source scan

If two refreshers compute outside the publication lease, the older snapshot can
wait behind the newer writer and then overwrite it after the lease is released.

- **Do:** serialize source enumeration, aggregation, and publication under one
  refresh owner; include every loaded generation in the materialized digest.
- **Caught:** orchestration index refresh initially acquired its lease only for
  the final file write.

## 368. Policy keys must use the consumer's closed taxonomy

A generic safe identifier can be structurally harmless while still being an
impossible routing category. Persisting it and merging after explicit option
validation bypasses the runtime's closed union.

- **Do:** validate durable policy keys with the same domain predicate used by
  proposals and runtime routing, not a broader path/id regex.
- **Caught:** applied Loop routes initially accepted any safe identifier as a
  failure category.

## 369. A CAS digest does not authorize an external source path

Matching caller-supplied bytes to a digest proves content integrity, not that
the caller was allowed to read the file into a workspace-scoped artifact store.

- **Do:** resolve the source to a non-symlink physical path beneath the exact
  workspace before opening and hashing it; keep digest/size verification as a
  separate invariant.
- **Caught:** the public Graph CAS store primitive initially accepted any
  readable host file as a source.

## 370. Exact Loop generation checks need the Loop lifecycle owner

A separate deployment-target lease serializes deployments with each other, but
it does not stop the running Loop from checkpointing between source validation
and policy activation.

- **Do:** acquire the Loop's authoritative lifecycle lease around baseline
  capture, exact-generation revalidation, apply, and rollback; retain the target
  lease to serialize distinct proposals.
- **Caught:** Loop route deployment initially used only its orchestration target
  lease, unlike Graph deployment which also entered the Graph migration owner.

## 371. Idempotent checkpoint recovery must also repair derived history

A transaction participant may already match its committed target because the
process crashed after publishing the checkpoint but before appending its history.
Treating that participant as a complete no-op leaves the authoritative checkpoint
and its derived audit trail inconsistent.

- **Do:** when recovery recognizes the exact target generation, idempotently repair
  every derived history/index effect before advancing the transaction.
- **Caught:** Graph tree recovery skipped history repair for a child checkpoint
  already committed at the injected crash boundary.

## 372. Text classifiers need lexical boundaries around every alternative

A bounded alternative beside an unbounded phrase does not protect the whole
regular expression. For example, `go test` can match the tail of `cargo test`
and misclassify a Rust workspace as mixed-language.

- **Do:** put every toolchain keyword inside one explicit word-boundary group
  and test overlapping suffixes and prefixes.
- **Caught:** contextual Loop routing initially classified `cargo test` as both
  Rust and Go.

## 373. One capacity decision must use one persisted snapshot

Re-reading a reservation document during one lease-held decision adds needless
I/O and, for stores whose locks are not the read owner, can compare values from
different generations.

- **Do:** read once after acquiring the owner, derive active/expired entries
  from that immutable snapshot, and publish one replacement.
- **Caught:** workspace Graph executor capacity initially re-read its document
  while deciding whether expired entries required publication.

## 374. Bounded history eviction must preserve active lifecycles

A newest-first slice treats terminal audit records and active state machines as
equivalent. Enough recent completed records can evict a still-running rollout,
making its deployed effect unmanageable.

- **Do:** retain every active lifecycle first, reject impossible active overflow,
  then fill the remaining bound with terminal history.
- **Caught:** orchestration rollout retention initially sliced shadow, canary,
  and terminal records together.

## 375. Cross-tree joins need the complete generation identity

A logical ID alone may be reused in another physical workspace or generation.
Joining an optimization report to a checkpoint by ID can therefore attach an
actual outcome to the wrong prediction.

- **Do:** join durable graph evidence on graph ID plus exact fingerprint (and
  physical owner whenever it is available).
- **Caught:** orchestration forecast maintenance initially indexed discovered
  Graph states only by graph ID.

## 376. Dependent options must be validated before effects start

An option can be valid in isolation but meaningless or unsafe without its
enabling option. Discovering that dependency only when a background scheduler
is constructed may leave earlier services and timers running.

- **Do:** validate option implications and timer ranges at the public entry
  point before registries, servers, or schedulers are created.
- **Caught:** idle orchestration auto-rollback initially did not require idle
  orchestration maintenance during server preflight.

## 377. Provenance deduplication keys must include every distinct origin

A content digest identifies bytes, not the path or producer claim that created
them. Two outputs may intentionally contain identical bytes while carrying
different lineage.

- **Do:** include the exact generation, producer, source path, and digest in an
  attestation identity; use the digest alone only for blob storage.
- **Caught:** Graph artifact attestations initially collapsed two same-content
  paths from one producer into one record.

## 378. Observation identities must include the lifecycle generation and attempt

An action can be retried, or a proposal can be revised without changing its
logical ID or final metric values. Deduplicating only on the ID and outcome then
silently drops a real control-plane sample.

- **Do:** include the exact proposal revision and deployment attempt in durable
  observation identities; include the run generation for execution forecasts.
- **Caught:** deployment evidence initially collapsed identical outcomes from
  distinct attempts, while Graph forecasts initially collapsed reruns.

## 379. Capacity reporting and enforcement must read the same owner state

An adapter-local active counter cannot describe reservations held by other
processes. Reporting it while enforcement uses a workspace reservation store
produces contradictory availability and rollout decisions.

- **Do:** derive workspace-capacity telemetry from the same durable reservation
  snapshot used by admission control, while retaining adapter-local counters for
  adapters without a workspace limit.
- **Caught:** the first executor-capacity report ignored cross-process Graph
  reservations.

## 380. Derived lifecycles must reconcile authoritative manual transitions

An automation record may say promoted while the underlying deployment has been
manually rolled back through another surface. Treating terminal automation state
as immutable leaves management views stale.

- **Do:** reconcile derived rollout state against authoritative deployment
  transitions, including transitions initiated outside the rollout surface.
- **Caught:** promoted rollouts initially remained promoted after direct rollback.

## 381. Learned advice must stay optional and cover generated identities

Historical routing may name a provider that has since been removed, and a new
run may not have a caller-supplied ID yet. Neither condition should disable or
break workspace learning.

- **Do:** select advice for every persistent generated or explicit run, probe
  advisory providers safely, and fall back without weakening explicit policies.
- **Caught:** contextual Loop routing initially required an explicit Loop ID and
  could make retired historical providers a run prerequisite.

## 382. Per-key capacity bounds do not bound the shared collection

Several executors can each remain below their own limit while their combined
reservations overflow the durable document's maximum.

- **Do:** enforce both the per-executor capacity and the total store admission
  bound before appending; keep public capacity maxima compatible with that bound.
- **Caught:** Graph workspace reservations allowed multiple executors to publish
  more entries than their parser would later accept.

## 383. Derived telemetry must retain its physical owner

Nested Graphs can persist artifacts and reservations in external or managed
workspaces. Aggregating only the root store either drops their evidence or
attributes same-content evidence from another workspace to them.

- **Do:** read every discovered physical owner once and key derived joins by
  owner plus the domain identity.
- **Caught:** orchestration artifact-attestation counts initially read only the
  root workspace and joined solely by digest.

## 384. Idempotent evidence must preserve its original timestamp

Re-recording the same claim during retry is not a new observation. Replacing it
with a fresh timestamp mutates audit history and can postpone bounded eviction.

- **Do:** return the existing exact-identity record unchanged; create a new
  record only when the complete provenance identity differs.
- **Caught:** repeated Graph artifact attestation refreshed `createdAt`.

## 385. Temporal analytics must exclude future and identity-less samples

Clock-skewed future records contaminate a current calibration window, while a
legacy execution without a run generation cannot be safely deduplicated.

- **Do:** bound every current-window metric at `now` and skip legacy samples
  that lack the identity required by the observation key.
- **Caught:** forecast calibration admitted future timestamps and maintenance
  failed on old Graph checkpoints with an empty control-run ID.

## 386. Bounded lifecycle stores need byte-aware terminal eviction

A record-count limit is insufficient when terminal errors carry bounded but
variable-size text. A valid near-full file can otherwise reject every later
transition.

- **Do:** preserve all active records, then evict the oldest terminal records
  until both count and serialized-byte bounds hold.
- **Caught:** rollout persistence enforced bytes only after its count-based slice.

## 387. Expiring capacity leases must fence late results

Releasing a lease in `finally` does not protect a long-running remote operation
after its lease expires. A replacement owner may start while the old result is
still accepted.

- **Do:** renew well before expiry on a timer independent from optional remote
  heartbeats, bind renewal to the exact fencing token, and
  cancel/reject the attempt when renewal loses that generation.
- **Caught:** workspace-wide Graph executor reservations expired during a long
  remote node without preventing its late result from committing.

## 388. Staged rollout evidence must be cohort-local and single-use

Reusing one observation after moving to a larger cohort turns repeated polling
into fake independent evidence and can promote without new executions.

- **Do:** retain a global deduplication set and a separate current-stage sample
  set; clear only the stage set on transition or manual resume.
- **Caught:** a single exact-generation canary observation could otherwise be
  counted again at the next rollout percentage.

## 389. A zero retention allowance is not a negative slice

JavaScript treats `slice(-0)` as `slice(0)`, so code that means “retain no
terminal entries” can accidentally retain the complete collection exactly when
protected records fill the limit.

- **Do:** branch explicitly when the remaining slot count is zero before using
  a negative tail slice, and test the exact full-window boundary.
- **Caught:** Graph preflight decision retention kept every terminal decision
  when unfinished preflights occupied all 512 protected slots.

## 390. Transition audits must bind the evaluated snapshot

A staged transition commonly clears the evidence window for the next cohort.
Logging the resulting state instead of the state that passed the gate produces
an audit record with no evidence for the decision it claims.

- **Do:** commit the authoritative transition first, but build its observational
  decision record from the immutable pre-transition evidence snapshot.
- **Caught:** 5% and 25% rollout gate decisions initially fingerprinted the
  newly cleared next-stage observation window.

## 391. Dynamic safety state must be sampled at every advertised boundary

Capturing a controller's startup state turns a temporary freeze into a
run-lifetime policy even when the scheduler claims to reconcile at safe
boundaries.

- **Do:** cache immutable history and configuration, but re-read mutable safety
  state at every boundary where it can change behavior in either direction.
- **Caught:** a Graph started while the adaptive controller was frozen could not
  resume learned scheduling after the controller recovered during that run.

## 392. Execution-slice limits are not task-terminal limits

A bounded provider/tool slice may end while the user's task still has valid
progress and budget. Turning that boundary into a failed session strands large
interactive tasks; starting a second run invents a user turn and drops run-local
state.

- **Do:** continue only through an explicit finite slice budget, inside the same
  run, lease, context, usage counters, and cancellation scope; keep harness
  guidance out of the durable user-turn trace and emit a non-terminal progress
  event.
- **Caught:** Desktop chat treated the 50-turn inner loop cap as a terminal
  `max_turns_exceeded` for the whole user task.

## 393. Bootstrap filesystem roots are not user projects

A desktop shell may need a safe cwd before the user chooses a project. If that
operational directory enters normal workspace selection or idle maintenance, it
becomes a surprising editable project and can accumulate domain state.

- **Do:** tag bootstrap roots at the server boundary, exclude them from project
  UI and project maintenance targets, and keep their default-workspace role only
  for backward-compatible server routing.
- **Caught:** removing the startup folder dialog otherwise required exposing an
  app-data directory as Desktop's active workspace.

## 394. Retaining rollback state is part of the atomic upgrade

Replacing the active directory first and only then rotating its prior rollback
can report failure after the new version is already live, leaving state and
filesystem truth inconsistent.

- **Do:** move the previous rollback aside before the active swap, restore both
  active and rollback generations on every failed rename, and retire the older
  copy only after the complete swap succeeds.
- **Caught:** plugin force-update originally installed the new digest before a
  rollback-directory rotation failure could be reported.

## 395. Registry records are not their nested domain payloads

A listing endpoint often returns lifecycle metadata around the object accepted
by a domain operation. Passing that wrapper onward can typecheck as `unknown`
but fail semantic validation later; duplicate wrapper identities can also
collide in keyed UI collections.

- **Do:** decode the wrapper once, retain identity and lifecycle state, reject
  duplicate identities, and pass the explicitly named nested payload. Test the
  real listing response shape.
- **Caught:** the Desktop Graph template selector treated
  `{template, registeredAt, deprecatedAt?}` as the template itself.

## 396. Reference-safe edits must enumerate every contract-bearing field

A dependency can be represented outside the obvious dependency array. Protecting
only direct edges lets an editor remove a value still referenced by a condition,
binding, route, compensation target, or another domain-specific field.

- **Do:** derive the complete reference inventory from the authoritative
  contract, keep nested scopes separate, and test every reference-bearing
  variant before allowing dependency removal or node deletion.
- **Caught:** Desktop Graph editing initially omitted router `routes[].when`
  conditions from its reference guard.

## 397. Debounced persistence must flush or cancel deliberately

A debounce timer is part of the persistence lifecycle. Clearing it during
navigation or unmount without first settling its captured value loses the most
recent edit exactly when the user leaves the surface.

- **Do:** retain the bounded pending payload with its exact owner identity;
  flush it at normal lifecycle boundaries, explicitly cancel it for reset, and
  isolate quota or unavailable-storage failures from the live editor.
- **Caught:** workspace-local Desktop Graph draft autosave initially cancelled
  the newest 300 ms window during workspace changes and unmount.

## 398. Apply must consume the exact preview controls and owner

A dry-run result describes one control snapshot even when authoritative state is
recomputed at apply time. Re-reading mutable controls can execute a policy the
user never reviewed; a late result can also cross resource boundaries when the
surface is reused.

- **Do:** retain the validated options beside the preview, invalidate the preview
  on any input edit, capture the resource generation, and guard success, error,
  side-effect follow-up, and busy cleanup.
- **Caught:** Desktop memory compaction previewed one prune threshold but applied
  the current field value, with callbacks not bound to a workspace generation.

## 399. Code shipped to another runtime cannot rely on the build transform

A function handed to a different runtime — a browser page, a worker, a database
— travels as source. Whatever the local build inserted into it (name-keeping
wrappers, coverage counters, helper prologues) travels too, and refers to
helpers that do not exist there. This breaks per build tool, so it can pass in
one entry point and fail in another.

- **Do:** write such a function without constructs the transform rewrites (no
  named inner function bindings), state that constraint next to it, and cover it
  with a smoke test that runs through the same transform the users hit.
- **Caught:** browser_snapshot's page-side extraction used named inner helpers;
  under esbuild keepNames (which tsx enables, so every run from source) they
  became `__name(...)` calls and the tool failed with "__name is not defined".

## 400. A schema wrapper the converter does not know advertises nothing

A validator that wraps its subject — a refinement, a transform, a branded type —
is a different node than the object it validates. A converter that falls through
to a permissive default for unknown nodes silently emits an EMPTY schema, and
the model is told the tool takes no parameters at all. Validation still passes
locally, so nothing fails until a caller gets it wrong.

- **Do:** unwrap wrapper nodes to their inner type, and assert the advertised
  parameter set for every tool rather than only for the plain ones.
- **Caught:** zodToJsonSchema returned `{}` for two `.refine()`d tool schemas;
  the description lint skipped them precisely because they looked parameterless.

## 401. A new step before the gate inherits the gate's guarantees

When a pipeline's decision point moves, everything now in front of it silently
gains the privileges the decision was there to withhold. A step added "just to
describe the work" still runs for a caller the policy refuses — and describing
the work can mean I/O, a subprocess, or a paid call.

- **Do:** split the refusals that need no input from anyone out of the gate and
  apply them before the new step, keeping one implementation for both callers;
  assert per refusal reason that the step did not run.
- **Caught:** the tool dispatcher's async `prepare` (added so a rename can show
  its diff) ran before permission enforcement, so a tool excluded by
  `allowedTools`, blocked by a deny rule, or forbidden in ask mode still issued
  its language-server request.

## 402. Compare paths in one resolved form or reject the ordinary case

A path that arrives from another process is resolved; a path held locally often
is not. Comparing the two decides containment on a spelling difference — and on
macOS the workspace is routinely reached through a symlink, so the common case
is the failing one. It fails closed, which is why it reads as a security check
working rather than a feature that never worked.

- **Do:** resolve both sides before comparing (falling back to the parent for a
  path that does not exist yet, so "missing" is not reported as "outside"), and
  keep the authoritative sandbox check where it was.
- **Caught:** `lsp_rename` compared the language server's resolved uris against
  the raw workspace path; under any symlinked workspace (`/var` → `/private/var`
  on every macOS temp dir) every legitimate rename was refused as
  `outside_workspace`. The tests missed it because the stub server echoed back
  the unresolved paths the test itself supplied.

## 403. "Could not read it" is not "it does not exist"

A reader that answers `null` for both a missing value and an unavailable one
lets every consumer treat unavailability as absence. In a diff that means an
overwrite renders as a creation: all additions, no deletions, and a reviewer who
approves believing nothing is being replaced.

- **Do:** keep the two outcomes distinguishable at the boundary, and have the
  consumer refuse to render rather than render from the ambiguous value.
- **Caught:** the write-tool preview returned `null` for a runtime-backed
  session (whose files need an async read) exactly as it did for a new file, so
  every `write_file` in a Rust-runtime or Docker session was reviewed as a brand
  new file. The async read now happens in `prepare`; the sync path renders
  nothing when it cannot read.

## 404. A conditional spread is where an optional field goes to die

`...(x ? { key: x } : {})` is the house idiom for "add this only when set", and
it is also the one place TypeScript's excess-property check does not look. Spread
a key the destination type does not declare and it is silently dropped: the
feature is wired end to end, compiles, and does nothing.

- **Do:** assert the passthrough for every option that travels this way, in the
  contract test that already exists for that entry point. Types cannot cover it,
  so a test must.
- **Caught:** the session usage bus was spread into the TUI's runSession
  options, which did not declare it — an MCP server's sampling would have gone
  uncounted in exactly the surface the feature was being added for.

## 405. A replace that matched nothing looks exactly like one that worked

Rewriting a file by string replacement succeeds silently when the pattern does
not match: the script exits 0, the file is written, and the change is simply
absent. In prose this ships a document that contradicts itself — the surrounding
paragraph was updated, the table it describes was not.

- **Do:** assert the pattern is present before replacing, every time, and check
  the result (a count, a grep) rather than the exit code.
- **Caught:** the LSP tool table kept listing three tools while the sentence
  under it said "four of the five"; the edit that was meant to add the rows had
  quietly matched nothing, and no gate covers a tool table.

## 406. A default price may only stand in for its own vendor

An unknown model id falling back to a default model's rates is a reasonable
estimate within one vendor and a fabrication across vendors, where list prices
differ by more than an order of magnitude. The report reads the same either way.

- **Do:** scope a fallback default to the family it belongs to, and report
  "unknown" outside it rather than a number nothing supports.
- **Caught:** `packages/core/src/provider/cost.ts` — adding a second vendor's
  models made every unpriced Claude id inherit DeepSeek's rate, understating
  cost roughly thirtyfold while `pricingSourceFor` still called it a "fallback".

## 407. A field named like a total may be a remainder

Two protocols can spell the same quantity with the same word and mean different
things. Anthropic's `input_tokens` is the part of the prompt that missed the
cache, not the prompt; the cached part is reported separately.

- **Do:** read each protocol's own definition of a usage field before mapping it
  onto an internal one, and reconstruct the internal quantity explicitly.
- **Caught:** `packages/core/src/provider/protocols/anthropic.ts` — mapping
  `input_tokens` straight to `promptTokens` would have understated every cached
  turn, and prompt caching is on by default.

## 408. A protocol may require echoing back data your model cannot hold

Some request shapes are only valid if the client returns opaque blocks the
server sent earlier — reasoning blocks with their signatures, for instance. An
internal message type that has no field for them cannot produce a valid request,
and the gap only appears on the second turn of a specific feature combination.

- **Do:** check, when adding a protocol, what a *replayed* turn must contain, not
  only what a fresh one must. State the limitation where the request is built
  when the internal type cannot carry it yet.
- **Open in** `packages/core/src/provider/protocols/anthropic.ts` — thinking
  blocks are not replayed with the tool results that answer them, because
  `ChatMessage` has nowhere to keep them; enabling thinking is opt-in with that
  caveat documented.

## 409. Rebuilding a record field-by-field drops whatever is added later

A transform that constructs its output by listing the fields it keeps is
complete only on the day it is written. The next field added to the type is
silently absent from every record that passes through, and nothing fails: the
type still checks, because every listed field is still there.

- **Do:** spread the input and override only what the function is actually
  about. Reserve an explicit field list for the case where dropping the unknown
  is the point (a trust boundary), and say so.
- **Caught:** `packages/core/src/provider/tool-pairing.ts` rebuilt each message
  from role/content/toolCallId/toolCalls, so the images and reasoning blocks a
  turn later gained never reached the request — a screenshot silently became a
  screenshot the model could not see.

## 410. A "copy-pasteable" rendering must be quoted for the shell that will paste it

A dry-run prints a command so a human can inspect and paste it. Quoting that
line the way a string literal is quoted looks correct and is not: double quotes
stop word splitting but not command substitution, so the backticks and `$(…)`
inside a task run the instant the line is pasted — from a feature whose entire
purpose was to let someone check the command before running it.

- **Do:** render with the quoting rules of the shell the output is destined for
  (single quotes, with embedded quotes escaped), not JSON's.
- **Caught:** `formatDockerCommand` and `formatSshCommand` both rendered the
  task with `JSON.stringify`, so `--check` on a task containing backticks
  printed a line that executed them when pasted.

## 411. A deadline that a heartbeat can extend needs its own ceiling

A flat request timeout kills a peer that is working correctly but slowly, so the
fix is to let its progress reports re-arm the clock. That fix, alone, hands the
peer an unbounded hold: a server that emits progress forever keeps the call —
and whatever is waiting on it — alive forever.

- **Do:** make the original timeout an IDLE timeout and add a separate total,
  which no amount of progress extends past. Both bounds, or neither.
- **Caught:** `packages/core/src/mcp/client.ts` and `mcp/http.ts` — a 30s flat
  timeout failed every MCP tool that legitimately took longer (a build, a
  migration), while the protocol's own progress notifications went unread.
- **Precedent:** the provider stream already had exactly this shape, with an
  idle timeout for a stalled stream and a total timeout independent of progress.

## 412. A grant is only durable if the layer you write it to is one the reader trusts

Persistence has two halves and it is easy to ship only the first. The write
succeeds, the UI says "saved", the file on disk contains exactly the right rule
— and the loader drops it every time, because the layer it landed in is one the
trust boundary deliberately downgrades. The user then has a permission they
believe they granted, cannot see failing, and will re-grant every session.

- **Do:** before persisting anything the policy will later read, check what the
  READER does to that layer. If the loader sanitizes it, writing there is not a
  weaker version of persistence — it is a lie with a file behind it.
- **Caught:** while adding "always allow" to the permission prompt. The obvious
  home for a project-specific approval is `.seekforge/config.json`, and
  `sanitizeProjectConfig` strips every `allow` rule from a repository layer —
  by design, since a repo must not grant itself permissions. The durable rule
  goes to `~/.seekforge/config.json` for that reason, and only there.
- **Related:** the same question applies in reverse to what you OFFER. Core
  omits `rememberRule` from the prompt whenever it will not grant the call
  durably, so a frontend cannot present a choice and then have to invent the
  rule behind it.

## 413. A rule a keystroke can create must be matched by the strictest matcher available

A matcher can be deliberately lenient because of who writes its input. URL allow
rules match by unanchored prefix so that one hand-typed docs-domain rule covers
its sub-paths — a good default for a line a person chose to write. Generate that
same rule from one value the model happened to pass, and the leniency is no
longer a convenience: the grant now covers every string that starts the same
way, in every project, forever.

- **Do:** when adding a one-keystroke way to create a policy entry, check the
  matcher each candidate subject gets — not the matcher in general. Offer only
  the subjects whose matching is anchored, and say why the others are missing.
- **Caught:** in review of `proposeDurableRule`. `web_fetch` classifies as
  `GET <url>`, so the first version offered a durable rule for it; `ruleMatches`
  compares non-shell commands with a bare `startsWith`, which would have made an
  approved `GET https://host/doc.md` also cover
  `https://host/doc.md.attacker.example/leak?secret=…`. Durable rules are now
  restricted to `run_command`/`task_kill`, whose matching is anchored on a
  token boundary.
- **Related:** [412] — that entry is about writing to a layer the reader
  discards; this one is about writing a rule the matcher reads too generously.

## 414. Arm a timer in the same block that clears it, or it fires into the next run

A one-shot CLI hides this: whatever the function returns, the process exits and
a stray timer never runs. The same function called twice in one process does
not hide it. A deadline armed near the top, cleared in a `finally` further down,
and skipped by any early return in between survives its own run — and then
fires, printing a stop message about a run that ended and aborting a controller
nobody is listening to, in the middle of the next one.

- **Do:** create the timer immediately before the `try` whose `finally` clears
  it, so the pairing is structural rather than a list of return paths someone
  has to keep in sync. If the work before that point also needs bounding, give
  it its own bounded step — do not stretch one timer over both.
- **Caught:** in review of `--max-duration`. `apps/cli/src/commands/run.ts`
  armed the deadline beside the cost budget, well above the `try`; five early
  returns (bad permission mode, bad output style, unreadable --mcp-config, a
  failed MCP spawn, a throwing agent construction) each left it running.
  `schedule run` calls `runTaskCommand` once per due job in one long-lived
  process, so the leftover timer had somebody else's run to land in.
- **Also:** starting the clock later turned out to be the more honest semantic
  anyway — the setup it used to cover can legitimately be waiting on a human to
  answer a prompt.

---

*Add an entry whenever a boundary defect is fixed: the pattern, the fix, and the
file — not just the one-off.*
