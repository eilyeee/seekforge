//! seekforge-runtime: line-delimited JSON over stdin/stdout.
//!
//! One request per line in, exactly one response line out, flushed after each.
//! stdout carries protocol JSON only; logs go to stderr. Requests are handled
//! by a bounded worker pool and responses may arrive out of order. See
//! PROTOCOL.md for the spec.

mod command;
mod edit;
mod fs;
mod git;
mod protocol;
mod sandbox;

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use protocol::{codes, err_response, ok_response, parse_params, RtError, RtResult};

const MIN_WORKERS: usize = 2;
const MAX_WORKERS: usize = 8;
const QUEUED_REQUESTS_PER_WORKER: usize = 2;

struct WorkItem {
    line: String,
    id: Option<String>,
    cancelled: Arc<AtomicBool>,
}

fn dispatch(method: &str, params: Value, cancelled: &AtomicBool) -> RtResult<Value> {
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
            let timeout_ms = p.timeout_ms.map_or(command::DEFAULT_TIMEOUT_MS, |t| {
                if t < 0.0 {
                    0
                } else {
                    t as u64
                }
            });
            command::run_command_cancellable(
                &p.workspace,
                &p.command,
                p.cwd.as_deref().unwrap_or("."),
                timeout_ms,
                cancelled,
            )
        }
        "git_status" => {
            let p: protocol::GitStatusParams = parse_params(params)?;
            git::git_status(&p.workspace, cancelled)
        }
        "git_diff" => {
            let p: protocol::GitDiffParams = parse_params(params)?;
            git::git_diff(&p.workspace, p.staged, cancelled)
        }
        _ => Err(RtError::new(
            codes::UNKNOWN_METHOD,
            format!("unknown method: {method}"),
        )),
    }
}

fn handle_line(line: &str, cancelled: &AtomicBool) -> String {
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
    if cancelled.load(Ordering::Acquire) {
        return err_response(&id, &RtError::new(codes::CANCELLED, "request cancelled"));
    }

    // Belt and braces: a panic in a handler must not kill the process or
    // corrupt the protocol stream.
    match catch_unwind(AssertUnwindSafe(|| dispatch(&method, params, cancelled))) {
        Ok(Ok(data)) => ok_response(&id, data),
        Ok(Err(err)) => err_response(&id, &err),
        Err(_) => err_response(
            &id,
            &RtError::io(format!("internal error: handler for {method} panicked")),
        ),
    }
}

fn request_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}

fn cancellation_target(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("id").is_some_and(|id| !id.is_null())
        || value.get("method").and_then(Value::as_str) != Some("cancel")
    {
        return None;
    }
    let params: protocol::CancelParams =
        serde_json::from_value(value.get("params")?.clone()).ok()?;
    Some(params.id)
}

fn worker_count() -> usize {
    thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(MIN_WORKERS)
        .clamp(MIN_WORKERS, MAX_WORKERS)
}

fn main() {
    let stdin = io::stdin();
    let workers = worker_count();
    let (request_tx, request_rx) =
        mpsc::sync_channel::<WorkItem>(workers * QUEUED_REQUESTS_PER_WORKER);
    let request_rx = Arc::new(Mutex::new(request_rx));
    let active = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
    let (response_tx, response_rx) =
        mpsc::sync_channel::<String>(workers * QUEUED_REQUESTS_PER_WORKER);

    let writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        for response in response_rx {
            if writeln!(out, "{response}").is_err() || out.flush().is_err() {
                break; // stdout closed: parent is gone
            }
        }
    });

    let mut worker_handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let request_rx = Arc::clone(&request_rx);
        let active = Arc::clone(&active);
        let response_tx = response_tx.clone();
        worker_handles.push(thread::spawn(move || loop {
            let line = {
                let receiver = match request_rx.lock() {
                    Ok(receiver) => receiver,
                    Err(poisoned) => poisoned.into_inner(),
                };
                receiver.recv()
            };
            let work = match line {
                Ok(work) => work,
                Err(_) => break,
            };
            let response = handle_line(&work.line, &work.cancelled);
            if let Some(id) = &work.id {
                let mut active = active
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if active
                    .get(id)
                    .is_some_and(|current| Arc::ptr_eq(current, &work.cancelled))
                {
                    active.remove(id);
                }
            }
            if response_tx.send(response).is_err() {
                break;
            }
        }));
    }
    let immediate_response_tx = response_tx.clone();
    drop(response_tx);

    // Read raw bytes and lossy-decode per line rather than `.lines()`: a line
    // with invalid UTF-8 makes `.lines()` yield an Err, and the old code treated
    // ANY line error as fatal and shut the runtime down — losing every
    // subsequent request. With lossy decode a bad line simply fails to parse and
    // is answered with `bad_request` (id null), per the protocol; only a genuine
    // IO error stops the loop.
    let mut reader = stdin.lock();
    let mut raw: Vec<u8> = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => {
                eprintln!("seekforge-runtime: stdin read error: {e}");
                break;
            }
        }
        while matches!(raw.last(), Some(b'\n' | b'\r')) {
            raw.pop();
        }
        let line = String::from_utf8_lossy(&raw).into_owned();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(target) = cancellation_target(&line) {
            let active = active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(cancelled) = active.get(&target) {
                cancelled.store(true, Ordering::Release);
            }
            continue;
        }

        let id = request_id(&line);
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(id) = &id {
            let mut active = active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if active.contains_key(id) {
                let response = err_response(
                    &Value::String(id.clone()),
                    &RtError::new(codes::BAD_REQUEST, "duplicate in-flight request id"),
                );
                if immediate_response_tx.send(response).is_err() {
                    break;
                }
                continue;
            }
            active.insert(id.clone(), Arc::clone(&cancelled));
        }

        let work = WorkItem {
            line,
            id: id.clone(),
            cancelled,
        };
        match request_tx.try_send(work) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(work)) => {
                if let Some(id) = &work.id {
                    active
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(id);
                }
                let response = err_response(
                    &work.id.map(Value::String).unwrap_or(Value::Null),
                    &RtError::new(codes::RUNTIME_BUSY, "runtime request queue is full"),
                );
                if immediate_response_tx.send(response).is_err() {
                    break;
                }
            }
            Err(mpsc::TrySendError::Disconnected(_)) => break,
        }
    }
    for cancelled in active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
    {
        cancelled.store(true, Ordering::Release);
    }
    drop(request_tx);
    drop(immediate_response_tx);

    for worker in worker_handles {
        let _ = worker.join();
    }
    let _ = writer.join();
}
