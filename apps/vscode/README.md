# SeekForge for VS Code

Thin local client for the versioned `seekforge serve` REST/WebSocket contract.

1. Start `seekforge serve /path/to/project` and copy its bearer token.
2. Open the same folder in VS Code.
3. Set `seekforge.serverUrl`, then run **SeekForge: Set Server Token**. The
   bearer token is stored in VS Code SecretStorage; legacy `seekforge.token`
   settings are migrated and removed automatically.
4. Run **SeekForge: New Task**, **Resume Session**, **Show Workspace Diff**,
   **Review Memory Candidates**, **Open Session Transcript**, **Open Loop**, or
   **Show Activity Output**.

The extension streams model output, thinking, tool activity (`⏺ tool(arg)` /
`⎿ result`), changed files, sub-agent progress, and live command output to the
SeekForge output channel, and ends a run with the final report and its cost. A
status-bar item keeps the run state and cost/cache-hit accounting visible after
the progress notification disappears.

Permission prompts always show the raw command or path. A proposed diff opens as
its own `diff` document beside the editor instead of being squeezed into a modal
that would elide it, and multi-edit `apply_patch` requests offer **Allow selected
edits…** to approve individual hunks (dismissing that picker approves nothing).

**Review Memory Candidates** lists the facts a run proposed and is waiting on a
human for, and approves or rejects one — memory is human-gated by design, and
the review belongs where the code is. **Open Session Transcript** renders a past
session as readable Markdown (roles as headers, tool calls named, attachments
noted) instead of the raw JSONL.

The **SeekForge Loops** view in the Explorer lists the persisted Loops of the
active workspace with their status, iteration progress and spend against the
budget; selecting one opens a Markdown report with the verify command, the last
verify output, delivery state, and the most recent retained lifecycle events
(the report says how many earlier events it left out). The view is
**read-only** and refreshes only when you ask it to (the refresh button in its
title bar): starting, pausing, steering, pruning and deleting a Loop stay with
the surfaces that own the control plane, and an idle editor window does not poll
a server you may not be running.

It deliberately remains a thin client: orchestration, permissions, traces, and
workspace coordination stay inside the local SeekForge server.

In a multi-root window, commands target the workspace containing the active
editor (falling back to the first folder when no editor is active). The extension
refuses to run when that folder is not hosted by the configured server; it never
silently falls back to the server's default workspace.

REST calls have a 15-second timeout. Active WebSocket runs have a 30-minute
safety timeout and the VS Code progress notification is cancellable; cancelling
sends the server's `cancel` frame before closing the local socket. The extension
does not replay an interrupted edit run automatically.

Build a local VSIX with `pnpm --filter seekforge-vscode package`, or install the
`seekforge-vscode-<version>.vsix` attached to each GitHub release
(`code --install-extension <file>`). Its version is bumped by
`scripts/release.mjs` together with the CLI, TUI, and desktop app, and the
release workflow refuses to package a mismatched version.

Marketplace publishing is deliberately not automated: `vsce publish` needs the
`publisher` account's personal access token, which is not a repository secret.
The `publisher` field must match the account that owns that token before any
Marketplace publish.
