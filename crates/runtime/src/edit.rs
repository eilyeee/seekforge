//! apply_patch: search/replace edits, all-or-nothing.

use std::io::{Read, Seek, SeekFrom, Write};

use serde_json::{json, Value};

use crate::fs::MAX_FILE_BYTES;
use crate::protocol::{codes, EditSpec, RtError, RtResult};
use crate::sandbox::SecureWritePath;

pub fn apply_patch(workspace: &str, path: &str, edits: &[EditSpec]) -> RtResult<Value> {
    apply_patch_with_hook(workspace, path, edits, || {})
}

fn apply_patch_with_hook<F>(
    workspace: &str,
    path: &str,
    edits: &[EditSpec],
    after_validation: F,
) -> RtResult<Value>
where
    F: FnOnce(),
{
    // Editing reads current content back into error hints, so read rules apply too.
    let target = SecureWritePath::prepare(workspace, path, true)?;
    after_validation();
    let mut file = target.open_for_update()?;
    let meta = file
        .metadata()
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
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| RtError::io(format!("cannot read {path}: {e}")))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(RtError::new(
            codes::TOO_LARGE,
            format!("file {path} grew beyond the {MAX_FILE_BYTES} byte limit while being read"),
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        RtError::new(
            codes::BINARY_FILE,
            format!("file {path} is not valid UTF-8"),
        )
    })?;

    // All edits are applied in memory; any failure means nothing is written.
    let next = apply_edits(&content, edits)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| RtError::io(format!("cannot write {path}: {e}")))?;
    file.write_all(next.as_bytes())
        .map_err(|e| RtError::io(format!("cannot write {path}: {e}")))?;
    file.set_len(next.len() as u64)
        .map_err(|e| RtError::io(format!("cannot truncate {path}: {e}")))?;
    Ok(json!({ "path": path, "editsApplied": edits.len() }))
}

