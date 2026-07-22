# SeekForge for VS Code

Thin local client for the versioned `seekforge serve` REST/WebSocket contract.

1. Start `seekforge serve /path/to/project` and copy its bearer token.
2. Open the same folder in VS Code.
3. Set `seekforge.serverUrl` and `seekforge.token` in VS Code settings.
4. Run **SeekForge: New Task**, **Resume Session**, or **Show Workspace Diff**.

The extension streams model output to the SeekForge output channel, surfaces
raw commands/paths/diffs in permission prompts, answers agent questions, and
adds the active file or selection as `@file` context. It deliberately remains a
thin client: orchestration, permissions, traces, and workspace coordination stay
inside the local SeekForge server.
