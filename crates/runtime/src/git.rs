//! git_status / git_diff via direct git invocation (no shell).

use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::command::{
    drain_output, read_chunks, truncate_head_tail, BoundedOutput, MAX_OUTPUT_CHARS,
    OUTPUT_CHANNEL_DEPTH,
};
use crate::protocol::{codes, RtError, RtResult};
use crate::sandbox::canonical_workspace;

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
    let ws = canonical_workspace(workspace)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(RtError::new(codes::CANCELLED, "git request cancelled"));
    }

    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(&ws)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
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
    thread::spawn(move || {
        if let Some(pipe) = stdout_pipe {
            read_chunks(pipe, out_tx);
        }
    });
    thread::spawn(move || {
        if let Some(pipe) = stderr_pipe {
            read_chunks(pipe, err_tx);
        }
    });

    let mut stdout_capture = BoundedOutput::default();
    let mut stderr_capture = BoundedOutput::default();
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        drain_output(&out_rx, &mut stdout_capture);
        drain_output(&err_rx, &mut stderr_capture);

        if cancelled.load(Ordering::Acquire) {
            kill_and_reap(&mut child, pid);
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
                return Err(RtError::new(
                    codes::GIT_ERROR,
                    format!("git {} timed out", args.join(" ")),
                ));
            }
            Err(e) => {
                kill_and_reap(&mut child, pid);
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
            return Err(RtError::new(codes::CANCELLED, "git request cancelled"));
        }
        stdout_done |= drain_output(&out_rx, &mut stdout_capture);
        stderr_done |= drain_output(&err_rx, &mut stderr_capture);
        if stdout_done && stderr_done {
            break;
        }
        if Instant::now() >= deadline {
            return Err(RtError::new(
                codes::GIT_ERROR,
                format!("git {} output drain timed out", args.join(" ")),
            ));
        }
        thread::sleep(Duration::from_millis(2));
    }

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
