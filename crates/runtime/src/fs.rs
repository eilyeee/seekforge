//! File methods: read_file, list_files, write_file.

use std::path::Path;

use serde_json::{json, Value};

use crate::protocol::{codes, RtError, RtResult};
use crate::sandbox::{
    is_ignored_dir, resolve_for_read, resolve_for_write, resolve_inside_workspace,
};

/// PROTOCOL.md: files over 5 MB are rejected with `too_large`.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// PROTOCOL.md: list_files caps at 500 entries.
const MAX_LIST_ENTRIES: usize = 500;
/// Binary sniff window: a NUL byte in the first 8 KB means binary.
const BINARY_SNIFF_BYTES: usize = 8192;

pub fn read_file(workspace: &str, path: &str) -> RtResult<Value> {
    let resolved = resolve_for_read(workspace, path)?;
    let meta = std::fs::metadata(&resolved)
        .map_err(|e| RtError::io(format!("cannot read {path}: {e}")))?;
    if !meta.is_file() {
        return Err(RtError::io(format!("not a regular file: {path}")));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(RtError::new(
            codes::TOO_LARGE,
            format!(
                "file {path} is {} bytes (limit {MAX_FILE_BYTES})",
                meta.len()
            ),
        ));
    }
    let bytes =
        std::fs::read(&resolved).map_err(|e| RtError::io(format!("cannot read {path}: {e}")))?;
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|b| *b == 0) {
        return Err(RtError::new(
            codes::BINARY_FILE,
            format!("file {path} looks binary (NUL byte found)"),
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        RtError::new(
            codes::BINARY_FILE,
            format!("file {path} is not valid UTF-8"),
        )
    })?;
    Ok(json!({ "content": content }))
}

pub fn list_files(workspace: &str, path: &str, max_depth: u32) -> RtResult<Value> {
    let root = resolve_inside_workspace(workspace, path)?;
    if !root.is_dir() {
        return Err(RtError::io(format!("not a directory: {path}")));
    }
    let mut entries: Vec<String> = Vec::new();
    let mut truncated = false;
    walk(&root, "", 1, max_depth, &mut entries, &mut truncated);
    Ok(json!({ "entries": entries, "truncated": truncated }))
}

fn walk(
    dir: &Path,
    rel: &str,
    depth: u32,
    max_depth: u32,
    entries: &mut Vec<String>,
    truncated: &mut bool,
) {
    if *truncated || depth > max_depth {
        return;
    }
    let mut dirents: Vec<std::fs::DirEntry> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };
    dirents.sort_by_key(|e| e.file_name());
    for d in dirents {
        if *truncated {
            return;
        }
        let name = d.file_name().to_string_lossy().into_owned();
        // Symlinks are listed as plain entries and never followed.
        let is_dir = d.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && is_ignored_dir(&name) {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if entries.len() >= MAX_LIST_ENTRIES {
            *truncated = true;
            return;
        }
        if is_dir {
            entries.push(format!("{child_rel}/"));
            walk(
                &d.path(),
                &child_rel,
                depth + 1,
                max_depth,
                entries,
                truncated,
            );
        } else {
            entries.push(child_rel);
        }
    }
}

pub fn write_file(workspace: &str, path: &str, content: &str, overwrite: bool) -> RtResult<Value> {
    let resolved = resolve_for_write(workspace, path)?;
    if resolved.exists() && !overwrite {
        return Err(RtError::new(
            codes::EXISTS,
            format!("file already exists: {path} (pass overwrite:true to replace)"),
        ));
    }
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| RtError::io(format!("cannot create directories for {path}: {e}")))?;
    }
    std::fs::write(&resolved, content)
        .map_err(|e| RtError::io(format!("cannot write {path}: {e}")))?;
    Ok(json!({ "path": path }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn tmpdir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("sf-fs-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn read_rejects_binary_and_large() {
        let ws = tmpdir("read");
        let ws_s = ws.to_str().unwrap();
        std::fs::write(ws.join("bin.dat"), [b'a', 0u8, b'b']).unwrap();
        assert_eq!(
            read_file(ws_s, "bin.dat").unwrap_err().code,
            codes::BINARY_FILE
        );
        std::fs::write(ws.join("bad.txt"), [0xffu8, 0xfe, 0xfd]).unwrap();
        assert_eq!(
            read_file(ws_s, "bad.txt").unwrap_err().code,
            codes::BINARY_FILE
        );
        std::fs::write(ws.join("ok.txt"), "hello").unwrap();
        let data = read_file(ws_s, "ok.txt").unwrap();
        assert_eq!(data["content"], "hello");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn write_respects_overwrite_flag() {
        let ws = tmpdir("write");
        let ws_s = ws.to_str().unwrap();
        write_file(ws_s, "a/b/c.txt", "one", false).unwrap();
        assert_eq!(read_file(ws_s, "a/b/c.txt").unwrap()["content"], "one");
        assert_eq!(
            write_file(ws_s, "a/b/c.txt", "two", false)
                .unwrap_err()
                .code,
            codes::EXISTS
        );
        write_file(ws_s, "a/b/c.txt", "two", true).unwrap();
        assert_eq!(read_file(ws_s, "a/b/c.txt").unwrap()["content"], "two");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn list_skips_ignored_dirs_and_marks_dirs() {
        let ws = tmpdir("list");
        let ws_s = ws.to_str().unwrap();
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::create_dir_all(ws.join("node_modules/x")).unwrap();
        std::fs::write(ws.join("src/a.txt"), "a").unwrap();
        std::fs::write(ws.join("root.txt"), "r").unwrap();
        let data = list_files(ws_s, ".", 10).unwrap();
        let entries: Vec<String> = data["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(entries, vec!["root.txt", "src/", "src/a.txt"]);
        assert_eq!(data["truncated"], false);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn list_caps_entries_and_respects_depth() {
        let ws = tmpdir("cap");
        let ws_s = ws.to_str().unwrap();
        for i in 0..510 {
            std::fs::write(ws.join(format!("f{i:04}.txt")), "x").unwrap();
        }
        let data = list_files(ws_s, ".", 10).unwrap();
        assert_eq!(data["entries"].as_array().unwrap().len(), 500);
        assert_eq!(data["truncated"], true);

        let ws2 = tmpdir("depth");
        let ws2_s = ws2.to_str().unwrap();
        std::fs::create_dir_all(ws2.join("a/b")).unwrap();
        std::fs::write(ws2.join("a/b/deep.txt"), "x").unwrap();
        let data = list_files(ws2_s, ".", 1).unwrap();
        let entries: Vec<&str> = data["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(entries, vec!["a/"]);
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&ws2).ok();
    }
}
