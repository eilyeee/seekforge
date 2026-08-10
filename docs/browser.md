# Browser / visual verification

> **English** | [简体中文](browser.zh-CN.md)

SeekForge can drive a real headless browser so the agent can **verify a frontend
change**: open your dev server, read the console for errors, snapshot the DOM,
capture a screenshot — and act on the page, so a flow that takes a login and a
form submission can be verified end to end rather than just looked at.

This is powered by [Playwright], which is an **optional, opt-in add-on you
install yourself** (it is deliberately NOT a declared dependency, so a normal
install never pulls in a browser driver) — the core stays lean and users who
don't want it are completely unaffected.

[Playwright]: https://playwright.dev

## Install

The browser tools are dormant until Playwright and a browser binary are present:

```sh
pnpm add -w playwright-core   # the driver; does NOT auto-download browsers
npx playwright install chromium
```

We depend on `playwright-core` (not `playwright`) on purpose: it does not
download browsers on install, so CI and users who never touch these tools pay
nothing. Until it's installed, every browser tool returns a single actionable
error:

```
browser tools need Playwright: pnpm add -w playwright-core && npx playwright install chromium
```

Playwright is loaded via a **dynamic import inside the tool**, never at the top
level, so typecheck, build, and the test suite all pass whether or not it is
installed.

If Playwright is already installed somewhere else (a global install, another
project), point `SEEKFORGE_PLAYWRIGHT` at it instead of installing a second
copy — the value is any import specifier or file URL that resolves to a
`playwright-core` module:

```sh
export SEEKFORGE_PLAYWRIGHT=/path/to/node_modules/playwright-core/index.mjs
```

## Opening and reading a page

| Tool | Args | Permission | What it does |
| --- | --- | --- | --- |
| `browser_navigate` | `url` | `env` (always confirmed) | Opens `url` in a shared headless browser (launches once, reused across calls). Returns final url, HTTP status, and title; starts capturing console/errors/failed-requests. |
| `browser_screenshot` | `path?` | `execute` | Saves a full-page PNG under `.seekforge/uploads/` (or `path`) and returns the path. Read-only on the page. |
| `browser_snapshot` | — | `readonly` | Returns a concise text snapshot (title, url, headings, links, buttons, inputs, visible text) so the agent can "see" the page without an image. |
| `browser_console` | — | `readonly` | Returns console messages, uncaught page errors, and failed network requests captured since the last navigate — the key signal for "did my change break the page". Interactions do not clear it. |
| `browser_network` | `urlContains?`, `failedOnly?` | `readonly` | Returns the requests the page **completed** since the last navigate — method, URL, status. A fetch that returns 500 raises no console message and no page error, so this is the half `browser_console` cannot show. |

## Acting on the page

| Tool | Args | Permission | What it does |
| --- | --- | --- | --- |
| `browser_click` | `selector`, `index?`, `timeoutMs?` | see below | Clicks an element once it is actionable. |
| `browser_fill` | `selector`, `text`, `index?`, `submit?`, `timeoutMs?` | see below | Replaces a field's value; `submit:true` presses Enter afterwards. |
| `browser_select` | `selector`, `value?` \| `label?`, `index?`, `timeoutMs?` | see below | Chooses an option in a `<select>`; fails with `option_not_found` if nothing matched. |
| `browser_press` | `key`, `selector?`, `index?`, `timeoutMs?` | see below | Presses a key or chord (`Enter`, `Escape`, `Control+A`), optionally focusing an element first. |
| `browser_wait_for` | `selector?` \| `text?`, `state?`, `timeoutMs?` | `readonly` | Waits until something appears (or is hidden) before you look at the page. |
| `browser_upload` | `selector`, `path`, `index?`, `timeoutMs?` | `execute` / `env` | Attaches a workspace file to a file input, so an upload flow can be exercised end to end. The path is shown raw in the prompt and resolved through the workspace sandbox. |

`selector` is a Playwright selector: CSS (`#login button`), text (`text=Sign in`)
or role (`role=button[name="Save"]`). Take them from `browser_snapshot`.
Playwright is strict — a selector matching several elements is an error, not a
silent "first one" — so pass `index` to choose. The failure is reported as
`ambiguous_selector` with the number of matches, and a selector that never
appears as `element_not_found`.

The page is shared for the whole session, so an interaction is pinned to the
page it was approved against: if something moves the page between the approval
and the action — a parallel subagent, a slow redirect — the action is refused
with `page_changed` rather than landing somewhere the user never saw.

Every interaction answers with the page's url afterwards, whether the action
navigated, and any uncaught errors the page raised while it ran. `browser_fill`
reports how many characters it typed, never the text itself — the field may be a
password.

### Security

`browser_navigate` is the only tool that takes an outward action, so it is
classified at the **`env`** level — exactly like `web_fetch`/`web_search`. It is
**always confirmed**, even in auto-approval mode, and the raw URL is shown to
the user verbatim.

