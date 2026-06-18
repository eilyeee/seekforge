// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod serve;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use serve::{Diagnostics, Resolution, ServeChild, ServeCommand, URL_TIMEOUT};

/// Holds the running serve child so the exit handler can kill it.
struct ServerState(Mutex<Option<ServeChild>>);

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            // Boot the server off the main thread; window creation below is
            // dispatched back to the main loop by Tauri.
            std::thread::spawn(move || start_server_and_open_window(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SeekForge");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<ServerState>();
            let child = state.0.lock().unwrap().take();
            if let Some(mut child) = child {
                child.kill();
            }
        }
    });
}

fn start_server_and_open_window(handle: tauri::AppHandle) {
    match boot_server(&handle) {
        Ok(url) => {
            let external = match url.parse() {
                Ok(u) => u,
                Err(e) => {
                    fail(&handle, &format!("invalid server URL `{url}`: {e}"));
                    return;
                }
            };
            let builder = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(external))
                .title("SeekForge")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 560.0)
                // Matches the default (light) --sf-surface (#f8fafc) to avoid a
                // flash before the web UI loads.
                .background_color(tauri::webview::Color(248, 250, 252, 255));
            // macOS: transparent overlay title bar — traffic lights float over
            // the sidebar (which pads for them); content runs edge-to-edge.
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            match builder.build() {
                Ok(_) => spawn_update_check(handle),
                Err(e) => fail(&handle, &format!("failed to create window: {e}")),
            }
        }
        Err(msg) => fail(&handle, &msg),
    }
}

/// Resolves the serve command, spawns it, and waits for the workbench URL.
fn boot_server(handle: &tauri::AppHandle) -> Result<String, String> {
    let env_cmd = std::env::var("SEEKFORGE_SERVE_CMD").ok();
    let home = std::env::home_dir();
    // macOS GUI apps inherit a minimal launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin)
    // that omits the dirs where `npm i -g seekforge` actually installs, so a
    // DMG-only user would otherwise never find the CLI. Append the common
    // global-bin locations before resolving.
    let path_var = augmented_path(std::env::var("PATH").ok().as_deref(), home.as_deref());
    let repo_root = discover_repo_root();

    // The bundled sidecar (a self-contained `seekforge-server` compiled with
    // bun, shipped via `externalBin`) is the first choice: a DMG-only user has
    // no system `seekforge`. It sits next to the app binary. When absent
    // (`tauri dev`), `sidecar_command` returns None and we fall through to the
    // existing env/repo/PATH resolution, so dev is unaffected. An explicit
    // SEEKFORGE_SERVE_CMD still wins (debugging override), so we honor it first.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(std::path::Path::to_path_buf));
    let (cmd, from_sidecar) = if env_cmd.is_none() {
        match serve::sidecar_command(exe_dir.as_deref()) {
            Some(c) => (Some(c), true),
            None => (None, false),
        }
    } else {
        (None, false)
    };

    let cmd = match cmd {
        Some(c) => c,
        None => serve::resolve_serve_command(
            env_cmd.as_deref(),
            Some(&path_var),
            repo_root.as_deref(),
            // Dev builds (run from a source checkout via `tauri dev`) prefer the
            // repo's own server over an older `seekforge` on PATH.
            cfg!(debug_assertions),
        )
        .ok_or_else(|| {
            "could not resolve the `seekforge serve` command.\n\n\
             Install the CLI with `npm install -g seekforge`, set SEEKFORGE_SERVE_CMD \
             to its full command line, or run from a SeekForge source checkout."
                .to_string()
        })?,
    };

    // When running the bundled sidecar, point it at the web UI shipped as an app
    // resource (Contents/Resources/web). A bun --compile binary cannot find the
    // dist via import.meta.url, so this env var is how it locates the UI.
    //
    // The sidecar can ONLY find the UI through this env var, so if the bundled
    // run can't locate the `web` resource we must fail loudly: booting anyway
    // would serve a UI-less API info page that looks like a broken/blank app.
    let static_dir: Option<PathBuf> = if from_sidecar {
        let web = handle
            .path()
            .resource_dir()
            .ok()
            .map(|r| r.join("web"))
            .filter(|p| p.join("index.html").is_file());
        match web {
            Some(p) => Some(p),
            None => {
                return Err(
                    "this SeekForge bundle is missing its web UI resource \
                     (expected `Contents/Resources/web/index.html`).\n\n\
                     The bundled server cannot locate the workbench, so it would \
                     only serve a UI-less API page. Reinstall from a complete \
                     release, or rebuild the bundle (the `web` resource is laid \
                     out by `tauri build`)."
                        .to_string(),
                );
            }
        }
    } else {
        None
    };
    let extra_env: Vec<(&str, &std::path::Path)> = match static_dir.as_deref() {
        Some(p) => vec![("SEEKFORGE_STATIC_DIR", p)],
        None => Vec::new(),
    };

    let env_ws = std::env::var("SEEKFORGE_WORKSPACE").ok();
    let cwd = std::env::current_dir().ok();
    let workspace = serve::resolve_workspace(env_ws.as_deref(), cwd.as_deref(), home.as_deref())
        .ok_or_else(|| "could not resolve a workspace directory".to_string())?;

    let resolution = if from_sidecar {
        Resolution::Sidecar
    } else {
        Resolution::EnvPathOrDev
    };

    let mut child = match ServeChild::spawn(&cmd, &workspace, &extra_env) {
        Ok(child) => child,
        Err(e) => {
            let msg = format!(
                "failed to start the server (`{} {}` in {}): {e}",
                cmd.program,
                cmd.args.join(" "),
                workspace.display()
            );
            return Err(with_diagnostics(
                msg,
                "spawn error",
                resolution,
                &cmd,
                &workspace,
                false,
                "",
            ));
        }
    };

    match child.wait_for_url(URL_TIMEOUT) {
        Ok(url) => {
            handle
                .state::<ServerState>()
                .0
                .lock()
                .unwrap()
                .replace(child);
            Ok(url)
        }
        Err(captured) => {
            child.kill();
            let msg = format!(
                "the server did not print its URL within {}s.\n\nCaptured output:\n{}",
                URL_TIMEOUT.as_secs(),
                if captured.is_empty() {
                    "(none)"
                } else {
                    captured.as_str()
                }
            );
            Err(with_diagnostics(
                msg,
                "URL-wait timeout",
                resolution,
                &cmd,
                &workspace,
                false,
                &captured,
            ))
        }
    }
}

