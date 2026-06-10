# seekforge-runtime stdio protocol

Line-delimited JSON over stdin/stdout. One request per line in, one response
per line out. Responses may arrive out of order; `id` correlates them.
stderr is for human-readable logging only and is never parsed.

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
| git_status | – | `{output}` |
| git_diff | staged? | `{output}` |

## Sandbox rules (must match docs/06)

- Canonicalized path must stay under canonicalized workspace; for paths that
  do not exist yet, canonicalize the deepest existing ancestor.
- Read denial for sensitive basenames: `.env`, `.env.*`, `*.pem`, `*.key`,
  `id_rsa*`, `id_ed25519*` → error `sensitive_path`.
- Write denial under `.git/`.
- Ignore list for list_files: `.git node_modules dist build .next .nuxt
  .cache coverage target vendor`.
- run_command denylist (error `denied_dangerous`, never execute):
  `rm -rf`, `sudo`, `chmod -R`, `chown`, `git reset --hard`, `git clean`,
  `git push`, `curl|sh` / `wget|sh` pipes, `bash -c`, `sh -c`, `node -e`,
  `python -c`.
- Permissions/approval live in the TypeScript dispatcher. The runtime's
  checks are a second line of defense, not the policy source.

## Error codes

`bad_request unknown_method outside_workspace sensitive_path exists no_match
ambiguous too_large binary_file denied_dangerous timeout io_error git_error`
