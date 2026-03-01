//! Path containment and sensitive-file rules (PROTOCOL.md "Sandbox rules").
//!
//! Canonicalize-based: symlinks anywhere in the path are resolved; for paths
//! that do not exist yet, the deepest existing ancestor is canonicalized and
//! the missing tail re-appended. This mirrors the TypeScript sandbox
//! (packages/core/src/tools/sandbox.ts) as a second line of defense.

use std::ffi::OsString;
use std::fs;
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
    }

    if !resolved.starts_with(&ws) {
        return Err(RtError::new(
            codes::OUTSIDE_WORKSPACE,
            format!("path escapes the workspace: {rel}"),
        ));
    }
    Ok(resolved)
}

/// Containment + sensitive-basename check for read access.
pub fn resolve_for_read(workspace: &str, rel: &str) -> RtResult<PathBuf> {
    let resolved = resolve_inside_workspace(workspace, rel)?;
    let basename = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if is_sensitive_basename(&basename) {
        return Err(RtError::new(
            codes::SENSITIVE_PATH,
            format!("reading {rel} is not allowed (sensitive file)"),
        ));
    }
    Ok(resolved)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn tmpdir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "sf-sandbox-{tag}-{}-{n}",
            std::process::id()
        ));
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
        for name in ["env", ".environment", ".env.", "envfile", "key.txt", "pem.txt", "rsa_id"] {
            assert!(!is_sensitive_basename(name), "{name} should not be sensitive");
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
