//! Path containment and sensitive-file rules (PROTOCOL.md "Sandbox rules").
//!
//! Canonicalize-based: symlinks anywhere in the path are resolved; for paths
//! that do not exist yet, the deepest existing ancestor is canonicalized and
//! the missing tail re-appended. This mirrors the TypeScript sandbox
//! (packages/core/src/tools/sandbox.ts) as a second line of defense.

use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use crate::protocol::{codes, RtError, RtResult};

/// Directories skipped by list_files.
pub const DEFAULT_IGNORE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
    "target",
    "vendor",
];

pub fn is_ignored_dir(name: &str) -> bool {
    DEFAULT_IGNORE_DIRS.contains(&name)
}

/// Files whose contents must never be read back to the model.
pub fn is_sensitive_basename(name: &str) -> bool {
    name == ".env"
        || (name.starts_with(".env.") && name.len() > ".env.".len())
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        // Unambiguous credential files (always secrets).
        || name == ".npmrc"
        || name == ".netrc"
        || name == ".pgpass"
        || name == ".git-credentials"
}

/// Workspace-relative paths whose contents are secrets despite a generic
/// basename (SeekForge's own config.json / triggers.json, and .git/config).
/// Mirrors the TS isSensitiveRelPath. `rel` uses "/" separators.
pub fn is_sensitive_rel_path(rel: &str) -> bool {
    matches!(
        rel,
        ".seekforge/config.json" | ".seekforge/triggers.json" | ".git/config"
    )
}

/// Canonicalize the workspace root itself (must exist).
pub fn canonical_workspace(workspace: &str) -> RtResult<PathBuf> {
    fs::canonicalize(workspace)
        .map_err(|e| RtError::io(format!("cannot resolve workspace {workspace}: {e}")))
}

/// Lexically normalize `.` and `..` (like Node's path.resolve before realpath).
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // At the root this is a no-op, matching path.resolve("/..") == "/".
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve `rel` against `workspace` and assert containment.
/// Returns the fully resolved absolute path inside the canonical workspace.
pub fn resolve_inside_workspace(workspace: &str, rel: &str) -> RtResult<PathBuf> {
    let ws = canonical_workspace(workspace)?;
    let rel_path = Path::new(rel);
    let target = if rel_path.is_absolute() {
        rel_path.to_path_buf()
    } else {
        ws.join(rel_path)
    };
    let target = lexical_normalize(&target);

    // Canonicalize the deepest existing ancestor, then re-append the tail.
    let mut probe = target;
    let mut tail: Vec<OsString> = Vec::new();
    while !probe.exists() {
        match (probe.parent().map(Path::to_path_buf), probe.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                probe = parent;
            }
            _ => break,
        }
    }
    let mut resolved = fs::canonicalize(&probe).unwrap_or(probe);
    for name in tail.iter().rev() {
        resolved.push(name);
        // The existence probe above uses `exists()`, which FOLLOWS symlinks — so a
        // dangling symlink (one whose target does not exist) is treated as a plain
        // missing tail name and its literal path passes the containment check,
        // after which `fs::write` would follow the link and escape the workspace.
        // Reject any symlink tail component outright (lstat, no follow). A genuinely
        // new path component simply doesn't exist here and is left alone.
        if let Ok(meta) = fs::symlink_metadata(&resolved) {
            if meta.file_type().is_symlink() {
                return Err(RtError::new(
                    codes::OUTSIDE_WORKSPACE,
                    format!("path escapes the workspace (symlink): {rel}"),
                ));
            }
        }
    }

    if !resolved.starts_with(&ws) {
        return Err(RtError::new(
            codes::OUTSIDE_WORKSPACE,
            format!("path escapes the workspace: {rel}"),
        ));
    }
    Ok(resolved)
}

/// Containment + sensitive-basename/path check for read access.
pub fn resolve_for_read(workspace: &str, rel: &str) -> RtResult<PathBuf> {
    let ws = canonical_workspace(workspace)?;
    let resolved = resolve_inside_workspace(workspace, rel)?;
    ensure_read_allowed(&ws, &resolved, rel)?;
    Ok(resolved)
}

