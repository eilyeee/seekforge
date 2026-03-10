//! Spawning and supervising the `seekforge serve` child process.
//!
//! The pure parts (URL-line parsing, command resolution, repo-root discovery,
//! workspace resolution) are plain functions so they can be unit-tested
//! without spawning anything.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long we wait for the server to print its URL line.
pub const URL_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// URL-line parsing
// ---------------------------------------------------------------------------

/// Extracts the workbench URL from one line of server stdout.
///
/// `seekforge serve` prints exactly one line containing
/// `http://127.0.0.1:<port>/?token=<token>`. The line may carry a prefix
/// (e.g. "SeekForge server: ..."), so we scan for the URL anywhere in it.
pub fn parse_url_line(line: &str) -> Option<String> {
    const NEEDLE: &str = "http://127.0.0.1:";
    let start = line.find(NEEDLE)?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    let url = &rest[..end];

    // Validate shape: http://127.0.0.1:<port>/?token=<non-empty>
    let after_host = &url[NEEDLE.len()..];
    let slash = after_host.find('/')?;
    let port: &str = &after_host[..slash];
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let path = &after_host[slash..];
    let token = path.strip_prefix("/?token=")?;
    if token.is_empty() {
        return None;
    }
    Some(url.to_string())
}

// ---------------------------------------------------------------------------
// Serve-command resolution
// ---------------------------------------------------------------------------

/// A fully resolved command line for starting the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Resolves the serve command. Order:
/// 1. `SEEKFORGE_SERVE_CMD` env var (full command line, split on whitespace)
/// 2. `seekforge` found on PATH, with args `serve --port 0`
/// 3. dev fallback: `<repo-root>/node_modules/.bin/tsx <repo-root>/apps/cli/src/index.ts serve --port 0`
///
/// `env_cmd` / `path_var` / `repo_root` are injected so tests can control them.
pub fn resolve_serve_command(
    env_cmd: Option<&str>,
    path_var: Option<&str>,
    repo_root: Option<&Path>,
) -> Option<ServeCommand> {
    if let Some(cmd) = env_cmd {
        let mut parts = cmd.split_whitespace().map(str::to_string);
        let program = parts.next()?;
        return Some(ServeCommand {
            program,
            args: parts.collect(),
        });
    }

    if let Some(path) = find_on_path("seekforge", path_var) {
        return Some(ServeCommand {
            program: path.to_string_lossy().into_owned(),
            args: vec!["serve".into(), "--port".into(), "0".into()],
        });
    }

    let root = repo_root?;
    let tsx = root.join("node_modules/.bin/tsx");
    let entry = root.join("apps/cli/src/index.ts");
    if tsx.is_file() && entry.is_file() {
        return Some(ServeCommand {
            program: tsx.to_string_lossy().into_owned(),
            args: vec![
                entry.to_string_lossy().into_owned(),
                "serve".into(),
                "--port".into(),
                "0".into(),
            ],
        });
    }
    None
}

