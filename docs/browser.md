# Browser / visual verification

> **English** | [简体中文](browser.zh-CN.md)

SeekForge can drive a real headless browser so the agent can **verify a frontend
change**: open your dev server, read the console for errors, snapshot the DOM,
and capture a screenshot. This is powered by [Playwright], which is an
**optional, opt-in add-on you install yourself** (it is deliberately NOT a
declared dependency, so a normal install never pulls in a browser driver) — the
core stays lean and users who don't want it are completely unaffected.

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

## The four tools

| Tool | Args | Permission | What it does |
| --- | --- | --- | --- |
| `browser_navigate` | `url` | `env` (always confirmed) | Opens `url` in a shared headless browser (launches once, reused across calls). Returns final url, HTTP status, and title; starts capturing console/errors/failed-requests. |
| `browser_screenshot` | `path?` | `execute` | Saves a full-page PNG under `.seekforge/uploads/` (or `path`) and returns the path. Read-only on the page. |
| `browser_snapshot` | — | `readonly` | Returns a concise text snapshot (title, url, headings, links, buttons, inputs, visible text) so the agent can "see" the page without an image. |
| `browser_console` | — | `readonly` | Returns console messages, uncaught page errors, and failed network requests captured since the last navigate — the key signal for "did my change break the page". |

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

The three inspect tools act only on the **already-loaded** page and take no new
outward action, so they are `readonly` (snapshot/console) or `execute`
(screenshot, which writes a PNG artifact). They fail with `no_page` until you
navigate first.

The shared browser is a single instance for the session and is torn down at
session end (with a process-exit fallback), so a headless browser process is
never leaked.

## The verification loop

1. Start your dev server (e.g. `run_command` with `npm run dev` in the
   background) and note its URL.
2. `browser_navigate({ url: "http://localhost:5173/" })` — open the page.
3. `browser_console()` — check for errors / failed requests introduced by your
   change. This is the fastest "did I break it" signal.
4. `browser_snapshot()` — confirm the expected headings/links/form fields are
   present, without spending tokens on an image.
5. `browser_screenshot()` — capture a PNG for the record, or to hand to
   `image_analyze` for a visual check ("is the layout broken?").

Iterate: edit → re-`browser_navigate` (or reload) → `browser_console` until the
page is clean.

Stopping the Agent run cancels pending browser DNS checks and active navigation,
screenshot, title, or snapshot operations, closing the shared browser when
needed to interrupt Playwright.