fn ensure_read_allowed(ws: &Path, resolved: &Path, rel: &str) -> RtResult<()> {
    let basename = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Secret files with a generic basename (config.json / triggers.json /
    // .git/config) are blocked by workspace-relative path.
    let rel_from_ws = resolved
        .strip_prefix(ws)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if is_sensitive_basename(&basename) || is_sensitive_rel_path(&rel_from_ws) {
        return Err(RtError::new(
            codes::SENSITIVE_PATH,
            format!("reading {rel} is not allowed (sensitive file)"),
        ));
    }
    Ok(())
}

/// Containment + .git/ protection for write access.
pub fn resolve_for_write(workspace: &str, rel: &str) -> RtResult<PathBuf> {
    let ws = canonical_workspace(workspace)?;
    let resolved = resolve_inside_workspace(workspace, rel)?;
    if let Ok(inner) = resolved.strip_prefix(&ws) {
        if inner.components().next() == Some(Component::Normal(".git".as_ref())) {
            return Err(RtError::new(
                codes::SENSITIVE_PATH,
                format!("writing under .git/ is not allowed: {rel}"),
            ));
        }
    }
    Ok(resolved)
}

fn open_workspace_root(ws: &Path, rel: &str) -> RtResult<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(ws)
        .map_err(|e| secure_path_error(rel, "open workspace", e))
}

fn split_secure_path(ws: &Path, resolved: &Path, rel: &str) -> RtResult<(Vec<OsString>, OsString)> {
    let inner = resolved.strip_prefix(ws).map_err(|_| {
        RtError::new(
            codes::OUTSIDE_WORKSPACE,
            format!("path escapes the workspace: {rel}"),
        )
    })?;
    let mut components = Vec::new();
    for component in inner.components() {
        match component {
            Component::Normal(name) => components.push(name.to_os_string()),
            _ => {
                return Err(RtError::new(
                    codes::OUTSIDE_WORKSPACE,
                    format!("invalid workspace-relative path: {rel}"),
                ));
            }
        }
    }
    let leaf = components
        .pop()
        .ok_or_else(|| RtError::io(format!("path must name a file inside the workspace: {rel}")))?;
    Ok((components, leaf))
}

/// A validated read target anchored to an open workspace descriptor.
pub(crate) struct SecureReadPath {
    root: File,
    parents: Vec<OsString>,
    leaf: OsString,
    display: String,
}

impl SecureReadPath {
    pub(crate) fn prepare(workspace: &str, rel: &str) -> RtResult<Self> {
        let ws = canonical_workspace(workspace)?;
        let root = open_workspace_root(&ws, rel)?;
        let resolved = resolve_for_read(workspace, rel)?;
        let (parents, leaf) = split_secure_path(&ws, &resolved, rel)?;
        Ok(Self {
            root,
            parents,
            leaf,
            display: rel.to_string(),
        })
    }

    pub(crate) fn open(&self) -> RtResult<File> {
        let parent = open_parent_chain(&self.root, &self.parents, false, &self.display)?;
        openat_file(
            &parent,
            &self.leaf,
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )
        .map_err(|error| secure_path_error(&self.display, "open file for reading", error))
    }
}

/// A validated directory target anchored to an open workspace descriptor.
pub(crate) struct SecureDirPath {
    root: File,
    components: Vec<OsString>,
    display: String,
}

impl SecureDirPath {
    pub(crate) fn prepare(workspace: &str, rel: &str) -> RtResult<Self> {
        let ws = canonical_workspace(workspace)?;
        let root = open_workspace_root(&ws, rel)?;
        let resolved = resolve_inside_workspace(workspace, rel)?;
        let inner = resolved.strip_prefix(&ws).map_err(|_| {
            RtError::new(
                codes::OUTSIDE_WORKSPACE,
                format!("path escapes the workspace: {rel}"),
            )
        })?;
        let mut components = Vec::new();
        for component in inner.components() {
            match component {
                Component::Normal(name) => components.push(name.to_os_string()),
                _ => {
                    return Err(RtError::new(
                        codes::OUTSIDE_WORKSPACE,
                        format!("invalid workspace-relative path: {rel}"),
                    ));
                }
            }
        }
        Ok(Self {
            root,
            components,
            display: rel.to_string(),
        })
    }

    pub(crate) fn open(&self) -> RtResult<File> {
        open_parent_chain(&self.root, &self.components, false, &self.display)
    }
}

/// A validated write target anchored to an open workspace descriptor.
///
/// All later traversal is descriptor-relative and rejects symlinks. This keeps
/// validation and mutation bound to the same directory hierarchy even when an
/// untrusted process swaps path components concurrently.
pub(crate) struct SecureWritePath {
    root: File,
    parents: Vec<OsString>,
    leaf: OsString,
    display: String,
}

