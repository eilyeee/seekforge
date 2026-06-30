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
