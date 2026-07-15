# Security scanning

SeekForge can run a repository-wide, read-only Agent review and maintain an
auditable Finding queue. The scanner covers architecture, trust boundaries,
entry points, authentication and authorization, command and filesystem access,
parsing, persistence, networking, secrets, dependencies, and security tests.

## Quick start

```sh
seekforge security scan
seekforge security list --severity high
seekforge security show sf-0123456789abcdef
seekforge security status sf-0123456789abcdef triaged --reason "confirmed reachable"
seekforge security fix sf-0123456789abcdef --max-cost 1.00
seekforge security verify sf-0123456789abcdef
seekforge security threat-model
seekforge security export --format sarif -o reports/security.sarif
```

`scan` and `threat-model` use the configured provider and are billable Agent
runs. `fix` requires an explicit positive cost budget. It uses the normal Agent
permission path, runs configured `verifyCommand` and `lintCommand` checks, and
then performs another security scan.

## Finding queue

The append-only source of truth is:

```text
.seekforge/security/events.jsonl
```

The directory is created with mode `0700` and the JSONL file with mode `0600`.
Current Finding, scan, fix, and threat-model views are rebuilt from events; old
events are not rewritten.

Finding lifecycle states are:

```text
open -> triaged -> fixing -> resolved
  \         \          \-> accepted_risk
   \         \----------> dismissed
    \--------------------> accepted_risk / dismissed

resolved / accepted_risk / dismissed -> reopened
```

Verification is independent of lifecycle: `unverified`, `verified`, `failed`,
or `stale`. Changing a Finding to `resolved` does not prove the fix. A later scan
that redetects a resolved Finding reopens it and makes prior verification stale.

## Verification rules

An automatic fix is marked `verified` only when all of these hold:

1. The Agent edit run completed.
2. Every configured project verify/lint command exited successfully.
3. A new scan no longer contains the target Finding fingerprint.
4. The new scan introduced no Finding with severity equal to or higher than the
   target Finding.

Command, exit status, duration, timeout state, and bounded stdout/stderr are
recorded in the fix event. At least one project `verifyCommand` or `lintCommand`
must be configured; without one, verification fails closed and no rescan can
promote the Finding to `verified`. Commands use the configured OS sandbox and
timeouts terminate their full process groups.

## Evidence and prompt-injection defense

Repository content and tool output are treated as untrusted data. Scanner output
must be one exact JSON object matching the Core schema. Unknown fields, markdown
wrappers, malformed values, absolute or escaping paths, missing files, invalid
line ranges, and excerpts that do not occur in the cited source lines are
rejected. The raw model response is never persisted.

Stored text and command output are length-limited and common secret formats are
redacted. Evidence paths are repository-relative and resolved with the same
symlink-aware workspace boundary used by Core tools. Do not treat an LLM
Finding as confirmed solely because it passed structural validation; triage its
reachability and impact.

## Threat model

`seekforge security threat-model` records assets, entry points, trust
boundaries, data flows, threat scenarios, mitigations, and source locations.
Every item must cite at least one real repository file and valid line range.
Threat models are historical events; generating a new model does not overwrite
the previous one.

## Export formats

`security export` supports:

- `json`: complete evidence package, including events and derived records.
- `markdown`: human review report with Finding evidence, verification command
  outcomes, fix attempts, and expanded threat scenarios.
- `sarif`: SARIF 2.1.0 for code-scanning and archive systems.

Use `-o/--output` to write inside the workspace; exported files are mode `0600`.
Without `--output`, the selected format is written to stdout.

Exports are compliance evidence packages. They are not certifications and do
not guarantee that the repository is vulnerability-free or compliant with a
particular framework.

## Command reference

| Command | Purpose |
| --- | --- |
| `security scan [--max-findings N] [--json]` | Run a deep, read-only Agent scan and append validated Findings. |
| `security list [--status S] [--severity S] [--json]` | Query the current Finding queue. |
| `security show <id> [--json]` | Show one Finding and its evidence. |
| `security status <id> <status> [--reason TEXT]` | Record a valid lifecycle transition. |
| `security fix <id> --max-cost USD [-y]` | Fix, run checks, rescan, and record the attempt. |
| `security verify <id>` | Run checks and rescan without asking the Agent to edit. |
| `security threat-model [--json]` | Generate an evidence-backed threat model. |
| `security export --format json\|markdown\|sarif [-o PATH]` | Render the evidence package. |

`scan`, `fix`, `verify`, and `threat-model` accept `-m/--model`.

## Desktop Security Center

The Desktop sidebar exposes the same repository-scoped evidence store under
**Security**. It supports deep scans, Finding inspection and lifecycle changes,
verified automatic fixes, threat-model generation, and JSON, Markdown, or SARIF
exports. Switching workspaces reloads the selected repository's queue; no
security state is shared between workspaces.

Automatic fixes require an explicit positive Agent cost limit, a verify command,
and an optional lint command. Desktop
shows the resulting lifecycle and verification states independently, matching
the CLI rules above. MCP credentials and command output remain masked or
redacted in REST responses and exported evidence.
