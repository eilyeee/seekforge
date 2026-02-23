# Spikes

Phase 0 throwaway experiments against the live DeepSeek API. They are NOT part
of the build/test pipeline; they exist to validate assumptions before we commit
to a design.

## Prerequisites

```sh
pnpm install
export DEEPSEEK_API_KEY=sk-...
```

If `DEEPSEEK_API_KEY` is not set, each script prints a skip message and exits 0
(so CI never fails on missing credentials).

## 01 — tool-calling reliability

```sh
pnpm tsx spikes/01-tool-calling-reliability.ts          # 10 conversations
pnpm tsx spikes/01-tool-calling-reliability.ts --n 25   # custom count
```

Runs N multi-turn conversations against `deepseek-chat` with two fake tools
(`read_file`, `get_weather`) whose results are canned and fed back. Every
conversation needs at least 2 sequential tool calls (read a file to learn a
city, then fetch that city's weather).

Measured:

- % of turns where the model produced a syntactically valid tool call when one
  was needed (valid = native tool call with parseable JSON args and a known
  tool name)
- % of conversations completed (correct city + temperature in the final answer)
- malformed-JSON tool call count

**Pass:** >= 90% valid tool calls on turns that needed one.

## 02 — edit format success

```sh
pnpm tsx spikes/02-edit-format-success.ts
```

Sends 5 small inline source fixtures plus edit instructions and asks the model
to reply ONLY with search/replace edits as JSON:

```json
{"path": "src/App.tsx", "edits": [{"oldString": "...", "newString": "..."}]}
```

Each `oldString` must appear exactly once in the fixture; edits are applied in
order and the result is checked against a per-fixture expectation.

**Pass:** >= 80% of fixtures end with all edits applicable and the expected
result (this validates the `apply_patch` search/replace design from AGENTS.md).

Both scripts print a markdown summary table at the end.