/// Looks for an executable file named `name` in the entries of `path_var`
/// (a PATH-style colon-separated string).
pub fn find_on_path(name: &str, path_var: Option<&str>) -> Option<PathBuf> {
    let path_var = path_var?;
    for dir in std::env::split_paths(path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

// ---------------------------------------------------------------------------
// Repo-root discovery
// ---------------------------------------------------------------------------

/// Walks up from `start` looking for a directory containing
/// `pnpm-workspace.yaml` (the monorepo root).
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join("pnpm-workspace.yaml").is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

// ---------------------------------------------------------------------------
// Workspace (cwd for the server) resolution
// ---------------------------------------------------------------------------

/// Picks the directory the agent server should operate on:
/// `SEEKFORGE_WORKSPACE` env > the Tauri process cwd (dev: launch the app
/// from your project dir) > the user's home dir (bundled app, whose cwd is
/// typically `/`).
pub fn resolve_workspace(
    env_workspace: Option<&str>,
    cwd: Option<&Path>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(ws) = env_workspace {
        if !ws.is_empty() {
            return Some(PathBuf::from(ws));
        }
    }
    if let Some(cwd) = cwd {
        // A bundled macOS app is launched with cwd "/" — not a useful workspace.
        if cwd != Path::new("/") {
            return Some(cwd.to_path_buf());
        }
    }
    home.map(Path::to_path_buf)
}

// ---------------------------------------------------------------------------
// Child process supervision
// ---------------------------------------------------------------------------

/// A spawned serve child. Killing it takes the whole process group down
/// (the child runs `setsid`, so its pid is the pgid).
pub struct ServeChild {
    child: Child,
}

impl ServeChild {
    /// Spawns the serve command with `workspace` as cwd, in its own process
    /// group, with stdout piped.
    pub fn spawn(cmd: &ServeCommand, workspace: &Path) -> std::io::Result<Self> {
        let mut command = Command::new(&cmd.program);
        command
            .args(&cmd.args)
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group so we can kill the whole tree on exit.
            unsafe {
                command.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        let child = command.spawn()?;
        Ok(Self { child })
    }

    /// Reads child stdout line-by-line until a URL line shows up or
    /// `timeout` elapses. On failure returns the output captured so far.
    pub fn wait_for_url(&mut self, timeout: Duration) -> Result<String, String> {
        let stdout = match self.child.stdout.take() {
            Some(s) => s,
            None => return Err("child stdout was not piped".into()),
        };
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        wait_for_url_from_lines(&rx, timeout)
    }

    /// Kills the child's whole process group (SIGKILL) and reaps it.
    pub fn kill(&mut self) {
        #[cfg(unix)]
        {
            let pid = self.child.id() as libc::pid_t;
            // setsid in pre_exec makes pid the process-group id.
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Pure-ish core of [`ServeChild::wait_for_url`]: drains `rx` until a line
/// parses as the workbench URL or the deadline passes.
pub fn wait_for_url_from_lines(
    rx: &mpsc::Receiver<String>,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut captured = String::new();
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(captured);
        }
        match rx.recv_timeout(deadline - now) {
            Ok(line) => {
                if let Some(url) = parse_url_line(&line) {
                    return Ok(url);
                }
                captured.push_str(&line);
                captured.push('\n');
            }
            Err(_) => return Err(captured),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // --- parse_url_line ---

    #[test]
    fn parses_url_with_prefix_text() {
        let line = "SeekForge server: http://127.0.0.1:52345/?token=abc123def";
        assert_eq!(
            parse_url_line(line).as_deref(),
            Some("http://127.0.0.1:52345/?token=abc123def")
        );
    }

    #[test]
    fn parses_bare_url_line() {
        let line = "http://127.0.0.1:8080/?token=t";
        assert_eq!(parse_url_line(line).as_deref(), Some(line));
    }

    #[test]
    fn url_stops_at_whitespace() {
        let line = "x http://127.0.0.1:9/?token=tok trailing words";
        assert_eq!(
            parse_url_line(line).as_deref(),
            Some("http://127.0.0.1:9/?token=tok")
        );
    }

    #[test]
    fn rejects_lines_without_url() {
        assert_eq!(parse_url_line("Serving this workspace on 127.0.0.1"), None);
        assert_eq!(parse_url_line(""), None);
        assert_eq!(parse_url_line("http://127.0.0.1:notaport/?token=t"), None);
        assert_eq!(parse_url_line("http://127.0.0.1:8080/?token="), None);
        assert_eq!(parse_url_line("http://127.0.0.1:8080/notoken"), None);
        assert_eq!(parse_url_line("http://localhost:8080/?token=t"), None);
    }

    // --- resolve_serve_command ---

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn env_cmd_wins_over_everything() {
        let cmd = resolve_serve_command(
            Some("node /tmp/server.js serve --port 0"),
            Some("/usr/bin"),
            Some(Path::new("/nonexistent")),
        )
        .unwrap();
        assert_eq!(cmd.program, "node");
        assert_eq!(cmd.args, vec!["/tmp/server.js", "serve", "--port", "0"]);
    }

    #[test]
    fn empty_env_cmd_yields_none_not_fallthrough_crash() {
        // Whitespace-only env value has no program token.
        assert_eq!(resolve_serve_command(Some("   "), None, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn path_seekforge_used_when_no_env() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(&dir.path().join("seekforge"));
        let path_var = dir.path().to_string_lossy().into_owned();
        let cmd = resolve_serve_command(None, Some(&path_var), None).unwrap();
        assert_eq!(cmd.program, dir.path().join("seekforge").to_string_lossy());
        assert_eq!(cmd.args, vec!["serve", "--port", "0"]);
    }

    #[cfg(unix)]
    #[test]
    fn dev_fallback_used_when_no_env_and_no_path_hit() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        fs::create_dir_all(root.path().join("node_modules/.bin")).unwrap();
        make_executable(&root.path().join("node_modules/.bin/tsx"));
        fs::create_dir_all(root.path().join("apps/cli/src")).unwrap();
        fs::write(root.path().join("apps/cli/src/index.ts"), "// cli\n").unwrap();

        let cmd = resolve_serve_command(None, Some("/definitely/not/a/dir"), Some(root.path()))
            .unwrap();
        assert_eq!(
            cmd.program,
            root.path()
                .join("node_modules/.bin/tsx")
                .to_string_lossy()
        );
        assert_eq!(
            cmd.args,
            vec![
                root.path()
                    .join("apps/cli/src/index.ts")
                    .to_string_lossy()
                    .into_owned(),
                "serve".into(),
                "--port".into(),
                "0".into(),
            ]
        );
    }

    #[test]
    fn no_resolution_yields_none() {
        assert_eq!(
            resolve_serve_command(None, Some("/definitely/not/a/dir"), None),
            None
        );
    }

    // --- find_repo_root ---

    #[test]
    fn finds_repo_root_walking_up() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        let nested = root.path().join("apps/desktop/src-tauri");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_repo_root(&nested).unwrap(), root.path());
        assert_eq!(find_repo_root(root.path()).unwrap(), root.path());
    }

    #[test]
    fn repo_root_none_when_marker_missing() {
        let dir = tempfile::tempdir().unwrap();
        // The tempdir's ancestors must not contain pnpm-workspace.yaml; that
        // holds for system temp locations.
        assert_eq!(find_repo_root(dir.path()), None);
    }

    // --- resolve_workspace ---

    #[test]
    fn workspace_env_wins() {
        let ws = resolve_workspace(
            Some("/projects/foo"),
            Some(Path::new("/somewhere")),
            Some(Path::new("/home/u")),
        );
        assert_eq!(ws, Some(PathBuf::from("/projects/foo")));
    }

    #[test]
    fn workspace_falls_back_to_cwd_then_home() {
        assert_eq!(
            resolve_workspace(None, Some(Path::new("/proj")), Some(Path::new("/home/u"))),
            Some(PathBuf::from("/proj"))
        );
        // cwd "/" (bundled app) is skipped in favor of home.
        assert_eq!(
            resolve_workspace(None, Some(Path::new("/")), Some(Path::new("/home/u"))),
            Some(PathBuf::from("/home/u"))
        );
        assert_eq!(
            resolve_workspace(Some(""), None, Some(Path::new("/home/u"))),
            Some(PathBuf::from("/home/u"))
        );
        assert_eq!(resolve_workspace(None, None, None), None);
    }

    // --- wait_for_url_from_lines ---

    #[test]
    fn wait_for_url_returns_first_match() {
        let (tx, rx) = mpsc::channel();
        tx.send("booting...".to_string()).unwrap();
        tx.send("SeekForge server: http://127.0.0.1:1234/?token=z".to_string())
            .unwrap();
        let url = wait_for_url_from_lines(&rx, Duration::from_secs(1)).unwrap();
        assert_eq!(url, "http://127.0.0.1:1234/?token=z");
    }

    #[test]
    fn wait_for_url_times_out_with_captured_output() {
        let (tx, rx) = mpsc::channel();
        tx.send("some noise".to_string()).unwrap();
        drop(tx); // channel closes -> error path with captured output
        let err = wait_for_url_from_lines(&rx, Duration::from_millis(50)).unwrap_err();
        assert!(err.contains("some noise"));
    }
}
