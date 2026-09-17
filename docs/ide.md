# VS Code extension and IDE bridge

> **English** | [简体中文](ide.zh-CN.md)

The VS Code extension (`apps/vscode`) is a client of a local `seekforge serve`.
It gives you a chat next to your code, reviews every permission request in the
native diff editor, and runs a small loopback **IDE bridge** that the terminal
UI uses to read what you have open. Orchestration, permissions, traces and
workspace coordination stay in the server; the extension never runs the agent
itself.

## Install and connect

Install the `seekforge-vscode-<version>.vsix` attached to each GitHub release
(`code --install-extension <file>`), or build one with
`pnpm --filter seekforge-vscode package`. The extension has no runtime
dependencies.

The extension talks to `http://127.0.0.1:7373` by default, the address
`seekforge serve` listens on. You can connect in either of two ways:

- **Let VS Code start the server.** Run **SeekForge: Start Server for This
  Workspace**. It runs `seekforge serve <workspace folders> --port <port>` in a
  **SeekForge Server** terminal, reads the token from the line the server
  prints, saves it to VS Code SecretStorage, and masks it in the terminal.
  Closing the terminal (or Ctrl+C in it, or **Stop the Server Started by VS
  Code**) stops the server. The executable comes from `seekforge.serveCommand`
  (default `seekforge`, so install the CLI with `npm install -g seekforge`).
  VS Code only starts a server for a trusted workspace.
- **Use a server you started yourself.** Run `seekforge serve /path/to/project`,
  then **SeekForge: Set Server Token** and paste the token from the printed URL.
  If the server listens elsewhere, set `seekforge.serverUrl`.

When a request finds nothing listening, the extension offers to start the
server, set the token, or open the setting. When the server rejects the saved
token, it offers to set a new one.

`seekforge serve` prints its token once and does not write it to a file, which
is why the extension either starts the server itself or asks you to paste it.

## Chat

Open the **SeekForge** view in the activity bar, or press **Cmd+Esc** (macOS) /
**Ctrl+Esc** (Windows, Linux). The **⧉** button (or **SeekForge: Open Chat in
Editor Tab**) opens another conversation in an editor tab; every tab and the
sidebar hold their own conversation.

- **Conversations continue.** The first message starts a session; every later
  message continues it, until **+** (New Chat) starts a fresh one. **⟲**
  (Resume Session) lists the workspace's stored sessions and reloads one with
  its history and cost. A session running in one chat cannot be continued from
  another at the same time.
- **Streaming.** Assistant text streams in as rendered markdown. Reasoning
  streams into a collapsible *Thinking* block that folds away when the answer
  starts. Tool calls appear as rows with the tool and its main argument; expand
  a row for the full arguments and live command output. Changed files, sub-agent
  progress, plan checklists (`update_plan`) and the final report appear inline;
  file names open the file.
- **Footer.** The session's cost, prompt tokens (with context-cache hits) and
  completion tokens, plus context-window use. The status bar shows the same
  spend after the chat is hidden.
- **Stop.** The Stop button (or **SeekForge: Stop the Running Task**) cancels
  the run on the server.
- **Mode** — *Ask* answers read-only, *Edit* makes changes, *Plan* produces a
  read-only plan first. When a plan finishes, **Execute plan** continues the
  same session in edit mode.
- **Approval mode** — *Confirm each* asks before every write or command,
  *Accept edits* applies file edits and asks for commands, *Auto* approves
  writes and commands (dangerous calls are still refused and environment
  changes still ask).
- **Mentions.** Type `@` to search workspace files and insert `@path`.
- **Selections.** **+ Selection** (or **Cmd+Alt+K** / **Ctrl+Alt+K** in the
  editor, or **Add Selection to Chat** in the editor context menu) inserts a
  reference such as `@src/app.ts#L10-24` and attaches that code to the message
  while the reference stays in it.
