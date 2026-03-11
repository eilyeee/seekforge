// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod serve;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use serve::{ServeChild, URL_TIMEOUT};

/// Holds the running serve child so the exit handler can kill it.
struct ServerState(Mutex<Option<ServeChild>>);

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            let built = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(external))
                .title("SeekForge")
                .inner_size(1280.0, 800.0)
                .build();
            if let Err(e) = built {
                fail(&handle, &format!("failed to create window: {e}"));
            }
        }
        Err(msg) => fail(&handle, &msg),
    }
}

/// Resolves the serve command, spawns it, and waits for the workbench URL.
fn boot_server(handle: &tauri::AppHandle) -> Result<String, String> {
    let env_cmd = std::env::var("SEEKFORGE_SERVE_CMD").ok();
    let path_var = std::env::var("PATH").ok();
    let repo_root = discover_repo_root();

    let cmd = serve::resolve_serve_command(
        env_cmd.as_deref(),
        path_var.as_deref(),
        repo_root.as_deref(),
    )
    .ok_or_else(|| {
        "could not resolve the serve command.\n\
         Set SEEKFORGE_SERVE_CMD, put `seekforge` on PATH, or run from the \
         SeekForge repo (dev fallback needs node_modules/.bin/tsx)."
            .to_string()
    })?;

    let env_ws = std::env::var("SEEKFORGE_WORKSPACE").ok();
    let cwd = std::env::current_dir().ok();
    let home = std::env::home_dir();
    let workspace = serve::resolve_workspace(env_ws.as_deref(), cwd.as_deref(), home.as_deref())
        .ok_or_else(|| "could not resolve a workspace directory".to_string())?;

    let mut child = ServeChild::spawn(&cmd, &workspace).map_err(|e| {
        format!(
            "failed to start the server (`{} {}` in {}): {e}",
            cmd.program,
            cmd.args.join(" "),
            workspace.display()
        )
    })?;

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
            Err(format!(
                "the server did not print its URL within {}s.\n\nCaptured output:\n{}",
                URL_TIMEOUT.as_secs(),
                if captured.is_empty() {
                    "(none)"
                } else {
                    captured.as_str()
                }
            ))
        }
    }
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
