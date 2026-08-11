# Changelog

## Unreleased

### Baseline re-recorded on the commit it measures

68 tasks at three samples against `deepseek-v4-flash`: 203/204, $0.628,
$0.0031 and 105,310 tokens per success, 1.54% tool failures, no session errors.
Every suite gate passed, including all four baseline-comparison gates — cost per
success and tokens per success both moved down. The run still exits non-zero,
because a single failed sample is enough when `--fail-on-regression` is off.

`gitSha` is the commit above and the tree was clean at start, so unlike the
previous baseline the numbers need no paragraph reconciling the recorded sha
with the core that actually ran. The `datasetHash` is unchanged, so the two
baselines compare like for like.

The single failure moved tasks — `foreach-await-bug` went 3/3 and
`pagination-window-fix` went 2/3, its failing sample simply leaving the buggy
line in place. Two runs that each lose one sample in 204, on different tasks,
are the same measurement.

### What the review of the above found

An adversarial pass over the whole change set produced fourteen findings; the
ones that were defects rather than wording are fixed here.

**The TUI's tab total could not express its own history.** `/resume`, `/fork`
and the session picker all switch session through a `set-session` action, and
the `session.created` that follows carries the same id, so it short-circuits.
A single running carry then either drops the outgoing session's spend or, once
you come back to a session the carry already absorbed, bills its earlier turns
twice — and that total feeds `costBudgetUsd`. Usage is now keyed by session id
and the total is their sum, so re-entering a session overwrites its entry and
`set-session` has nothing to settle.

**Desktop lost a failed run's spend when a server sends no `sessionUsage`.**
Deleting the run slot left the fallback with nothing tracking the run in
flight. It now adds the run window to the session window as it stood when the
run began, which `session.created` records.

**A resumed Loop could be rejected by rules that did not exist when it was
written.** Extracting the verification-plan validator tightened two value-level
rules on the engine path — duplicate path prefixes, and non-boolean
`required`/`cacheable`/`parallel`. `runAutoLoop` validates
`resumeState.verificationPlan` with the same parser, so a checkpoint written by
an earlier build would throw on resume. Authored plans stay strict; a replayed
one is repaired the way the builder already repairs it.

**The LoopEvent gate read the wrong union.** It checked the 22-member mirror in
`@seekforge/shared`, not the union core actually emits — which is how
`loop.model.routed` came to be emitted, persisted into loop history and
rendered by the TUI while neither the Desktop history nor the VS Code report
handled it. The gate now reads core's union, and both surfaces render the
event.

**`trigger-run.ts` still compared the run window** against `maxCostUsd`, the
one guard of that shape the sweep missed. **Both READMEs named a command that
does not exist** — `seekforge export-graph` is `seekforge loop-dag
export-graph`. Two counts were wrong (22 flat `loop-*` commands, not 23 or 24;
five validator divergences, not four), `--max-total-tokens` was cited as a CLI
flag when it is an internal option only scheduled jobs set, and the entry-421
note still described the *old* failure direction. The table-integrity check
only looked below the first command row, so a paragraph spliced above it would
have gone unseen. And Desktop's maintenance tick — which records proposals,
reconciles rollouts and re-evaluates the controller freeze — was labelled
"Refresh proposals" next to a read-only button labelled "Refresh"; it now says
"Run maintenance".

### A test fixture that outlived its test by a week

Four `run-ledger-race-worker` processes were found still running on the
development machine, spawned on 3 August and each having burned 92 minutes of
CPU by 11 August. The fixture busy-polls for a go-file with `existsSync` on a
5 ms `Atomics.wait` and no deadline; the test writes that file only after all
four report ready. Anything that stops the parent in between — a timeout, a
crash, Ctrl-C — orphans the children, and the temp directory holding the file
they are waiting for is then removed, so they can never exit. The wait is now
bounded at 60 s, and the test SIGKILLs any surviving child on every exit path
rather than only the happy one.

### The budget was reading the wrong window, and so was last round's fix

**`--max-cost` was per-turn, not per-session.** Core tracked usage over two
windows — the current run, and the whole session a resume inherits — but only
ever emitted the run. The session window lived inside `writeSessionMeta` and was
reachable only by reading the trace off disk, so every consumer that wanted a
session total rebuilt it, and they disagreed. `apps/cli/src/commands/run.ts`
compared its budgets against the run window: `--input-format stream-json` handed
out the full `--max-cost` again on every turn, `plan → execute` handed it out
twice, and `--resume` ignored everything the session had already spent.

**Last round's TUI and Desktop fix made it worse in the quieter direction.** Both
were patched on the belief that `report.usage` is the session total; it never
was. Replacing the session total with the run total turned a visible
double-count into a silent undercount — and the TUI's total is what
`costBudgetUsd` reads, so the budget became too permissive. A probe run settled
the question in a minute: start a session, resume it, print what each channel
reports. The eval harness carried the same false comment and dropped every
earlier step's cost from resumed scenarios.

Core now publishes **both** windows on both events, named after what they mean,
computed in one place (`usageWindows()`): `usage` is this run, `sessionUsage` is
the session. Nothing has to be reconstructed and nothing has to be added.
`sessionUsage >= usage` always, so every budget guard now trips at the same
point or earlier — never later. The report also drains the usage bus, which it
previously did not, so MCP-sampling tokens stop going unbilled. `security.ts`
gained the backstop it was missing: it checked `usage.updated` but never the
final report, so a provider that only reports at the end could bill past
`maxCostUsd` and still be recorded as a verified fix.

Not flipping `usage` to the session window was deliberate: `auto-loop.ts` does
`costUsd += runCost` across iterations that resume each other, and
`dispatch-tools.ts` and the REPL are correct today *because* the window is
per-run. Every new test is a verified negative control — reverting the window
selection makes it fail.

### Three implementations that should have been one, and one that should not

A sweep for duplicated invariants found three candidates and merged two.

The `.seekforge/worktrees/<slug>` path shape was byte-identical in
`auto-loop.ts` and the TUI, whose copy carried a comment asking for exactly this
("if core ever exports the predicate, delete this and call it instead"). Both
now call `isRetainedWorktreeWorkspace()`. The CLI's `isRetainedLoopWorktree` was
left alone on purpose — same regex, different question: it asks whether a path
belongs to *this base repo's* worktrees, not whether it has the worktree shape.

Verification-plan validation existed twice and the copies had **diverged in
five ways**, with the Graph side strictly stricter. Three differences were
unified on the strict side; two were kept as parameters because they are
layering, not drift — a graph definition is authored text where a typo should be
fatal, while the engine also replays plans from persisted resume state that a
newer version may have written with fields this build does not know.

The third — Loop event formatting shared between Desktop and VS Code — **was not
merged, and should not be.** `apps/vscode` is CommonJS with no build step and no
bundler, and `@seekforge/shared` is private with an exports map pointing at raw
`.ts`. Requiring it works only on Node ≥ 22.18; every shipping VS Code is on
Electron with Node 20.x–22.16. It would have passed locally and broken in the
editor. A gate now reads the 22-member `LoopEvent` union out of shared and
asserts Desktop covers all of them and VS Code covers all but a named,
justified omission list — so adding an event forces a decision on both surfaces
without forcing a dependency that cannot exist.

Three findings recorded but not acted on: the verification-plan rules are
re-rolled in three *more* places (one of them in `packages/shared`, which cannot
depend on core, so those rules need pushing down rather than up);
`LoopVerificationStage` is itself mirrored in shared as a narrower copy; and a
stage `timeoutMs` above 2^31−1 fires `setTimeout` immediately on the engine path,
which the Graph layer caps at 24h and the programmatic API does not.

### Fourteen commands that rendered as raw text, and an A/B with no ties

**The command table promise held in the source and broke in the browser.** A
VS Code paragraph sat between the `evolve` row and the `security` row of both
READMEs. A blank line ends a GFM table, so every row below that paragraph —
`security`, `init`, `mcp`, `mcp-serve`, `skill`, `plugin`, `agent`, the four
`memory` rows, `config`, fourteen in all — rendered on GitHub and npm as literal
pipe-separated text. The drift gate greps raw Markdown, so it had been reporting
no drift the whole time. The paragraph now follows the table, and a new check
asserts that nothing interrupts a command table between its first and last row.

**The same gate was scanning the wrong half of the CLI.** `cliCommands()` read
`apps/cli/src/index.ts` and `apps/cli/src/commands/*.ts`, but `register-loop.ts`,
`register-graph.ts` and `register-orchestration.ts` live one directory above
`commands/`. Every command they register was exempt from a check whose name
promises *every top-level command* — which is how `seekforge loop`, the 22 flat
`loop-*` commands and `orchestration` stayed out of both READMEs while the gate
stayed green. This is the third blind spot of the same shape in this one gate,
after the segment-dispatch routes and the Server/Tui config keys. All 24 now have
rows, grouped by family the way `graph` already was.

**A paired A/B that reported zero ties across forty-five pairs.** The comparator
falls through to `costUsd` at full float precision, so `tie` was structurally
unreachable: the skill-brief run called all 45 pairs decisive and printed a
confidence interval over them, when 13 had identical success, score and turns and
were separated by cost alone. Seven of those thirteen differed by 0.08%–0.26% —
noise a $0.0025 task cannot resolve. Cheaper is still better, but only above a 1%
relative threshold; below it the pair is a tie, and the report now says how many
decisions rested on cost alone. Re-scored, that run reads A 23 / B 15 / 7 ties,
a 60.5% [44.7%–74.4%] win rate for the control — the interval still spans 50%, so
the wider skill-brief cap is not shipping.

**The roadmap said Phase 2 was deletion.** It is not: `loop-speculate` runs its
candidate strategies through `runLoopDag`, making it the last non-DAG caller of
the engine. Retiring the Loop DAG means porting speculation onto a Graph fan-out
of Loop nodes with a shared weighted budget first, and it takes `loop-dag`,
`loop-dag-resources` and `export-graph` with it — not the rest of the flat
`loop-*` family, which manages single Loops and outlives the DAG.

### The Loop DAG can be retired, and a gate that walks docs → code

**The Graph `loop` node was a strictly weaker Loop, and that is why two
orchestration engines were still alive.** It forwarded seven fields to its child.
Everything else a `loop-dag` node could carry — the whole `options` surface,
`verifierId`, `consumeDependencyOutputs`, `outputPaths`, `budgetWeight`,
`predictiveBudget`, a per-node `failurePolicy` — had no Graph equivalent, so the
roadmap listed closing that gap as the precondition for retiring the DAG.

The specification was already executable: `loop-dag export-graph` refuses, by
name, every field it cannot convert faithfully, so its blocking-code list was
both the todo list and the acceptance test. It now converts a DAG that uses all
of them with zero blocking issues.

`loopOptions` is typed as a `Pick<>` of `LoopOptions`, so the two cannot drift.
What a node may **not** declare is enumerated with reasons: `workspace`,
`signal`, `loopId`, `persist`, `resumeState`, `verify` and the rest belong to the
Graph runtime, which owns the child's durable identity. `persist: false` is the
sharpest — it would make the child unresumable while the Graph checkpoint still
claims otherwise. Opening the whole option type would have been less code and
would have broken exactly that.

One strictness increase needed walking back partway: `inputs` on a kind that
never reads it (`gate`, `join`, `router`, `wait`, `subgraph`) is now rejected —
but the old parser *kept* that field, so it is inside the fingerprint of every
checkpoint written with one. Rejecting it while decoding stored state would have
made those graphs unloadable, invisible to `graph list` and unresumable, over a
field that never did anything. New definitions are rejected; persisted ones
decode exactly as written, field intact, because the fingerprint is computed over
the parsed definition and stripping it would look like a changed definition.

**`scripts/doc-claim-reachability.test.mjs` walks docs → code**, the direction
`surface-drift` does not. A documented symbol, `seekforge` command, `--flag`,
`/slash` command, `SEEKFORGE_*` variable or config key that no surface reaches
now fails the build. Getting it trustworthy took six tightening rounds on one
check alone (6 → 11 → 4 → 2 → 1 findings), each removing a class of false
positive rather than adding an exemption, plus four measured variants rejected
outright — a gate people learn to ignore is worse than no gate.

It found one: `createDockerRunner` is documented as how the Docker backend is
exposed and is called by nothing; the shipping path uses `spawnDockerRun`
directly. `createSshRunner` was equally dead, silent only because no page named
it. Both are gone along with the `AgentRunner` interface they implemented —
implemented twice, consumed zero times, its own comment claiming "callers depend
on AgentRunner". When a real need for a runner seam did arrive, Graph `remote`
nodes got a purpose-built adapter instead. The shared option/result types and
shell quoting stayed; those two backends really do share them.

The gate's own closing note says what it cannot catch, including an honest
calibration: it would not have caught the three incidents that motivated it
unless the page had named the symbol or the flag.

**Information the surfaces were dropping.** `verify.flaky` was invisible on
Desktop and the TUI — the two surfaces that offer the flaky-retry control — so a
green that only went green on a retry looked identical to a clean pass. A
multi-stage verification plan collapsed to one line whose visible tail almost
never contained the failing stage. `loop.rollback` was silent while it restored
and deleted files in the user's workspace. `/loop-pause` and `/loop-steer`
printed that the request was queued and never that the boundary was reached.
`graph run` printed `[42] graph.warning` and dropped the message that was the
warning's entire content.

**A cost bug found while wiring the Desktop footer.** `usage.updated` carries the
current run's total; `session.completed` carries the whole session's, including
turns a resume inherited. Both are cumulative, over different windows — and
Desktop and the TUI were adding the report to a running total, re-billing every
earlier turn. In the TUI that total drives `costBudgetUsd`, so the budget stopped
runs early. Each surface now replaces per slot instead of summing. Two existing
tests encoded the double-count by sending two completions with no session in
between; they now span two genuinely different sessions.

### Eight security promises the code did not keep

An audit checked ~575 capability statements across fourteen documents against
the code. Forty-seven did not hold. Eight of those were security promises, and
those are the ones worth reading.

**Enabling a plugin silently trusted its MCP servers.** `loadPluginContributions`
wrote `trusted: true` unconditionally, overwriting a manifest's explicit
`trusted: false` — and trust is not cosmetic: it auto-connects the server and
drops the default tool permission from `env` to `write`. `docs/plugins.md`
promised plugins "do not bypass the existing permission system"; `docs/mcp.md`
promised only `trusted: true` entries connect. Trust now comes from the manifest
the user reviewed and the digest covers, never from the loader. **Behavior
change:** an installed plugin whose manifest omits `trusted` stops auto-connecting
its MCP servers. That is the fix, and it is user-visible.

**`mcp-serve` read no configuration at all.** It was the one CLI entry point
that called neither `loadConfig` nor `configureCliTools`, so its `ToolContext`
had no sandbox, no permission rules and no hooks — while `docs/configuration.md`
promised the sandbox "fails hard, never silently degrades" and that a `preToolUse`
non-zero exit blocks the call. Both now hold.

Wiring the sandbox alone would have been *worse* than leaving it off: a failed
sandboxed command offers one unsandboxed retry through `ctx.confirm`, and the old
confirm auto-allowed execution — so the first denied write would have re-run
unconfined, quietly. Full mode now auto-approves L1/L2 inside `enforcePermission`
where the decision is scoped to permission levels, and answers every actual
question with no. Authorization outcomes are unchanged; the silent escalation is
gone. The retry request also carries `escalation: true` now, because it was
otherwise indistinguishable from an ordinary execute approval — a human
answering it is a legitimate approval, so the flag gates nothing in core and
exists for hosts that answer without one.

**A scheduled job's budget could be enforced by nothing.** `schedule add` refuses
a job without `--max-cost`, and `docs/scheduling.md` said "there is no way to
schedule an unbounded run". On a provider with no price table every request
reports a cost of 0, so the cap never trips — the code's own comment said so
while the doc did not. Scheduled runs now carry the same 8,000,000-token ceiling
the webhook path already had.

