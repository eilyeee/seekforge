# `@seekforge/core` package policy

> **English** | [简体中文](core-package-policy.zh-CN.md)

## Decision

`@seekforge/core` remains a private, internal workspace package for the 0.x
series. The supported public surfaces are the `seekforge` CLI and the versioned
local REST/WebSocket protocol exposed by `seekforge serve`.

Publishing the current package would create a misleading compatibility promise:
it exports TypeScript source, exposes orchestration internals, and changes in
lockstep with the CLI/server. The VS Code bridge demonstrates that integrations
do not need those internals; they can remain thin clients over the auditable
server boundary.

## Exit criteria

Reconsider a public core SDK only after all of these exist:

- compiled ESM artifacts and declaration files for Node 20+;
- an explicit, small export map instead of the current broad source exports;
- semver and deprecation rules, including provider/protocol compatibility;
- clean-install consumer tests against the packed package;
- examples for provider injection, permissions, cancellation, and trace storage;
- a security statement distinguishing trusted embedding from workspace sandboxing.

Until then, internal consumers use `workspace:*`; third-party integrations use
`seekforge serve`. This is a distribution boundary, not a ban on eventually
publishing an SDK.
