# Releasing the SeekForge desktop app (macOS DMG + auto-update)

The desktop shell ships as a DMG and self-updates via
[`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/), which polls

```
https://github.com/eilyeee/seekforge/releases/latest/download/latest.json
```

on every launch (see `spawn_update_check` in `src-tauri/src/main.rs`). Until
the placeholder pubkey in `src-tauri/tauri.conf.json` is replaced, the
updater logs "updater unavailable" and the app otherwise works normally.

## 0. One-time: generate the updater signing keypair

```sh
pnpm tauri signer generate -w ~/.tauri/seekforge.key
```

- The command prints a **public key** — paste it into
  `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
  (replacing the `REPLACE_WITH_UPDATER_PUBKEY ...` placeholder) and commit.
- `~/.tauri/seekforge.key` (and `.key.pub`) is the **private key — never
  commit it**. Back it up: losing it means shipped apps can no longer verify
  your updates and users must re-download manually.

## 1. Build

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/seekforge.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # or the password you chose
pnpm install
pnpm tauri build
```

`tauri build` runs `pnpm --filter @seekforge/desktop build` first (Vite),
compiles the Rust shell, and because `bundle.createUpdaterArtifacts` is true
also produces signed updater artifacts. Output (workspace root, since the
crate is a member of the root Cargo workspace):

```
target/release/bundle/dmg/SeekForge_<version>_aarch64.dmg     # what users download
target/release/bundle/macos/SeekForge.app.tar.gz              # updater payload
target/release/bundle/macos/SeekForge.app.tar.gz.sig          # updater signature
```

Bump `version` in `src-tauri/tauri.conf.json` (and keep
`src-tauri/Cargo.toml` in sync) before each release.

## 2. macOS code signing & notarization (separate from updater signing)

Unsigned builds run locally but Gatekeeper quarantines downloads. For public
distribution you need an Apple Developer ID certificate:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
pnpm tauri build        # signs + notarizes automatically when these are set
```

Without these env vars the build still succeeds; tell testers to
`xattr -dr com.apple.quarantine /Applications/SeekForge.app` after install.

## 3. Write `latest.json`

```json
{
  "version": "0.1.0",
  "notes": "What changed.",
  "pub_date": "2026-06-12T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of SeekForge.app.tar.gz.sig>",
      "url": "https://github.com/eilyeee/seekforge/releases/download/v0.1.0/SeekForge.app.tar.gz"
    }
  }
}
```

Add a `darwin-x86_64` entry too if you also build on/for Intel
(`pnpm tauri build --target x86_64-apple-darwin`).

## 4. Publish the GitHub release

```sh
gh release create v0.1.0 \
  target/release/bundle/dmg/SeekForge_0.1.0_aarch64.dmg \
  target/release/bundle/macos/SeekForge.app.tar.gz \
  latest.json \
  --title "SeekForge 0.1.0" --notes "..."
```

`releases/latest/download/latest.json` always resolves to the most recent
non-draft, non-prerelease release — publishing is all it takes for existing
installs to pick the update up on next launch (it downloads and installs in
the background; users see it after restarting the app).

## Checklist

1. Bump versions (`tauri.conf.json` + `Cargo.toml`), update CHANGELOG.
2. `pnpm tauri build` with `TAURI_SIGNING_PRIVATE_KEY` (+ Apple env for
   notarization).
3. Smoke-test the DMG: install, launch, check `⏺ chat` connects.
4. Write `latest.json` with the `.sig` contents.
5. `gh release create` with DMG + `SeekForge.app.tar.gz` + `latest.json`.