impl SecureWritePath {
    pub(crate) fn prepare(workspace: &str, rel: &str, needs_read: bool) -> RtResult<Self> {
        let ws = canonical_workspace(workspace)?;
        let root = open_workspace_root(&ws, rel)?;
        let resolved = resolve_for_write(workspace, rel)?;
        if needs_read {
            ensure_read_allowed(&ws, &resolved, rel)?;
        }
        let (components, leaf) = split_secure_path(&ws, &resolved, rel)?;
        Ok(Self {
            root,
            parents: components,
            leaf,
            display: rel.to_string(),
        })
    }

    pub(crate) fn open_for_write(&self, overwrite: bool) -> RtResult<File> {
        let parent = self.open_parent(true)?;
        let mut flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        if !overwrite {
            flags |= libc::O_EXCL;
        }
        match openat_file(&parent, &self.leaf, flags, 0o666) {
            Ok(file) => {
                let metadata = file.metadata().map_err(|error| {
                    secure_path_error(&self.display, "inspect file for writing", error)
                })?;
                if !metadata.is_file() {
                    return Err(RtError::io(format!("not a regular file: {}", self.display)));
                }
                if overwrite {
                    file.set_len(0).map_err(|error| {
                        secure_path_error(&self.display, "truncate file for writing", error)
                    })?;
                }
                Ok(file)
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) && !overwrite => {
                Err(RtError::new(
                    codes::EXISTS,
                    format!(
                        "file already exists: {} (pass overwrite:true to replace)",
                        self.display
                    ),
                ))
            }
            Err(error) => Err(secure_path_error(
                &self.display,
                "open file for writing",
                error,
            )),
        }
    }

    pub(crate) fn open_for_update(&self) -> RtResult<File> {
        let parent = self.open_parent(false)?;
        openat_file(
            &parent,
            &self.leaf,
            libc::O_RDWR | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )
        .map_err(|error| secure_path_error(&self.display, "open file for editing", error))
    }

    fn open_parent(&self, create: bool) -> RtResult<File> {
        open_parent_chain(&self.root, &self.parents, create, &self.display)
    }
}

fn open_parent_chain(
    root: &File,
    parents: &[OsString],
    create: bool,
    display: &str,
) -> RtResult<File> {
    let mut current = root
        .try_clone()
        .map_err(|e| secure_path_error(display, "clone workspace handle", e))?;
    for component in parents {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        match openat_file(&current, component, flags, 0) {
            Ok(next) => current = next,
            Err(error) if create && error.raw_os_error() == Some(libc::ENOENT) => {
                match mkdirat(&current, component) {
                    Ok(()) => {}
                    Err(mkdir_error) if mkdir_error.raw_os_error() == Some(libc::EEXIST) => {}
                    Err(mkdir_error) => {
                        return Err(secure_path_error(
                            display,
                            "create parent directory",
                            mkdir_error,
                        ));
                    }
                }
                current = openat_file(&current, component, flags, 0)
                    .map_err(|error| secure_path_error(display, "open parent directory", error))?;
            }
            Err(error) => {
                return Err(secure_path_error(display, "open parent directory", error));
            }
        }
    }
    Ok(current)
}

fn c_name(name: &OsStr) -> std::io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path component contains a NUL byte",
        )
    })
}