**Cancelling a run saved the login it interrupted.** `closeSession` defaulted to
`persist = true`, so every teardown that was not a finished run — Ctrl+C, SIGTERM,
a forced dispose — inherited "save", and stopping mid-login-redirect could
replace a working profile with a broken one. `persist` is now explicit at every
call site, cancellation is sticky on the session so a sibling operation cannot
hand a cancelled session to an ordinary release, and the run carries its
cancellation intent into teardown rather than inferring it — the loop's own
cleanup aborts the run signal, so by release time a finished run and a cancelled
one are byte-identical, and reading the signal there would be a timing heuristic
deciding whether to overwrite a credential.

**One keypress bought every later URL and selector.** `browser_*` and `web_*` are
L3 `env` — "confirm on every call" is what the level means — but an
allow-for-session answer stored the bare tool name, so answering `a` once
auto-approved every subsequent navigation to any host and every click on any
element. L3 approvals are no longer remembered. An explicit allow rule still
covers them, because a rule names what it grants and a keypress does not.

**`resolve` asked a human, and deleted the trace it told you to audit.** It never
set an output format, so approvals fell through to the terminal — its guardrails
held only because someone was there to decline. It also ran in a temp worktree it
deleted on success, taking the session trace with it. It is headless now, and the
trace is copied back to the repository before the worktree goes.

**`ask` runs read-only commands, and said it did not.** Level-0 tools return
allowed *before* the ask gate, so `git log` really is spawned. Three surfaces
claimed otherwise; all three now say what happens. Same correction for the
security scan's "the raw model response is never persisted" — true of the Finding
queue, not of the session trace it also writes.

Also corrected: eleven capabilities that existed with no way to reach them —
including a GitLab CI adapter that shipped, was tested, was documented, and had
no selector — eleven wrong numbers, and seventeen imprecise claims. And
`LoopPhase` was declared twice with the copies already diverged: `"review"` is
persisted by `--code-review` Loops and was missing from the shared DTO the REST
list returns verbatim, so the contract could not describe a value already on the
wire. It now lives in `@seekforge/shared` alone.

The drift gate could not have caught any of this. It passes 9/9, and a verbatim
sweep of every `seekforge …` line in all fourteen documents found zero errors:
it catches a renamed command or an undocumented route, not a shipped adapter with
no selector, a budget enforced by nothing, or two copies of a union that
disagree. Those are the three shapes that produced every incident here.

### The surfaces a capability claimed, and the premise that was wrong

**A `wait` node could not be woken without starting a server.** Graph's durable
control mailbox, external signals, evidence export, run comparison and the
template registry were REST-only. They are now `graph
pause|continue|steer|cancel-node|reprioritize|signal|evidence|compare`, `graph
template list|show|register|compare|deprecate`, and six `/graph-*` TUI commands.
Whether a control or signal may act on a Graph right now is decided once, in
Core, because copying the server's inline state checks into two more surfaces is
how they drift.

**The drift gate only ever saw `graph`.** It matched `program.command("x")`, so a
whole subcommand could ship behind a documented group. It now walks nested
registrations and checks every `<group> <sub>` against both languages. It
immediately found `memory remove`, undocumented as its own command since it was
written, and failed twice more while this work was in progress.

**Graph is not a strict superset of Loop DAG** — the premise this set out to act
on did not survive contact with `runGraphLoop`, which forwards seven fields. A
Graph `loop` node cannot express `node.options` at all (`maxIterations`,
verification plans, model routing, `codeReview`), `consumeDependencyOutputs`,
`outputPaths`, `budgetWeight`, `predictiveBudget`, `verifierId`, or a per-node
failure policy; declaring `inputs` on one even parses and is silently inert. So
no rewrite: `loop-dag export-graph` converts deterministically and refuses, by
name, every field it cannot make behave identically. The Loop DAG contract is
frozen and closing that gap is the documented precondition for retiring it.

**`function` nodes were a documented feature with two handlers.** `pick`,
`project`, `merge`, `assert`, `count` and `summarize` join `noop`/`collect` — no
contract change and no new execution surface, because operands ride the existing
`inputs` binding and predicates ride the existing schemas. `count`/`summarize`
plus `outputSchema.enum` is how a definition-only user finally gates a `map`.

**`remote` nodes had no adapter to trust.** The Docker and ssh runners are now
adapters, registered only from `~/.seekforge/graph-executors.json` in the
operator's home — never the workspace, so a cloned repository cannot name a host.
ssh cannot cancel, so a `requiresCancellation` node is refused there rather than
promised. And the ssh cost was never invisible: `--output-format json` returns
usage over the same channel. What differs is attribution, so results carry
`costAccount`, and a node reporting no usage under a budget fails closed instead
of booking a zero.

**`read-only` was writable.** Both kernels match resolved paths while the sandbox
profile named the unresolved workspace, so a `read-only` workspace under `/tmp`
fell through its own deny rule into the `/private/tmp` allowance. This defeated
the fix already recorded as boundary-checklist §49 — ordering the deny last is
useless when the rule names a path the kernel never matches.

**No Windows sandbox, and now the README says why.** Job objects have no path
dimension, restricted tokens gate by ACL, and AppContainer denies reads by
default. The decisive fact: command execution is `/bin/sh -c` everywhere, so
there is no Windows execution path to sandbox.

**The reasoner fallback is deleted, not wired.** Exported, zero consumers. A
non-function-calling model has no `tool` role, so results return as prose — and
any file or diff containing a fenced `tool_call` block becomes an executed call.

**The skill brief split its budget evenly and cut steps in half.**
`buildSkillBrief` injects only the `## Procedure` section, and the
2,500-character budget was divided *per skill*: at the default limit of three
that is 832 characters each, while `simplify` needs only 740 of it and `bugfix`
needs 1,104 — one brief leaving 92 characters unspent and truncating another
skill by 272 at the same time.
Allocation now water-fills by need, re-offers whatever a step-boundary cut hands
back, and gives the last remainder to a single skill rather than spreading it too
thin for anyone to reach their next step. Cuts land between steps: these are
numbered lists whose steps wrap across lines, so a line-boundary cut still landed
inside step 4, and half of step 4 reads exactly like all of step 4.

Measured at three selected skills, `small-code-change`'s closing "search the old
text again to catch any leftover" step now arrives where it did not before, and
no brief ends mid-step. `bugfix`'s regression-guard step still does not fit, and
reallocation cannot make it: three procedures of that size genuinely exceed 2,500
characters. That remainder is a cap question, not an allocation one, and raising
the cap changes the cost of every provider call — so it needs its own paired
measurement rather than a guess bundled in here. The cap is unchanged, so
everything above costs nothing per call.

Also: a `graph` eval runner over the real engine with five control-plane tasks; a
read-only Loop panel for the VS Code client, whose history paged forward from
zero and so showed a failed Loop its oldest events; and AGENTS.md now forbids
`git stash` on a shared tree, because following its own clean-checkout advice
destroyed two parallel work streams here.

### The quality gate, the eye, the bill, and four languages

**The eval baseline was five weeks and fourteen tasks out of date.** It was
recorded 2026-07-01 against 49 tasks; the dataset has held 63 since, so the
subagent specialists, prompt caching, memory scoring and repo-map work that
landed after it had never passed the gate they are supposed to pass. Re-recorded
at three samples: **187/189 (98.9%), $0.551, $0.00295 per success, 96,875 tokens
per success, zero session errors**.

**One sample is not a measurement.** Recorded first at one sample, the same
suite reported three failures. At three, two of them —
`go-pagination-window` and `memory-convention-recall` — pass 3/3: they were
noise, and the single-sample baseline had frozen them as failures, which would
have made a later run that passed them look like an improvement and set
`maxSuccessRateDrop` against an inflated count. `foreach-await-bug` passes 1/3
and is the one real weakness in the set. Tokens per success measured 118,742 at
one sample and 96,875 at three, on the same code — an 18% swing that is the
whole argument for the sample count the weekly job already uses.

**And that weakness is not the one its name suggests.** In both failing samples
`npm test` passed and the file contained `await`; the only failed check was
`file_not_contains "\.forEach\(async"`. The fixture's test asserts order, length
and a non-empty result, so a deterministic pass means the async semantics were
fixed correctly 3 times out of 3. What survived was the JSDoc line above the
function — `* BUG: this uses \`.forEach(async …)\`` — describing a bug that had
just been removed. The passing sample spent 8 tool calls; the two failures spent
6 and 4. The extra calls were the second edit that retired the stale comment.

So the measured weakness is **diff hygiene**: the fix lands, and the file is left
describing behavior it no longer has. No test can catch that, which is why the
guidance went into the shared edit-mode prompt and the `bugfix` skill procedure —
retire the comments, docstrings and now-dead code a change made false in the same
edit — rather than into anything shaped like `forEach`. A rule about one idiom
would have been eval-specific and would have taught nothing.

Found while investigating and deliberately not bundled: `buildSkillBrief` injects
only a skill's `## Procedure` section, and `SKILL_BRIEF_MAX_CHARS = 2500` divided
across three selected skills truncates every builtin procedure mid-step — so
`bugfix`'s regression-test step and `small-code-change`'s "search the old text
again" step have never reached the model. Raising the cap changes cost on every
provider call, so it needs its own eval measurement first.

Two things that only showed up by running it:

- **A completed run could lose its entire report.** `--baseline evals/baseline.json`
  — the invocation in the README — resolves against the package directory under
  `pnpm --filter`, not the repository, so the file was not there and the throw
  took the finished run with it: 63 tasks, 33 minutes and real money, and
  nothing written. The path now resolves against the cwd and then the repo root,
  and an unreadable baseline is reported *after* the report is on disk.
- **`maxTokensPerSuccess` had never actually been checked.** The old baseline
  carried no token metrics at all, so the gate only ever compared against its
  absolute ceiling — and that ceiling (100,000) predates the 14 long-running
  tasks added since. Two runs of the same commit measured 106,435 and 118,742,
  so it is now 150,000: headroom over the measured spread, not a target. The
  gate that catches drift from here is the ratio against a baseline that finally
  has tokens in it.

**A screenshot can reach a model that has eyes.** `browser_screenshot` has
attached its bytes since it was written, and the OpenAI-compatible protocol
dropped them with a note on every provider — so the loop it exists for worked on
Anthropic and nowhere else. The mapping now emits `image_url` content parts:
inside the user turn for a user's own image, and as one user turn after a tool
block for a screenshot, because this protocol takes image parts on a user
message and not on a tool message, and a tool result may not be interleaved with
anything. Which providers carry them is a per-endpoint answer with a per-model
question inside it, so it is on for `openai` and `openrouter` (every model in
those catalogs accepts one), off for `ark` and `ollama` (mixed catalogs, where
one attached screenshot would fail the request rather than degrade), off for
DeepSeek, and settable per model with the new **`inlineImages`** config key.

**Cost stops being a `0` that means "unknown" on two more providers.** `openai`
ships its published price table and reads its cached-input count; `openrouter`
reports what it charged in `usage.cost` on every request, which is the only
price that cannot go stale for a 400-model catalog — read now, above the
built-in table and below a user's own `modelPricing`. Where cost genuinely
cannot be known (`ark`, `ollama`, a bare `baseUrl`), every surface says so
instead of implying a bound it cannot hold: the TUI and the server warn like the
CLI already did, `--max-cost` says the budget cannot be enforced, and
`schedule add` warns at creation — a scheduled run is unattended, so a budget
enforced by nothing is worst there. The stale `gpt-4o`/`o3-mini` and
`claude-3.5-sonnet` catalogs are refreshed.

**Four languages the tools claimed and did not serve.**

- `lsp_*` covered 19 languages and not Java or C#, which `repo_map` outlines.
  Both were left out for stated reasons, and both reasons are answered rather
  than overridden: jdtls gets a data directory of SeekForge's own, keyed by
  workspace under `~/.seekforge/lsp/jdtls/`, and C# is served by `csharp-ls`,
  which finds the solution itself, with OmniSharp behind it.
- `.vue` and `.svelte` were walked but only ever regex-matched. They are now
  outlined by lifting the `<script>` out and parsing it as the JS/TS it declares
  — no markup grammar involved, which is what the vue grammar's single
  `raw_text` token made pointless. Line numbers are offset back into the real
  file, and a component with two script blocks contributes both.
- Elixir is outlined for the first time. Every declaration there is a macro
  *call*, so there is no node type to match: the target identifier is what makes
  a call a definition, and the functions live one level down inside the module.
- `dart`, `elm` and `ql` are re-measured and still unfixable here: the runtime
  accepts language versions 13–14 and `tree-sitter-wasms@0.1.13` ships them at
  15, 12 and 10. Recorded with the numbers so the next person does not measure
  it again.

**`web_search` gains a leg you can buy.** Brave Search API joins SearXNG and the
DuckDuckGo scrape, tried first when a key is present, with the same
http(s)-only URL filter and the same "only a backend that did not run hands
over" rule. The three frontends now share one `resolveWebSearchConfig` instead
of each inlining the mapping — which is how the first key ended up honored by
one surface and ignored by another in earlier rounds.

MCP sampling and elicitation needed nothing: the server answers both through the
`confirm` and `askUser` bridges the Desktop and the VS Code client already
implement, so they were never the gap they looked like.

### A capability the eval could not have measured

The specialist subagents a coding run dispatches were never exercised by the
eval, and not because nobody ran the A/B: the harness never passed `subagents`
at all, so `dispatch_agent` sat in the catalog with nothing to dispatch. The
factory now receives the task's workspace — deliberately the fixture's own, so
the SeekForge repository's agents cannot leak into a run — and a
`with-subagents` variant turns them on. Control keeps the old behavior, so the
recorded baseline stays a valid comparison point and the variant is what prices
them.

### Two surfaces that had never been run

`integration.yml` drives the Loop, the server, the Rust runtime, Docker and a
real Chromium against real environments. It did not drive a language server or a
search backend — the two surfaces the change above extended on contracts read
from documentation. Both now have a smoke like the browser one, and running them
found three defects that no amount of reading would have.

- **`lsp_exited` threw the server's own explanation away.** stderr was drained
  into an empty callback, so a server that refused to start reported `jdtls
  exited` while having printed the exact reason. It now carries the last lines
  of stderr: `jdtls exited: … Exception: jdtls requires at least Java 21`.
- **jdtls needs Java 21+, and the install hint did not say so.** A user on the
  LTS their project targets would hit an immediate exit. Both the hint and
  `docs/lsp.md` say it now — as does the fact that the version is about the
  server, not the project.
- **The 15s request budget was too short for a cold index.** A server accepts
  `initialize` long before it can answer a question about the code, and jdtls on
  an empty `-data` directory did not return the first `documentSymbol` inside
  15s — Java would have timed out on first use for every user and worked
  afterwards, the worst shape a timeout can have. The first post-handshake
  request now gets 120s; every later one keeps the ordinary budget. (The
  handshake itself does not count as that first answer — it is answered before
  any indexing starts, which is what made the first attempt at this a no-op.)

The `-data` claim the review could only call "high confidence, not perfectly
citable" is now executed: jdtls creates the directory itself, at the path this
repository chose. One real limitation is recorded rather than papered over:
Java's project-wide `lsp_symbols` needs an imported build (pom/Gradle/.project),
and in a directory of loose `.java` files it stays empty however long it is
polled, while everything scoped to an open document works.

`docs/lsp.md` listed three languages while the code served twenty-one. It lists
all of them now.

Six findings from an independent review, all real and all mine:

- **The pricing warning fired once per TURN, not once per session** — which is
  what all three frontends' documentation promises. The TUI had noticed and
  carried its own set; the server had not and printed it forever. The gate now
  lives once in `buildAgentCoreDeps`, keyed by (provider, model) rather than by
  workspace, because "no price is known for this model" does not become true
  again in another directory.
- **A renamed field on either JSON search backend would have read as "no
  results".** Both classified an unparseable-but-JSON body as `empty` — the
  outcome documented as *believe it, the query matched nothing* — when the whole
  reason `drift` exists is to say the opposite. Both now decide on the envelope:
  `results` present and empty is a real zero-hit answer, `results` absent is
  drift. The SearXNG half of this predates the Brave backend and is fixed with
  it.
