# Boundary-defect checklist

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

## 3. A cache / memo key must include every input that affects the output

If two different requests hash to the same key, the second silently gets the
first one's answer.

- **Do:** hash **all** output-affecting fields, not just the obvious ones.
- **Caught:** `packages/core/src/provider/cache.ts` — the key omitted
  `temperature` and `maxTokens`, so a follow-up call with a larger `maxTokens`
  replayed the earlier truncated reply.

## 4. Serialize and deserialize must be exact inverses

If the writer uses `JSON.stringify` but the reader only strips the outer quotes,
any value containing `"` or `\` is corrupted on a render→reload round-trip.

- **Do:** pair the encoder and decoder deliberately; when the writer JSON-encodes,
  the reader must `JSON.parse`. Add a round-trip test with a quote/backslash value.
- **Caught:** `packages/core/src/subagents/frontmatter.ts` vs `import.ts`.

## 5. Cursor / index math must be surrogate-pair & multibyte aware

Astral characters (emoji, CJK-ext) are two UTF-16 code units. A bare `cursor ± 1`
lands *between* the halves and corrupts the text on the next edit.

- **Do:** step by whole code points (`stepLeft`/`stepRight`/`moveLeft`/`moveRight`)
  and `snapToBoundary` any clamped position. Test with `"😀"`.
- **Caught:** `apps/tui/src/vim.ts` (insert-mode Escape, charwise `p`) — the
  helpers already existed in `editor.ts`; vim just bypassed them.

## 6. Every `addEventListener` needs a matching `removeEventListener`

`{ once: true }` only removes the listener *if it fires*. On the normal
settle/cleanup path it never fires, so a listener attached to a long-lived signal
leaks once per operation.

- **Do:** name the handler and `removeEventListener` it in a `finally` / settle
  callback (or use `AbortSignal.any`). Same for timers, streams, child processes.
- **Caught:** `packages/core/src/subagents/manager.ts` — abort listener on the
  shared parent `AbortSignal`.

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

## 9. "Read-only vs mutating" classification: check each command's real effect

Empty-args ≠ listing. Bare `git stash` is `git stash push` and mutates the working
tree; treating "no args = read-only" auto-ran it with no confirmation.

- **Do:** classify by the command's actual side effect, per subcommand. When in
  doubt, treat as mutating (require confirmation) — fail closed.
- **Caught:** `packages/core/src/tools/run-command.ts` (`classifyGit`).
- **Also caught:** `packages/core/src/tools/run-command.ts` (`classifyGh`) —
  `gh api --method=POST` / `-XPOST` and `--field=...` forms were not parsed as
  mutating, so they could be misclassified as read-only GET requests.

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

---

*Add an entry whenever a boundary defect is fixed: the pattern, the fix, and the
file — not just the one-off.*
