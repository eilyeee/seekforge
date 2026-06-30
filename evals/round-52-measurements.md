# Round-52 capability measurements (2026-06-30)

First real-run A/B of the three round-52 "transparent" capabilities, on the
default `deepseek-v4-flash`. **Directional, not conclusive: N = 1–3 tasks, a
single run each, no variance.** All tasks passed in every arm, so success rate
can't discriminate — only turns/cost do, and those are noisy at this N.

## Retrieval (relevant-files shortlist) — no measurable benefit

`--ab control,no-retrieval` on the three CJK fixtures that clear the 40-file floor.

| Task | control turns/cost | no-retrieval turns/cost | win |
| --- | --- | --- | --- |
| cjk-buried-discount | 5 / 0.0016 | 5 / 0.0015 | B |
| cjk-buried-retry | 7 / 0.0017 | 5 / 0.0016 | B |
| cjk-large-paginate | 5 / 0.0015 | 6 / 0.0016 | A |
| **Total** | 3/3 · 0.0047 | 3/3 · 0.0047 | **1/2/0** |

The injected shortlist didn't help flash reach the buried bug — it already
locates it with `search_text`. Note the **squeeze**: where retrieval *can* fire
(an English token in the task), the agent's own grep finds the file too; where
grep fails (pure-CJK, no English token), retrieval returns empty as well. So the
lexical shortlist adds little over the agent's own lexical search.

## Auto-verify (auto-run vs nudge-only) — positive

`--ab verify-gate,no-auto-verify` on loop-verify-green (a failing-suite fixture).

| Task | verify-gate (auto-run) | no-auto-verify (nudge) | win |
| --- | --- | --- | --- |
| loop-verify-green | 6 turns / 0.0014 | 9 turns / 0.0020 | **A** |

Running the verify in the loop and feeding the real result back beats nudging the
model to run it itself (which burns turns re-running and re-reading). Supports
keeping `autoVerify` default-on. N = 1.

## Review-gate (final review) — measurable cost, no checkable benefit

`--ab control,review-gate` on three edit tasks.

| Task | control turns/cost | review-gate turns/cost | win |
| --- | --- | --- | --- |
| cross-module-bug | 6 / 0.0017 | 8 / 0.0025 | A |
| large-context-nav | 5 / 0.0015 | 6 / 0.0019 | A |
| off-by-one-fix | 7 / 0.0018 | 7 / 0.0021 | A |
| **Total** | 3/3 · 0.0050 | 3/3 · 0.0065 | **3/0/0** |

Review-gate added ~30% cost and extra turns with the same pass rate and score.
**Caveat:** deterministic checks cannot see quality (a latent edge case the
review might fix but the test doesn't cover), so this measures the *cost*, not
the feature's intended *value*.

## Caveats

- N = 1–3, single run each — no statistical significance; treat win/loss as a
  coin flip, the cost/turn deltas as weak signal.
- All tasks are "fix a bug with a failing test." They do **not** stress the
  features' intended hard cases: retrieval is meant for huge repos where the
  agent can't grep-orient; review is meant to catch quality issues the tests
  miss. The eval can't yet discriminate either.

## Takeaways

1. **Keep `autoVerify` default-on** — the only clearly positive signal.
2. **Retrieval and review-gate do not justify their cost on these tasks**, but
   the suite cannot measure their intended value. Before relying on either,
   either (a) build tasks that can discriminate them (a repo where grep-orienting
   fails; a bug whose quality fix isn't covered by the failing test), or (b) run
   more repetitions for variance. Until then, treat their default-on status as
   unproven, not validated.

## Follow-up: discriminating tasks (2026-06-30, 3 reps each)

Built two fixtures designed to stress the intended hard case of each capability
(takeaway 2a), and ran each A/B three times.

### Retrieval — `cjk-find-checkout` (ask mode; grep returns 41 hits, retrieval 1)

`--ab control,no-retrieval`, where "checkout" is in every file's *contents* but
only the target's *path/exports*, and no failing test reveals the location.

| rep | control (retrieval) | no-retrieval | win |
| --- | --- | --- | --- |
| 1 | 2 turns / 0.0009 | 3 / 0.0010 | A |
| 2 | 2 turns / 0.0009 | 3 / 0.0011 | A |
| 3 | 2 turns / 0.0009 | 3 / 0.0010 | A |

**Retrieval reliably wins 3/3: ~1 fewer turn, ~10% cheaper, same (correct)
answer.** Caveat on rigor: the answer check only matches the file + function,
not the diagnosed cause, and the control prompt names that file in its shortlist
— so the 1-turn delta is best read as "retrieval saved the grep-to-locate step"
(control still spent a turn reading the file) rather than a hard lower bound.
This is the niche the round-52 tasks couldn't show — when the agent
can't cheaply grep-orient, the precise shortlist saves a navigation turn. So
retrieval *does* earn its keep, but its value is concentrated on hard-navigation
tasks and is ~nil when the task term is already greppable. Net: keep it (cheap to
compute, helps the hard cases, never observed to hurt).

### Review-gate — `cjk-review-edge` (naive fix passes `npm test`, fails a hidden negative-bounds check)

| rep | control passes hidden edge check? | control cost | review-gate cost |
| --- | --- | --- | --- |
| 1 | yes | 0.0022 | 0.0026 |
| 2 | yes | 0.0020 | 0.0027 |
| 3 | yes | 0.0018 | 0.0033 |

**In all 3 reps control already handled the edge case** — flash writes a robust
parse unprompted, so the latent-bug-catch never triggers and review-gate is pure
overhead (always more expensive, no success/quality gain). Stronger evidence it
doesn't pay off for this model. The discriminator is sound (a naive split fix
*does* fail the hidden check — verified), so this is about the model, not the
task: flash doesn't make the naive mistake here. Review-gate might still help a
weaker model that does — but flash is already the weakest available tier, so that
hypothesis is currently untestable.

### Net recommendation

- `autoVerify` on, **retrieval on** (now validated on hard-navigation).
- **Review-gate: leave off by default.** No measured benefit across two task
  families and a built-to-need-it discriminator; only cost. Revisit if/when a
  weaker model or a quality-regression task can exercise its intended value.