- The `webSearch` type in `ServerConfig` never grew `braveApiKey`, so the config
  shape drifted across the three surfaces in the same change that introduced
  `resolveWebSearchConfig` to stop exactly that.
- Three pieces of prose that had stopped being true: `modelPricing`'s doc
  comment still named OpenAI as a provider with no built-in table, the TUI's
  `webSearch` comment still described a two-backend chain, and the LSP
  workspace-args comment credited `seekforge doctor` with calling a function it
  has never called.

The review also independently re-fetched OpenAI's pricing page and confirmed all
sixteen rates and the six catalog models against it, and verified the OpenRouter,
Brave, jdtls, csharp-ls and OpenAI image-part contracts this change assumes.

### Tool reach: drive the browser, rename a symbol, answer an MCP server

Three capabilities that were shaped like gaps rather than choices.

- **The browser tools can act on the page.** `browser_click`, `browser_fill`,
  `browser_select`, `browser_press` and `browser_wait_for` join the four
  read-only ones, so a login or a form submission can be verified end to end
  instead of screenshotted. An interaction's permission level follows the loaded
  page: a loopback dev server is ordinary work, any other page is confirmed on
  every call. `packages/core/src/tools/browser/` replaces the single file, and
  `scripts/browser-tools-smoke.mts` drives the whole loop against real Chromium
  in CI.
- **`lsp_rename` and `lsp_symbols`.** Rename a symbol across every file the
  language server resolves it in, after approving a real diff with one
  selectable hunk per file; edits outside the workspace, file create/rename/
  delete operations, overlapping edits and stale targets all abort before
  anything is written, and a mid-way failure rolls back. `lsp_symbols` searches
  the project's declarations by name with their kinds. Tools may now define an
  async `prepare` step that computes a review payload between `classify` and
  permission enforcement; it cannot change the permission level.
- **MCP sampling and elicitation.** A server can borrow the user's model
  (confirmed every time, with the prompt shown verbatim and the cost reported)
  or ask the user a question. Each capability is advertised only where an answer
  is wired — the CLI and the local server today, not the TUI — so a server never
  asks for something that will be refused. Both transports now share one
  server-request module.

Four defects found while building and reviewing these are recorded as reusable
classes in `docs/boundary-checklist.md`: page-side code broken by the build's
name-keeping transform, `.refine()`d tool schemas advertising no parameters at
all, a step added in front of the permission gate inheriting what the gate
withheld, and paths compared in two different resolved forms (which refused
every legitimate rename under a symlinked workspace — i.e. every macOS temp
dir).

## 1.0.0 (2026-07-31)

0.7.0 shipped the five surfaces (CLI, REPL, TUI, local web, desktop app). 1.0.0
is about what runs inside them: agents that finish work unattended and can be
audited afterwards. Sixty-seven development rounds are summarized below; the
per-round log follows.

### Autonomous Loop (rounds 49–72)

Run a task to green without supervision: `seekforge loop "<task>" --verify
"<cmd>"` runs the agent, runs the verification command, feeds failures back, and
repeats until the command exits 0 or a guardrail trips — as one resumed,
rewindable session. Guardrails default on: iteration cap, cumulative cost/token/
time budgets, no-progress detection, and cooperative cancel.

Around that core: requirement confirmation before work starts, durable state
that survives a crash or a closed server, cross-process controls (pause, resume,
steer), verification DAGs with dependency-aware stage selection, managed
worktrees for isolated parallel attempts, evidence-backed delivery (checkpoint,
merge, or pull request) that cannot publish an unverified tree, bounded CI-log
repair, and idle recovery for orphaned runs.

### Graph Engineering (rounds 73–78)

Heterogeneous execution graphs over Agent, Loop, function, router, approval-gate
and nested-graph nodes, with completion-driven scheduling, shared budgets,
retries, pause/resume, downstream reruns, typed input/output contracts, and
content-addressed artifact attestation. On top: durable migration between graph
versions, remote-executor capacity fencing, SLO burn-rate policy, and explicit
shadow/canary/promotion rollouts with opt-in regression rollback.

Both engines are exposed through Core, CLI, REST, and the desktop app, and both
persist enough evidence to reconstruct what happened after the fact.

### Agent quality (rounds 36, 43–44, 51–54)

Code navigation, a finalize gate, durable plans, task-relevant file retrieval,
auto-verification, and a reviewer subagent — each measured with paired A/B eval
runs rather than assumed. Round 54 recorded the verdicts and kept only what paid
for itself: auto-verify default-on (~30% cheaper), retrieval default-on (value
concentrated on hard navigation), review gate opt-in (cost without measured
benefit). A low-end-model audit fixed the findings that only show up on weaker
models.

### Memory (rounds 37, 40, 42–43)

Global cross-project facts, `@import` composition, exposure/retrieval metrics,
and extraction levers chosen by measurement instead of intuition.

### Interfaces (rounds 18, 26–33, 35, 45–48)

Headless CLI parity (`-p`, `--output-format`, `--permission-mode`,
`--fallback-model`, `--settings`), per-hunk partial apply across every surface,
English + 简体中文 for the CLI, TUI, and desktop, a redesigned desktop app with a
file browser, source control, ⌘K palette, and live run controls, and a VS Code
client over the same REST/WS contract.

### Security, correctness, and distribution (rounds 34, 38–39, 41, 55, 57, 68)

Dependency audit to zero vulnerabilities, a self-contained desktop bundle (the
DMG no longer needs a system-installed CLI), full-project boundary reviews whose
findings are recorded as reusable bug *classes* in `docs/boundary-checklist.md`,
and release wiring for npm, native desktop packages, and the VS Code extension.

### Also in 1.0.0

- Interactive OAuth 2.1 (PKCE) login for remote MCP servers: `seekforge mcp
  login <name>` stores the refresh token owner-only outside the shared config.
- OpenAI-compatible providers: `reasoning` streams, legacy `function_call`
  finish reasons, index-less tool-call deltas, and
  `prompt_tokens_details.cached_tokens` are all normalized, with a fixture
  matrix pinning each dialect.
- CI gates the Loop/Graph control plane's test coverage, and fails the build on
  cross-surface documentation drift (undocumented command, config key, REST
  route, or missing translation).

### Upgrading from 0.7.0

- `git push` is no longer denied outright; it prompts every time (headless runs
  auto-reject). `--force` pushes remain denied.
- Cost accounting stays DeepSeek-specific: non-DeepSeek presets report 0 until
  you set `modelPricing`.
- `@seekforge/core` remains internal and unpublished; the exit criteria are in
  `docs/core-package-policy.md`.

### round 78: adaptive Loop and Graph control plane
- Added contextual Loop route learning, unfinished-node Graph runtime replanning, workspace-wide remote executor capacity fencing, and verified artifact attestations.
- Added durable SLO burn rates and forecast calibration, explicit shadow/canary/promotion rollouts, safe idle orchestration maintenance, and opt-in regression rollback.
- Exposed the control plane through Core, CLI, REST, and Desktop, with a real-project ecosystem/execution/fault eval matrix, strict shared contracts, bilingual documentation, and focused lifecycle/boundary regression coverage.

### round 77: recoverable orchestration deployment and Graph transactions
- Added crash-recoverable Graph tree migration and append-only expansion apply, remote executor capacity fencing and placement alternatives, Monte Carlo scheduling distributions, and verified SHA-256 artifact CAS materialization plus reference-aware collection.
- Added persistent SLO policy, bounded full-generation orchestration indexing and pagination, multi-objective Loop routing, and a proposal deployment/observation/rollback lifecycle across Core, CLI, REST, and Desktop.
- Bound mutations to exact source generations and monotonic decision versions, restored prior Loop routes on rollback, coordinated CAS writers and GC, and documented the new boundary classes and public operations in English and Chinese.

### round 76: orchestration decision intelligence
- Added workspace Loop/Graph portfolio budgets, caller-defined SLO evaluation, deterministic replay, Loop route outcome learning, remote executor placement checks, and bounded Pareto counterfactuals.
- Added durable advisory proposal review with optimistic concurrency, exact-generation verified artifact reuse planning, append-only Graph expansion checks, and nested migration-tree preflight.
- Added CLI, REST, and Desktop decision surfaces plus shared transport contracts, bilingual architecture/SDK guidance, and model/chaos regression coverage.
- Bound strategy learning to pre-edit failures, made SLO aggregation evidence-correct, excluded Graph-owned child Loops from parent-inclusive portfolio totals, hardened proposal retention/corruption handling, and bound migration previews plus Desktop results to their source generations.

### round 75: recoverable dynamic Graphs and verification DAGs
- Added Graph v2 state migration, attempt/idempotency journals, durable pause/steer controls, idle recovery/retention, and complete Desktop lifecycle actions.
- Added typed input/output and artifact contracts, bounded map/quorum-join nodes, priority/critical-path planning, nested managed worktrees, run comparison, and safe plugin handler aliases.
- Added explicit resource-scoped Loop verification DAG parallelism with history ordering while preserving sequential compatibility and the authoritative full gate.

### round 74: durable Graph operations and explainable Loop recovery
- Added nested Graph pause/resume and scoped reruns, rotating JSONL history, tamper-evident evidence, shared handler/run-ledger integration, and full REST lifecycle controls.
- Added deterministic managed Graph worktrees, dependency propagation through control nodes, verified fan-in, generation-bound archive/prune/promotion, templates with typed parameters, recursive dry-run plans, and Desktop resource/dependency inspection.
- Added auditable Loop verification-impact events, dedicated SARIF/review repair, bounded contextual recovery prompts, and a shared non-overlapping idle timer lifecycle for Loop and memory maintenance.

### round 73: Graph Engineering
- Added a validated, durable heterogeneous execution graph for Agent, Loop, function, router, approval-gate, and nested-graph nodes.
- Added completion-driven scheduling, shared budgets, retries, timeouts, pause/resume, downstream reruns, bounded event/output persistence, and physical-workspace concurrency guards.
- Added CLI lifecycle commands, REST/Desktop observability, shared DTOs, bilingual architecture guidance, and regression coverage.

### round 72: reusable Loop contracts and documentation rules
- Centralized Loop DAG identifiers, conditions, relative paths, dependency, and
  topology validation in one pure Core module shared by runtime and CLI input.
- Reused Shared persisted-status, delivery, and evidence DTOs directly in Core,
  removing parallel contract definitions and preserving `verifierId` in CLI DAG input.
- Added invariant-ownership, extraction, validation-before-effects, export, and
  independent boundary-review guidance across contributor and bilingual docs.

### round 71: Loop maintainability and boundary consolidation
- Split Loop persistence, history, leases, managed worktrees, budget policy,
  verification selection, evidence formatting, CLI lifecycle/input parsing,
  REST resources, and Desktop views into focused modules.
- Centralized Loop REST DTOs in `@seekforge/shared`, reduced unrelated Desktop
  operation blocking, and avoided repeated DAG budget-history reads.
- Fixed offset-timestamp ordering and rejected malformed managed fan-in branch
  provenance, with focused regression coverage.

### round 70: operational Loop intelligence
- Added context-weighted recovery learning, predictive DAG budget allocation,
  multi-ecosystem verification discovery, and occurrence-based lifecycle eval metrics.
- Added resumable speculative runs, explicit winner promotion, managed DAG resource
  inspection/archive/prune/promotion, and CLI/REST/Desktop operational surfaces.
- Added SHA-256 evidence integrity with JSON/SARIF/JUnit export and run comparison,
  plus a GitLab CLI adapter alongside GitHub CI closure.

### round 69: dependency-aware and isolated Loop operations
- Added dependency-closure verification selection with explainable stage outcomes,
  bounded workspace recovery learning, lifecycle interruption evals, and hosted-CI fixtures.
- Added managed DAG worktrees, downstream dependency integration, verified fan-in,
  and bounded speculative repair candidate selection without implicit publication.
- Added provider-neutral CI closure adapters, requirement-to-delivery evidence reports,
  CLI/REST surfaces, and Desktop verification, acceptance, timeline, and DAG views.
- Bound managed DAG provisioning to its coordination lease and physical paths,
  invalidated stale fan-in evidence, and accounted failed integration usage.

### round 68: Loop boundary hardening
- Bound incremental verification reuse to an unchanged workspace fingerprint and
  preserved the authoritative full gate across later passes and rollback.
- Persisted DAG approval before execution, repaired monorepo verification discovery
  and stage caps, and made CI repair dependencies lazy and cancellation-aware.
- Guarded Desktop Loop list/history responses by request generation, expanded
  regression coverage, and documented the new boundary classes.

### round 67: durable completion-driven Loop orchestration
- Made PR/CI delivery policy and repair progress durable and cooperatively cancellable,
  so retries cannot bypass an unfinished CI closure.
- Replaced DAG batch barriers with completion-driven scheduling and added composite
  conditions, audited approvals, and validated artifact contracts.
- Added monorepo-aware verification with safe intra-iteration caching, adaptive budget
  forecasts, richer REST/Desktop management and metrics, and real eval coverage.

### round 66: full Loop engineering surface
- Added frozen automatic verification discovery, per-iteration cost/token/time/path
  observability, failure classification, and category-specific recovery strategies.
- Upgraded durable DAGs with conditional branches, exclusive resources, approval
  gates, structured dependency outputs, and downstream invalidation/rerun.
- Added bounded PR-check waiting and CI-log repair for Loop delivery, REST/Desktop/TUI
  lifecycle management, richer eval scenarios, and bilingual operational docs.

### round 65: verified immutable Loop publication
- Re-run the full persisted verification pipeline against the checkpointed
  delivery tree, reject verifier/hook mutations, and publish merge/PR delivery
  by an immutable checked revision.
- Preserve retained branches with commits not reachable from the base checkout,
  including automatic worktree pruning and non-force manual cleanup.
- Require a stable `verifierId` for persisted DAG nodes that inject a custom
  verifier, and repair explicit evidence-free finalized delivery records.

### round 64: Loop delivery and cleanup integrity
- Bound delivery retries to the evidenced branch tree and working tree so later
  unverified commits or local changes cannot enter checkpoint, merge, or
  pull-request publication.
- Made retained-worktree cleanup acquire the workspace guard, and made
  whole-worktree pruning revalidate and remove atomically without first
  dirtying tracked Loop state.
- Bound durable DAG fingerprints to each node's resolved physical workspace,
  protected legacy evidence-free deliveries from pruning, and serialized
  recovery-priority updates with the Loop lifecycle.

### round 63: durable adaptive Loop orchestration
- Added foreground preemption of idle recovery, prioritized bounded recovery,
  per-Loop exponential backoff, failure isolation, and idle terminal-state pruning.
- Added path-scoped incremental verification with an unconditional full-pipeline
  success gate across CLI, Server, TUI, and Desktop surfaces.
- Added durable DAG checkpoints/resume, weighted remaining-budget allocation,
  node priorities/retries, and configurable dependency failure policies.
- Upgraded delivery to evidence-backed `prepared`, `action_completed`, and
  `finalized` phases so partial Git/patch/PR publication can be retried safely.
- Added CLI management commands, protocol validation, observability, bilingual
  documentation, and cross-surface regression coverage.

### round 62: Loop lifecycle and delivery recovery hardening
- Unified Loop run, delivery, and deletion under one cross-process lifecycle
  lease so resume cannot race post-pass Git or PR side effects.
- Moved successful delivery persistence after the primary side effect, added
  idempotent final-state publication and legacy premature-success repair, and
  made patch retries replace stale artifacts safely.
- Kept the workspace idle guard for the complete automatic recovery while
  authorizing only its owned Agent sessions, including nested agents, and
  excluded actively owned `interrupted` records from recovery candidates.
- Added Core, CLI, and Server regression coverage plus bilingual lifecycle docs.

### round 61: resumable Loop recovery shutdown
- Distinguished explicit user cancellation from background-owner teardown so
  closing a server leaves its active automatic Loop recovery `interrupted` and
  resumable on the next start.