/// Builds the diagnostics report for a startup failure, writes it best-effort to
/// the OS temp dir, and appends the file path to the user-facing `message` so
/// the dialog tells them where to look. If writing the file fails, the original
/// message is returned unchanged (best-effort — never panics).
#[allow(clippy::too_many_arguments)]
fn with_diagnostics(
    message: String,
    failure: &str,
    resolution: Resolution,
    cmd: &ServeCommand,
    workspace: &std::path::Path,
    url_seen: bool,
    captured: &str,
) -> String {
    // A second-resolution timestamp: ISO-8601 for the body, digits-only for the
    // filename. Computed from UNIX_EPOCH so we need no chrono dependency.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let timestamp = format!("{now} (unix seconds)");

    let diag = Diagnostics {
        failure,
        resolution: Some(resolution),
        program: Some(&cmd.program),
        args: &cmd.args,
        workspace: Some(workspace),
        port: None,
        url_seen,
        captured,
    };
    let body = serve::diagnostics_text(
        &timestamp,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        &diag,
    );

    match serve::write_diagnostics_file(&body, &now.to_string()) {
        Some(path) => format!("{message}\n\nDiagnostics written to:\n{}", path.display()),
        None => message,
    }
}

/// Whether auto-update is configured. Ships `false` because tauri.conf.json
/// carries a disabled placeholder pubkey + `createUpdaterArtifacts: false`;
/// flip to `true` once a real updater keypair is wired (see docs/RELEASING.md).
/// While false we skip the check entirely so we don't emit misleading
/// "checking/failed" update logs for a release that can't actually update.
const UPDATER_ENABLED: bool = false;

/// Background update check against GitHub releases (see docs/RELEASING.md).
/// No-op while [`UPDATER_ENABLED`] is false. Failures are logged, never block.
fn spawn_update_check(handle: tauri::AppHandle) {
    if !UPDATER_ENABLED {
        return;
    }
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("SeekForge: updater unavailable: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                eprintln!(
                    "SeekForge: update {} available, downloading in background…",
                    update.version
                );
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => eprintln!("SeekForge: update installed; restart to apply"),
                    Err(e) => eprintln!("SeekForge: update install failed: {e}"),
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("SeekForge: update check failed: {e}"),
        }
    });
}

/// Global-bin locations to search in addition to the inherited PATH. macOS GUI
/// apps get a minimal launchd PATH, so `npm i -g` / homebrew / volta / nvm bin
/// dirs are appended here as best-effort fallbacks.
fn extra_bin_dirs(home: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    if let Some(home) = home {
        for rel in [".npm-global/bin", ".local/bin", ".volta/bin", ".yarn/bin", ".bun/bin"] {
            dirs.push(home.join(rel));
        }
        // nvm installs each node version under ~/.nvm/versions/node/<v>/bin.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
    }
    dirs
}

/// Returns the inherited PATH with [`extra_bin_dirs`] appended (PATH entries
/// keep priority; the extras are only consulted when PATH misses).
fn augmented_path(path_var: Option<&str>, home: Option<&std::path::Path>) -> String {
    let mut parts: Vec<PathBuf> = path_var
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    parts.extend(extra_bin_dirs(home));
    std::env::join_paths(parts)
        .map(|os| os.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path_var.unwrap_or_default().to_string())
}

/// Locates the monorepo root by walking up from the executable dir and then
/// from the cwd (dev runs sit inside the repo; bundled apps simply find none).
fn discover_repo_root() -> Option<PathBuf> {
    let from_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().and_then(|d| serve::find_repo_root(d)));
    from_exe.or_else(|| {
        std::env::current_dir()
            .ok()
            .and_then(|cwd| serve::find_repo_root(&cwd))
    })
}

/// Shows a blocking error dialog and quits.
fn fail(handle: &tauri::AppHandle, message: &str) {
    eprintln!("SeekForge: {message}");
    handle
        .dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title("SeekForge failed to start")
        .blocking_show();
    handle.exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn augmented_path_appends_global_bin_dirs_after_inherited_path() {
        let home = Path::new("/home/dev");
        let out = augmented_path(Some("/usr/bin:/bin"), Some(home));
        let dirs: Vec<PathBuf> = std::env::split_paths(&out).collect();
        // Inherited entries keep priority (come first).
        assert_eq!(dirs[0], PathBuf::from("/usr/bin"));
        assert_eq!(dirs[1], PathBuf::from("/bin"));
        // The common global-bin locations are appended.
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&home.join(".npm-global/bin")));
    }

    #[test]
    fn augmented_path_handles_missing_path_and_home() {
        let out = augmented_path(None, None);
        let dirs: Vec<PathBuf> = std::env::split_paths(&out).collect();
        // Still yields the absolute fallbacks even with nothing inherited.
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }
}
