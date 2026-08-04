# LSP / precise symbol intelligence

> **English** | [简体中文](lsp.zh-CN.md)

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
| "Where does `X` live?" | `search_text` — every mention, declaration or not | `lsp_symbols` — declarations only, each with its kind |
| "What type is this?" | read the definition and infer | `lsp_hover` — the resolved type, overloads already applied |
| "Rename `X` to `Y`" | search/replace, one file at a time, same-named symbols caught in the crossfire | `lsp_rename` — the declaration and every real reference, across files |
| "Fix this error" | write the fix by hand | `lsp_apply_code_action` — the fix the compiler itself proposes |

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

## The tools

| Tool | Args | Permission | What it does |
| --- | --- | --- | --- |
| `lsp_definition` | `path`, `line`, `character?` | `readonly` | Go-to-definition for the symbol at that position; returns the defining `file:line(s)`. |
| `lsp_references` | `path`, `line`, `character?` | `readonly` | Find all references to that symbol; returns every `file:line` plus a count. |
| `lsp_diagnostics` | `path` | `readonly` | Opens the file in the server and returns its diagnostics (`error`/`warning`/… with line + message). |
| `lsp_hover` | `path`, `line`, `character?` | `readonly` | The compiler's own description of a symbol: resolved type or signature, plus its doc comment. |
| `lsp_document_symbols` | `path` | `readonly` | Outline one file in source order — every declaration with its kind, 1-based line and nesting depth. |
| `lsp_symbols` | `query`, `path?`, `limit?` | `readonly` | Search the whole project for declarations matching `query`; returns name, kind and `path:line`. |
| `lsp_code_actions` | `path`, `line`, `endLine?`, `kind?` | `readonly` | List the fixes the server offers for those lines; the diagnostics there travel with the request. |
| `lsp_apply_code_action` | `path`, `line`, `endLine?`, `title` | `write` | Apply one of them by title, after you approve its diff. |
| `lsp_format` | `path`, `tabSize?`, `insertSpaces?` | `write` | Format the file with the server's formatter, after you approve the diff. |
| `lsp_rename` | `path`, `line`, `character?`, `newName` | `write` | Rename the symbol everywhere the server resolves it, across files, after you approve the diff. |
| `lsp_call_hierarchy` | `path`, `line`, `character?`, `direction?` | `readonly` | Who calls that function (`incoming`, default) or what it calls (`outgoing`) — each caller named, with the lines the calls are on. |
| `lsp_type_hierarchy` | `path`, `line`, `character?`, `direction?` | `readonly` | What implements or extends that type (`subtypes`, default) or what it extends (`supertypes`). |

`path` is workspace-relative and must stay inside the workspace (same sandbox as
every other file tool; sensitive files like `.env`/keys are refused). `line` is
**1-based** (matching editor/tool convention); `character` is **0-based**
(0 = start of line) and defaults to 0. Results report **1-based** lines;
locations inside the repo are workspace-relative, out-of-tree locations (stdlib,
dependencies) are shown as absolute paths.

`lsp_symbols` asks a **server-wide** question, so it needs to know which
language server to ask. It uses the ones already running for this workspace —
normally the one previous `lsp_*` calls started. If none is running it fails
with `lsp_no_session`; pass `path` (any file in the language) to start one.

The analysis tools only read, so they are classified **`readonly`** — like the
browser inspect tools (`browser_snapshot` / `browser_console`) — and are
auto-allowed under every approval mode.

## Editing

Three tools write: `lsp_rename`, `lsp_apply_code_action` and `lsp_format`. All
three work the same way — the language server produces the edit, you approve a
real diff, and it is applied all-or-nothing — so the rules spelled out for
rename below hold for all of them.

`lsp_apply_code_action` is how the compiler fixes its own complaints: list what
is on offer with `lsp_code_actions` on a line `lsp_diagnostics` flagged, then
apply one by title. An action that asks the server to run a command instead of
producing an edit is refused; that is not something to run on your behalf.

Rename is the case worth spelling out, because it writes to files the caller
never named.

**You approve a diff, not an intention.** Before you are asked anything, the
rename is computed in full: the server is asked for the edit, every target is
resolved, every file is read and the edit applied *in memory*. The confirmation
prompt then carries the real unified diff of every file, plus one selectable
hunk per file. Nothing has been written at that point.

**It is all-or-nothing.** The edit is refused outright — before the prompt — if
it would touch a file outside the workspace (a definition in `node_modules` or
the standard library), if it goes through a symlink leading out, if the server
asks to create/rename/delete files (SeekForge advertises no support for those
and does not apply them), or if any target has changed since the server read it.
If a write fails part-way through, the files already written are restored.

**Held-back files are reported.** If you approve only some of the hunks, the
result names the files that were skipped — a partial rename leaves references
pointing at the old name, and the agent has to know that.

Every file is checkpointed before it is touched, so `seekforge rewind` undoes
the whole rename like any other edit.

```
lsp_references({ path: "src/widget.ts", line: 12 })   # gauge the blast radius
lsp_rename({ path: "src/widget.ts", line: 12, newName: "Panel" })
lsp_diagnostics({ path: "src/widget.ts" })            # confirm it still compiles
```

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
- **Handshake.** `initialize` (advertising definition/references/diagnostics/
  rename/workspace-symbol capabilities and the workspace root) → wait for the
  result → `initialized`. The advertised workspace edit support lists **no**
  resource operations, telling the server it must not answer a rename with
  file creates, renames or deletes.
- **Documents.** `textDocument/didOpen` (with the file's `languageId`, version,
  and text) the first time a file is touched; `textDocument/didChange` bumps the
  version to force a fresh diagnostics pass.
- **Requests.** `textDocument/definition`, `textDocument/references`,
  `textDocument/hover`, `textDocument/documentSymbol`, `textDocument/codeAction`
  (+ `codeAction/resolve`), `textDocument/formatting`,
  `textDocument/rename`, `workspace/symbol`, and the server-pushed
  `textDocument/publishDiagnostics` notification (awaited briefly after
  opening/changing the file). Positions are converted from our 1-based `line`
  to LSP's 0-based line/character at the boundary.
- **Applying a rename.** `tools/lsp/workspace-edit.ts` normalizes both
  WorkspaceEdit shapes (`changes` and `documentChanges`), converts LSP positions
  to string offsets (`character` counts UTF-16 code units, which is exactly a
  JavaScript string index), rejects overlapping edits, and writes through the
  same verified path as every other tool write.