- Prevented lifecycle interruptions from being recorded as failed skill
  outcomes, while preserving existing `cancelled` behavior for CLI, TUI,
  Desktop, REST, and WebSocket user stops.
- Added Core cancellation-path and Server integration regression coverage.

### round 60: idle Loop recovery
- Added opt-in `seekforge serve --loop-auto-resume` recovery for orphaned and
  interrupted durable Loops, with delayed recurring checks, sequential
  workspace processing, retryable failures, non-overlap, cancellation, and
  structured completion/failure logs.
- Added a non-blocking Server coordinator path that reserves the physical
  repository queue and checks process-visible session activity before starting
  background work.
- Kept automatic model calls and edits disabled by default, and added Core,
  Server, and CLI lifecycle regression coverage.

### round 59: retryable Loop delivery
- Added a strict persisted delivery lifecycle for passed Loops, including mode,
  status, attempt count, bounded errors, and final branch/path/PR artifacts.
- Added `loop-deliver` to retry a failed retained-worktree delivery without
  rerunning the agent or verifier, while preserving the original delivery mode.
- Serialized delivery with the Loop lifecycle lease so deletion and duplicate
  delivery cannot race external Git/PR side effects, and kept successful
  checkpoint worktrees clean after recording final delivery state.

### round 58: cross-process Loop controls
- Added `loop-pause`, `loop-continue`, and `loop-steer` CLI commands for safely
  controlling a Loop owned by another live SeekForge process.
- Added a bounded, atomically written, cross-process-serialized control mailbox
  with per-run generation ids so late commands cannot leak into a resumed run.
- Hardened mailbox corruption, capacity, byte-budget, waiter cleanup, and
  concurrent-writer behavior with Core and end-to-end CLI regression coverage.

### round 57: requirement-aware Loop deep audit
- Hardened persisted requirement lifecycle validation so forged approval,
  acceptance, and pending-status combinations fail closed instead of bypassing
  confirm-mode approval.
- Wrapped repository-controlled verifier diagnostics in an explicit untrusted
  data envelope before adding them to continuation prompts.
- Retained Desktop requirement state independently of its bounded live event
  feed, and corrected pending-approval hints and warning labels across CLI/TUI.
- Required completed requirement-analysis/review sessions before accepting model
  output, prevented same-call pre-approval, and stopped cancellation from
  consuming an edit iteration.
- Made stale lease recovery serialized, included committed `HEAD` changes in
  no-progress detection, and rejected whitespace-only Loop inputs centrally.
- Unified the shared WS frame contract, represented confirm-mode pauses as
  non-failure `waiting` runs, and preserved Loop session identity across
  Desktop follow-ups, mock resumes, and detached TUI completion.
- Aligned decimal input grammar across CLI/TUI/Desktop and made REST Loop runs
  explicitly edit-only with an edit default.
- Added regression coverage and corrected stale bilingual TUI Loop examples.

### round 56: requirement-aware autonomous Loop
- Added `quick`, `analyze`, and `confirm` Loop requirement modes across Core,
  CLI, TUI, Server, and Desktop. Analyzed modes freeze a bounded structured
  specification before pre-checking and require a read-only evidence review in
  addition to a green verifier; confirm mode persists and pauses for approval.
- Requirement analysis/review usage counts toward the existing cost budget and
  survives resume. Structured model output is strictly validated, aggregate
  completion is derived from required criteria, and malformed output fails
  closed with conservative fallbacks.
- Added protocol validation, persisted-state compatibility, cross-surface UI,
  regression coverage, and bilingual Loop architecture/tutorial/reference docs.

### round 55: full-project boundary/edge-case review — 16 verified fixes
A parallel-subagent review of every subsystem for boundary bugs; each finding
verified before fixing (a claimed AST byte-vs-char offset bug was disproved by a
direct test and dropped). Landed in three batches:
- **Security/correctness:** `loop` command bypassed per-folder access consent
  (now gated like `run`/`repl`); `search_text`'s `.seekforge/sessions`
  self-pollution guard failed on a symlinked workspace (`/tmp`→`/private/tmp`);
  `run_command` corrupted multi-byte UTF-8 split across chunks (→ StringDecoder);
  server WS had no `error` handler so a bad frame crashed the process;
  `sessions prune --keep-last 0`/negative would delete all sessions.
- **Robustness:** `glob` threw an opaque SyntaxError on a bad pattern (→
  ToolError); MCP server advertised a stale protocolVersion; MCP SSE without a
  trailing blank line dropped a valid response; a hook timeout could hang the
  run if the kill didn't land; surrogate-pair splits in the CJK bigram tokenizer
  and hook-context slice; `authorizeDir` idempotency wasn't ancestor-aware; TUI
  pager `G`/scroll ran past the useful offset (dead-zone of wasted keystrokes).
- **Compaction (the two deferred design items):** when an entire turn is one
  assistant message + many tool results, nothing can be dropped without orphaning
  a tool call, so compaction returned null even when over budget — added
  `shrinkToolResultsToFit`, a last resort that truncates the oversized tool
  payloads in place (no message dropped) so the provider isn't handed an
  over-budget request. `budgetTokens` floored at 1 so a pathologically small
  window can't yield a zero/negative budget.
- **Test reliability:** the auto-verify finalize-gate tests spawned a real
  `pnpm test` subprocess against a 5s limit (flaky under load) → `exit 1`.
- Verified: core 989 · tui 679 · server 194 · cli all · workspace typecheck clean.

### round 54: round-52 verdict — ran the A/Bs, kept what earns its cost
- **Measured all three round-52 levers** (deepseek-v4-flash), recorded in
  `evals/round-52-measurements.md`. Verdict: **auto-verify** positive (fewer
  turns, ~30% cheaper → stays default-on); **retrieval** no gain on greppable
  tasks but **wins 3/3 reps** on a deliberately grep-noisy ask task (→ stays
  default-on, value concentrated on hard navigation); **review-gate** adds cost
  with no measured benefit even on a fixture built to need it (→ stays opt-in).
- **Found the eval suite couldn't exercise the orientation features**: every
  prior fixture is under the 40-code-file retrieval floor (and the 150-file
  repo-overview floor), so neither ever fired in evals. Added fixtures that do:
  `cjk-buried-discount`/`cjk-buried-retry` (48 files), `cjk-large-paginate` (159
  files, triggers both), plus discriminators `cjk-find-checkout` (retrieval,
  grep-noisy ask) and `cjk-review-edge` (review, hidden edge-case check). All are
  Chinese (code-switched) prompts.
- **Eval harness**: new `injectRelevantFiles` core dep + `autoVerify`/`model`
  forwarding; A/B variants `no-retrieval`, `review-gate`, `no-auto-verify`,
  `model-pro`; fixed the CLI to tolerate the `--` that `pnpm … eval -- <flags>`
  forwards. Docs (EVALS.md, configuration.md) updated with the findings.

### round 53: measure round 52 — A/B toggles + verify-output/internal polish
- **Eval A/B toggles for the round-52 capabilities.** New core dep
  `injectRelevantFiles` (default on) gates the task-relevant shortlist, mirroring
  `injectMemory`; the eval factory now also forwards `autoVerify`. New A/B
  variants `no-retrieval`, `review-gate`, and `no-auto-verify` let
  `--ab control,no-retrieval` (retrieval), `--ab control,review-gate` (final
  review), and `--ab verify-gate,no-auto-verify` (auto-run) put real numbers on
  whether each capability helps — addressing the "wants dogfooding" note.
- **Smarter auto-verify output.** A failed verify now feeds back a digest that
  surfaces failure-signal lines (FAIL/Error/AssertionError/…) pulled from the
  omitted middle, so a buried failing assertion isn't lost to an even head/tail
  cut (`digestCommandOutput`).
- **Internal.** The two "drain the event queue while awaiting an outcome" loops
  (tool-call + finalize-reviewer) share one `drainUntil` helper.
- Verified: core 986 · eval-harness 56 · workspace typecheck + tests clean.

### round 52: transparent agent capability — retrieval, auto-verify, reviewer subagent
- **Task-relevant file retrieval (auto-injected).** Alongside the generic repo
  overview, the loop injects a **task-targeted** shortlist at session start
  (top-level runs): code files ranked by lexical overlap of their path + symbol
  outline with the task, each with a one-line outline. Reuses the memory-brief
  tokenizers (CJK tasks work). A cheap orientation hint, not a search engine —
  content-only relevance still needs `search_text`; nothing is injected for small
  trees, generic tasks, or when nothing clears the relevance floor.
- **Auto-verify on completion.** `verifyCommand` is no longer just a nudge: by
  default (`autoVerify`) the loop **runs it itself** on the finish turn and feeds
  the real result back — a pass is accepted, a failure continues with the captured
  output so the agent fixes the cause. Degrades to the nudge on `autoVerify:false`
  or when the command can't run.
- **Reviewer subagent on completion.** With `finalizeReview` on and a reviewer
  specialist available (a built-in), the loop **dispatches the reviewer** (fresh
  context, read-only) instead of asking the model to self-review, and feeds its
  findings back. Degrades to the self-review nudge when no reviewer is wired in.
- **Code-aware compaction.** `read_file` truncation of large code files now cuts
  on **construct boundaries** (whole functions/classes via tree-sitter ranges)
  instead of mid-function, with a line-aware fallback; offsets are UTF-16-safe
  (verified on CJK sources).
- **Why these three:** all are **transparent** — they take effect without relying
  on the model to adopt a tool/lever (the failure mode of earlier add-ons). Net
  value on real tasks still wants dogfooding; not claimed as a measured win.
- **Config.** New `autoVerify` (default on when `verifyCommand` is set).
- **Review hardening.** A failed auto-verify now re-runs after the model edits
  again (and only then — a finish with no new edit is accepted, so it can't spin
  on an unfixable command). Task-relevant retrieval matches path tokens on
  component boundaries (no `index.ts` → `reindex.ts` false hits), and the repo
  overview + retrieval now share a single tree walk per run.
- Verified: core 980 · cli typecheck · workspace typecheck clean. (11 new tests:
  retrieval 6, auto-verify 4, reviewer auto-dispatch 1.)

