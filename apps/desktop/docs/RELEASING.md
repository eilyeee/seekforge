# Releasing the SeekForge desktop app (macOS, Linux, Windows + auto-update)

The desktop shell ships as macOS DMG, Linux DEB/AppImage, and Windows NSIS
packages. Signed builds can self-update via
[`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/), which polls

```
https://github.com/eilyeee/seekforge/releases/latest/download/latest.json
```

on every launch (see `spawn_update_check` in `src-tauri/src/main.rs`). The
`latest/download/latest.json` URL always resolves to the most recent non-draft,
non-prerelease release, so publishing a release is all it takes for existing
installs to pick up the update on the next launch (it downloads + installs in
the background; users see it after restarting the app).

There are two ways to cut a release:

- **[A. CI flow (recommended)](#a-ci-flow-recommended)** — add repo secrets once,
  push a `v*` tag, and GitHub Actions builds + publishes native macOS, Linux,
  and Windows packages. Signing is enabled when the platform credentials are configured.
- **[B. Manual local build (fallback)](#b-manual-local-build-fallback)** — run
  `pnpm tauri build` yourself and publish with `gh`.

Both paths require the **updater signing keypair** below.

---

## 0. One-time: enable + generate the updater signing keypair

The auto-updater ships **opt-in**: `tauri.conf.json` keeps a `plugins.updater`
block (so the registered plugin initializes) but with a disabled placeholder
`pubkey`, and `bundle.createUpdaterArtifacts` is `false` — so `pnpm tauri build`
succeeds out of the box and produces a (non-updatable) bundle, and the running
app just logs "updater unavailable". To turn auto-update on, do the steps below.

The updater verifies every downloaded update against an Ed25519 public key
baked into the app. Generate the keypair once:

```sh
pnpm tauri signer generate -w ~/.tauri/seekforge.key
```

This writes the **private key** to `~/.tauri/seekforge.key` (and the public key
to `~/.tauri/seekforge.key.pub`) and also prints the public key.

1. **Enable signing + public key** → in
   `apps/desktop/src-tauri/tauri.conf.json` set `bundle.createUpdaterArtifacts`
   to `true` and replace the placeholder `plugins.updater.pubkey` with the
   printed public key, then **commit**:

   ```json
   "plugins": {
     "updater": {
       "endpoints": [
         "https://github.com/eilyeee/seekforge/releases/latest/download/latest.json"
       ],
       "pubkey": "<paste the printed public key>"
     }
   }
   ```

   With `createUpdaterArtifacts: true` but the placeholder/invalid pubkey, `pnpm
   tauri build` fails with `failed to decode pubkey: ... Invalid symbol`
   **after** producing the bundles.
2. **Private key** (`~/.tauri/seekforge.key`) → **never commit it**. For CI it
   goes into the `TAURI_SIGNING_PRIVATE_KEY` repo secret (see below). Back it
   up: losing it means shipped apps can no longer verify your updates and users
   must re-download manually.

---

## A. CI flow (recommended)

`.github/workflows/release-desktop.yml` runs on every pushed `v*` tag (and via
manual **workflow_dispatch**). Its native matrix builds **`macos-14`
(Apple Silicon / aarch64)**, **`macos-13` (Intel / x86_64)**,
**`ubuntu-22.04` (x86_64 DEB + AppImage)**, and **Windows x86_64 (NSIS)**.
Every job compiles a target-qualified CLI sidecar before Tauri packages the
application. Updater payload signing and Apple code-signing/notarization are
enabled when their repository secrets are present.

### A.1 Add repo secrets once

Repo **Settings → Secrets and variables → Actions → New repository secret**.

**Required** (auto-update will not work without these):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `~/.tauri/seekforge.key` (the file from step 0). Copy with `pbcopy < ~/.tauri/seekforge.key`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose when running `signer generate`. If you pressed Enter for no password, set this to an **empty string**. |

**Optional** — Apple Developer ID code-signing + notarization. Set **all** of
these together to ship a signed/notarized build. If they are absent (e.g. a
fork), the macOS jobs still produce **unsigned** DMGs instead of failing.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of your Developer ID Application `.p12`: `base64 -i cert.p12 \| pbcopy`. |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12`. |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)`. |
| `APPLE_ID` | Apple Developer account email (for notarization). |
| `APPLE_PASSWORD` | App-specific password for that Apple ID (notarization). |
| `APPLE_TEAM_ID` | Your 10-char Apple Team ID. |
| `KEYCHAIN_PASSWORD` | *(optional)* Password for the temp CI keychain. Defaults to `APPLE_CERTIFICATE_PASSWORD` if unset. |

> `GITHUB_TOKEN` is provided automatically by Actions — no secret needed. The
> workflow declares `permissions: contents: write` so it can create/upload to
> releases.

### A.2 Cut a release

```sh
# 1. Bump the version everywhere it must agree (see "Version consistency").
#    Edit apps/desktop/src-tauri/tauri.conf.json  -> "version"
#    Edit apps/desktop/src-tauri/Cargo.toml       -> [package] version
#    Update CHANGELOG.

