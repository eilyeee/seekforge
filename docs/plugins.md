# Plugins

> **English** | [简体中文](plugins.zh-CN.md)

Plugins are first-class extension bundles that can contribute ordinary SeekForge
skills, subagents, slash commands, output styles, MCP servers, language servers,
and hooks through one reviewed manifest — SeekForge's own `plugin.json` or a
Claude Code `.claude-plugin/plugin.json` (see
[Claude Code plugins](#claude-code-plugins)). They do not bypass the existing
permission system: contributed tools still use normal tool permissions, and
contributed hooks activate only after explicit approval.

## Lifecycle and locations

- Project plugins live at `.seekforge/plugins/<id>/`. SeekForge discovers them
  with status `review_required`; repository content is never enabled directly.
- `seekforge plugin install <source>` stages a plugin from a local directory, a
  git repository, an https archive, or a marketplace (see
  [Install sources](#install-sources)) and copies it into
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

## Install sources

`seekforge plugin install <source>` (and `plugin update <source>`, which is the
same with `--force`) accepts:

| Source | Example | What happens |
| --- | --- | --- |
| Local directory | `./team-workflows` | Copied as before. An existing path wins over the `<plugin>@<marketplace>` reading of the same text. |
| Git repository | `https://github.com/acme/tools.git#v1.2.0`, `git@github.com:acme/tools.git`, `ssh://…`, `file:///srv/mirror/tools` | `git clone --depth 1` (with `--branch <ref>` for `#ref`) into a private staging directory; the checked-out commit is recorded and `.git` is removed before anything is validated. |
| https archive | `https://example.com/tools-1.2.0.tar.gz` (`.tgz`, `.zip`) | Downloaded, hashed with SHA-256 (recorded), then unpacked by the system `tar` or `unzip`. A single top-level directory, as in GitHub tarballs, is descended into. |
| Marketplace entry | `formatter@acme` | Resolved through a registered marketplace; see [Marketplaces](#marketplaces). |

Plain `http://` and `git://` (unencrypted), `ext::` and other git transports,
and sources starting with `-` are refused. Git runs without a shell, with
`protocol.ext.allow=never`, without submodules, and with its terminal
credential prompt disabled (`GIT_TERMINAL_PROMPT=0`); credentials embedded in a
git URL are used for the clone but stripped from the recorded origin. Archive
URLs with embedded credentials are refused.

Whatever the source, the staged copy then goes through the same install as a
local directory: manifest validation, the link/special-file refusal, the
1,000-file / 10 MiB bounds, and **a disabled install until `plugin enable`
approves its exact digest**. The origin (commit or archive SHA-256, plus the
marketplace it came through) is informational — it appears in
`plugin list --json`, `plugin inspect --json` and the install output, but the
approval is bound to the digest of what was installed, never to the origin.
The staging directory lives under `~/.seekforge/plugins/.staging-*` and is
removed whether or not the install succeeds.

Archives are checked before the system tool sees them:

- a `.tar.gz` is inflated in-process with a 32 MiB output cap, so no
  decompression bomb reaches disk, and the download itself is capped at 20 MiB;
- the tar/zip member table is parsed by SeekForge, and any symlink, hard link,
  device, FIFO, absolute or `..` path, set-id bit, encrypted or zip64 member is
  refused;
- `tar -t` / `unzip -Z1` must list the same members (same count, and the same
  names wherever they are plain ASCII) before extraction is allowed;
- redirects are followed by hand and every hop must stay on https.

Residual risk: a zip member's *declared* size is what the cap checks, and
`unzip` detects a lying size only after inflating that member, so a malicious
zip can still spend disk space (bounded by a 60-second extraction timeout)
before the install fails and the staging directory is deleted. `tar` and
`unzip` must be on `PATH` for archive installs; git must be for repository
installs and git marketplaces.

The server's `POST /api/plugins/install` (and therefore the Desktop install
flow) still takes a local path only.

## Marketplaces

A marketplace is a catalog that maps plugin names to sources, in Claude Code's
`.claude-plugin/marketplace.json` format (a root `marketplace.json` is accepted
as a fallback):

```json
{
  "name": "acme",
  "owner": { "name": "Acme tools team" },
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "formatter", "source": "formatter", "description": "House formatting rules", "version": "1.2.0" },
    { "name": "reviewer", "source": { "source": "github", "repo": "acme/reviewer", "ref": "v2" } },
    { "name": "linter", "source": { "source": "url", "url": "https://git.example.com/linter.git", "path": "plugin" } },
    {
      "name": "bundle",
      "source": { "source": "archive", "url": "https://example.com/bundle.zip", "sha256": "<64 hex digits>" }
    }
  ]
}
```

```bash
seekforge plugin marketplace add https://github.com/acme/marketplace.git   # or a local directory
seekforge plugin marketplace list [--json]
seekforge plugin install formatter@acme
seekforge plugin enable formatter
seekforge plugin marketplace remove acme
```

- `plugin marketplace add <source> [--name <name>] [--force]` takes a git URL
  (same forms and `#ref` as above) or a local directory. A git marketplace is
  cloned once, without history, into `~/.seekforge/plugin-marketplaces/<name>/`
  and its commit is recorded; a local one is read from its directory each time
  it is used. The name is the manifest's `name` unless `--name` overrides it,
  and uses lowercase letters, digits and dashes. Registrations are kept in
  `~/.seekforge/plugin-marketplaces.json`. Re-adding a name needs `--force`.
- Entry `source` forms: a relative path (joined to `metadata.pluginRoot` when
  set, and required to stay inside the marketplace after symlinks are
  resolved); a git or https archive URL string; `{ "source": "github", "repo",
  "ref"?, "sha"?, "path"? }`; `{ "source": "url" | "git", "url", "ref"?, "sha"?,
  "path"? }`; and `{ "source": "archive", "url", "sha256"? }`. A `sha` pins the
  exact commit (the install fails if it cannot be checked out); a `sha256` must
  match the downloaded archive before it is unpacked; `path` selects a
  subdirectory. `npm` and `command` sources are refused: a catalog never gets
  to run a package manager or a command. Unusable entries are listed as skipped
  instead of failing the whole marketplace.
- `plugin install <name>@<marketplace>` installs exactly the entry with that
  name, and refuses the install if the plugin's own manifest id differs, so the
  reference always means what it says. The recorded origin names the
  marketplace and the underlying git commit, archive hash or local path.
- `plugin marketplace remove <name>` deletes the registration and the cached
  clone. Plugins already installed from it stay installed (and stay under their
  own approval).

A marketplace grants nothing. Every plugin it resolves is staged, validated and
installed disabled exactly like a direct install, and still needs
`plugin enable` after you review it. Entries that rely on Claude Code's
`strict: false` (a plugin described only by its marketplace entry, with no
manifest of its own) are not supported: the plugin directory must carry its
own manifest.

## Manifest

A native plugin has a strict `plugin.json`:

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
    "commandRoots": ["commands"],
    "outputStyleRoots": ["output-styles"],
    "lspServers": {
      "terraform": { "command": "terraform-ls", "args": ["serve"], "extensionToLanguage": { ".tf": "terraform" } }
    },
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

`commandRoots` hold Markdown slash commands in the
[custom command](../apps/tui/README.md#custom-commands) format; they are named
`<plugin-id>:<command>` (subdirectories add further `:` segments), report scope
`user` with a `plugin` field, and lose to a project or user command of the same
name. The model can invoke them through `run_user_command` like any other
custom command. `outputStyleRoots` hold `<name>.md` output styles, selectable as
`<plugin-id>:<name>` after the built-in, project and user styles.
`lspServers` add or replace language servers for the `lsp_*` tools, exposed as
`<plugin-id>:<server>`; for an extension two plugins both claim, the lower
plugin id wins, and the user's own `lspServers` config beats every plugin (see
[LSP](lsp.md#configured-language-servers)).

## Claude Code plugins

A directory without `plugin.json` but with `.claude-plugin/plugin.json` is read
as a Claude Code plugin and translated in memory — the files on disk, and so
the digest you approve, are unchanged. Only `name` is required; it must be
kebab-case and becomes the plugin id. A missing or non-SemVer `version` is
shown as `0.0.0`. The components map as follows:

| Claude Code | SeekForge |
| --- | --- |
| `skills/` (manifest `skills` paths are added) | skill roots; `SKILL.md` frontmatter is read natively ([Skills](skills.md#claude-code-skills)) |
| `commands/` (manifest `commands` replaces it) | command roots, `<plugin>:<command>` |
| `agents/` (manifest `agents` replaces it) | agent roots — Claude Code's flat `agents/<name>.md` files are not loaded yet and are reported |
| `output-styles/` (manifest `outputStyles` replaces it) | output-style roots, `<plugin>:<style>` |
| `hooks/hooks.json` or manifest `hooks` | hooks: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`, `SubagentStop`, `Notification`, `SessionEnd` |
| `.mcp.json` or manifest `mcpServers` | MCP servers, names lower-cased to `[a-z0-9-]`, marked `trusted: true` |
| `.lsp.json` or manifest `lspServers` | language servers (`command`, `args`, `env`, `extensionToLanguage`, `initializationOptions`) |

Manifest component values may be a relative path, a list of paths, or (for
hooks, MCP and LSP) an inline object. Paths must stay inside the plugin; only
directories are accepted as component roots. `${CLAUDE_PLUGIN_ROOT}` resolves to
the installed plugin directory: it is substituted into MCP and LSP commands,
arguments and environment values and into skill bodies, and exported to hook
commands, which run as `export CLAUDE_PLUGIN_ROOT='<dir>'; <command>`.

Two mappings carry authority, so review them before `plugin enable`:

- **MCP servers connect automatically.** Claude Code starts a plugin's servers
  when the plugin is enabled; SeekForge does the same by marking the
  translated entries `trusted: true`, so enabling the digest is the trust grant.
- **Hooks keep SeekForge's contract.** A hook command receives SeekForge's JSON
  payload (see [Configuration](configuration.md#hooks)), and any non-zero exit blocks a
  `preToolUse` hook — scripts written for Claude Code's payload or its
  exit-code-2 convention may behave differently.

What does not map is left out and listed as `warnings` on the plugin record
(`plugin inspect <id> --json`): other hook events, non-`command` hook types,
matchers that are not a plain `Tool|Tool` alternation (tool matchers use Claude
Code tool names, mapped to SeekForge's), any matcher on a non-tool event, MCP
servers with an unsupported transport such as `sse`, invalid language servers,
missing or escaping paths, and flat agent files. The `supply-chain` report lists
`commands`, `output-styles` and `lsp` among a plugin's capabilities.

## Safety boundaries

Installation accepts only real directories containing regular files: symbolic
links and special files are rejected. A plugin is capped at 1,000 files and
10 MiB, and its manifest at 64 KiB. Invalid, oversized, changed, project-only,
or disabled plugins contribute nothing.

Enabling a plugin is an authority decision. Review its complete directory,
especially hooks, stdio MCP commands, MCP `trusted` flags (and a Claude Code
plugin's `.mcp.json`, which is trusted once enabled), language-server commands,
environment/header values, and agent or skill instructions — a plugin skill's
`allowed-tools` pre-approves those tools while the skill is active. The digest check detects changes; it does not establish the
author's trustworthiness or sandbox third-party code.

## CLI

```bash
seekforge plugin list [--json]
seekforge plugin inspect <id> [--json]
seekforge plugin validate <path>
seekforge plugin create <id>
seekforge plugin install <source>     # path | git URL[#ref] | https archive | <plugin>@<marketplace>
seekforge plugin update <source>
seekforge plugin enable|disable <id>
seekforge plugin remove <id>
seekforge plugin marketplace add <source> [--name <name>] [--force]
seekforge plugin marketplace remove <name>
seekforge plugin marketplace list [--json]
```

`plugins` is an alias for the top-level `plugin` command.
