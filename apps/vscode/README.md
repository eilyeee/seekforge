# SeekForge for VS Code

Thin local client for the versioned `seekforge serve` REST/WebSocket contract.

1. Start `seekforge serve /path/to/project` and copy its bearer token.
2. Open the same folder in VS Code.
3. Set `seekforge.serverUrl`, then run **SeekForge: Set Server Token**. The
   bearer token is stored in VS Code SecretStorage; legacy `seekforge.token`
   settings are migrated and removed automatically.
4. Run **SeekForge: New Task**, **Resume Session**, or **Show Workspace Diff**.

The extension streams model output to the SeekForge output channel, surfaces
raw commands/paths/diffs in permission prompts, answers agent questions, and
adds the active file or selection as `@file` context. It deliberately remains a
thin client: orchestration, permissions, traces, and workspace coordination stay
inside the local SeekForge server.

In a multi-root window, commands target the workspace containing the active
editor (falling back to the first folder when no editor is active). The extension
refuses to run when that folder is not hosted by the configured server; it never
silently falls back to the server's default workspace.

REST calls have a 15-second timeout. Active WebSocket runs have a 30-minute
safety timeout and the VS Code progress notification is cancellable; cancelling
sends the server's `cancel` frame before closing the local socket. The extension
does not replay an interrupted edit run automatically.

Build a local VSIX with `pnpm --filter seekforge-vscode package`. Marketplace
publishing still requires the publisher's external credentials.
