# seekforge-runtime stdio protocol

Line-delimited JSON over stdin/stdout. Each request occupies one input line and
gets one response line. Responses may arrive out of order; `id` correlates
them. Cancellation notifications are the only input lines without responses.
stderr is for human-readable logging only and is never parsed.

Requests run on a fixed-size worker pool behind a bounded input queue. A request
received while that queue is full gets a `runtime_busy` error. EOF cancels
unfinished requests, waits for their responses, and then exits.

Each request line is limited to 8 MiB. An oversized line receives a `too_large`
response with a null id, is discarded through its newline, and does not prevent
subsequent requests from being processed.

Cancellation is an optional notification with no response of its own:

```json
{"method": "cancel", "params": {"id": "r1"}}
```

The target request still receives exactly one response, normally with error
code `cancelled`. Request ids must be unique while in flight. Clients that do
not send cancellation notifications remain compatible; runtimes predating
this extension may ignore or reject the notification without affecting the
original request/response framing.

## Request

```json
{"id": "r1", "method": "read_file", "params": {"workspace": "/abs/path", "path": "src/a.ts"}}
```

`workspace` is required in every method's params (absolute path). All file
paths are workspace-relative; the runtime re-resolves and re-checks
containment independently of the TypeScript layer (defense in depth).

## Response

```json
{"id": "r1", "ok": true, "data": {"content": "..."}}
{"id": "r1", "ok": false, "error": {"code": "outside_workspace", "message": "..."}}
```

Unparseable request lines get a response with `"id": null`, code
`bad_request`. Unknown methods: code `unknown_method`.

## Methods

| method | params (besides workspace) | data |
| --- | --- | --- |
| ping | – | `{version}` |
| read_file | path | `{content}` (UTF-8; >5 MB → error `too_large`; binary → error `binary_file`) |
| list_files | path?, maxDepth? | `{entries: string[], truncated: bool}` (sorted, ignore-list applied, cap 500) |
| write_file | path, content, overwrite? | `{path}` (exists && !overwrite → error `exists`) |
| apply_patch | path, edits: [{oldString,newString}] | `{path, editsApplied}` (atomic; 0 matches → `no_match` with nearest-line hint in message; >1 → `ambiguous` with count) |
| run_command | command, cwd?, timeoutMs? | `{exitCode, stdout, stderr, durationMs, timedOut}` (denylist re-check → `denied_dangerous`; stdout/stderr capped 20000 chars head+tail) |
| git_status | – | `{output}` (cancellable; 30-second internal deadline; output capped at 20000 chars head+tail) |
| git_diff | staged? | `{output}` (cancellable; 30-second internal deadline; output capped at 20000 chars head+tail) |

## Sandbox rules (must match docs/06)

- Canonicalized path must stay under canonicalized workspace; for paths that
  do not exist yet, canonicalize the deepest existing ancestor.
- Read denial for sensitive basenames: `.env`, `.env.*`, `*.pem`, `*.key`,
  `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.pgpass`, and
  `.git-credentials` → error `sensitive_path`. The workspace-relative paths
  `.seekforge/config.json`, `.seekforge/triggers.json`, and `.git/config` are
  denied as well.
- Write denial under `.git/`.
- Ignore list for list_files: `.git node_modules dist build .next .nuxt
  .cache coverage target vendor`.
- run_command denylist (error `denied_dangerous`, never execute):
  `rm -rf`, `sudo`, `chmod -R`, `chown`, `git reset --hard`, `git clean`,
  force push (`git push --force`, `--force-with-lease`, or `-f`),
  `curl|sh` / `wget|sh` pipes, nested shell `-c`, and inline interpreter eval
  (`node`, `python`, `perl`, `ruby`, `deno`, or `bun`). Git global options and
  their separate values are consumed before classifying the subcommand.
- Plain `git push` is not runtime-denied. The TypeScript dispatcher classifies
  it as an environment-level operation that always requires human approval;
  the runtime then accepts the already-approved command while still rejecting
  force push.
- Permissions/approval live in the TypeScript dispatcher. The runtime's
  checks are a second line of defense, not the policy source.

## Error codes

`bad_request unknown_method outside_workspace sensitive_path exists no_match
ambiguous too_large binary_file denied_dangerous cancelled runtime_busy timeout
io_error git_error`
