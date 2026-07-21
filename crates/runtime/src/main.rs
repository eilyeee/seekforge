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
const MAX_REQUEST_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIST_DEPTH: u64 = 100;

fn bounded_integer(value: Option<f64>, default: u64, max: u64, name: &str) -> RtResult<u64> {
    let Some(value) = value else {
        return Ok(default);
    };
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > max as f64 {
        return Err(RtError::new(
            codes::BAD_REQUEST,
            format!("{name} must be an integer between 0 and {max}"),
        ));
    }
    Ok(value as u64)
}

#[derive(Debug, Eq, PartialEq)]
enum BoundedLine {
    Eof,
    Line,
    TooLarge,
}

/// Read one newline-delimited request without ever buffering more than `max` bytes.
/// An oversized line is discarded through its newline so the next request remains usable.
fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
    max: usize,
) -> io::Result<BoundedLine> {
    output.clear();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if output.is_empty() && !too_large {
                BoundedLine::Eof
            } else if too_large {
                BoundedLine::TooLarge
            } else {
                BoundedLine::Line
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !too_large {
            if output.len().saturating_add(consumed) > max {
                too_large = true;
                output.clear();
            } else {
                output.extend_from_slice(&available[..consumed]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(if too_large {
                BoundedLine::TooLarge
            } else {
                BoundedLine::Line
            });
        }
    }
}

struct WorkItem {
    /// The request, parsed ONCE by the reader thread. The worker dispatches this
    /// directly rather than re-parsing the raw line (request lines can be up to
    /// 8 MiB, so re-parsing on the throughput-serializing reader/worker path is
    /// the runtime's dominant cost on edit-heavy runs).
    value: Value,
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
            let max_depth = bounded_integer(p.max_depth, 10, MAX_LIST_DEPTH, "maxDepth")? as u32;
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
            let timeout_ms = bounded_integer(
                p.timeout_ms,
                command::DEFAULT_TIMEOUT_MS,
                command::MAX_TIMEOUT_MS,
                "timeoutMs",
            )?;
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

fn handle_value(value: Value, cancelled: &AtomicBool) -> String {
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

fn request_id(value: &Value) -> Option<String> {
    value.get("id")?.as_str().map(str::to_owned)
}

fn cancellation_target(value: &Value) -> Option<String> {
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
            let response = handle_value(work.value, &work.cancelled);
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
        match read_bounded_line(&mut reader, &mut raw, MAX_REQUEST_LINE_BYTES) {
            Ok(BoundedLine::Eof) => break,
            Ok(BoundedLine::Line) => {}
            Ok(BoundedLine::TooLarge) => {
                let response = err_response(
                    &Value::Null,
                    &RtError::new(codes::TOO_LARGE, "request line exceeds 8 MiB"),
                );
                if immediate_response_tx.send(response).is_err() {
                    break;
                }
                continue;
            }
            Err(e) => {
                eprintln!("seekforge-runtime: stdin read error: {e}");
                break;
            }
        }
        while matches!(raw.last(), Some(b'\n' | b'\r')) {
            raw.pop();
        }
        let line = String::from_utf8_lossy(&raw);
        if line.trim().is_empty() {
            continue;
        }
        // Parse the request ONCE here on the reader thread; the worker dispatches
        // the parsed Value directly instead of re-parsing (the line can be 8 MiB).
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let response = err_response(
                    &Value::Null,
                    &RtError::new(codes::BAD_REQUEST, format!("unparseable request: {e}")),
                );
                if immediate_response_tx.send(response).is_err() {
                    break;
                }
                continue;
            }
        };
        if let Some(target) = cancellation_target(&value) {
            let active = active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(cancelled) = active.get(&target) {
                cancelled.store(true, Ordering::Release);
            }
            continue;
        }

        let id = request_id(&value);
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
            value,
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

#[cfg(test)]
mod tests {
    use super::{bounded_integer, read_bounded_line, BoundedLine};
    use std::io::Cursor;

    #[test]
    fn bounded_line_discards_an_oversized_request_and_recovers() {
        let mut input = Cursor::new(b"123456\nnext\n".to_vec());
        let mut output = Vec::new();
        assert_eq!(
            read_bounded_line(&mut input, &mut output, 5).unwrap(),
            BoundedLine::TooLarge
        );
        assert!(output.is_empty());
        assert_eq!(
            read_bounded_line(&mut input, &mut output, 5).unwrap(),
            BoundedLine::Line
        );
        assert_eq!(output, b"next\n");
        assert_eq!(
            read_bounded_line(&mut input, &mut output, 5).unwrap(),
            BoundedLine::Eof
        );
    }

    #[test]
    fn bounded_line_handles_an_unterminated_final_request() {
        let mut input = Cursor::new(b"final".to_vec());
        let mut output = Vec::new();
        assert_eq!(
            read_bounded_line(&mut input, &mut output, 5).unwrap(),
            BoundedLine::Line
        );
        assert_eq!(output, b"final");
    }

    #[test]
    fn bounded_integer_rejects_non_finite_fractional_and_oversized_values() {
        assert_eq!(bounded_integer(None, 10, 100, "value").unwrap(), 10);
        assert_eq!(bounded_integer(Some(0.0), 10, 100, "value").unwrap(), 0);
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 1.5, 101.0] {
            assert_eq!(
                bounded_integer(Some(invalid), 10, 100, "value")
                    .unwrap_err()
                    .code,
                super::codes::BAD_REQUEST
            );
        }
    }
}
