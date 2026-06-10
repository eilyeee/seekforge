//! Request/response types and error codes for the stdio JSONL protocol
//! (see PROTOCOL.md — the binding spec).

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

/// Error codes from PROTOCOL.md. The TypeScript layer matches on these strings.
pub mod codes {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNKNOWN_METHOD: &str = "unknown_method";
    pub const OUTSIDE_WORKSPACE: &str = "outside_workspace";
    pub const SENSITIVE_PATH: &str = "sensitive_path";
    pub const EXISTS: &str = "exists";
    pub const NO_MATCH: &str = "no_match";
    pub const AMBIGUOUS: &str = "ambiguous";
    pub const TOO_LARGE: &str = "too_large";
    pub const BINARY_FILE: &str = "binary_file";
    pub const DENIED_DANGEROUS: &str = "denied_dangerous";
    pub const IO_ERROR: &str = "io_error";
    pub const GIT_ERROR: &str = "git_error";
}

/// Runtime-level error carried back to the client as `{code, message}`.
#[derive(Debug)]
pub struct RtError {
    pub code: &'static str,
    pub message: String,
}

impl RtError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        RtError {
            code,
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        RtError::new(codes::IO_ERROR, message)
    }
}

pub type RtResult<T> = Result<T, RtError>;

/// Serialize a success response line.
pub fn ok_response(id: &Value, data: Value) -> String {
    json!({ "id": id, "ok": true, "data": data }).to_string()
}

/// Serialize an error response line.
pub fn err_response(id: &Value, err: &RtError) -> String {
    json!({ "id": id, "ok": false, "error": { "code": err.code, "message": err.message } })
        .to_string()
}

/// Deserialize method params; failures become `bad_request`.
pub fn parse_params<T: DeserializeOwned>(params: Value) -> RtResult<T> {
    serde_json::from_value(params)
        .map_err(|e| RtError::new(codes::BAD_REQUEST, format!("invalid params: {e}")))
}

// ---------------------------------------------------------------------------
// Per-method params (wire names are camelCase per PROTOCOL.md)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileParams {
    pub workspace: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesParams {
    pub workspace: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub max_depth: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileParams {
    pub workspace: String,
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
    pub old_string: String,
    pub new_string: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchParams {
    pub workspace: String,
    pub path: String,
    pub edits: Vec<EditSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandParams {
    pub workspace: String,
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusParams {
    pub workspace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffParams {
    pub workspace: String,
    #[serde(default)]
    pub staged: bool,
}
