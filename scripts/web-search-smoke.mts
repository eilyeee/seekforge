#!/usr/bin/env node
/**
 * Runs web_search against the live backends.
 *
 * The unit tests parse recorded bodies, which proves the parsers and nothing
 * about whether the bodies still look like that. This tool's whole failure mode
 * is silent: a provider changes its markup or renames a field, the parser finds
 * nothing, and the model is told "no results" — a confident answer built on a
 * broken integration. The `drift` outcome exists to say that instead, and this
 * is what checks it is still able to.
 *
 * DuckDuckGo needs no key and is always exercised. Brave and SearXNG run only
 * when configured, so a contributor without either still gets the check that
 * matters most (the scraped page is the leg most likely to change).
 *
 * Usage: npx tsx scripts/web-search-smoke.mts
 *   BRAVE_API_KEY=…            also exercise the Brave backend
 *   SEEKFORGE_SEARXNG_URL=…    also exercise a SearXNG instance
 *   SEEKFORGE_REQUIRE_WEB_SEARCH_SMOKE=1  fail instead of skipping when offline
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureWebSearch, createDefaultDispatcher } from "../packages/core/src/tools/index.js";
import type { ToolContext } from "../packages/core/src/tools/index.js";

type SearchData = {
  results: { title: string; url: string; snippet: string }[];
  note: string;
  searched: boolean;
};

// A query with durable, popular answers: this asserts that SOMETHING comes
// back, not that a particular page ranks, so it does not rot with the web.
const QUERY = "typescript release notes";

const dispatcher = createDefaultDispatcher();
const workspace = mkdtempSync(join(tmpdir(), "seekforge-search-smoke-"));
const ctx: ToolContext = {
  sessionId: "web-search-smoke",
  workspace,
  // `edit` mode, not `ask`: an `env` tool is forbidden outright in ask mode,
  // before any confirmation is reached.
  policy: { approvalMode: "auto", mode: "edit", commandAllowlist: [] },
  // web_search is an `env` tool: always confirmed, even in auto mode.
  confirm: async () => true,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function search(label: string): Promise<SearchData> {
  const res = await dispatcher.execute(
    { id: `search-${label}`, name: "web_search", arguments: { query: QUERY, count: 5 } },
    ctx,
  );
  if (!res.ok) throw new Error(`${label}: web_search failed: ${res.error?.code} ${res.error?.message}`);
  return res.data as SearchData;
}

function check(label: string, data: SearchData): void {
  // `searched: false` is the signal this script exists for: the backend did not
  // answer, and reporting its empty result as "no hits" would be a lie.
  assert(data.searched, `${label}: the backend did not run — ${data.note}`);
  assert(data.results.length > 0, `${label}: a query with durable answers returned nothing — ${data.note}`);
  for (const row of data.results) {
    assert(/^https?:\/\//.test(row.url), `${label}: a result url is not http(s): ${row.url}`);
    assert(row.title.trim().length > 0, `${label}: a result has no title: ${row.url}`);
    assert(!row.title.includes("<"), `${label}: a title still carries markup: ${row.title}`);
  }
  console.log(`OK   ${label} (${data.results.length} results)`);
}

const required = process.env.SEEKFORGE_REQUIRE_WEB_SEARCH_SMOKE === "1";
const brave = process.env.BRAVE_API_KEY?.trim();
const searxng = process.env.SEEKFORGE_SEARXNG_URL?.trim();

try {
  // DuckDuckGo: no key, and the leg every install falls back to.
  configureWebSearch(undefined, workspace);
  try {
    check("duckduckgo", await search("duckduckgo"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Offline is a skip; a backend that answered with something we could not
    // read is the failure this exists to catch, and says so in `note`.
    if (!required && /fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
      console.log(`SKIP duckduckgo: no network (${message})`);
    } else {
      throw error;
    }
  }

  if (brave) {
    configureWebSearch({ braveApiKey: brave }, workspace);
    check("brave", await search("brave"));
  } else {
    console.log("SKIP brave: set BRAVE_API_KEY to exercise it.");
  }

  if (searxng) {
    configureWebSearch({ searxngUrl: searxng }, workspace);
    check("searxng", await search("searxng"));
  } else {
    console.log("SKIP searxng: set SEEKFORGE_SEARXNG_URL to exercise it.");
  }

  console.log("web_search smoke passed");
} finally {
  configureWebSearch(undefined, workspace);
  rmSync(workspace, { recursive: true, force: true });
}