### round 51: code navigation, finalize gate, durable plans
- **Code navigation tools.** New `repo_map` (compact structural overview —
  directory rollup + per-file symbol outlines; auto-injected into the system
  prompt for repos > ~150 files) and `find_definition` (locate a symbol's
  declaration, not every mention). Symbol extraction is a **hybrid resolver**:
  tree-sitter (accurate, comment/string-aware — JS/TS/JSX/TSX, Python, Java,
  Rust, Go, C, C++, C#) with a dependency-free **regex floor** for other
  languages and on any parse/extraction failure. `web-tree-sitter` +
  `tree-sitter-wasms` are **optionalDependencies** (graceful degrade to regex).
- **Finalize gate.** When the model declares done, a one-time transient nudge can
  surface the highest-priority unmet check: finish open plan steps, run the
  `verifyCommand`, or self-review the diff. Each kind fires once (bounded);
  skipped on the last turn so it never converts a completion into a failure.
- **Durable plans (long-horizon).** `update_plan` is persisted to `session.json`,
  restored into the system prompt on resume, and re-injected after mid-run
  compaction — a task's checklist now survives across resume and compaction.
- **Premature-finish guard (opt-in `guardNoProgress`).** Nudge an edit-mode run
  that declares done with no changes and ~no tool calls; skipped on resume.
- **CLI/config.** New config keys `maxCostUsd`, `verifyCommand`, `finalizeReview`,
  `guardNoProgress`; `--max-cost <usd>` now works with `-p` (not just `run`);
  `maxCostUsd` is type-validated. `seekforge replay <session>` re-renders a stored
  session's events (no model calls). Tool-choice guidance steers toward
  `repo_map`/`find_definition` instead of grep-first.
- **Eval harness.** Harder discriminating tasks (multi-file rename+signature,
  param-threading, buried-bug-at-scale, CSV/expr/multi-bug); `--task` accepts a
  comma-separated subset; new `verify-gate` and `no-progress-guard` variants for
  A/B.
- **Fixes:** whitespace-tolerant `apply_patch` fallback; CJK-aware token estimate;
  WASM tree memory leak in the AST backend; `.h` headers parsed as C++.
- **Honest notes:** the behavioral levers (`verify-gate`, `finalizeReview`,
  `guardNoProgress`) are **opt-in** — eval A/B showed no pass-rate gain and ~+10%
  cost on verify-prompted task sets. Dogfooding a real ~1100-file repo: `repo_map`
  orientation gets adopted; `find_definition` adoption from prompting alone is
  weak (the model often prefers `search_text`, which works). Tools are
  available-not-forced; no measured efficiency win is claimed.
- Verified: core 954 · cli · eval 52 · server 194 · tui 679 · workspace typecheck
  clean · desktop build clean.

### round 50: loop engineering — desktop loop panel
- **Loop mode in the chat.** A collapsible Loop panel at the top of the chat
  window: an explanation line, task + verify-command inputs, max-iterations +
  budget, and Run/Stop. Progress streams live (per-iteration run cost + verify
  pass/fail + output tail; a status summary on completion).
- **Server WS:** new `{type:"loop", task, verifyCommand, maxIterations?, budget?,
  ws?}` client frame runs `runAutoLoop` (acceptEdits) and streams
  `{type:"loop.event", event}` back, ending with `idle`; `cancel` aborts.
  Permission/question prompts during the loop's runs use the existing modals.
  `createDefaultAgent` factored into `buildAgentDeps` + `runDefaultLoop` (a
  testable `RunLoopFn`). Built by two parallel agents (server / desktop) against
  a fixed WS contract; SERVER-API.md updated.
- Verified: typecheck clean; server 184 (+4) / desktop 261 (+12) tests; build clean.

### round 49: loop engineering (auto-loop) — core + CLI
- **Autonomous run → verify → continue.** New core `runAutoLoop` (`@seekforge/core`)
  drives one task to "green" across multiple runs: it runs the agent, runs a
  verification command, and if it fails feeds the output back and continues —
  fully autonomously — until the command exits 0 or a guardrail trips. The whole
  loop is one resumed session (auditable, rewindable).
- **Guardrails (all default-on):** max iterations (default 8), a cumulative cost
  cap (`--budget`), no-progress detection (identical verify output → stop), and
  cooperative cancel (`Ctrl-C`/AbortSignal). Result status is one of passed /
  exhausted / no_progress / budget / cancelled / verify_error.
- **CLI:** `seekforge loop "<task>" --verify "<cmd>" [--max-iters N] [--budget $X]
  [-y]` — streams per-iteration progress; runs at `acceptEdits` (edits
  auto-approved, dangerous commands still refused); exits non-zero unless the
  verify passed. Built by two parallel agents (core / cli) against a fixed
  exported contract. See `docs/loop-engineering.md`.
- Verified: typecheck clean; core 819 (+8) / cli loop 11 tests; `loop --help` wired.
  TUI/desktop surfaces deferred.

### round 48: desktop file browser, source control, ⌘K palette, custom commands
Closes the remaining desktop gaps vs Claude Code / Codex. Built by two parallel
agents on disjoint trees (backend+TUI / desktop) against one REST contract.

- **File browser + viewer + editor.** New Files view: a workspace file tree
  (`GET /api/tree`, lazy-expand), a text viewer (`GET /api/file`), and edit/save
  (`PUT /api/file`) — all containment- and denylist-checked (no `.env`/keys, no
  escaping the workspace). Doubles as the rules editor (open `AGENTS.md`).
- **Source control.** New Git view: `git status` grouped staged/unstaged with
  stage/unstage, commit, and (confirmed) discard — `GET /api/git/status` +
  `POST /api/git/{stage,unstage,discard,commit}` (never pushes; "not a git repo"
  empty state).
- **Custom slash commands.** Core `loadUserCommands` reads `.seekforge/commands/
  *.md` (project + user); `GET /api/commands` surfaces them; the desktop
  composer merges them into its slash menu. (The TUI already supported these.)
- **Manual `/compact`** in the desktop chat (`POST /api/sessions/:id/compact`),
  matching the TUI/CLI.
- **⌘K command palette**: fuzzy quick-switcher over views + actions (matches the
  label and the id, so "git" finds Source Control).
- Localization (en + zh) for all new surfaces; mock API covers every endpoint.
- Verified: typecheck clean (8 packages); tests core 810 / server 180 /
  desktop 249 / tui 667 / eval 45; desktop build clean.

### round 47: desktop chat UX — live controls, run toolbar, unified dropdowns
- **Approval mode (and edit/ask) changeable mid-conversation.** The selectors
  were locked for the whole session and the server's `send` hardcoded
  `approvalMode:"confirm"`; now the send frame carries `approvalMode`/`mode`,
  the server honors them, and the controls stay live whenever the tab is idle
  ("plan" remains start-only).
- **Run controls moved below the composer.** Workspace, model, thinking,
  sandbox, run mode, and approval now live in one toolbar under the chat input
  (the header keeps only title/session/status + actions); the workspace menu
  left the sidebar for this toolbar. Sandbox is a dropdown that writes the
  `sandbox` config; thinking collapses on/off + effort into one control.
- **Unified dropdown.** New `Select` component (a styled popover, not a native
  `<select>`) used everywhere — every dropdown across Chat/Settings/Memory now
  shares one modern, theme-consistent look.
- **Resume actually continues.** A session's primary action now loads the full
  transcript into a live chat tab so you can keep asking (it previously opened a
  read-only preview); a separate "View details" button keeps the read-only view.
- **Agents "Ask" works.** It was a no-op (opened details); it now seeds the chat
  composer with a delegation prompt for that subagent and jumps to chat.
- (Session delete shipped in round 46; verified present.)
- Verified: typecheck clean (8 packages); tests server 161 / desktop 230 /
  core 805 / tui 667 / eval 45; desktop build clean.

### round 46: desktop capability parity with the CLI/TUI
Closed the desktop's management gaps so the GUI can do what the CLI/TUI can.
Built by two parallel agents on disjoint trees (server/core vs desktop) against
one shared REST contract, then verified end-to-end (shapes aligned).

- **Memory hygiene:** `GET /api/memory/stats` (extraction-quality stats) and
  `POST /api/memory/compact` (dedup + `pruneUnusedDays`); MemoryView gains a
  stats panel and a dry-run→apply compact control.
- **Skill management:** `PUT /api/skills/:id` (enable/disable), `POST
  /api/skills` (scaffold), `POST /api/skills/import`, `DELETE /api/skills/:id`
  (builtins are read-only, enforced server-side); SkillsView gains toggles,
  New/Import, and delete.
- **Sessions are deletable + prunable:** `DELETE /api/sessions/:id` (new core
  `deleteSession`) and `POST /api/sessions/prune`; SessionsView gains a per-row
  Delete and a "Prune old…" control.
- **Subagent import:** `POST /api/agents/import`; AgentsView gains Import.
- **MCP server management:** `POST /api/mcp` / `DELETE /api/mcp/:name` edit the
  workspace config; SettingsView's MCP section gains add/remove.
- **More settable config:** `planModel`, `escalateOnFailure`,
  `memoryAutoApproveConfidence` now accepted by `setConfigValue` and surfaced in
  Settings (confidence validated 0..1).
- **Diagnostics view:** `GET /api/doctor` (api key / node / git / runtime / mcp
  / model checks) behind a new sidebar "Diagnostics" view.
- Verified: typecheck clean (8 packages); tests core 805 / server 160 /
  desktop 230 / tui 667 / eval-harness 45; desktop build + `pnpm audit` clean.

### round 45: desktop workspace selection + diff resilience
- **Open/switch/recent workspaces (desktop).** The sidebar workspace control is
  now a full menu: switch between hosted workspaces, **Open folder…** (native
  picker in the Tauri shell via `tauri-plugin-dialog`; manual path input as a
  browser fallback), reopen a **Recent** project, and remove/forget entries.
  Recents persist server-side at `~/.seekforge/workspaces.json`
  (`SEEKFORGE_HOME`-overridable). New REST: `POST /api/workspaces` (open a
  folder), `DELETE /api/workspaces/:id` (stop hosting), `DELETE
  /api/workspaces/recent` (forget); `GET /api/workspaces` now returns
  `{workspaces, recents}`. The last project is remembered (by path) and
  auto-reopened on relaunch.
- **Diff view no longer errors on a non-git workspace.** `GET /api/diff` returns
  a clean `notGit` flag instead of throwing `git diff failed: …not a git
  repository`; the desktop shows a friendly "Not a git repository" notice. A
  missing git binary still surfaces as a real error.
- **Bug fixes found in review:** removing a workspace no longer offers to "stop
  hosting" a **worktree** (`wt-*`) — that would orphan its git checkout; the
  server rejects it and the menu hides the action. Removing a hosted workspace
  now closes any tabs bound to it (avoids 404s against a dead workspace id).
- **Desktop bundle identifier** renamed `com.seekforge.app` → `com.seekforge.desktop`
  (the `.app` suffix conflicts with the macOS bundle extension).
- Verified: typecheck clean (8 packages); tests server 139 / desktop 217;
  `cargo check` clean (capability `dialog:allow-open` valid); `pnpm tauri build`
  produces the DMG.

### round 44: low-end-model audit — fix every finding, cross-entry parity
Ran the `docs/low-end-model-audit.md` deep procedure (config wiring, cross-entry
consistency, permission/security, agent loop/trace, release, UI state, deps,
docs) and fixed all P1/P2/P3 findings via parallel agents.

- **P1 — trace fidelity (regression introduced in round 38).** The agent loop
  traced the reflection nudge and the escalation note as `role:"user"` messages,
  breaking the *one-user-message-per-run* invariant (corrupting
  `truncateSessionAtUserTurn` / checkpoint-turn indexing on resume/backtrack).
  Both are now transient (`messages.push` only, no `trace.message`), like the
  wrap-up nudge. Added tests asserting the trace holds exactly one user message.
- **P1 — CLI dropped 6 of 9 hook stages.** `loadConfig` merged only
  `preToolUse`/`postToolUse`/`sessionEnd` then spread the result last, silently
  dropping `sessionStart`, `userPromptSubmit` (a blocking/context-injecting
  stage), `preCompact`, `stop`, `subagentStop`, `notification`. Now merges all
  nine, mirroring the TUI. (+regression test.)
- **P1 — server ignored `permissionRules`.** The desktop/web path never read,
  merged, or passed users' deny rules to the agent — a deny they relied on did
  nothing. `ServerConfig` now carries `permissionRules`, `loadConfig`
  concatenates them across layers (project-first), and `createDefaultAgent`
  passes them to `createAgentCore`. (+tests.)
- **P2 — TUI config parity.** Reads the documented flat `planModel` key (was
  only nested `routing.planModel`; flat now wins, nested kept for back-compat)
  and wires `memoryAutoApproveConfidence` into the core deps like the CLI.
- **P2 — skip memory usage bump on resume.** `recordFactUse` no longer fires
  when resuming a session, so resumes don't inflate the usage stats `memory
  stats` reports.
- **Desktop resilience.** Global server-unreachable banner with Retry
  (`bootError`/`retryBoot`), fail-loud on missing bundled web resource (was a
  silent fallthrough), chat-header/footer/tool-row overflow fixes, `boot.*`
  i18n (en+zh).
- **Release.** `bundle.targets` scoped to `["app","dmg"]`; `build:sidecar`
  honors `SIDECAR_TARGET` for cross-arch builds (+RELEASING.md note).
- **Docs.** `configuration.md`: `sandbox`/`compaction`/`thinking`/
  `reasoningEffort` *are* settable via `config set` (corrected the false "No"),
  documented the `models` key, and fixed the hooks-merge description (all stages
  concatenate now). `apps/cli/README.md`: default model is `deepseek-v4-flash`
  (`deepseek-chat` is deprecated). README: documented `search_memory`, `memory
  stats`, and `memory compact --prune-unused`.
- **Deps.** Removed dead `ink-text-input` from the TUI.
- Verified: typecheck clean across all 8 packages; tests core 805 / tui 667 /
  server 131 / desktop 217 / eval-harness 45 / cli all suites; `pnpm audit`
  clean.

### round 43: memory extraction — measure first, then the safe levers
- **`memory stats` (the gate).** New core `memoryStats(workspace)` + `seekforge
  memory stats` command: extraction **precision proxy** (% of approved facts ever
  used, via fact-meta), candidate **rejection rate**, and **confidence↔usage**
  (avg model confidence of used vs unused facts) — the empirical calibration
  signal. This subsumes the "feedback loop" and "confidence calibration" ideas
  as *data for a human* rather than speculative auto-tuning/calibrators.
- **Better long-session digest.** `buildTranscriptDigest` now keeps HEAD + TAIL
  and prioritizes signal lines (errors/decisions/tool results) within the same
  6 KB cap, so facts buried in long sessions aren't dropped (short sessions stay
  byte-identical).
- **Confidence auto-approval (opt-in, default OFF).** `memoryAutoApproveConfidence`
  (config + `AgentCoreDeps`): extracted facts with confidence ≥ threshold (after
  injection + dedup filters) go straight to project.md; below stay pending. Off
  by default — **enable only after `memory stats` shows extraction precision
  holds**, or you'd scale noise.
- Deliberately **not** done: automatic prompt-tuning from rejections, a
  confidence calibrator (both need ground truth — `memory stats` gives the human
  the data instead), and the doc-bootstrap bulk-distiller (uses the same
  distillation — do it once `memory stats` validates extraction quality).
- Verified: core 801 / cli 74 / server 127 tests; typecheck clean; `memory
  stats` smoke-tested on this repo.

### round 42: memory — close the last Claude-parity gaps
- **`search_memory` tool (agentic memory access).** A read-only (L0, available in
  ask + edit) builtin that lets the agent query its memory ON DEMAND mid-task —
  not just via the auto-injected brief at session start. Merges project + global
  + subdir facts, ranks against the query (reusing the brief's scorer, no
  char-cap), tags each hit with its source. This is Claude's "memory tool"
  pattern — and the right scaling answer instead of embeddings.
- **Path-scoped subdir `AGENTS.md` cascade.** Rules from a subdirectory's
  `AGENTS.md` are now merged, but ONLY when the task references a path under that
  subdir (via task path tokens) — closing Claude's monorepo per-directory rules
  behavior without bloating the always-loaded rules prompt. `collectProjectRules`
  gained an optional `task` arg (back-compat; caller threads `input.task`).
- Held the line: **semantic/embedding retrieval** stays deferred (eval-gate;
  `search_memory` covers the same need the Claude way), and an **enterprise/
  managed-policy tier** is not built (no real demand). Inline `#` capture is
  already covered by `/remember` + the desktop add-fact form.
- Net vs Claude Code: structure (global/subdir/import), lifecycle, measurement,
  and now agentic access are all at parity or ahead; SeekForge additionally
  auto-extracts facts, tracks usage/age, prunes, and is eval-measurable.

### round 41: memory growth + eval discrimination + TUI/desktop polish + release wiring
- **Memory (A):** subdirectory-cascade — `buildMemoryBrief` now also merges
  `*/.seekforge/memory/project.md` from subdirectories (bounded scan, excludes
  node_modules/.git/dist/etc.), so monorepo packages can carry their own facts
  (path-token relevance surfaces the right one). Raised the injection budget
  (SMALL_CORPUS 12→20, MAX_BULLETS 8→12, MAX_CHARS 800→1200) as the corpus grows.
  Also bootstrapped the corpus by distilling ~/.claude project notes into
  `.seekforge/memory/project.md` (12 facts) + global `~/.seekforge/...` (3).
- **Eval (B):** +5 discriminating tasks (32 total) — staged-rollout refactor,
  half-even rounding, buried feature flag, cross-module settlement bug,
  extend-without-regress — each verified fail-on-pristine / pass-on-solution, so
  the eval set can finally show A/B signal. (Live discrimination run = paid
  follow-up.)
- **Desktop polish (B):** fixed two real light-theme color bugs (`UsageFooter`
  `bg-zinc-800`, `TabBar` `bg-orange-400`), added `focus-ring`/`aria-label`
  across TabBar/Sidebar/ChatView/PermissionModal, wired the retry banner to i18n,
  aligned Diff/Evolution/Settings titles. Zero hardcoded colors remain.
- **TUI polish (B):** routed hardcoded chrome strings through the i18n layer
  (incl. a previously-unused `permission.*` key set), en/zh parity 70/70,
  verified all keybinding hints match the keymap.
- **Release (C):** the desktop release workflow now bun-compiles the per-target
  CLI sidecar before `tauri-action` (cross-platform self-contained bundles). The
  sidecar was re-verified to serve standalone after the core changes.
- Verified: `pnpm -r typecheck` 0; core 772 / desktop 217 / tui 662 / server 127
  / eval-harness 45 tests; `pnpm audit` clean.
- Deferred (with reasons): updater real signing key (user secret); a full
  `pnpm tauri build` / end-to-end DMG launch (heavy + GUI — runs in CI on tag, or
  locally); desktop Settings toggles for the experimental engine flags (gated on
  eval proving them); memory confidence-auto-approve / doc-bootstrap script /
  `search_memory` tool (corpus-growth levers — do when the corpus warrants).

### round 40: memory — close the Claude/Codex gaps
- **Global (cross-project) fact memory** (`memory/brief.ts` + `store.ts`):
  `buildMemoryBrief` now merges the project's `project.md` with a global
  `~/.seekforge/memory/project.md` (overridable via `SEEKFORGE_HOME` for tests),
  deduped, project-wins-ties. Global facts are included by relevance only (the
  always-include `[command]`/`[tech]` rule stays project-scoped) to avoid
  cross-project noise.
- **`@import` composition**: memory files may inline other files via `@<path>`
  (resolved relative to the file; absolute/`..`-escape refused, missing skipped,
  cycle- and depth/size-capped).
- **fact-meta reconcile**: compaction now drops orphaned `fact-meta.json` entries
  whose bullet no longer exists (after dedupe/merge/hand-edit).
- **CLI `memory compact --prune-unused <days>`**: surfaces the P2 archive of old,
  never-used facts (+ en/zh i18n).
- **Desktop Memory page**: shows each approved fact's lifecycle (used N · added
  age, with subtle never-used/stale flags) and lets you delete a fact or add one
  directly. New server routes: `GET /api/memory` returns `facts` with lifecycle;
  `POST`/`DELETE /api/memory/fact`.
- Deliberately **not** done (with reasons): subdirectory-scoped fact cascade
  (needs a file-vs-task scoping design decision), semantic/embedding retrieval
  (premature for the current small corpus — eval-gate first, per round 36's
  lesson), and code-validation of facts (research-grade; a weakness shared with
  Claude/Codex, not a gap).

### round 39: self-contained desktop bundle + dependency-audit to zero
- **Dependency audit: 9 → 0 vulnerabilities** (`pnpm audit` vs the official
  registry). Desktop bumped `vite` 5→8 (rolldown, drops the bundled esbuild),
  `@vitejs/plugin-react` 4→5, `vitest` 3→4; `vitest` 3→4 across core / tui /
  server / eval-harness; `tsx` →4.22, `tsup` →8.5; and a root
  `pnpm.overrides: { "esbuild": ">=0.28.1" }` to unify the rest. All 7 packages
  typecheck; every suite passes; the desktop build + screenshot smoke-test pass.
