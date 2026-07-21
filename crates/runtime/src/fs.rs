//! File methods: read_file, list_files, write_file.

use std::ffi::{CStr, OsString};
use std::io::{Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, IntoRawFd};
use std::os::unix::ffi::OsStringExt;

use serde_json::{json, Value};

use crate::protocol::{codes, RtError, RtResult};
use crate::sandbox::{is_ignored_dir, openat_file, SecureDirPath, SecureReadPath, SecureWritePath};

/// PROTOCOL.md: files over 5 MB are rejected with `too_large`.
pub(crate) const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// PROTOCOL.md: list_files caps at 500 entries.
const MAX_LIST_ENTRIES: usize = 500;
/// Binary sniff window: a NUL byte in the first 8 KB means binary.
const BINARY_SNIFF_BYTES: usize = 8192;

pub fn read_file(workspace: &str, path: &str) -> RtResult<Value> {
    read_file_with_hook(workspace, path, || {})
}

fn read_file_with_hook<F>(workspace: &str, path: &str, after_validation: F) -> RtResult<Value>
where
    F: FnOnce(),
{
    let target = SecureReadPath::prepare(workspace, path)?;
    after_validation();
    let mut file = target.open()?;
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
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_FILE_BYTES) as usize);
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
    list_files_with_hook(workspace, path, max_depth, || {})
}

fn list_files_with_hook<F>(
    workspace: &str,
    path: &str,
    max_depth: u32,
    after_validation: F,
) -> RtResult<Value>
where
    F: FnOnce(),
{
    let target = SecureDirPath::prepare(workspace, path)?;
    after_validation();
    let root = target.open()?;
    let mut entries: Vec<String> = Vec::new();
    let mut truncated = false;
    walk(root, "", 1, max_depth, &mut entries, &mut truncated);
    Ok(json!({ "entries": entries, "truncated": truncated }))
}

struct DirStream(*mut libc::DIR);

impl Drop for DirStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn open_dir_stream(dir: std::fs::File) -> std::io::Result<DirStream> {
    let fd = dir.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        Err(error)
    } else {
        Ok(DirStream(stream))
    }
}

fn is_directory(parent: &std::fs::File, name: &CStr) -> bool {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    result == 0 && (unsafe { stat.assume_init() }.st_mode & libc::S_IFMT) == libc::S_IFDIR
}

fn directory_entries(dir: &std::fs::File) -> std::io::Result<(DirStream, Vec<(OsString, bool)>)> {
    let stream = open_dir_stream(dir.try_clone()?)?;
    let mut entries = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let bytes = name.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        entries.push((OsString::from_vec(bytes.to_vec()), is_directory(dir, name)));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((stream, entries))
}

fn walk(
    dir: std::fs::File,
    rel: &str,
    depth: u32,
    max_depth: u32,
    entries: &mut Vec<String>,
    truncated: &mut bool,
) {
    if *truncated || depth > max_depth {
        return;
    }
    let (_stream, dirents) = match directory_entries(&dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for (raw_name, is_dir) in dirents {
        if *truncated {
            return;
        }
        let name = raw_name.to_string_lossy().into_owned();
        // Symlinks are listed as plain entries and never followed.
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
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            if let Ok(child) = openat_file(&dir, &raw_name, flags, 0) {
                walk(child, &child_rel, depth + 1, max_depth, entries, truncated);
            }
        } else {
            entries.push(child_rel);
        }
    }
}

pub fn write_file(workspace: &str, path: &str, content: &str, overwrite: bool) -> RtResult<Value> {
    write_file_with_hook(workspace, path, content, overwrite, || {})
}