- **Editor context.** While **Context** is checked, each message also carries
  the active file, its selection, the open editor tabs (up to 50, workspace
  files only) and the active file's error diagnostics (up to 30). Each part has
  a setting, below. The attached parts are listed under your message.
- **Questions.** When the agent asks a question (`ask_user`), pick an option,
  type your own answer when the question allows it, or decline.

Messages larger than the server's 1 MB frame limit are refused before they are
sent, and a refused or failed message goes back into the composer.

## Reviewing permission requests

A permission request appears as a card above the composer. When the chat is
hidden, a notification offers to show it.

- The card always shows the **raw command** and **raw path** the approval
  grants, never only a summary.
- **Open diff** shows a proposed edit in VS Code's diff editor. Both sides are
  read-only documents rebuilt from the preview; a multi-file edit opens as a
  changes view, and a preview that hit its size cap says so on both sides.
- A multi-edit `apply_patch` lists its edits with checkboxes; **Allow selected
  edits** applies only the checked ones.
- **Allow for session** and **Always allow** appear only when core says it will
  honor them. Environment-level tools are never offered a session grant, and
  **Always allow** shows the exact rule it would write to your user config.
- **Deny with reason** sends your note with the refusal, so the agent can try
  what you asked for instead. The note is limited to 2,000 characters. A server
  that predates this ignores the note and still denies.
- When the request is the agent asking to leave plan mode, the card renders
  the plan as markdown.
- The server denies an unanswered request after 120 seconds; the card counts
  down and then closes itself.

Everything the chat displays is rendered as text: markdown is parsed into a
tree and built from DOM nodes, so model or tool output can never inject HTML.
The chat page runs under a strict Content Security Policy (scripts need the
page's nonce, and nothing loads from the network), and every message between
the page and the extension is validated on both sides.

## Commands, keys and settings

| Command | Default key |
| --- | --- |
| SeekForge: Focus Chat | Cmd+Esc / Ctrl+Esc |
| SeekForge: Add Selection to Chat | Cmd+Alt+K / Ctrl+Alt+K (editor focused) |
| SeekForge: New Chat · Resume Session · Open Chat in Editor Tab · Stop the Running Task | — |
| SeekForge: Start Server for This Workspace · Stop the Server Started by VS Code · Set Server Token | — |
| SeekForge: Show Workspace Diff · Review Memory Candidates · Open Session Transcript · Open Loop · Show Activity Output | — |

| Setting | Default | Meaning |
| --- | --- | --- |
| `seekforge.serverUrl` | `http://127.0.0.1:7373` | Server address. User settings only. |
| `seekforge.serveCommand` | `seekforge` | Executable **Start Server** runs. User settings only. |
| `seekforge.context.includeSelection` | `true` | Attach the active selection. |
| `seekforge.context.includeOpenFiles` | `true` | List open workspace files. |
| `seekforge.context.includeDiagnostics` | `true` | Attach the active file's errors. |
| `seekforge.ideBridge.enabled` | `true` | Run the IDE bridge. User settings only. |

`seekforge.serverUrl` and `seekforge.serveCommand` are machine-scoped: a
repository's `.vscode/settings.json` cannot change them, because the saved
token is sent to the first and the second is executed.

## The IDE bridge

While the extension is active, it runs an HTTP server on `127.0.0.1` at a
random port, so a SeekForge process on the same machine can read the editor's
state. The terminal UI's `/ide` command uses it to pick up your selection, open
files and diagnostics for each prompt you type, and to show a pending edit as a
diff in the editor (`o` on the permission prompt); `/ide off` disconnects. Turn
the bridge off with `seekforge.ideBridge.enabled`.

### Discovery

Each VS Code window writes `~/.seekforge/ide/<port>.json`. The directory is
created with mode `0700` and the file with mode `0600`:

```json
{
  "version": 1,
  "port": 53124,
  "token": "<64 hex characters>",
  "pid": 81234,
  "ideName": "Visual Studio Code",
  "workspaceFolders": ["/Users/me/project"]
}
```

`ideName` is the editor's own name (for example *Cursor* or *Visual Studio Code
- Insiders*). The file is rewritten when the window's folders change and
removed when the window closes. On startup the extension removes lock files
whose process is gone; an unreadable file is removed only after a minute, in
case its owner is still writing it. Because process ids are reused, a client
should still expect a listed bridge to refuse the connection and move on to the
next one. A client should pick the window whose `workspaceFolders` contain
its working directory.