- **Self-contained desktop bundle (CLI sidecar).** The DMG no longer needs a
  system-installed `seekforge`: the CLI is compiled to a single native binary
  with `bun build --compile` and shipped as a Tauri `externalBin` sidecar
  (`apps/cli` gained a `build:sidecar` script; binary is git-ignored ~70MB). The
  Rust shell prefers the sidecar (env override > sidecar > dev repo/PATH
  fallbacks — dev unaffected). Two compile blockers fixed: `package.json`
  version reads made fail-soft (don't exist on bun's virtual FS), and the web UI
  is shipped as a Tauri resource with the shell passing `SEEKFORGE_STATIC_DIR`
  to the sidecar (a compiled binary can't find dist via `import.meta.url`). The
  sidecar was verified to serve the full UI standalone; `cargo check` + 20 Rust
  tests pass. NOT yet verified: a full `pnpm tauri build` / end-to-end DMG launch
  (the in-bundle layout relies on Tauri's documented convention).

### round 38: audit fixes — parity, fidelity, and honest defaults
- **Server/desktop now wire hooks** (#1): `ServerConfig.hooks` is read and passed
  to the agent, so the 9 hook stages fire on the desktop path too (was CLI/TUI
  only).
- **README `config set` corrected** (#2): only scalar/array keys are settable;
  `permissionRules`/`hooks`/`mcpServers`/`planModel` are edited in
  `config.json` (they were never accepted by `config set`).
- **Desktop updater no longer pretends** (#4): a `UPDATER_ENABLED` const (false)
  skips the per-launch update check while the placeholder pubkey ships, so there
  are no misleading "checking/failed" update logs for a non-updatable build.
- **planModel reasoner guard on the server** (#5): `deepseek-reasoner` (no tool
  calling) now falls back to the default model on the server too, matching
  CLI/TUI; documented in `docs/configuration.md`.
- **Harness nudges are traced** (#6): the stuck-reflection and escalation
  messages are written to the JSONL trace, so replay/audit matches what the
  model actually received.
- **Stuck detection is order-independent** (#7): the repeated-failure signature
  canonicalizes argument JSON (sorted keys), so reordered-but-equal args still
  match. Test added.
- **TUI gained `escalateOnFailure`** (#8): config + factory parity with
  CLI/server/eval.

### round 37: memory — measure it, then close the Claude/Codex gaps
Prioritized by value ÷ (cost × risk), and measured (the lesson from round 36).
- **P0 — made memory measurable.** Added an `injectMemory` dep (default on;
  `AgentCoreDeps` + eval `no-memory` variant) and a memory-discriminating eval
  fixture/task (`memory-convention-recall`): a `nowIso()`-not-`new Date()`
  convention that exists ONLY in seeded `.seekforge/memory/project.md`. A/B
  result: **memory-on passed 3/3, memory-off failed** (used `new Date()`) — a
  feature that demonstrably helps on a task built to need it. Loop test:
  `tests/agent/memory-inject.test.ts`.
- **P1 — recall: small-corpus inject-all** (`memory/brief.ts`). When the whole
  approved-fact set is small (≤12 bullets, fits the budget) the relevance floor
  is skipped and everything is injected — a lexically-missed-but-relevant fact
  is worse than a little extra context (matches how Claude/Codex always load
  their file). The floor still applies once memory grows large.
- **P2 — fact lifecycle** (`memory/store.ts` + `compact.ts`). A sidecar
  `fact-meta.json` records `addedAt` on approval and `uses`/`lastUsedAt` whenever
  a fact is injected; `compactProjectMemory({ pruneUnusedDays })` archives old,
  never-used facts to `project-archive.md` (facts without metadata or with uses
  are left alone). Tests: `tests/memory/lifecycle.test.ts`. (Payoff is gated on
  memory growing large — same reasoning that deprioritized embeddings/RAG, which
  stay deferred until the corpus warrants them.)

### round 36: "think more" — harness levers to lift a weaker model
Prompt/loop changes to make the model reason more before acting. The always-on
parts are conservative; the behavior-changing parts are **opt-in (default off)**
and should be eval-gated before enabling.
- **System prompt** (`agent/prompt.ts`): edit mode now asks for a one-line
  hypothesis + minimal change before the first edit; plan mode weighs 2–3
  approaches and picks one with a rationale.
- **Tool docs** (`tools/builtins/{fs,command}.ts`): `apply_patch` spells out the
  exact-match/unique-match contract with a worked example (cuts malformed
  patches); `run_command` clarifies `background:true` usage.
- **Skills** (`skills/builtins.ts`): sharper procedures for bugfix /
  test-failure-fix / verify-change / code-review / small-code-change.
- **Compaction digest** (`agent/context.ts`): preserves remaining work, the
  *why* of decisions, exact identifiers, and failed approaches.
- **Stuck detection** (`agent/loop.ts`, always on): a tool call that fails again
  with identical args injects a one-time reflection nudge ("you're looping —
  re-read, change approach"), mirroring the transient wrap-up nudge.
- **Failure escalation** (config, default off): wired `planModel` from config
  (also fixes `/plan` routing, previously unwired in the CLI) on **both** the CLI
  (`CliConfig` → agent-factory) and the **server** (`ServerConfig` →
  `apps/server/src/agent.ts`, so the desktop honors it), plus `escalateOnFailure`
  — hand the run to `planModel` once it loops on an identical failed call. Tested
  in `tests/agent/escalation.test.ts`.
- **Measured everything, then pruned.** Ran the eval harness A/B:
  - `control` vs a prototype `autoReview`+`planFirst` variant: the levers **lost
    26/0/0** — same pass rate (already 100%), equal-or-worse scores, ~+60% turns
    and cost, and `autoReview` sometimes degraded a correct solution. **Removed
    both** (kept the failure-only `escalateOnFailure`, which can't add overhead to
    healthy runs).
  - current `control` vs the 2026-06-12 baseline: the always-on changes above
    show **no score regressions** (a couple +1/+2) and **lower cost**, so they
    stay.

### round 35: desktop UI redesign (Codex-style light theme)
- **Light theme is now the default.** Inverted the palette so `:root` is light
  and dark is opt-in via `<html data-theme="dark">` (theme switcher + tests
  updated). Retuned to the spec palette: blue accent `#2563eb`/`#3b82f6`,
  surfaces `#f8fafc`/`#ffffff`, gray text/borders. The native window's initial
  background now matches (`#f8fafc`) so there's no dark first-frame flash.
- **Redesigned every screen** to a Codex/Linear/Raycast feel: a new chat home
  (welcome card + quick-action starters + live recents), card-based Sessions,
  Diff, Skills, Agents, Memory, Evolution and grouped Settings, a styled right
  todo panel, and a cleaner toolbar (pill mode/approval groups). Sidebar widened
  to 220px with a blue active-nav highlight.
- **Composer action bar.** Surfaced the previously keyboard-only features as
  labelled pills (`@` files, `/` commands, a thinking toggle) plus an attach
  button and a real send button — all wired to the existing palettes/upload.
- **Cross-page consistency pass.** Standardized header padding/title sizes,
  left-aligned all page content with its header (removed mismatched centering),
  and added a `stacked` Settings row so multi-line fields (models, allowlist)
  render full-width instead of a cramped sliver. Home grids use CSS container
  queries so they collapse to one column when the content area is narrow.
- **Desktop robustness.** The serve-command PATH search is augmented with the
  common global-bin dirs (npm-global/homebrew/volta/yarn/bun/nvm) so a bundled
  app finds an `npm i -g seekforge` install despite the minimal macOS GUI PATH;
  the error dialog now suggests `npm install -g seekforge`. The auto-updater is
  opt-in (`createUpdaterArtifacts: false` + placeholder pubkey) so `tauri build`
  succeeds without a signing key — see `apps/desktop/docs/RELEASING.md` to
  enable it. i18n (en + zh) added for all new strings.

### round 34: security/correctness audit fixes
- **High — `rm -R -f` / `rm -Rf` bypassed the dangerous-command denylist.** Both
  the TS classifier and the Rust runtime only matched lowercase `rm -rf`/`-r -f`
  in order, so capital-R, reordered, or long-form (`--recursive --force`)
  recursive force-deletes could run as ordinary `execute` (auto-approved under
  `-y`). Replaced with an order-independent, case-aware, long-form-aware check
  (short bundles parsed char-by-char; long flags by exact match so `--force`,
  which contains an "r", isn't read as recursive). Added positive + negative
  tests on both sides.
- **Medium — malformed URL paths could hang an API request.** `decodeURIComponent`
  ran before the request handler's try/catch, and the dispatch used
  `void handleApi(...)` with no catch, so a bad percent-encoding (e.g.
  `/api/%E0%A4%A`) rejected without ever answering the client. Now the decode is
  guarded (→ 400 bad_request) and the dispatch has a defensive `.catch` (→ 500).
- **Low — npm tarball omitted the LICENSE.** Added `LICENSE` to apps/cli and its
  `files[]`; `npm pack` now ships `package/LICENSE`.

### round 33: headless/SDK-parity CLI flags
Closes the remaining Claude-CLI flag gaps (all SDK/automation-oriented):
- `--dangerously-skip-permissions` — alias for `-y` (auto-approve everything).
- `--mcp-config <file>` — load MCP servers from a JSON file for the run
  (`{mcpServers:{…}}` or a bare `{name:server}` map), merged over the config
  file's servers; `--strict-mcp-config` uses ONLY the file's (ignores config).
- `--replay-user-messages` — with `--input-format stream-json`, echo each user
  turn back as a `{type:"user"}` stream event.
- `--include-partial-messages` — with `--output-format stream-json`, emit
  assistant text deltas as `content_block_delta` stream events.
- `--permission-prompt-tool` is intentionally NOT added: it requires routing the
  permission-confirm path through an MCP tool execution (architecturally
  invasive) for the lowest-value, SDK-only case, and can't be verified against
  Claude's exact protocol here.

### round 32: configurable model list (pickers read it, not just DeepSeek)
- New `models` config key (string[]) — your own list of selectable model ids.
  Server `setConfigValue` + CLI `config set` accept it (comma-separated, like
  commandAllowlist); GET /api/config returns it, defaulting to core's
  non-deprecated ids when unset so a picker is never empty.
- The desktop **chat-box model control is now a strict dropdown** reading
  `config.models` (no longer a hardcoded deepseek-v4 list); the active value
  stays selectable even if it's not in the list.
- Settings gains a **models list editor** (comma-separated) and the default
  `model` is now picked from that list. Add any id — including other
  OpenAI-compatible providers (set baseUrl + apiKey for those).

### round 31: native top-bar clicks + sandbox/engine settings in the UI
Two issues found running the native desktop app:
- **macOS overlay title bar ate clicks on the top toolbar** (tab bar, mode
  toggles, New session, "+" menu) — they sit at y=0, under the draggable
  title-bar zone, so clicks dragged the window instead. The content column now
  reserves a draggable strip at the top (matching the sidebar's `pt-9`), pushing
  the top chrome below the title bar so it's clickable. (Composer/sidebar were
  unaffected and always worked.)
- **The OS sandbox (and other engine knobs) couldn't be set from the UI** — only
  apiKey/model/baseUrl/runtimeBin/commandAllowlist were settable. Added
  `sandbox`, `compaction`, `thinking`, `reasoningEffort` to the writable config
  keys (server `setConfigValue` + CLI `config set`, with enum/boolean
  validation) and to the desktop Settings (dropdowns + a thinking checkbox). The
  sandbox badge in the toolbar remains a status display; you set it here.

### round 30: CLI i18n (English + 简体中文)
Completes the i18n work (TUI + desktop already done): the CLI's user-facing
chrome is now translatable.
- `apps/cli/src/i18n.ts`: TUI-style flat key→string tables with an English
  fallback; locale resolved once at startup (`config.locale` > `SEEKFORGE_LANG`
  > `LC_ALL`/`LANG` > en). Tables split into i18n/{common,repl,commands}.
- Translated: `fail()` messages + hints, the text-mode renderer labels, the REPL
  chrome (/help, prompts, status), and command output (status, sessions, models,
  doctor, memory, …). A `locale` config key is added.
- Deliberately NOT translated: `--help`/option text (kept English), and all
  machine output (`--output-format json`/`stream-json`, output-format.ts) stays
  byte-stable English so scripts keep parsing it.

### round 29: desktop i18n (English + 简体中文)
The desktop app had no i18n (all hardcoded English) while the TUI did. Added a
matching lightweight layer — no deps, a flat key→string table per locale with an
English fallback chain — now covering the whole desktop UI in **en + zh-CN**:
- `lib/i18n.ts` engine: `t()` / `useT()` (live re-render via `useSyncExternalStore`),
  `detectLocale` (stored choice > browser language > en), localStorage-persisted.
  String tables split by feature (i18n/common, i18n/views, i18n/chat).
- Every desktop component/view translated (sidebar, chat toolbar/stream/composer,
  permission + question modals, all 8 views, onboarding, todos, theme switcher).
- A language picker in Settings (en / 中文（简体）), live-switching like the theme.
- Built in parallel (3 dogfood sessions on disjoint file-groups) then reviewed:
  fixed a `t`/Todo variable shadow and pinned the locale in the renderer-free
  PermissionModal test (Node's navigator.language follows the OS, so the default
  was non-deterministic). Verified by screenshotting the running app in zh-CN.
- CLI i18n is the next wave.

### round 28: ship the web UI in the npm package + dev server resolution
Found by actually running the native desktop app (`pnpm tauri dev`): it printed
"web UI is not built" because the Tauri shell spawned the globally-installed
`seekforge`, which ships no UI.
- **`seekforge serve` now ships a web UI.** The published `seekforge` package
  excluded the desktop build, so `seekforge serve` (documented as "local web UI
  + agent API") only ever served the API. The cli build now copies the desktop
  `dist` into `dist/web`, `resolveStaticRoot` falls back to it, and
  `prepublishOnly` builds the desktop first — so npm installs get a real
  workbench.
- **Dev builds prefer the repo's server.** `resolve_serve_command` gains a
  `prefer_repo` flag (passed `cfg!(debug_assertions)`): a `tauri dev` from a
  source checkout now uses the repo's server (which serves the freshly-built UI)
  instead of an older `seekforge` on PATH. Release builds are unchanged.

### round 27: desktop UI design polish
A UI-design pass on the desktop app (the token system, themes, modals, and
button philosophy were already solid — these are refinements):
- **Unified iconography.** ~27 inline unicode glyphs used as icons in the chat
  stream (✻ thinking, ▸/▾ expand carets, ⤷ subagent, → arrows) are replaced with
  SVG icons (`IconSparkle`/`IconChevron`/`IconCornerDownRight`/`IconArrowRight`),
  so weight/baseline/color are consistent across platforms and CJK fonts.
  Genuinely-textual characters (streaming cursor ▌, `·` separators) are kept.
- **Tighter accent hierarchy.** The whale-blue accent was tinting too many
  secondary things; it's now reserved for the user's own messages and
  interactive elements. The "session completed" card uses the success color
  (`ok`); subagent/agent rows are neutral.
- **One micro type size.** Scattered `text-[9px]/[10px]/[11px]` (incl. an
  illegible 9px) collapse into a single `text-2xs` (11px) token in the Tailwind
  config.

### round 26: model-selection polish + REPL commands (Claude detail parity)
An audit vs Claude found stale deprecated-model defaults users would hit:
- **Desktop Settings could only pick `deepseek-chat`** — the dropdown omitted the
  actual default `deepseek-v4-flash` and `deepseek-v4-pro` entirely. Added a
  `GET /api/models` endpoint (server, sourced from core MODEL_PRICING/
  DEFAULT_MODEL/DEPRECATED_MODELS) that the SettingsView fetches: active models
  selectable (default marked), deprecated ones disabled and labelled.
- **`seekforge init`** scaffolded `model: "deepseek-chat"` (deprecated); now uses
  `DEFAULT_MODEL` from core (deepseek-v4-flash).
- **REPL** `/model` help no longer suggests the deprecated model, and the bare
  REPL gains `/clear`, `/diff`, `/status`, `/compact` (it was far thinner than
  the TUI). Single source of truth: all model lists come from core, not hardcode.

### round 22: per-hunk UI everywhere + a dogfood bug fix (parallel dogfood)
- **Per-hunk partial-apply now reaches the TUI and desktop** (completing the
  round-21 core+CLI contract). Two SeekForge dogfood sessions ran in parallel on
  disjoint dirs:
  - TUI `PermissionPanel`: multi-hunk requests render `[x]/[ ]` per-hunk
    checkboxes (number key toggles, `a` selects all, `y`/`n` confirm/deny),
    state in app.tsx; single-/no-hunk unchanged.
  - Desktop + ws: the `permission.response` frame carries optional
    `selectedHunks`; the server maps it to the core ConfirmResult and forwards
    `hunks` to the client; the desktop PermissionModal renders per-hunk
    selection. Backward compatible (boolean all-or-nothing when ≤1 hunk).
- **Bug fix: `seekforge models` flagged deprecated models.** It listed
  deepseek-chat/reasoner as plainly available; now a `DEPRECATED_MODELS` set in
  core (re-exported) drives a `(deprecated)` tag and sorts current models first.
- All built by SeekForge, then reviewed and independently verified: 7 packages
  typecheck; tui 662, desktop 217, server 119, cli 74, core 743 tests green.

### round 21: per-hunk partial-apply (hardest dogfood — cross-layer contract)
- **`apply_patch` per-hunk partial-apply (core + CLI).** When a patch has more
  than one edit, you can now approve/reject individual hunks instead of
  all-or-nothing. SeekForge implemented this itself via plan→execute on a
  genuinely hard, cross-layer change; reviewed and independently verified.
  - Additive contract: `ConfirmResult` gains a `{ allow: true; selectedHunks:
    number[] }` variant and `PermissionRequest` a `hunks?` field — existing
    `boolean` / `{allow,remember}` returns are byte-for-byte unchanged, so the
    TUI, desktop, and server WS frontends keep returning `boolean` and were not
    touched (they stay all-or-nothing until a future round adds the UI).
  - Core threads the selection from `confirmWithUser` → `ctx.selectedHunks` →
    `apply_patch.run` (filters edits to the chosen indices), and clears it after
    each call so it never leaks across tool invocations.
  - CLI `confirmInTerminal`: multi-hunk prompt offers apply-all / skip-all /
    pick indices (`0,2`); machine/non-interactive mode is unchanged.
  - 6 new core tests; all 7 packages typecheck and core/cli/tui/desktop/server
    suites pass.

### round 20: features built by dogfooding (SeekForge implementing SeekForge)
- **`seekforge models`** — lists each DeepSeek model with cache-miss/cache-hit
  input and output pricing (sourced from MODEL_PRICING), marking the default.
  Written by SeekForge in an edit dogfood, then reviewed.
- **`--settings <file>`** (Claude-Code style) — loads a JSON settings file and
  layers it into the resolved config, slotting between project config (below)
  and env vars / CLI flags (above); mcpServers/permissionRules/hooks keep their
  deep-merge semantics. Implemented by SeekForge via a full plan→execute
  dogfood. Review caught one integration bug the unit tests missed: the flag was
  read as `opts.settingsFile` but commander exposes single-word `--settings` as
  `opts.settings`, so the flag was silently ignored — fixed and verified live.

### round 19: dogfood fixes (bugs found by running SeekForge on SeekForge)
Four parallel dogfood sessions (3 read-only investigations + 1 live edit run)
surfaced real bugs only running the agent could expose:
- **`auto`/`-y` now actually auto-approves command execution.** The `execute`
  permission case had no `auto` branch, so `-y` / `--permission-mode
  bypassPermissions` still prompted for commands — and in headless mode that
  meant every non-allowlisted command was auto-DENIED. Matches the documented
  "auto-approve write/execute" contract now. (acceptEdits still confirms
  commands, by design.)
- **`search_text` no longer descends into `.seekforge/sessions/`** — it was
  ingesting escaped copies of the agent's own prior tool output (a
  self-pollution feedback loop that burned tokens).
- **Reasoning/thinking stream is clean in non-TTY output.** The CLI renderer
  forced color on for every interactive run, so piped/captured `ask` output was
  flooded with per-token ANSI escapes; it now honors the TTY-aware color gate.
- **Skills are no longer selected/announced in read-only ask mode** — they are
  task-execution procedures, irrelevant to Q&A (plan/edit still get them).
- **Stronger `--output-style` presets.** The original wording was too soft to
  visibly change responses; concise/explanatory/learning now state hard,
  shape-changing rules.
- **Citation guidance**: ask mode now instructs the model to take line numbers
  from actual tool output, never reconstruct them from memory (the dogfood found
  citations drifting 10–45 lines).
- Plus a feature SeekForge wrote itself during the edit dogfood: `seekforge
  completion bash|zsh` now offers `run` subcommand flags (function-based
  completion), not just top-level command names.

### round 18: CLI headless parity (Claude Code flag closeout)
- `--permission-mode <mode>`: Claude-compatible names (`default`/`acceptEdits`/
  `plan`/`bypassPermissions`) plus native (`confirm`/`auto`) map onto the core
  ApprovalMode; `plan` forces plan-first. Reaches `acceptEdits` from headless
  for the first time. Overrides `-y` when set.
- `--fallback-model <model>`: provider retries the request once with an
  alternate model after the primary exhausts retries on a retryable error
  (429/5xx/network); surfaced via the retry event, original error rethrown on
  double failure. No-op when unset.
- `--output-style <style>`: `concise`/`explanatory`/`learning` presets appended
  to the system prompt (combine with `--append-system-prompt`).
- `--input-format stream-json`: drive a multi-turn headless session from
  line-delimited user envelopes on stdin (Claude SDK shapes accepted), chaining
  each turn onto the prior session id, emitting the Claude-style result envelope.
- Audit honesty: dropped the phantom `manual` ApprovalMode from the CLI surface
  — it has no distinct behavior in core (aliases `confirm`) and the server WS
  rejects it; not exposed rather than faked.
- Fixed stale help text: `run --model` example (now v4), `--append-system-prompt`
  no longer labelled "not yet supported", `ask` gains `--output-style`/
  `--fallback-model`.

## 0.7.0 (2026-06-13)

### round 17: detail-audit closeout (wire core capabilities into the UIs)
- Image thumbnails end-to-end: `GET /api/raw` serves uploaded image bytes
  (hard-confined to `.seekforge/uploads/`, symlink-guarded, token-checked);
  desktop chat + composer render real `<img>` thumbnails with click-to-open
  and onError fallback.
- MCP prompts as slash commands: `mcp:<server>:<prompt>` in the TUI palette +
  `/prompts` + `GET /api/mcp/prompts`; workspace path now passed as MCP roots
  at every connect site.
- Permission UX reachable: `acceptEdits` mode in the TUI Shift+Tab cycle and a
  desktop Confirm/Accept-edits/Auto selector; allow-for-session via core's
  richer confirm result (TUI "a", desktop 3-button modal, ws protocol);
  `/compact <focus>` runs LLM-summarized compaction.
- Integrator fixes from the audit: chat surfaces (Composer/ChatItems/TabBar/
  Sidebar) tokenized so light theme works; `--append-system-prompt` wired via
  a core seam; glob tool row title; CLI completion list + `config set` help.

### round 16: detail-audit gap closure
- Engine: `glob` tool; grep parity (context lines / glob filter / files-only /
  multiline / maxMatches); run_command `cwd`. MCP prompts + roots + protocol
  2025-06-18. acceptEdits permission mode + allow-for-session confirm channel
  + `/compact` focus + llmCompactSessionNow + web_fetch extract.
- Desktop: GFM markdown (links/tables/bold/italic), code + diff syntax
  highlighting, inline image markers.
- CLI: Claude-compatible `--output-format json`/`stream-json` envelopes,
  `--system-prompt`, `--allowedTools`/`--disallowedTools`.


### round 15: polish pass (CLI output + desktop design system)

- Desktop: all 8 views adopt the whale-blue semantic tokens + ui/ primitives
  (Button/Card/Badge/Input/EmptyState) — previously they still used the old
  green zinc/emerald palette while the chrome was blue. Added consistent
  empty / loading / error states across every data view; everything now
  reads correctly in light theme too. Sidebar Todos button tokenized.
- CLI: NO_COLOR + non-TTY color gating (piped output and NO_COLOR users no
  longer get raw \x1b[ escapes); a single useColor() predicate + no-op color
  helpers across render/doctor/mcp/update/repl/version-check. Consistent
  errors via fail() → "error: <msg>" (+ hint) on stderr with non-zero exit.
  --output-format json/stream-json guaranteed byte-clean (no color, no
  notices, errors to stderr).

### round 14: CLI + desktop detail parity vs Claude Code

- Edit review before apply: write tools (write_file/apply_patch) attach a diff
  preview to their permission request; the TUI panel and desktop modal become
  "Review change → Accept / Reject" showing the colored diff before anything
  is written (per-hunk partial-apply deferred — needs a confirm-contract change).
- CLI completeness: `-p/--print` headless mode + stdin piping
  (`cat err.log | seekforge -p "explain"`); `--output-format text|json|stream-json`
  (`--json` = stream-json alias); `-c/--continue` + `--resume <id>`, `--add-dir`,
  `--max-turns`, `--verbose` on run/ask/-p; new `doctor`, `mcp add/remove`,
  `update` commands.
- Desktop polish: native OS notifications (tauri-plugin-notification) on
  permission/completion when unfocused; light/dark/system theme switcher with a
  full light token set; first-run API-key onboarding screen.

### round 9: CodeWhale absorption + style

- Multi-tab sessions: Ctrl+N opens a parallel tab, Ctrl+T cycles, /tab
  manages; every tab owns its own transcript/session/run (actions route by
  tab ID, so a run keeps streaming into its tab after you switch away);
  per-tab permission/question prompts; the tab strip shows auto-names.
- Sidebar file tree (Ctrl+E): fold/expand dirs, Enter inserts @path.
- Transcript pager (Ctrl+L): full untruncated history, g/G/PgUp/PgDn.
- Composer extras: history ghost suggestions (→ accepts), /stash [pop|list]
  draft stash.
- CodeWhale-referenced style: tighter ◆ header, segmented │ status bar,
  theme presets (deepseek/mono/solarized/matrix) with /theme picker, OSC8
  hyperlinks in supported terminals; en/zh-CN i18n layer (config locale or
  SEEKFORGE_LANG).
- Engine: image_analyze vision tool (config visionModel, OpenAI-compatible
  endpoint — closes the Ctrl+V image loop); /balance; opt-in LLM response
  cache (llmCache); plan-model routing (routing.planModel — /plan thinks on
  v4-pro, execution on flash); seekforge mcp-serve exposes SeekForge AS an
  MCP server (read-only by default, --allow-write opt-in); /handoff session
  handoff documents; error taxonomy — failures now carry actionable hints.
- Deliberately not adopted from CodeWhale: in-TUI text selection (our
  default-off mouse capture keeps native selection), hotbar/context menus
  (mouse-first UI), full LSP integration and execpolicy DSL (our
  diagnostics-via-tools and permission rules cover the need at lower
  complexity), full i18n of every string (chrome strings only for now).

### round 11: desktop parity + design system

- Rich composer: / command palette, @ file picker (new GET /api/files),
  image paste & drag-drop upload (POST /api/upload → [image #N] markers for
  image_analyze), per-workspace input history.
- Worktree parallel sessions (Claude Code desktop-style): a tab can run on
  an isolated git worktree branch (auto-registered as a workspace); merge
  back auto-checkpoints dirty work and aborts cleanly on conflicts; discard
  deletes branch + worktree.
- Core-capability UI: ↺ backtrack on user bubbles (conversation + optional
  file restore), todos drawer, per-tab model/thinking/effort controls
  (per-run WS overrides), sandbox badge, balance chip, MCP resources list,
  client-side handoff export, session search.
- Design system: semantic tokens (surface/border/accent/text tiers,
  whale-blue accent), ui/ primitives (Button/Card/Badge/Input/Modal/…),
  ⏺/⎿ tool rows, macOS overlay title bar, typography pass — referencing
  Claude desktop calm + Codex minimalism.
- Packaging: real DMG built (SeekForge_0.1.0_x64.dmg + updater payload),
  tauri-plugin-updater wired to GitHub releases; signing keys are the
  documented user step (apps/desktop/docs/RELEASING.md).

### round 8: release readiness

- `seekforge-tui` now ships inside the published `seekforge` npm package as
  a second bin (bundled like core; ink/react become real dependencies).
- DeepSeek V4 verified against the real API: /models lists only
  deepseek-v4-flash/pro for current keys; thinking + tool calling confirmed
  to coexist in one response. Default model is now `deepseek-v4-flash`
  everywhere; V4 pricing table updated with real numbers (flash 0.14/0.0028
  in, 0.28 out; pro 0.435/0.003625 in, 0.87 out per 1M).
- CLI/REPL sync: streamed thinking (dim ✻ blocks), live command output,
  micro-compaction notices, ask_user over readline, /think, and
  sandbox/compaction/thinking config — all CLI-side now (suppressed in
  --json mode).
- Server/Web sync: `reasoning.delta` WS streaming, `question.request`/
  `question.answer` round-trip (declines on timeout/disconnect), live
  command tails and thinking blocks in the workbench, config passthrough;
  SERVER-API.md updated.
- Evals expanded 4 → 14 tasks (multi-file rename, cross-module bug, missing
  tests, API migration, off-by-one, spec-to-feature, error handling, perf,
  JSON edit, TS typing), all deterministic checks, fixtures verified
  fail-pristine/pass-solved.
- Docs refreshed to 0.7.0 reality (README forms/features/limitations, TUI
  design record of rounds 3-8, roadmap Phase 9 note).

### round 7: final gaps + command depth

- Command-detail alignment round: /compact <focus> runs an LLM-summarized
  compaction steered by the focus text (no-arg stays the instant digest);
  /memory edit <file> picks any file under .seekforge/memory/ (with an
  argument picker); /clear <name> labels the old session for /sessions;
  /model notes session-only switching; /rewind and /backtrack
  cross-reference each other; /mcp explains reconnection; /doctor failing
  checks print "→ fix:" hints.
- Layout: the approval mode (⏵⏵ auto-approve / ⏸ plan mode, shift+tab hint)
  and the running shell command + background/detached counts now sit UNDER
  the input box, Claude Code-style; the top status bar stays lean.
- Text selection: mouse capture is now OFF by default so dragging selects
  text natively; /mouse (or "mouse": true) enables wheel-scrolling, with
  Shift/Option-drag still selecting while it's on.

- Live command output: run_command streams stdout/stderr while it runs —
  the TUI shows a rolling tail under the running ⏺ row (core emits
  command.output during execution; ≤200 chunks/call).
- Sandbox escalation: a sandboxed command failing with a denial-looking
  error asks once "retry WITHOUT sandbox?"; results carry sandboxEscalated.
- MCP streamable-HTTP transport: servers with `url` (+ optional `headers`
  for bearer tokens) work alongside stdio — JSON and SSE responses,
  session-id echo, timeouts. OAuth flows out of scope.
- Hook stdout semantics: userPromptSubmit stdout is injected into the task
  as <hook-context> (8K cap); preToolUse stdout JSON {"decision":
  "deny"|"allow", reason} blocks with a reason or short-circuits.
- LLM compaction (`"compaction": "llm"`): the dropped middle is summarized
  by the model (decisions/files/commands/open problems); any failure falls
  back to the mechanical digest. Manual /compact stays deterministic.
- Skills are invocable: every enabled skill appears as /skill:<id> [task]
  in the palette and help; expansion wraps the skill procedure + your task.
- Command-depth audit vs Claude Code docs: /context now shows a
  per-category breakdown (tool results / text / thinking / diffs / shell)
  with mini-gauges, free space and the compaction threshold; /usage shows
  labeled lines incl. cache-hit rate, duration, turns; /sessions adds
  relative ages; /status shows uptime. Audited the rest to parity.

### round 5: engine gaps + UI polish + DeepSeek V4

### Added (engine)
- OS-level command sandbox (opt-in `"sandbox": "workspace-write" | "restricted"`):
  seatbelt on macOS, bwrap on Linux; restricted also cuts network; hard-fails
  when requested but unavailable (never silently unsandboxed).
- DeepSeek V4 support: `deepseek-v4-flash` / `deepseek-v4-pro` with thinking
  mode + tool calling — streamed `reasoning_content` renders as a collapsible
  "✻ thought for Ns" block (Ctrl+O expands); `/think on|off|high|max` and
  config `thinking` / `reasoningEffort` control it; reasoning is never echoed
  back into requests.
- Hook events: sessionStart, userPromptSubmit (blocking), preCompact, stop,
  subagentStop, notification — alongside the existing three.
- Micro-compaction: over budget, old tool outputs are cleared first
  (`context.microcompacted` event); full digesting only if still over.
- ask_user → see round 4; subagents and detached runs can never block on it.
- `forkSession` (core) + `/fork` and `f` in the sessions picker.
- MCP resources: `listMcpResources`/`readMcpResource` over the live client
  connections; `/mcp` lists them and `@mcp:<server>:<uri>` in a message
  inlines the resource.
- GitHub workflow builtin skill (`github-issue-pr`): gh issue → branch →
  fix → tests → PR, with explicit user-approval notes for gh/git push.
- `/review`: read-only review of the uncommitted changes.

### Added (TUI UX, command experience)
- Slash-argument pickers: after the command word, the picker lists real
  candidates — `/resume` sessions (with titles), `/todo done` open items,
  `/tasks kill` running tasks, `/approve` `/think` `/model` `/memory`
  `/config` `/rewind` values; Tab fills, Enter runs immediately.
- `/help` is a grouped interactive overlay (Session / Running / Review /
  Context / Tools / Settings / Info); Enter inserts the command.
- Palette ranks by session usage (recently used commands float up) and
  matches summaries too; mistyped commands get "did you mean /x?".
- New commands vs Claude Code: `/status` (env+session snapshot), `/config
  [edit]` (effective config, key redacted), `/permissions` (rules +
  allowlists + sandbox), `/hooks`, `/release-notes`, `/bug` (report to
  clipboard). Aliases: `/q` `/h` `/cost` `/todos`.
- Fixed: TUI hooks config only merged 3 of 9 stages.

### Added (TUI UX)
- Claude Code-style tool rows: `⏺ Read(src/app.ts)` with friendly per-tool
  titles and `  ⎿  120 lines`-style result summaries; verbose keeps full
  payloads. Live activity line: spinner + elapsed seconds + live token count
  + "esc to interrupt"; per-turn summary line `✓ 34s · $0.0123 · 12.4K tok`.
- Rich markdown: tables, blockquotes, rules, links, nested bullets; diffs
  gain old/new line-number gutters; header shows the version + a rotating tip;
  context-sensitive key-hint footer.
- Cross-session todos (`/todo`, `.seekforge/todos.md`); `/add-dir` read-only
  extra roots for @ references; custom statusline (`statusLine` command,
  JSON on stdin); cost budget warnings (`costBudgetUsd`, 80%/100% once);
  `/terminal-setup` Shift+Enter instructions.

## 0.7.0 (earlier rounds)

TUI v2 — full-parity terminal UI (apps/tui/DESIGN.md batches A–D).

### Added
- Input & navigation: typing `/` opens a fuzzy command palette (↑↓/Tab/Enter,
  argument hints); typing `@` opens a frecency-ranked fuzzy file picker over
  the workspace; multiline composer (trailing `\` or Ctrl+J for newlines,
  ↑/↓ history persisted to `.seekforge/tui-history`, Ctrl+U clear, Esc clears
  or cancels); managed scrollback viewport (PageUp/PageDown, Esc jumps to
  latest, older items virtualized).
- Review & modes: inline colored diffs after `apply_patch`/`write_file`
  (before/after captured around the tool call, unified hunks, collapsible);
  `/plan <task>` runs a read-only planning turn then asks `y` to execute in
  the same session; persistent approval modes auto / confirm / plan
  (Shift+Tab cycles, `/approve` sets); the permission panel gains
  `a` = allow similar commands for this session (feeds the live allowlist,
  applies mid-run); `/rewind [yes]` dry-runs/undoes the session's file edits.
- Sessions, memory, surfaces: `/sessions` + `/resume <id>`;
  `# <fact>` / `/remember` write straight to project memory; background
  tasks surface as `⚙ N bg` in the status bar and `/tasks`; `/context`
  opens a context inspector overlay (gauge, tokens, usage, items);
  `/agents` and `/mcp` list what's dispatchable; nested subagent activity
  renders as indented `↳ [agent] tool` rows.
- Polish: syntax-highlighted fenced code blocks (built-in tokenizer for
  ts/js/py/rust/go/sh/json/css/html/yaml — no new deps); configurable accent
  color (`accent` in config or `SEEKFORGE_TUI_ACCENT`; `NO_COLOR` respected);
  Ctrl+G / `/editor` edits the prompt in `$EDITOR`; `/copy` copies the last
  reply to the clipboard.

- Steering & shell: the composer stays live during a run — Enter queues
  follow-ups (sent in order afterwards; Esc cancels run + queue); `!cmd`
  runs a local shell command directly with inline output; terminal bell on
  permission prompts and completion (`"bell": false` in config disables).
- `/clear` (reset transcript + session), `/diff` (colored git diff of the
  working tree), `/export [path]` (transcript → markdown), `/memory [edit]`
  (list project facts / open in $EDITOR); `/sessions` is now an interactive
  picker (↑↓ + Enter resumes).
- Manual `/compact`: core gains `compactSessionNow(workspace, sessionId)` —
  folds the middle of a stored session's messages.jsonl into a digest on
  demand (the next message resumes the compacted history).
- Background tasks now survive across turns: `createAgentCore` accepts a
  shared caller-owned `background` manager (the TUI passes one per process,
  killed on exit); `/tasks` shows live status and `/tasks kill <id>` stops
  one.

- Vim mode (`/vim`, or `"vim": true`): modal composer editing — motions
  h j k l w b e 0 $ gg G, insert entries i a I A o O, edits x dd dw cw cc
  D C s S yy p, u undo; INSERT/NORMAL shown in the status bar.
- Ctrl+R reverse history search (incremental, Ctrl+R steps older) and Tab
  path completion for plain tokens (cycles candidates; `@` picker unchanged).
- Conversation backtrack: Esc Esc or `/backtrack` picks an earlier user turn,
  truncates the stored session there (core `truncateSessionAtUserTurn`) and
  refills the composer; file changes stay (use /rewind).
- `/init` (agent writes/refreshes AGENTS.md), `/doctor` (11 environment
  checks), `/skills` (installed skills incl. disabled builtins); OS
  notifications via osascript/notify-send on permission prompts and
  completion (`"notify": false` disables; bell kept as fallback).

- Run control: Ctrl+B detaches the running task to the background (chat
  continues in a fresh session; outcome arrives as a notice + bell); Ctrl+O
  verbose mode shows full diffs/shell output/tool results; Ctrl+Z suspends;
  mouse wheel scrolls the transcript.
- Per-turn checkpoints (core): file snapshots are tagged with the user turn;
  backtrack (Esc Esc) now restores files too via `rewindSessionToTurn`
  (Enter = conversation + files, `c` = conversation only).
- `ask_user` tool (core): the agent can ask a 2-6 option multiple-choice
  question; the TUI pops a panel (↑↓/1-N/Enter; Esc declines; unavailable to
  subagents and backgrounded runs).
- Custom slash commands: `.seekforge/commands/<name>.md` (project/global)
  appear in the palette; `$ARGUMENTS` substitution.
- Clipboard images: Ctrl+V saves the clipboard image to
  `.seekforge/uploads/` and inserts an `[image #N: path]` marker that
  travels with the task (ready for vision-capable models).
- Large pastes collapse to `[Pasted text #N]` placeholders, expanded on
  send; `/model` with no argument opens a picker; `/sessions` shows
  summary-based titles (core `sessionTitle`).
- Launch & environment: `-c/--continue`, `--model`, `--vim` flags; first-run
  API-key wizard; user keybinding overrides in `.seekforge/keybindings.json`;
  terminal-title updates; `seekforge completion bash|zsh`.

### Changed
- TUI keybindings are a declarative testable table (`keymap.ts`); all input
  routing (permission → overlay → composer) is centralized in one handler.
- TUI tests: 26 → 273 (editor model, history, fuzzy, file index, viewport,
  diff, capture, allowlist, surfaces, highlight, theme, keymap, export, vim,
  history-search, path-complete, backtrack, doctor, skills, notify).

## 0.6.0 (unreleased)

Phase 8 batch 5 — terminal UI and multi-project.

### Added
- `seekforge-tui`: an Ink (React-for-terminal) chat UI — scrolling transcript
  with streamed markdown, tool rows, in-place plan checklist, file badges and
  a final report; bottom composer with a status bar (model, context %, cost,
  working spinner); inline permission panel showing the raw command/path;
  slash commands (/help /new /model /context /usage /quit), @path inlining,
  Ctrl+C cancel. Runs AgentCore in-process (no server).
- Multi-project: one `seekforge serve [paths...] [--workspace <p>]` hosts
  several workspaces; `GET /api/workspaces`, a `?ws=<id>` param on all scoped
  routes (default = first, back-compatible), and a `ws` field on WS start/send.
  The web workbench gains a workspace switcher; each tab binds to its own
  workspace.

## 0.5.0 (unreleased)

Phase 8 batch 4 — final harness pieces.

### Added
- Tool-call hooks (`hooks.preToolUse/postToolUse/sessionEnd` in config):
  shell commands fired around tools; a non-zero preToolUse hook BLOCKS the
  tool (e.g. a lint gate). Payload on stdin, never the command line.
- Context-window visibility: `context.usage` event; the CLI shows `· ctx N%`
  and `/context` in the REPL; the web footer shows occupancy (amber/red).
- `web_search` tool (keyless DuckDuckGo HTML; network, always confirmed).
- `seekforge skill enable|disable|remove <id>` (builtins disable via marker).
- `seekforge memory compact [--dry-run]`: deterministic dedup/merge of
  project.md facts (CJK tokenized per character).

## 0.4.0 (unreleased)

Phase 8 batches 1–3 — harness ergonomics and the desktop workbench.

### Added (batch 3)
- Desktop workbench: multi-session tabs (each tab its own WebSocket session,
  parallel runs), Plan/Ask/Edit mode selector with an "Execute plan" step,
  auto-approve toggle, system notifications when hidden (confirmation needed /
  task finished), Agents and Evolution management views, an MCP panel in
  Settings, and per-session Rewind with dry-run preview.
- Server: /api/agents, /api/evolution (accept/reject/apply), /api/mcp
  (config + on-demand tool listing; env values never serialized), /api/rewind;
  WS start accepts plan, send accepts a mode override.

### Added (batch 2)
- Subagent execution upgrade: multiple `dispatch_agent` calls in one turn
  run in parallel; `background: true` + `agent_result` polling;
  `agent_send` continues a completed subagent with its context; builtin
  read-only `explorer`/`reviewer` agents; per-agent `model:` in AGENT.md.
- Fine-grained permission rules (`permissionRules` config): allow/deny per
  tool with command/path prefix match — deny blocks everything (even with
  `-y`), allow skips prompts but never rescues dangerous commands or
  bypasses read-only mode.
- Rules-file hierarchy: `~/.seekforge/AGENTS.md` (all projects) +
  `AGENTS.md` + `AGENTS.local.md` (personal, gitignore it) merged into the
  system prompt with origin headers.

### Added (batch 1)
- Background tasks: `run_command` accepts `background: true` (dev servers,
  watchers) plus `task_output` / `task_kill` tools; ring-buffered output,
  same permission flow as foreground, every task killed at session end.
- Checkpoint & rewind: file contents are snapshotted before a session's
  first write to each path (incl. the Rust backend path); `seekforge rewind
  [session] [--dry-run]` restores originals and deletes created files.
- Direct memory channel: `seekforge memory add` (straight into project.md
  with an audit candidate, `--pending` to queue instead), `memory remove`
  by index/id/text, numbered `memory list`, and `/remember <fact>` in the
  REPL. Injection-filtered like extracted memories.

## 0.3.0 (unreleased)

Phase 4 — interactive surfaces.

### Added
- Web workbench Diff view: per-file grouped, collapsible workspace diff with
  +/- stats and staged toggle, backed by GET /api/diff.
- `seekforge sessions prune --older-than <days> / --keep-last <n> [--dry-run]`
  to bound `.seekforge/sessions/`. Subagent (dispatched) sessions are now
  tagged with their parent agent, hidden from `sessions`/`status` and skipped
  by `evolve analyze`, and pruned along with their parent's age.
- Subagents: `AGENT.md` definitions (project > global), `seekforge agent
  list|show|import`, and a `dispatch_agent` tool the main agent uses to
  delegate bounded sub-tasks (own prompt, tool whitelist, turn budget,
  depth guard). Governance/review agents are read-only; a read-only
  (ask/plan) session cannot dispatch an edit agent. Imports Claude-style
  agent definitions incl. Meta_Kim's meta-agents (tool mapping + mode
  inference). The web workbench shows nested subagent activity.
- Evaluation harness (`packages/eval-harness`, `evals/`): four deterministic
  tasks with fixtures, `pnpm eval` runner, markdown/JSON reports, and
  baseline comparison for regression tracking.
- Plan mode: `seekforge run --plan` and `/plan <task>` in the REPL —
  read-only investigation produces a concrete plan; after your confirmation
  the SAME session executes it. Resumed sessions now rebuild their system
  prompt, so mode switches apply and freshly approved memory takes effect
  (fixes the stale-prompt limitation).
- `seekforge skill import <path> [--global] [--force]`: import external
  Claude-style SKILL.md skills (YAML frontmatter; |-separated triggers,
  block-scalar descriptions — e.g. Meta_Kim canonical skills). Imported
  skills are enabled with medium trust and never grant permissions.
- Interactive REPL as the default command (`seekforge`): multi-turn sessions
  with slash commands (/new /sessions /resume /model /usage)
- `seekforge serve`: local agent server (127.0.0.1, token-protected) with a
  REST API, a WebSocket session protocol (streaming deltas, permission
  round-trips, cancel), and a bundled React web workbench: chat with live
  plan/tool rows and a raw-args permission modal, sessions browser, skills,
  memory review, settings

## 0.2.0 (unreleased)

Gap-fill iteration after comparing against Claude Code / Codex CLI.

### Added
- `git_commit` tool (stages + commits; pushing remains impossible)
- `web_fetch` tool: public http(s) pages as readable text — always asks for
  confirmation, refuses private/loopback addresses (SSRF guard)
- `update_plan` tool: live step checklist rendered in the terminal
- `--json` flag on `run`/`ask`: one JSON event per line for CI use
- `@path` tokens in tasks inline file contents (sensitive files excluded)
- `commandAllowlist` config key (comma-separated command prefixes that
  auto-run without confirmation) — the policy engine already supported it,
  now it is configurable

## 0.1.0 (unreleased)

First usable release of the SeekForge CLI.

### Added
- Agent loop with turn/tool-call limits, context compaction, JSONL session
  traces, token/cost tracking (DeepSeek context-cache aware)
- DeepSeek provider: streaming (SSE), tool calls, retries, cost estimation,
  fallback text-protocol parser (not yet wired into the loop)
- Tool system: 10 sandboxed tools, 5-level permission policy, search/replace
  edit engine, command classification with denylist, secret redaction
- CLI: `run`, `ask`, `resume`, `sessions`, `status`, `diff`, `init`,
  `skill list|show|create`, `memory list|approve|reject`, `config show|set`;
  streaming output; cooperative Ctrl+C cancellation
- Skills: 3 builtin skills, project/global layers, rule-based selector,
  usage logging
- Memory: post-task fact extraction with human review (candidates →
  `project.md`), task-relevant memory brief injection
- Rust execution backend (`seekforge-runtime`): stdio JSONL protocol,
  workspace sandbox, atomic edits, process-group command timeouts —
  enabled via `config set runtimeBin <path>`

### Fixed
- Memory injection filter no longer drops legitimate facts containing
  "ignore" (e.g. `.gitignore` conventions)
- `init` creates `config.json` with 0600
- `--model deepseek-reasoner` is refused upfront instead of failing midway
- Ctrl+C during a permission prompt now denies and cancels cleanly

## 0.0.1 (2026-06-10)

npm placeholder release to reserve the package name.
