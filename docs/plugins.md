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
- A forced update retains one previous installation. `seekforge plugin
  supply-chain` (and `GET /api/plugins/supply-chain`) shows lock/current digests,
  integrity, API compatibility, capabilities, and rollback availability.
  `seekforge plugin rollback <id>` is atomic and restores the prior version
  disabled so its content must be reviewed again. `plugin update` is the only
  producer of a rollback version, and it is a CLI command — until now rollback
  itself was reachable only from the desktop, which this bullet did not say.

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
    },
    "graphHandlers": { "summarize": "collect" },
    "graphExecutors": { "build-farm": "trusted-build-farm" }
  }
}
```

IDs use lowercase letters, digits, and dashes. Versions use SemVer syntax,
including the optional pre-release and build-metadata parts (`1.2.0-rc.1+build.7`).
Contribution roots are relative directories confined to the plugin. MCP server
names are exposed as `<plugin-id>__<server-name>` to avoid ambiguous collisions. User
configuration wins over a plugin MCP server with the same effective name;
plugin hooks run before user-configured hooks.

A contributed MCP server carries exactly the connection trust its manifest
declares. `trusted` defaults to `false` here as everywhere else, so the `docs`
server above is listed but never connected automatically, and an explicit
`"trusted": false` is preserved. Only a manifest that itself contains
`"trusted": true` lets automatic discovery spawn that server's process or
contact its endpoint, and its tools then follow the ordinary MCP permission
mapping described in [MCP](mcp.md). That line is part of the approved digest:
adding it to an installed plugin marks the plugin `changed` and stops every
contribution until the new digest is approved. To connect a server the manifest
leaves untrusted, put a full entry named `<plugin-id>__<server-name>` in your own
configuration — user configuration replaces the plugin's entry.

`graphHandlers` contributes namespaced aliases such as `team-workflows__summarize` for the deterministic built-ins `noop`, `collect`, `pick`, `project`, `merge`, `assert`, `count`, and `summarize`. `graphExecutors` can alias only an adapter that the embedding host already registered as trusted and remote; the manifest cannot create or elevate an executor. Manifests cannot contain Graph handler code or shell commands; all aliases are resolved before any Graph effect.

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
especially hooks, stdio MCP commands, MCP `trusted` flags, environment/header
values, and agent or skill instructions. The digest check detects changes; it does not establish the
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