Browser verification has one narrow exception to the normal `web_fetch` SSRF
policy: after that explicit confirmation it may open a loopback development
server on `localhost`, `127.0.0.0/8`, or `::1`. Other private, link-local, and
special network targets remain blocked, including RFC-1918 addresses,
`169.254.169.254`, IPv6 ULA/link-local addresses, IPv4-mapped private forms, and
non-`http(s)` schemes. This exception is local to `browser_navigate`;
`web_fetch` continues to reject loopback targets.
The policy is reapplied to every navigation and subresource request, including
DNS answers, so ordinary redirects or split public/private DNS answers are
blocked after the initial confirmation. Chromium resolves the host again when
the approved request continues; Playwright cannot pin that connection to the
checked address, so a narrow TTL-0 DNS-rebinding race remains. The mandatory
`env` confirmation is the compensating control for that residual risk.

The inspect tools act only on the **already-loaded** page and take no new
outward action, so they are `readonly` (snapshot/console) or `execute`
(screenshot, which writes a PNG artifact). They fail with `no_page` until you
navigate first.

Interactions are classified from **where the loaded page points**, because that
decides what a click can actually do:

- **Loopback page** (`localhost`, `127.0.0.0/8`, `::1`) → `execute`. Driving
  your own dev server is ordinary work and runs unattended in auto mode.
- **Any other page** → `env`, confirmed on **every** call even in auto mode, with
  the selector and the page shown verbatim. A click on someone else's site can
  post, purchase or delete; one approval of the navigation is not an approval of
  everything done afterwards.

`browser_wait_for` only observes, so it stays `readonly` wherever the page came
from.

The shared browser is a single instance for the session and is torn down at
session end (with a process-exit fallback), so a headless browser process is
never leaked.

## Staying logged in between runs

By default every run starts logged out and forgets everything when it ends —
the browser context is created empty and torn down with the session. That is the
right default: what would be saved is not a preference, it is the cookies and
localStorage of every origin the page touched, which for a logged-in site **is**
the login.

Set `browserProfile` in your own `~/.seekforge/config.json` to keep it:

```json
{ "browserProfile": "work" }
```

The session is then loaded from and written back to
`~/.seekforge/browser-profiles/work.json`, created `0700`/`0600` so no other
account on the machine can read it. A profile that does not exist yet is the
normal first run, not an error.

The setting is a **name, not a path**. A path would let a typo — or a config
layer that should never have been trusted with the decision — drop live session
cookies into a repository working tree, where the next `git add -A` publishes
them. Names are restricted to letters, digits, dot, dash and underscore, so
they cannot leave that directory. The value is also user-owned: a project config
cannot turn persistence on, name a profile, or point the browser at a state file
the repository shipped.

Nothing the model can call reaches this. The agent cannot decide to start
storing cookies, or to store them somewhere else; the app resolves the path once
at startup and the browser session never learns anything more about it.

You do not need the agent to create the file. Point your own Playwright script
or `playwright codegen --save-storage` at the same path, log in as yourself
once, and every later run starts authenticated:

```bash
npx playwright codegen --save-storage ~/.seekforge/browser-profiles/work.json https://example.com
```

Two projects may name the same profile — that is how you say "both of these use
my work login". They then share the file, so the run that finishes LAST writes
it back: if one logged in while the other was open, the later teardown replaces
that session. Give them different names to keep their logins apart.

The profile is written when a run **finishes**. Cancelling a run (Ctrl+C, stop)
closes the browser without saving: stopping halfway through a login redirect, or
just after a cookie rotated, would otherwise replace a working session with a
broken one. The last run that finished stays the one on disk.

Sessions are per workspace: one Chromium process serves everything, but each
workspace gets its own browser context — separate cookies, separate pages — so
two workspaces running at once on `seekforge serve` never see each other's page
or each other's login.

To forget a session, delete the file.

## The verification loop

1. Start your dev server (e.g. `run_command` with `npm run dev` in the
   background) and note its URL.
2. `browser_navigate({ url: "http://localhost:5173/" })` — open the page.
3. `browser_console()` — check for errors / failed requests introduced by your
   change. This is the fastest "did I break it" signal.
4. `browser_snapshot()` — confirm the expected headings/links/form fields are
   present, without spending tokens on an image.
5. Drive the flow you actually changed: `browser_fill({selector:"#user",
   text:"ada"})` → `browser_select({selector:"#team", label:"Tools team"})` →
   `browser_click({selector:"#submit"})` → `browser_wait_for({text:"Welcome"})`.
6. `browser_screenshot()` — capture a PNG for the record. On a model that
   accepts images the shot is handed straight to it and it simply looks at the
   page; on one that does not, the result says so and the path goes to
   `image_analyze` for the visual check ("is the layout broken?"). Which of the
   two happens is the [`inlineImages`](configuration.md#inlineimages) answer for
   your provider.

Iterate: edit → re-`browser_navigate` (or reload) → interact → `browser_console`
until the page is clean.

`scripts/browser-tools-smoke.mts` runs exactly this loop against a real Chromium
and a throwaway page; CI runs it whenever Chromium is available.

Stopping the Agent run cancels pending browser DNS checks and active navigation,
screenshot, title, or snapshot operations, closing the shared browser when
needed to interrupt Playwright.
