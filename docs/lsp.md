# LSP / precise symbol intelligence

SeekForge can talk to a real **Language Server** (LSP) so the agent gets
**precise** symbol information — go-to-definition, find-all-references, and
diagnostics — straight from the compiler/type-checker rather than from a lexical
guess. This is powered by whatever language server you already use in your
editor, which is an **optional, opt-in binary you install yourself** (it is
deliberately NOT a declared dependency, so a normal install never pulls one in).

## Why LSP beats lexical retrieval

The built-in `repo_map`, `find_definition`, and `search_text` tools are fast and
dependency-free, but they are **heuristic**: identifier-only regex / tree-sitter
outlines. They cannot follow imports, re-exports, or overloads, and they cannot
tell a definition from a same-named unrelated symbol.

A language server resolves symbols the way the compiler does:

| Question | Lexical tool | LSP tool |
| --- | --- | --- |
| "Where is `X` defined?" | `find_definition` — every regex match for `X` | `lsp_definition` — the one true definition, across imports/re-exports |
| "Who uses `X`?" | `search_text` — every textual mention of `X` | `lsp_references` — every real read/write/call site the compiler resolves |
| "Did my change break something?" | grep for error strings | `lsp_diagnostics` — the compiler's/type-checker's own errors & warnings |

Reach for the LSP tools when you need **accuracy** (before a rename, to gauge
blast radius, to confirm a fix type-checks); reach for the lexical tools to
orient quickly or when no language server is installed.

## Install a language server

The `lsp_*` tools are dormant until a server binary is on your `PATH`. Install
the one for your language:

| Language | Files | Install | Binary detected |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `npm i -g typescript-language-server typescript` | `typescript-language-server` |
| Python | `.py` | `pip install pyright` **or** `pip install python-lsp-server` | `pyright-langserver`, else `pylsp` |
| Go | `.go` | `go install golang.org/x/tools/gopls@latest` | `gopls` |

Until a server is found, every LSP tool returns a single actionable error naming
the servers to install, for example:

```
Install the TypeScript/JavaScript language server: `npm i -g typescript-language-server typescript`.
```

The server is spawned **lazily inside the tool**, never at import time, so
typecheck, build, and the whole test suite pass whether or not any server is
installed. A file type with no configured server returns `lsp_unsupported`.

## The three tools

| Tool | Args | Permission | What it does |
| --- | --- | --- | --- |
| `lsp_definition` | `path`, `line`, `character?` | `readonly` | Go-to-definition for the symbol at that position; returns the defining `file:line(s)`. |
| `lsp_references` | `path`, `line`, `character?` | `readonly` | Find all references to that symbol; returns every `file:line` plus a count. |
| `lsp_diagnostics` | `path` | `readonly` | Opens the file in the server and returns its diagnostics (`error`/`warning`/… with line + message). |

`path` is workspace-relative and must stay inside the workspace (same sandbox as
every other file tool; sensitive files like `.env`/keys are refused). `line` is
**1-based** (matching editor/tool convention); `character` is **0-based**
(0 = start of line) and defaults to 0. Results report **1-based** lines;
locations inside the repo are workspace-relative, out-of-tree locations (stdlib,
dependencies) are shown as absolute paths.

All three tools only read/analyze, so they are classified **`readonly`** — like
the browser inspect tools (`browser_snapshot` / `browser_console`) — and are
auto-allowed under every approval mode.

## Session lifecycle

One language server is spawned **per language** and reused across calls
(the `initialize`/`initialized` handshake runs once, then documents are opened
on demand). The session is torn down at the end of the run — with a
process-exit fallback — so no server process is leaked, exactly like the shared
headless browser.

## How it works under the hood

The client (`packages/core/src/tools/lsp/client.ts`) is a **minimal LSP JSON-RPC
client** over the server's stdio:

- **Framing.** Every message is `Content-Length: <bytes>\r\n\r\n` + a JSON body.
  `encodeLspMessage` / `parseLspMessages` are kept pure and stream-safe: the
  parser handles multiple messages in one buffer, a partial trailing message
  (left for the next chunk), and resynchronizes past a malformed header.
- **Handshake.** `initialize` (advertising definition/references/diagnostics
  capabilities and the workspace root) → wait for the result → `initialized`.
- **Documents.** `textDocument/didOpen` (with the file's `languageId`, version,
  and text) the first time a file is touched; `textDocument/didChange` bumps the
  version to force a fresh diagnostics pass.
- **Requests.** `textDocument/definition`, `textDocument/references`, and the
  server-pushed `textDocument/publishDiagnostics` notification (awaited briefly
  after opening/changing the file). Positions are converted from our 1-based
  `line` to LSP's 0-based line/character at the boundary.