pub(crate) fn openat_file(
    parent: &File,
    name: &OsStr,
    flags: i32,
    mode: libc::c_uint,
) -> std::io::Result<File> {
    let name = c_name(name)?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn mkdirat(parent: &File, name: &OsStr) -> std::io::Result<()> {
    let name = c_name(name)?;
    let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o777) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn secure_path_error(path: &str, operation: &str, error: std::io::Error) -> RtError {
    if matches!(
        error.raw_os_error(),
        Some(libc::ELOOP) | Some(libc::ENOTDIR)
    ) {
        RtError::new(
            codes::OUTSIDE_WORKSPACE,
            format!("unsafe symlink or non-directory component in {path}: {error}"),
        )
    } else {
        RtError::io(format!("cannot {operation} for {path}: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn tmpdir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("sf-sandbox-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn ws_str(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    #[test]
    fn rejects_parent_escape() {
        let ws = tmpdir("parent");
        let err = resolve_inside_workspace(ws_str(&ws), "../outside.txt").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        let err = resolve_inside_workspace(ws_str(&ws), "a/../../outside.txt").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn rejects_absolute_escape() {
        let ws = tmpdir("abs");
        let err = resolve_inside_workspace(ws_str(&ws), "/etc/passwd").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        // Absolute paths inside the workspace are fine.
        let inside = fs::canonicalize(&ws).unwrap().join("ok.txt");
        let resolved = resolve_inside_workspace(ws_str(&ws), inside.to_str().unwrap()).unwrap();
        assert_eq!(resolved, inside);
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn rejects_symlink_escape() {
        let ws = tmpdir("symws");
        let outside = tmpdir("symout");
        fs::write(outside.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("link")).unwrap();
        let err = resolve_inside_workspace(ws_str(&ws), "link/secret.txt").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        // Even a path that does not exist yet behind the symlink must be caught.
        let err = resolve_inside_workspace(ws_str(&ws), "link/new/file.txt").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        fs::remove_dir_all(&ws).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn rejects_dangling_symlink_escape() {
        // A symlink whose target does NOT exist: exists() follows it and reports
        // false, so the old code treated `link` as a plain missing tail and let
        // `link` (and a following write) escape. Must be rejected.
        let ws = tmpdir("dangling");
        let target = tmpdir("dangling-target");
        fs::remove_dir_all(&target).unwrap(); // make the symlink target non-existent
        std::os::unix::fs::symlink(target.join("evil.txt"), ws.join("link")).unwrap();
        let err = resolve_inside_workspace(ws_str(&ws), "link").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn new_path_uses_deepest_existing_ancestor() {
        let ws = tmpdir("newpath");
        let resolved = resolve_inside_workspace(ws_str(&ws), "newdir/sub/file.txt").unwrap();
        let ws_real = fs::canonicalize(&ws).unwrap();
        assert!(resolved.starts_with(&ws_real));
        assert!(resolved.ends_with("newdir/sub/file.txt"));
        // ".." inside a not-yet-existing tail must still be normalized and checked.
        let err = resolve_inside_workspace(ws_str(&ws), "newdir/../../escape.txt").unwrap_err();
        assert_eq!(err.code, codes::OUTSIDE_WORKSPACE);
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn sensitive_basenames() {
        for name in [
            ".env",
            ".env.local",
            ".env.production",
            "cert.pem",
            "server.key",
            "id_rsa",
            "id_rsa.pub",
            "id_ed25519",
            "id_ed25519.pub",
        ] {
            assert!(is_sensitive_basename(name), "{name} should be sensitive");
        }
        for name in [
            "env",
            ".environment",
            ".env.",
            "envfile",
            "key.txt",
            "pem.txt",
            "rsa_id",
        ] {
            assert!(
                !is_sensitive_basename(name),
                "{name} should not be sensitive"
            );
        }
    }

    #[test]
    fn sensitive_basename_parity_fixture() {
        // Shared TS<->Rust fixture: the sensitive/not-sensitive decision here
        // must match the TypeScript isSensitiveBasename (asserted by a sibling
        // Vitest). Adding a pattern to one backend without the other breaks
        // this test. Source: test-fixtures/sensitive-basename.json.
        let raw = include_str!("../../../test-fixtures/sensitive-basename.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).unwrap();
        for case in parsed["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let expected = case["sensitive"].as_bool().unwrap();
            assert_eq!(
                is_sensitive_basename(name),
                expected,
                "parity mismatch for: {name}"
            );
        }
        for case in parsed["relPathCases"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            let expected = case["sensitive"].as_bool().unwrap();
            assert_eq!(
                is_sensitive_rel_path(path),
                expected,
                "rel-path parity mismatch for: {path}"
            );
        }
    }

    #[test]
    fn read_denied_for_sensitive_file() {
        let ws = tmpdir("sens");
        fs::write(ws.join(".env"), "SECRET=1").unwrap();
        let err = resolve_for_read(ws_str(&ws), ".env").unwrap_err();
        assert_eq!(err.code, codes::SENSITIVE_PATH);
        let err = resolve_for_read(ws_str(&ws), "sub/dir/key.pem").unwrap_err();
        assert_eq!(err.code, codes::SENSITIVE_PATH);
        assert!(resolve_for_read(ws_str(&ws), "normal.txt").is_ok());
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn write_denied_under_git_dir() {
        let ws = tmpdir("gitw");
        let err = resolve_for_write(ws_str(&ws), ".git/config").unwrap_err();
        assert_eq!(err.code, codes::SENSITIVE_PATH);
        let err = resolve_for_write(ws_str(&ws), ".git").unwrap_err();
        assert_eq!(err.code, codes::SENSITIVE_PATH);
        // .github is not .git
        assert!(resolve_for_write(ws_str(&ws), ".github/workflows/ci.yml").is_ok());
        assert!(resolve_for_write(ws_str(&ws), "src/main.ts").is_ok());
        fs::remove_dir_all(&ws).ok();
    }
}