# 2. Commit, then tag with a matching v-prefixed tag and push the tag.
git commit -am "release: desktop v0.1.0"
git tag v0.1.0
git push origin v0.1.0
```

The workflow then:

1. **Version-consistency guard** — fails immediately if the tag (minus the `v`)
   does not equal `apps/desktop/src-tauri/tauri.conf.json` → `version`.
2. Builds each native target and uploads its packages to the release for the tag.
3. Generates `latest.json`. All native jobs target the same `tagName`, and
   tauri-action appends supported platform entries to the shared manifest.

### A.3 Cross-platform outcome

All four native jobs publish into one tag and one GitHub Release: two macOS
DMGs, Linux DEB/AppImage packages, and a Windows NSIS installer. When updater
artifacts are enabled, tauri-action merges the supported platform entries into
the shared `latest.json`. If concurrent manifest updates ever conflict, rerun
the affected matrix job or add its entry manually as in path B.

### A.4 Coordination with the npm release workflow

The npm release workflow (`.github/workflows/release-npm.yml`) **also** creates
a GitHub Release for the **same `v*` tag**. This is intentional: both workflows
target **one shared release per tag**. tauri-action is idempotent against an
existing release — if the release already exists it reuses it and just appends
the desktop assets; if not, it creates it. Either ordering works.

---

## B. Manual local build (fallback)

Use this when you can't or don't want to use CI. You still need the keypair from
step 0 committed into `tauri.conf.json`.

### B.1 Build

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/seekforge.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # or the password you chose
pnpm install
pnpm --filter seekforge build:sidecar          # host-arch sidecar
pnpm tauri build
```

> **Build the sidecar for each `--target` first.** The bundled
> `seekforge-server` sidecar is a native binary and must match the arch you pass
> to `tauri build`. `build:sidecar` derives its triple from `SIDECAR_TARGET` (or
> the `rustc -vV` host when unset), so a **cross/manual** build must set
> `SIDECAR_TARGET` to the same triple **before** `tauri build` — otherwise the
> package launches but the embedded server can't exec on the target machine:
>
> ```sh
> # cross-building for Apple Silicon from an Intel host (and vice versa):
> SIDECAR_TARGET=aarch64-apple-darwin pnpm --filter seekforge build:sidecar
> pnpm tauri build --target aarch64-apple-darwin
> ```
>
> CI is already correct: the cross-platform Node builder names `.exe` sidecars
> on Windows and builds the sidecar per native matrix `--target`.

`tauri build` runs `pnpm --filter @seekforge/desktop build` first (Vite), then
the sidecar (via `beforeBuildCommand`), then compiles the Rust shell. The
updater artifacts (`.app.tar.gz` + `.sig`) are produced ONLY when
`bundle.createUpdaterArtifacts` is `true` — which it is NOT by default (step 0
turns it on). With the shipped default you get just the DMG (a non-updatable
build). Output (workspace root, since the crate is a member of the root Cargo
workspace):

```
target/release/bundle/dmg/SeekForge_<version>_<arch>.dmg      # what users download
target/release/bundle/macos/SeekForge.app.tar.gz              # updater payload (only if updater enabled)
target/release/bundle/macos/SeekForge.app.tar.gz.sig          # updater signature (only if updater enabled)
```

(`<arch>` is `x64` on Intel, `aarch64` on Apple Silicon; cross-build the other
with `pnpm tauri build --target aarch64-apple-darwin` /
`x86_64-apple-darwin` after `rustup target add <target>` — remembering to
rebuild the sidecar with a matching `SIDECAR_TARGET` first, per the note above.)

### B.2 macOS code signing & notarization (separate from updater signing)

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

### B.3 Write `latest.json`

```json
{
  "version": "0.1.0",
  "notes": "What changed.",
  "pub_date": "2026-06-12T00:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "<contents of SeekForge.app.tar.gz.sig>",
      "url": "https://github.com/eilyeee/seekforge/releases/download/v0.1.0/SeekForge.app.tar.gz"
    }
  }
}
```

Add a `darwin-aarch64` entry too when you build for Apple Silicon (give the two
tarballs distinct upload names, e.g. `SeekForge_x64.app.tar.gz`).

### B.4 Publish the GitHub release

```sh
gh release create v0.1.0 \
  target/release/bundle/dmg/SeekForge_0.1.0_x64.dmg \
  target/release/bundle/macos/SeekForge.app.tar.gz \
  latest.json \
  --title "SeekForge 0.1.0" --notes "..."
```

> If the npm workflow already created the release for this tag, use
> `gh release upload v0.1.0 <files>` instead of `gh release create`.

---

## Version consistency

The CI guard enforces: **tag (minus `v`) == `tauri.conf.json` version**. Keep
these three in sync before tagging:

- `apps/desktop/src-tauri/tauri.conf.json` → `version`
- `apps/desktop/src-tauri/Cargo.toml` → `[package] version`
- the git tag (`vX.Y.Z`)

## Checklist

1. (once) Generate keypair, commit pubkey, add `TAURI_SIGNING_*` (+ optional
   Apple) repo secrets.
2. Bump versions (`tauri.conf.json` + `Cargo.toml`), update CHANGELOG.
3. **CI:** `git tag vX.Y.Z && git push origin vX.Y.Z` → workflow does the rest.
   **Manual:** `pnpm tauri build`, write `latest.json`, `gh release create`.
4. Smoke-test the DMG: install, launch, check `⏺ chat` connects.