The terminal UI reads the lock files from `.seekforge/ide/` under its
SeekForge home: your home directory, or `$SEEKFORGE_HOME` when that is set. The
extension always writes under your home directory, so a terminal UI started
with a different `SEEKFORGE_HOME` finds no bridge. It believes a lock file only
when it is a regular file you own that nobody else can read, in a directory
nobody else can write to, and it quietly skips one whose process is gone;
`/ide` names every other file it refused, and why. Windows that contain the
current project are listed first.

### Requests

Every request needs `Authorization: Bearer <token>`. Responses are JSON.

`GET /v1/context` returns:

```json
{
  "activeFile": "/Users/me/project/src/app.ts",
  "selection": { "path": "/Users/me/project/src/app.ts", "startLine": 10, "endLine": 24, "text": "…" },
  "openFiles": ["/Users/me/project/src/app.ts"],
  "diagnostics": [
    { "path": "/Users/me/project/src/app.ts", "line": 12, "column": 5, "severity": "error", "message": "…", "source": "ts" }
  ]
}
```

Paths are absolute and lines and columns 1-based. `activeFile` and `selection`
are omitted when there is none; only files on disk are reported. The selection
text is capped at 20,000 characters, `openFiles` at 50 entries, and
`diagnostics` at 200, errors first (severity is `error`, `warning`, `info` or
`hint`).

`POST /v1/openDiff` with `{ "path", "original", "proposed", "title"? }` opens
VS Code's diff editor on two read-only documents and returns `{ "ok": true }`.
`POST /v1/openFile` with `{ "path", "line"? }` opens the file (at that line)
and returns `{ "ok": true }`; the terminal UI does not call it, it is there for
other clients. `path` must be absolute; `line` a positive integer; `title` at
most 200 characters.

Errors are `{ "error": "<code>", "message": "…" }`: `400 bad_request` (malformed
body, relative path), `401 unauthorized`, `403 forbidden`, `404 not_found`
(unknown route, or a file that does not exist), `405 method_not_allowed`,
`413 too_large` (bodies are capped at 16 MB), `500 internal`.

### Security model

- The server listens on `127.0.0.1` only, on a port chosen by the OS.
- The token is 32 random bytes, stored only in the owner-only lock file, and
  compared in constant time.
- Requests that carry an `Origin` header are refused, so a web page cannot use
  the bridge even through a CORS preflight. The `Host` header must name a
  loopback host with the bridge's port, which defeats DNS rebinding.
- There are no CORS headers, and responses are marked `no-store`.
- Bodies are counted while they arrive and refused past the cap; the bridge
  answers only the three routes above.
- The bridge shows things to you; it never edits a file. Any SeekForge process
  running as you can read the token, exactly as it can read your files.

## Troubleshooting

- **"No SeekForge server is answering"** — start one (the notification can do
  it) or check `seekforge.serverUrl`.
- **"rejected the saved token"** — the server was restarted and printed a new
  token; set it, or restart the server from VS Code.
- **"does not host the VS Code workspace"** — the server was started for a
  different folder; start it with this folder as an argument.
- **Nothing in the terminal UI's `/ide` list** — check that
  `seekforge.ideBridge.enabled` is on and that `~/.seekforge/ide/` contains a
  file for this window (and that `SEEKFORGE_HOME` is unset, or points at your
  home directory). **SeekForge: Show Activity Output** logs the bridge's port
  and lock file.
