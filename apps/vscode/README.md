# SeekForge for VS Code

Chat, permission review, and an IDE bridge for a local `seekforge serve`. The
full guide is [docs/ide.md](../../docs/ide.md).

## Connect

The extension talks to `http://127.0.0.1:7373`, the address `seekforge serve`
listens on by default.

- Run **SeekForge: Start Server for This Workspace** to have VS Code run
  `seekforge serve` for the open folders in a terminal. It saves the printed
  token to SecretStorage and masks it in the terminal; closing the terminal
  stops the server. The executable is `seekforge.serveCommand`.
- Or start `seekforge serve /path/to/project` yourself and run **SeekForge: Set
  Server Token**. Set `seekforge.serverUrl` if it listens elsewhere.

`seekforge.serverUrl` and `seekforge.serveCommand` can only be set in user
settings: the token is sent to the first and the second is executed, so a
repository's settings must not choose them. Legacy `seekforge.token` settings
are migrated to SecretStorage and removed.

When nothing answers, the extension offers to start the server or set the
token. In a multi-root window a conversation belongs to the folder of the
editor that was active when it started, and the extension refuses to run when
the server does not host that folder.

## Chat

The **SeekForge** activity-bar view (Cmd+Esc / Ctrl+Esc) is a chat; the ⧉
button opens more conversations in editor tabs. Assistant text streams as
rendered markdown, reasoning in a collapsible block, and tool calls as rows
with their arguments and live output. The footer keeps the session's cost and
cache-hit accounting, as does the status bar.

Pick Ask, Edit, or Plan, and an approval mode (Confirm each, Accept edits,
Auto) per message. Follow-up messages continue the same session; ⟲ resumes a
stored one; **Execute plan** turns a finished plan into an edit run; Stop
cancels. Type `@` to mention a file, and use **+ Selection** (Cmd+Alt+K /
Ctrl+Alt+K) to attach the selected lines. With **Context** on, the active
selection, open files, and the active file's errors are attached too. Agent
questions can be answered with an option or, when allowed, free text.

## Permission review

Requests appear as cards that always show the raw command and path. **Open
diff** uses VS Code's diff editor on read-only documents; multi-edit patches
can be approved per edit; **Allow for session** and **Always allow** appear
only when core will honor them (the rule "always" would write is shown
verbatim); **Deny with reason** tells the agent what to do instead. A plan the
agent asks to execute is rendered as markdown.

The chat page runs under a nonce-only Content Security Policy with no remote
resources, validates every message in both directions, and builds all content
as DOM text — model output is never interpreted as HTML.

## IDE bridge

While active, the extension serves the editor's context (active file,
selection, open files, diagnostics) and can open diffs and files for local
SeekForge processes such as the terminal UI. It listens on `127.0.0.1` only,
requires the bearer token from its owner-only lock file under
`~/.seekforge/ide/`, and refuses browser origins and non-loopback Host headers.
Disable it with `seekforge.ideBridge.enabled`. The contract is in
[docs/ide.md](../../docs/ide.md#the-ide-bridge).

## Other commands

**Show Workspace Diff**, **Review Memory Candidates** (memory stays
human-gated), **Open Session Transcript** (readable Markdown instead of the raw
JSONL), **Show Activity Output**, and the read-only **SeekForge Loops** Explorer
view, which lists persisted Loops with status, progress and spend and refreshes
only when you ask. Starting, pausing, steering and deleting Loops stay with the
surfaces that own the control plane.

REST calls time out after 15 seconds; runs have a 30-minute safety timeout.
Cancelling sends the server's `cancel` frame before closing the socket, and an
interrupted edit run is never replayed automatically.

## Build and release

The extension is plain CommonJS with no runtime dependencies (its WebSocket
client is built in). Build a VSIX with `pnpm --filter seekforge-vscode package`,
or install the `seekforge-vscode-<version>.vsix` attached to each GitHub
release (`code --install-extension <file>`). Its version is bumped by
`scripts/release.mjs` together with the CLI, TUI, and desktop app, and the
release workflow refuses to package a mismatched version. Tests:
`pnpm --filter seekforge-vscode test`.

Marketplace publishing is deliberately not automated: `vsce publish` needs the
`publisher` account's personal access token, which is not a repository secret.
The `publisher` field must match the account that owns that token before any
Marketplace publish.
