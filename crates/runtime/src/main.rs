//! seekforge-runtime: line-delimited JSON over stdin/stdout.
//!
//! One request per line in, exactly one response line out, flushed after each.
//! stdout carries protocol JSON only; logs go to stderr. Requests are handled
//! sequentially (v1 needs no concurrency). See PROTOCOL.md for the spec.

mod command;
mod edit;
mod fs;
mod git;
mod protocol;
mod sandbox;

use std::io::{self, BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Value};

use protocol::{codes, err_response, ok_response, parse_params, RtError, RtResult};

fn dispatch(method: &str, params: Value) -> RtResult<Value> {
    match method {
        "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "read_file" => {
            let p: protocol::ReadFileParams = parse_params(params)?;
            fs::read_file(&p.workspace, &p.path)
        }
        "list_files" => {
            let p: protocol::ListFilesParams = parse_params(params)?;
            let max_depth = p
                .max_depth
                .map_or(10, |d| if d < 0.0 { 0 } else { d as u32 });
            fs::list_files(&p.workspace, p.path.as_deref().unwrap_or("."), max_depth)
        }
        "write_file" => {
            let p: protocol::WriteFileParams = parse_params(params)?;
            fs::write_file(&p.workspace, &p.path, &p.content, p.overwrite)
        }
        "apply_patch" => {
            let p: protocol::ApplyPatchParams = parse_params(params)?;
            edit::apply_patch(&p.workspace, &p.path, &p.edits)
        }
        "run_command" => {
            let p: protocol::RunCommandParams = parse_params(params)?;
            let timeout_ms = p
                .timeout_ms
                .map_or(command::DEFAULT_TIMEOUT_MS, |t| if t < 0.0 { 0 } else { t as u64 });
            command::run_command(
                &p.workspace,
                &p.command,
                p.cwd.as_deref().unwrap_or("."),
                timeout_ms,
            )
        }
        "git_status" => {
            let p: protocol::GitStatusParams = parse_params(params)?;
            git::git_status(&p.workspace)
        }
        "git_diff" => {
            let p: protocol::GitDiffParams = parse_params(params)?;
            git::git_diff(&p.workspace, p.staged)
        }
        _ => Err(RtError::new(
            codes::UNKNOWN_METHOD,
            format!("unknown method: {method}"),
        )),
    }
}

fn handle_line(line: &str) -> String {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return err_response(
                &Value::Null,
                &RtError::new(codes::BAD_REQUEST, format!("unparseable request: {e}")),
            );
        }
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    let method = match value.get("method").and_then(Value::as_str) {
        Some(m) => m.to_string(),
        None => {
            return err_response(
                &id,
                &RtError::new(codes::BAD_REQUEST, "request is missing a string \"method\""),
            );
        }
    };
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));

    // Belt and braces: a panic in a handler must not kill the process or
    // corrupt the protocol stream.
    match catch_unwind(AssertUnwindSafe(|| dispatch(&method, params))) {
        Ok(Ok(data)) => ok_response(&id, data),
        Ok(Err(err)) => err_response(&id, &err),
        Err(_) => err_response(
            &id,
            &RtError::io(format!("internal error: handler for {method} panicked")),
        ),
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("seekforge-runtime: stdin read error: {e}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_line(&line);
        if writeln!(out, "{response}").is_err() {
            break; // stdout closed: parent is gone
        }
        if out.flush().is_err() {
            break;
        }
    }
}
