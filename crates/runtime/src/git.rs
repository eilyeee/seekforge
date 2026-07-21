//! git_status / git_diff via direct git invocation (no shell).

use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::command::{
    drain_output, spawn_output_reader, stop_output_readers, truncate_head_tail, BoundedOutput,
    MAX_OUTPUT_CHARS, OUTPUT_CHANNEL_DEPTH,
};
use crate::protocol::{codes, RtError, RtResult};
use crate::sandbox::SecureDirPath;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

pub fn git_status(workspace: &str, cancelled: &AtomicBool) -> RtResult<Value> {
    run_git(workspace, &["status", "--porcelain=v1", "-b"], cancelled)
}

pub fn git_diff(workspace: &str, staged: bool, cancelled: &AtomicBool) -> RtResult<Value> {
    if staged {
        run_git(workspace, &["diff", "--cached"], cancelled)
    } else {
        run_git(workspace, &["diff"], cancelled)
    }
}

fn kill_and_reap(child: &mut std::process::Child, pid: libc::pid_t) {
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

fn run_git(workspace: &str, args: &[&str], cancelled: &AtomicBool) -> RtResult<Value> {
    run_git_with_hook(workspace, args, cancelled, || {})
}

fn run_git_with_hook<F>(
    workspace: &str,
    args: &[&str],
    cancelled: &AtomicBool,
    after_cwd_open: F,
) -> RtResult<Value>
where
    F: FnOnce(),
{
    let ws = SecureDirPath::prepare(workspace, ".")?.open()?;
    after_cwd_open();
    if cancelled.load(Ordering::Acquire) {
        return Err(RtError::new(codes::CANCELLED, "git request cancelled"));
    }

    let mut command = Command::new("git");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let ws_fd = ws.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(ws_fd) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| RtError::new(codes::GIT_ERROR, format!("failed to run git: {e}")))?;
    let pid = child.id() as libc::pid_t;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let (out_tx, out_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_DEPTH);
    let (err_tx, err_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_DEPTH);
    let output_stop = Arc::new(AtomicBool::new(false));
    let mut output_readers = Vec::with_capacity(2);
    if let Some(pipe) = stdout_pipe {
        output_readers.push(spawn_output_reader(pipe, out_tx, Arc::clone(&output_stop)));
    }
    if let Some(pipe) = stderr_pipe {
        output_readers.push(spawn_output_reader(pipe, err_tx, Arc::clone(&output_stop)));
    }

    let mut stdout_capture = BoundedOutput::default();
    let mut stderr_capture = BoundedOutput::default();
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        drain_output(&out_rx, &mut stdout_capture);
        drain_output(&err_rx, &mut stderr_capture);

        if cancelled.load(Ordering::Acquire) {
            kill_and_reap(&mut child, pid);
            stop_output_readers(&output_stop, output_readers);
            return Err(RtError::new(codes::CANCELLED, "git request cancelled"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // Git may leave helpers or hooks behind. End its process group
                // before waiting for inherited output descriptors to close.
                unsafe {
                    libc::killpg(pid, libc::SIGKILL);
                }
                break status;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                kill_and_reap(&mut child, pid);
                stop_output_readers(&output_stop, output_readers);
                return Err(RtError::new(
                    codes::GIT_ERROR,
                    format!("git {} timed out", args.join(" ")),
                ));
            }
            Err(e) => {
                kill_and_reap(&mut child, pid);
                stop_output_readers(&output_stop, output_readers);
                return Err(RtError::new(
                    codes::GIT_ERROR,
                    format!("failed to wait for git: {e}"),
                ));
            }
        }
    };

    let mut stdout_done = false;
    let mut stderr_done = false;
    while !(stdout_done && stderr_done) {
        if cancelled.load(Ordering::Acquire) {
            stop_output_readers(&output_stop, output_readers);
            return Err(RtError::new(codes::CANCELLED, "git request cancelled"));
        }
        stdout_done |= drain_output(&out_rx, &mut stdout_capture);
        stderr_done |= drain_output(&err_rx, &mut stderr_capture);
        if stdout_done && stderr_done {
            break;
        }
        if Instant::now() >= deadline {
            stop_output_readers(&output_stop, output_readers);
            return Err(RtError::new(
                codes::GIT_ERROR,
                format!("git {} output drain timed out", args.join(" ")),
            ));
        }
        thread::sleep(Duration::from_millis(2));
    }

    stop_output_readers(&output_stop, output_readers);
    drain_output(&out_rx, &mut stdout_capture);
    drain_output(&err_rx, &mut stderr_capture);

    let stdout = stdout_capture.finish();
    let stderr = stderr_capture.finish();
    if !status.success() {
        let snippet: String = stderr.chars().take(2000).collect();
        return Err(RtError::new(
            codes::GIT_ERROR,
            format!("git {} failed: {}", args.join(" "), snippet.trim()),
        ));
    }
    Ok(json!({ "output": truncate_head_tail(&stdout, MAX_OUTPUT_CHARS) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn git(workspace: &PathBuf, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(workspace)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn git_cwd_stays_bound_to_open_workspace_after_swap() {
        let base =
            std::env::temp_dir().join(format!("seekforge-runtime-git-swap-{}", std::process::id()));
        let workspace = base.join("workspace");
        let moved = base.join("workspace-moved");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        git(&workspace, &["init", "-q"]);
        let cancelled = AtomicBool::new(false);

        let result = run_git_with_hook(
            &workspace.to_string_lossy(),
            &["status", "--porcelain=v1"],
            &cancelled,
            || {
                std::fs::rename(&workspace, &moved).unwrap();
                std::os::unix::fs::symlink(&outside, &workspace).unwrap();
            },
        )
        .unwrap();

        assert_eq!(result["output"], "");
        std::fs::remove_file(&workspace).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }
}