/// Apply search/replace edits sequentially. Each oldString must occur exactly
/// once in the content at the time it is applied.
pub fn apply_edits(content: &str, edits: &[EditSpec]) -> RtResult<String> {
    let mut next = content.to_string();
    for (i, edit) in edits.iter().enumerate() {
        let count = count_occurrences(&next, &edit.old_string);
        if count == 0 {
            return Err(RtError::new(
                codes::NO_MATCH,
                format!(
                    "edit {}/{}: oldString not found in file{}",
                    i + 1,
                    edits.len(),
                    nearest_line_hint(&next, &edit.old_string)
                ),
            ));
        }
        if count > 1 {
            return Err(RtError::new(
                codes::AMBIGUOUS,
                format!(
                    "edit {}/{}: oldString matches {count} times; add surrounding context to make it unique",
                    i + 1,
                    edits.len()
                ),
            ));
        }
        next = next.replacen(&edit.old_string, &edit.new_string, 1);
    }
    Ok(next)
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(needle) {
        count += 1;
        from += pos + needle.len();
    }
    count
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// Hint for no_match: the nearest line, i.e. the line whose trimmed text
/// shares the longest common prefix with the first non-empty line of oldString.
fn nearest_line_hint(content: &str, old_string: &str) -> String {
    let target = match old_string.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(t) => t,
        None => return String::new(),
    };
    let mut best: Option<(usize, usize, &str)> = None; // (prefix_len, line_no, text)
    for (idx, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let score = common_prefix_len(target, trimmed);
        if best.is_none_or(|(s, _, _)| score > s) {
            best = Some((score, idx + 1, trimmed));
        }
    }
    match best {
        Some((_, line_no, text)) => {
            let snippet: String = text.chars().take(200).collect();
            format!("; nearest line {line_no}: {snippet}")
        }
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn tmpdir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("sf-edit-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn edit(old: &str, new: &str) -> EditSpec {
        EditSpec {
            old_string: old.to_string(),
            new_string: new.to_string(),
        }
    }

    #[test]
    fn single_edit() {
        let out = apply_edits(
            "let a = 1;\nlet b = 2;\n",
            &[edit("let a = 1;", "let a = 10;")],
        )
        .unwrap();
        assert_eq!(out, "let a = 10;\nlet b = 2;\n");
    }

    #[test]
    fn multiple_edits_apply_sequentially() {
        let out = apply_edits(
            "one two three",
            &[edit("one", "1"), edit("two", "2"), edit("three", "3")],
        )
        .unwrap();
        assert_eq!(out, "1 2 3");
    }

    #[test]
    fn no_match_hint_names_nearest_line() {
        let content = "fn alpha() {\n}\n\nfn foobar() {\n}\n";
        let err = apply_edits(content, &[edit("fn foobaz() {", "fn x() {")]).unwrap_err();
        assert_eq!(err.code, codes::NO_MATCH);
        assert!(
            err.message.contains("nearest line 4: fn foobar() {"),
            "{}",
            err.message
        );
    }

    #[test]
    fn ambiguous_reports_count() {
        let err = apply_edits("x = 1;\nx = 1;\n", &[edit("x = 1;", "x = 2;")]).unwrap_err();
        assert_eq!(err.code, codes::AMBIGUOUS);
        assert!(err.message.contains("matches 2 times"), "{}", err.message);
    }

    #[test]
    fn failed_patch_writes_nothing() {
        let ws = tmpdir("atomic");
        let ws_s = ws.to_str().unwrap();
        let original = "alpha\nbeta\n";
        std::fs::write(ws.join("f.txt"), original).unwrap();
        // First edit would succeed, second fails -> file must be unchanged.
        let err = apply_patch(
            ws_s,
            "f.txt",
            &[edit("alpha", "ALPHA"), edit("missing", "x")],
        )
        .unwrap_err();
        assert_eq!(err.code, codes::NO_MATCH);
        assert_eq!(std::fs::read_to_string(ws.join("f.txt")).unwrap(), original);
        // Happy path applies all edits in one write.
        let data = apply_patch(ws_s, "f.txt", &[edit("alpha", "A"), edit("beta", "B")]).unwrap();
        assert_eq!(data["editsApplied"], 2);
        assert_eq!(std::fs::read_to_string(ws.join("f.txt")).unwrap(), "A\nB\n");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn patch_rejects_files_over_the_read_limit() {
        let ws = tmpdir("large");
        let file = ws.join("large.txt");
        std::fs::write(&file, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let err = apply_patch(ws.to_str().unwrap(), "large.txt", &[edit("x", "y")]).unwrap_err();
        assert_eq!(err.code, codes::TOO_LARGE);
        assert_eq!(std::fs::metadata(file).unwrap().len(), MAX_FILE_BYTES + 1);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn patch_rejects_parent_symlink_swap_after_validation() {
        let ws = tmpdir("patch-parent-swap");
        let outside = tmpdir("patch-parent-outside");
        std::fs::create_dir_all(ws.join("dir")).unwrap();
        std::fs::write(ws.join("dir/file.txt"), "inside").unwrap();
        std::fs::write(outside.join("file.txt"), "outside").unwrap();
        let err = apply_patch_with_hook(
            ws.to_str().unwrap(),
            "dir/file.txt",
            &[edit("inside", "changed")],
            || {
                std::fs::rename(ws.join("dir"), ws.join("dir-old")).unwrap();
                std::os::unix::fs::symlink(&outside, ws.join("dir")).unwrap();
            },
        )
        .unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        assert_eq!(
            std::fs::read_to_string(outside.join("file.txt")).unwrap(),
            "outside"
        );
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn patch_rejects_leaf_symlink_swap_after_validation() {
        let ws = tmpdir("patch-leaf-swap");
        let outside = tmpdir("patch-leaf-outside");
        let outside_file = outside.join("outside.txt");
        std::fs::write(ws.join("target.txt"), "inside").unwrap();
        std::fs::write(&outside_file, "outside").unwrap();
        let err = apply_patch_with_hook(
            ws.to_str().unwrap(),
            "target.txt",
            &[edit("inside", "changed")],
            || {
                std::fs::remove_file(ws.join("target.txt")).unwrap();
                std::os::unix::fs::symlink(&outside_file, ws.join("target.txt")).unwrap();
            },
        )
        .unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
