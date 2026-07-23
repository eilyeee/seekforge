# Plugins

> **English** | [简体中文](plugins.zh-CN.md)

Plugins are first-class extension bundles that can contribute ordinary SeekForge
skills, subagents, MCP servers, and hooks through one reviewed manifest. They do
not bypass the existing permission system: contributed tools still use normal
tool permissions, and contributed hooks activate only after explicit approval.

## Lifecycle and locations

- Project plugins live at `.seekforge/plugins/<id>/`. SeekForge discovers them
  with status `review_required`; repository content is never enabled directly.
- `seekforge plugin install <path>` copies a reviewed, local directory into
  `~/.seekforge/plugins/<id>/`. A new or updated install starts disabled.
- `seekforge plugin enable <id>` approves the exact SHA-256 digest of every file
  in the installed directory. Any later file change yields status `changed` and
  disables all contributions until the new digest is explicitly approved.
- `disable` keeps the installation but removes all contributions; `remove`
  uninstalls it and deletes its approval record.

The Desktop has a top-level **Plugins** page for the same review/install/enable
flow. The TUI `/plugins` command is a read-only status view.

## Manifest

Every plugin has a strict `plugin.json`:

```json
{
  "apiVersion": 1,
  "id": "team-workflows",
  "name": "Team workflows",
  "version": "1.0.0",
  "description": "Shared review workflows",
  "contributes": {
    "skillRoots": ["skills"],
    "agentRoots": ["agents"],
    "mcpServers": {
      "docs": {
        "url": "https://mcp.example.com/rpc",
        "permission": "readonly"
      }
    },
    "hooks": {
      "sessionStart": [{ "command": "node scripts/check-environment.mjs" }]
    }
  }
}
```

IDs use lowercase letters, digits, and dashes. Versions use SemVer syntax.
Contribution roots are relative directories confined to the plugin. MCP server
names are exposed as `<plugin-id>__<server-name>` to avoid ambiguous collisions. User
configuration wins over a plugin MCP server with the same effective name;
plugin hooks run before user-configured hooks.

Plugin skill/agent roots load in plugin-id order. A later plugin can replace an
earlier plugin's same-id contribution, while user global/project definitions
always load later and therefore win. Prefer plugin-prefixed skill and agent IDs.
Each Agent or Loop assembly takes one contribution snapshot and reuses its
approved roots/configuration for skills, subagents, hooks, and MCP servers.
Installed digest changes are revalidated when the next assembly is created;
do not mutate an installed plugin while a run is active.

## Safety boundaries

Installation accepts only real directories containing regular files: symbolic
links and special files are rejected. A plugin is capped at 1,000 files and
10 MiB, and its manifest at 64 KiB. Invalid, oversized, changed, project-only,
or disabled plugins contribute nothing.

Enabling a plugin is an authority decision. Review its complete directory,
especially hooks, stdio MCP commands, environment/header values, and agent or
skill instructions. The digest check detects changes; it does not establish the
author's trustworthiness or sandbox third-party code.

## CLI

```bash
seekforge plugin list [--json]
seekforge plugin inspect <id> [--json]
seekforge plugin validate <path>
seekforge plugin create <id>
seekforge plugin install <path>
seekforge plugin update <path>
seekforge plugin enable|disable <id>
seekforge plugin remove <id>
```

`plugins` is an alias for the top-level `plugin` command.
