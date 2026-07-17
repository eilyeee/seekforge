# Releasing the desktop app (DMG)

> **English** | [简体中文](RELEASING.zh-CN.md)

The desktop bundle is self-contained: it embeds the CLI's server as a Tauri
sidecar (see [`apps/desktop/src-tauri/README.md`](../apps/desktop/src-tauri/README.md)),
so an end user installs only the DMG — no system `seekforge`.

## Pre-release checklist

1. **Green baselines** — run the same deterministic gates as CI:
   ```sh
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm test:coverage:critical
   node scripts/npm-pack-smoke.mjs
   cargo test --workspace --exclude seekforge-desktop
   ```
   The package smoke builds on the existing CLI `dist`, packs the exact npm
   artifact, installs it under a clean temporary prefix, and runs both published
   entry points. It needs registry access to install runtime dependencies.
2. **Version bump** — set the release version in `apps/cli/package.json` and
   `apps/desktop/src-tauri/tauri.conf.json` (`version`); update `CHANGELOG.md`.
3. **Build the sidecar** for the target triple (required by Tauri):
   ```sh
   pnpm --filter seekforge build:sidecar
   # cross-build: SIDECAR_TARGET=aarch64-apple-darwin pnpm --filter seekforge build:sidecar
   ```
4. **Build the desktop web app + bundle**:
   ```sh
   pnpm --filter @seekforge/desktop build
   pnpm tauri build            # -> target/release/bundle/**/SeekForge_<ver>_<arch>.dmg
   ```

## Clean-machine verification (manual gate — required)

GUI end-to-end can't be CI-automated here; do this by hand on a machine (or
fresh user account) that has **no** `seekforge` on PATH:

- [x] Install the DMG and launch `SeekForge.app`. _(done — maintainer dev machine)_
- [ ] The window loads the workbench **served by the BUNDLED sidecar, not a
      system CLI** — this is the part still unverified: it requires a machine with
      no `seekforge` on PATH to be meaningful (the dev-machine run could be using
      the system CLI).
- [x] **⏺ chat end-to-end**: open a project, send a task, get a streamed
      response, approve a tool call. _(done — dev machine)_
- [ ] Quit the app — the sidecar's process group is killed (no orphan
      `seekforge-server`).

> Status: the DMG installs, launches, and the in-app chat works end-to-end
> (verified on a dev machine). The remaining required check is the **no-PATH /
> bundled-sidecar** containment — run it on a clean machine or fresh user account
> before publishing.

Record the result (OS version, arch) in the release notes. This is the last
pre-release check and is **not** yet wired into CI.

## Automated quality gates

- `.github/workflows/ci.yml` runs full typecheck/build/test on Node 22, enforces
  scoped coverage floors for the highest-risk URL/browser/command/cache
  boundaries, then installs and exercises the packed CLI on the supported floor,
  Node 20.
- `.github/workflows/integration.yml` runs weekly and on demand. It exercises the
  real Rust runtime protocol, builds/runs the Docker image, and launches
  Playwright Chromium for a screenshot smoke test.
- `.github/workflows/eval.yml` runs weekly and on demand against the committed
  behavioral baseline. It requires the repository `DEEPSEEK_API_KEY` secret and
  makes paid, non-deterministic provider calls; review its uploaded report and
  cost before refreshing `evals/baseline.json`.

The integration and eval schedules complement the deterministic PR gate; they
do not replace the clean-machine desktop checks above.

## Updater strategy

The updater is **disabled** today: `tauri.conf.json` has
`createUpdaterArtifacts: false` and a placeholder `updater.pubkey`. DMGs are
shipped without update artifacts or a `latest.json`.

**Decision: keep the updater off** until the project owner generates and stores a
real signing key. To enable it later:

1. `pnpm tauri signer generate -w ~/.tauri/seekforge.key` (keep the private key
   secret; never commit it).
2. Put the public key in `tauri.conf.json` `updater.pubkey` and set
   `createUpdaterArtifacts: true`.
3. Sign builds via `TAURI_SIGNING_PRIVATE_KEY` (+ password) in the release env.
4. Publish the generated `latest.json` + signed artifacts to the GitHub release;
   point `updater.endpoints` at it.

Until then, releases are install-only (download a fresh DMG to update).
