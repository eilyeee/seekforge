import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { estimateToolDefinitionsTokens } from "../../src/agent/context.js";

/**
 * What the tool catalog costs.
 *
 * Every request carries every tool definition, so this number is paid on every
 * turn of every session — the one prompt cost that is not proportional to the
 * work being done. Measured: 53 builtins, 10,858 tokens.
 *
 * The obvious response is to send fewer tools per turn, and the arithmetic says
 * no. Definitions sit at the FRONT of the cached prefix, so changing them
 * mid-run invalidates the cache for everything behind them, conversation
 * included. A cached prefix bills at a tenth of input, which puts the full
 * catalog at 1,086 tokens-equivalent per turn — less than a narrowed 15-tool
 * catalog costs uncached. The break-even conversation size is negative: there
 * isn't one. (Narrowing ONCE before the first request is a different thing, and
 * is what --allowedTools already does.)
 *
 * So the catalog is not narrowed, and instead it is watched. The budget below
 * is headroom over the measured size, not a target: a single MCP server can add
 * more definition tokens than every builtin combined, and a tax paid on every
 * turn should be a visible event when it grows.
 */

/** Measured 10,858 — ~15% headroom for ordinary growth. */
const CATALOG_TOKEN_BUDGET = 12_500;
/** A single definition this large is a description that got away from someone. */
const PER_TOOL_TOKEN_BUDGET = 600;

describe("tool catalog cost", () => {
  it("stays inside the per-turn budget every session pays", () => {
    const tools = createDefaultDispatcher().list();
    const total = estimateToolDefinitionsTokens(tools);
    console.log(`tool catalog: ${tools.length} tools, ${total} tokens (budget ${CATALOG_TOKEN_BUDGET})`);
    expect(total).toBeLessThanOrEqual(CATALOG_TOKEN_BUDGET);
  });

  it("has no single tool large enough to dominate it", () => {
    const oversized = createDefaultDispatcher()
      .list()
      .map((tool) => ({ name: tool.name, tokens: estimateToolDefinitionsTokens([tool]) }))
      .filter((t) => t.tokens > PER_TOOL_TOKEN_BUDGET);
    expect(oversized).toEqual([]);
  });
});
