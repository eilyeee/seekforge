#!/usr/bin/env node
/**
 * Drives the real browser tools against a real Chromium.
 *
 * The unit tests run these tools against a scriptable fake, which proves our
 * own logic but not that the structural Playwright types match the library. A
 * wrong argument shape (`selectOption` values, `fill` options) only shows up
 * against the real thing, so this serves a small page over loopback and makes
 * the tools log in, choose an option, submit, and verify the result.
 *
 * Usage: npx tsx scripts/browser-tools-smoke.ts
 * Set SEEKFORGE_REQUIRE_BROWSER_SMOKE=1 (CI does) to fail instead of skip when
 * Playwright is not installed.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultDispatcher } from "../packages/core/src/tools/index.js";
import { disposeBrowser } from "../packages/core/src/tools/browser/index.js";
import type { ToolContext } from "../packages/core/src/tools/index.js";
import type { ToolResult } from "../packages/shared/src/index.js";

const PAGE = `<!doctype html>
<html><head><title>SeekForge smoke</title></head>
<body>
  <h1>Sign in to continue</h1>
  <form id="login" onsubmit="event.preventDefault(); submitForm();">
    <input id="user" name="user" placeholder="username" />
    <select id="team" name="team">
      <option value="">choose…</option>
      <option value="core">Core team</option>
      <option value="tools">Tools team</option>
    </select>
    <button id="submit" type="submit">Sign in</button>
  </form>
  <div id="result"></div>
  <script>
    function submitForm() {
      const user = document.getElementById("user").value;
      const team = document.getElementById("team").value;
      console.log("submitting", user, team);
      setTimeout(() => {
        document.getElementById("result").textContent = "Welcome " + user + " (" + team + ")";
      }, 150);
    }
  </script>
</body></html>`;

const workspace = mkdtempSync(join(tmpdir(), "seekforge-browser-smoke-"));
const dispatcher = createDefaultDispatcher();
let callId = 0;

const ctx: ToolContext = {
  sessionId: "browser-smoke",
  workspace,
  policy: { approvalMode: "auto", mode: "edit", commandAllowlist: [] },
  confirm: async () => true,
};

async function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await dispatcher.execute({ id: `smoke-${callId++}`, name, arguments: args }, ctx);
  if (!res.ok) throw new Error(`${name} failed: ${res.error?.code} ${res.error?.message}`);
  return res;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "server did not bind a port");
  const url = `http://127.0.0.1:${address.port}/`;

  // Probe first: a missing optional dependency is a skip, not a failure,
  // unless the environment demands the real run.
  const probe = await dispatcher.execute({ id: "probe", name: "browser_navigate", arguments: { url } }, ctx);
  if (!probe.ok && probe.error?.code === "browser_unavailable") {
    if (process.env.SEEKFORGE_REQUIRE_BROWSER_SMOKE === "1") {
      throw new Error(`Playwright is required for this run but missing: ${probe.error?.message}`);
    }
    console.log("SKIP: playwright-core is not installed — install it to run the browser smoke.");
    process.exit(0);
  }
  assert(probe.ok, `browser_navigate failed: ${probe.error?.code} ${probe.error?.message}`);
  assert((probe.data as { status: number }).status === 200, "expected HTTP 200 from the smoke page");
  assert((probe.data as { title: string }).title === "SeekForge smoke", "unexpected page title");

  const snapshot = (await run("browser_snapshot", {})).data as {
    headings: string[];
    buttons: string[];
    inputs: string[];
  };
  assert(
    snapshot.headings.some((h) => h.includes("Sign in")),
    "snapshot did not see the heading",
  );
  assert(snapshot.buttons.includes("Sign in"), "snapshot did not see the submit button");
  assert(
    snapshot.inputs.some((i) => i.includes("username")),
    "snapshot did not see the username field",
  );

  await run("browser_fill", { selector: "#user", text: "ada" });
  const selected = (await run("browser_select", { selector: "#team", label: "Tools team" })).data as {
    selected: string[];
  };
  assert(selected.selected.join(",") === "tools", `unexpected selection: ${selected.selected.join(",")}`);

  await run("browser_click", { selector: "#submit" });
  // The result is rendered asynchronously: waiting is the point of the tool.
  await run("browser_wait_for", { text: "Welcome ada (tools)" });

  const after = (await run("browser_snapshot", {})).data as { text: string };
  assert(after.text.includes("Welcome ada (tools)"), `page never showed the result: ${after.text}`);

  const console_ = (await run("browser_console", {})).data as { console: { text: string }[]; errors: string[] };
  assert(
    console_.console.some((entry) => entry.text.includes("submitting ada tools")),
    "console capture missed the page's own log line",
  );
  assert(console_.errors.length === 0, `page raised errors: ${console_.errors.join("; ")}`);

  const shot = (await run("browser_screenshot", { path: "smoke.png" })).data as { path: string };
  const bytes = readFileSync(join(workspace, shot.path)).length;
  assert(bytes > 1000, `screenshot looks empty (${bytes} bytes)`);

  // Interacting with a page that is NOT loopback must be gated, whatever the
  // approval mode says. Deny the confirmation and expect a refusal.
  const gatedCtx: ToolContext = { ...ctx, confirm: async () => false };
  await run("browser_navigate", { url: "https://example.com/" });
  const denied = await dispatcher.execute(
    { id: "gated", name: "browser_click", arguments: { selector: "h1" } },
    gatedCtx,
  );
  assert(!denied.ok, "a click on a public page was allowed without confirmation");

  console.log(`Browser tools smoke passed (screenshot ${bytes} bytes)`);
} finally {
  await disposeBrowser();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
}