fn write_file_with_hook<F>(
    workspace: &str,
    path: &str,
    content: &str,
    overwrite: bool,
    after_validation: F,
) -> RtResult<Value>
where
    F: FnOnce(),
{
    let target = SecureWritePath::prepare(workspace, path, false)?;
    after_validation();
    let mut file = target.open_for_write(overwrite)?;
    file.write_all(content.as_bytes())
        .map_err(|e| RtError::io(format!("cannot write {path}: {e}")))?;
    Ok(json!({ "path": path }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
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
        std::fs::write(
            ws.join("large.txt"),
            vec![b'x'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(
            read_file(ws_s, "large.txt").unwrap_err().code,
            codes::TOO_LARGE
        );
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn file_methods_reject_fifo_without_blocking() {
        let ws = tmpdir("fifo");
        let fifo = ws.join("pipe");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();

        assert_eq!(
            read_file(ws.to_str().unwrap(), "pipe").unwrap_err().code,
            codes::IO_ERROR
        );
        assert_eq!(
            write_file(ws.to_str().unwrap(), "pipe", "x", true)
                .unwrap_err()
                .code,
            codes::IO_ERROR
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn read_rejects_parent_symlink_swap_after_validation() {
        let ws = tmpdir("read-parent-swap");
        let outside = tmpdir("read-parent-outside");
        std::fs::create_dir_all(ws.join("dir")).unwrap();
        std::fs::write(ws.join("dir/file.txt"), "inside").unwrap();
        std::fs::write(outside.join("file.txt"), "outside").unwrap();
        let err = read_file_with_hook(ws.to_str().unwrap(), "dir/file.txt", || {
            std::fs::rename(ws.join("dir"), ws.join("dir-old")).unwrap();
            std::os::unix::fs::symlink(&outside, ws.join("dir")).unwrap();
        })
        .unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn read_rejects_leaf_symlink_swap_after_validation() {
        let ws = tmpdir("read-leaf-swap");
        let outside = tmpdir("read-leaf-outside");
        let outside_file = outside.join("outside.txt");
        std::fs::write(ws.join("target.txt"), "inside").unwrap();
        std::fs::write(&outside_file, "outside").unwrap();
        let err = read_file_with_hook(ws.to_str().unwrap(), "target.txt", || {
            std::fs::remove_file(ws.join("target.txt")).unwrap();
            std::os::unix::fs::symlink(&outside_file, ws.join("target.txt")).unwrap();
        })
        .unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
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
    fn write_rejects_parent_symlink_swap_after_validation() {
        let ws = tmpdir("write-parent-swap");
        let outside = tmpdir("write-parent-outside");
        std::fs::create_dir_all(ws.join("dir")).unwrap();
        let err =
            write_file_with_hook(ws.to_str().unwrap(), "dir/new.txt", "secret", false, || {
                std::fs::rename(ws.join("dir"), ws.join("dir-old")).unwrap();
                std::os::unix::fs::symlink(&outside, ws.join("dir")).unwrap();
            })
            .unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        assert!(!outside.join("new.txt").exists());
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn write_rejects_leaf_symlink_swap_after_validation() {
        let ws = tmpdir("write-leaf-swap");
        let outside = tmpdir("write-leaf-outside");
        let outside_file = outside.join("outside.txt");
        std::fs::write(ws.join("target.txt"), "inside").unwrap();
        std::fs::write(&outside_file, "outside").unwrap();
        let err = write_file_with_hook(
            ws.to_str().unwrap(),
            "target.txt",
            "replacement",
            true,
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
    fn list_rejects_parent_symlink_swap_after_validation() {
        let ws = tmpdir("list-parent-swap");
        let outside = tmpdir("list-parent-outside");
        std::fs::create_dir_all(ws.join("dir")).unwrap();
        std::fs::write(ws.join("dir/inside.txt"), "inside").unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        let err = list_files_with_hook(ws.to_str().unwrap(), "dir", 2, || {
            std::fs::rename(ws.join("dir"), ws.join("dir-old")).unwrap();
            std::os::unix::fs::symlink(&outside, ws.join("dir")).unwrap();
        })
        .unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn list_does_not_follow_recursive_symlink_swap() {
        let ws = tmpdir("list-recursive-swap");
        let outside = tmpdir("list-recursive-outside");
        std::fs::create_dir_all(ws.join("dir/sub")).unwrap();
        std::fs::write(ws.join("dir/sub/inside.txt"), "inside").unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        std::fs::remove_dir_all(ws.join("dir/sub")).unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("dir/sub")).unwrap();
        let data = list_files(ws.to_str().unwrap(), "dir", 3).unwrap();
        let entries = data["entries"].as_array().unwrap();
        assert!(entries
            .iter()
            .all(|entry| entry.as_str() != Some("sub/secret.txt")));
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
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
