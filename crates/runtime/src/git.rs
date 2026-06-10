//! git_status / git_diff via direct git invocation (no shell).

use std::process::{Command, Stdio};

use serde_json::{json, Value};

use crate::command::{truncate_head_tail, MAX_OUTPUT_CHARS};
use crate::protocol::{codes, RtError, RtResult};
use crate::sandbox::canonical_workspace;

pub fn git_status(workspace: &str) -> RtResult<Value> {
    run_git(workspace, &["status", "--porcelain=v1", "-b"])
}

pub fn git_diff(workspace: &str, staged: bool) -> RtResult<Value> {
    if staged {
        run_git(workspace, &["diff", "--cached"])
    } else {
        run_git(workspace, &["diff"])
    }
}

fn run_git(workspace: &str, args: &[&str]) -> RtResult<Value> {
    let ws = canonical_workspace(workspace)?;
    let output = Command::new("git")
        .args(args)
        .current_dir(&ws)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| RtError::new(codes::GIT_ERROR, format!("failed to run git: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let snippet: String = stderr.chars().take(2000).collect();
        return Err(RtError::new(
            codes::GIT_ERROR,
            format!("git {} failed: {}", args.join(" "), snippet.trim()),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(json!({ "output": truncate_head_tail(&stdout, MAX_OUTPUT_CHARS) }))
}
