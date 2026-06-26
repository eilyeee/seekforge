# SeekForge desktop shell (Tauri 2)

A thin native shell around the SeekForge web workbench. On launch it spawns
`seekforge serve` as a child process, waits for the single stdout line
containing `http://127.0.0.1:<port>/?token=<token>`, and opens a 1280x800
webview window navigated to that URL. On exit it kills the server's whole
process group.

The shell does **not** use Vite dev integration: `frontendDist` points at the
prebuilt React app in `../dist`, but at runtime the window always navigates to
the local server URL, which serves that same build.

## How the serve command is resolved

In order:

1. `SEEKFORGE_SERVE_CMD` — full command line, split on whitespace
   (e.g. `SEEKFORGE_SERVE_CMD="node /opt/seekforge/cli.js serve --port 0"`).
   Always wins (debugging override).
2. **Bundled sidecar** — the self-contained `seekforge-server` binary shipped
   inside the app (see below). Tauri copies the `externalBin` next to the app
   binary with the target-triple suffix stripped, so it sits at
   `<exe-dir>/seekforge-server`. This is the first real choice so a DMG-only
   user needs **no** system `seekforge`. Absent in `tauri dev` (no bundle), so
   resolution falls through — dev is unaffected.
3. Dev only (`debug_assertions`): the repo dev fallback (tsx, see #5), preferred
   over a possibly-stale `seekforge` on PATH.
4. `seekforge` found on `PATH`, run as `seekforge serve --port 0`. The searched
   PATH is **augmented** with the common global-bin locations
   (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.npm-global/bin`, `~/.local/bin`,
   `~/.volta/bin`, `~/.yarn/bin`, `~/.bun/bin`, and each
   `~/.nvm/versions/node/*/bin`) because macOS GUI apps inherit a minimal
   launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits where
   `npm i -g seekforge` installs.
5. Dev fallback: `<repo-root>/node_modules/.bin/tsx <repo-root>/apps/cli/src/index.ts serve --port 0`,
   where the repo root is found by walking up from the executable dir (then
   the cwd) to a directory containing `pnpm-workspace.yaml`.

## Self-contained bundle (CLI sidecar)

The DMG embeds the CLI's server as a Tauri **sidecar** so it is self-contained:
a user who installs only the bundle can launch it with **no** system-installed
`seekforge`.

- The sidecar is the whole CLI compiled to a single native binary with
  [`bun build --compile`](https://bun.sh/docs/bundler/executables). Regenerate
  it before bundling:

  ```sh
  pnpm --filter seekforge build:sidecar
  ```

  This writes `binaries/seekforge-server-<target-triple>` (the
  `-<target-triple>` suffix is **required** by Tauri). The triple comes from the
  `SIDECAR_TARGET` env var when set, otherwise from the `rustc -vV` host. **When
  cross-building** (`tauri build --target <other-arch>`) you must set
  `SIDECAR_TARGET` to that same triple, e.g.

  ```sh
  SIDECAR_TARGET=aarch64-apple-darwin pnpm --filter seekforge build:sidecar
  ```

  otherwise you'd ship a host-arch sidecar that can't exec on the target. The
  file is git-ignored (~70 MB) and rebuilt per release. The
  CLI's `serve` subcommand prints the same
  `http://127.0.0.1:<port>/?token=...` line the shell waits for, so the sidecar
  is wired through `externalBin: ["binaries/seekforge-server"]` in
  `tauri.conf.json` (no suffix in config).

- **Web UI for the sidecar.** A bun-compiled binary cannot find the React
  build via `import.meta.url` (its files live on a virtual FS), so the dist is
  also shipped as an app resource (`bundle.resources: { "../dist": "web" }` →
  `Contents/Resources/web`). When the shell launches the sidecar it sets
  `SEEKFORGE_STATIC_DIR` to that resource dir; `seekforge serve` honors the env
  var and serves the real workbench (verified standalone: `index.html` + assets
  + token-gated API all served). Without it the binary still runs but only
  shows the API info page.

> **Verification status:** the sidecar binary serves the full UI standalone
> (run directly with `SEEKFORGE_STATIC_DIR` set); `cargo check`/`cargo test`
> pass; and `pnpm tauri build` has been run successfully — it produces
> `SeekForge_<ver>_<arch>.dmg` + `SeekForge.app` with the sidecar laid out at
> `Contents/MacOS/seekforge-server` and the web resource bundled. The DMG has
> been **installed and launched with the in-app `⏺ chat` working end-to-end**,
> verified on a maintainer's dev machine.
> **Remaining (one check):** the same install on a machine/account with **no
> `seekforge` on PATH** — only that proves the app is served by the *bundled*
> sidecar rather than incidentally by a system-installed CLI.

## Which workspace the agent operates on

The server child's cwd is, in order:

1. `SEEKFORGE_WORKSPACE` env var.
2. The Tauri process's current working directory — so in dev, **launch the
   app from the project directory you want the agent to work on**.
3. The user's home directory (the bundled app starts with cwd `/`, which is
   skipped).

## Dev run

```sh
pnpm install
pnpm --filter @seekforge/desktop build   # produce ../dist once
cd /path/to/project-you-want-to-work-on
SEEKFORGE_WORKSPACE=$PWD pnpm --dir /path/to/seekforge tauri dev
```

`pnpm tauri dev` here still spawns the serve child itself (dev fallback via
tsx if `seekforge` is not on PATH); there is no separate Vite dev server to
start.

If the server fails to print its URL within 20 s, an error dialog shows the
captured output.

## Build a bundle

```sh
pnpm tauri build              # runs `pnpm --filter @seekforge/desktop build` first
pnpm tauri build --no-bundle  # compile the release binary only
```

Artifacts land in `target/release/` (binary) and
`target/release/bundle/` (platform packages) at the repo root, since the
crate is a member of the root Cargo workspace.

## Icons

`icons/icon.svg` is the source of truth (whale + forge spark, whale blue on
deep zinc — matches the in-app `LogoMark`). Regenerate the platform set with:

```sh
pnpm tauri icon apps/desktop/src-tauri/icons/icon.svg -o apps/desktop/src-tauri/icons
rm -rf apps/desktop/src-tauri/icons/{android,ios}   # mobile sets are not used
```

## Releasing (DMG + auto-update)

See [`../docs/RELEASING.md`](../docs/RELEASING.md) for key generation,
signing, and publishing `latest.json` to GitHub releases.

## Tests

```sh
cargo test -p seekforge-desktop
```

Covers URL-line parsing, serve-command resolution order, PATH augmentation,
repo-root discovery, workspace resolution, and the URL-wait timeout path.
