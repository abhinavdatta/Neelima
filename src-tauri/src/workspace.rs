//! Workspace confinement. Every file operation in Neelima goes through here:
//! paths are rejected unless they resolve INSIDE the canonical workspace root.
//! Defenses (in order):
//!   1. lexical: absolute paths, `..` components and Windows device names are rejected
//!   2. canonical: the deepest existing ancestor is canonicalized (dunce, no \\?\ form)
//!      and must start with the canonical root — this defeats symlink escapes
//!   3. TOCTOU note: we canonicalize at call time; racing renames are out of threat model.

use std::path::{Component, Path, PathBuf};

use dunce::canonicalize;

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("path escapes the workspace: {0}")]
    Escape(String),
    #[error("invalid path: {0}")]
    Invalid(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl Workspace {
    pub fn open(path: &Path) -> Result<Self, WorkspaceError> {
        let root = canonicalize(path).map_err(WorkspaceError::Io)?;
        if !root.is_dir() {
            return Err(WorkspaceError::Invalid(format!(
                "not a directory: {}",
                root.display()
            )));
        }
        Ok(Workspace { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn display_name(&self) -> String {
        self.root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.to_string_lossy().into_owned())
    }

    /// Resolve a user/AI-supplied relative path into a confined absolute path.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, WorkspaceError> {
        let trimmed = rel.trim();
        if trimmed.is_empty() {
            return Err(WorkspaceError::Invalid("empty path".into()));
        }
        let p = Path::new(trimmed);
        if p.is_absolute() {
            // Absolute paths are allowed ONLY if already inside the root (after
            // canonicalization) — checked below like any other path.
        }
        for comp in p.components() {
            match comp {
                Component::ParentDir => {
                    return Err(WorkspaceError::Escape(format!(
                        "'..' is not allowed: {trimmed}"
                    )))
                }
                Component::RootDir | Component::Prefix(_) => {}
                Component::Normal(name) => {
                    if is_windows_device_name(&name.to_string_lossy()) {
                        return Err(WorkspaceError::Invalid(format!(
                            "reserved device name: {}",
                            name.to_string_lossy()
                        )));
                    }
                }
                Component::CurDir => {}
            }
        }

        let joined = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        };

        // Canonicalize the deepest existing ancestor so symlinks are resolved.
        let mut probe = joined.clone();
        let mut to_rebuild: Vec<PathBuf> = Vec::new();
        let canonical = loop {
            match canonicalize(&probe) {
                Ok(c) => break c,
                Err(_) => {
                    let name = probe.file_name().map(|n| n.to_os_string());
                    if let Some(n) = name {
                        to_rebuild.push(PathBuf::from(n));
                    }
                    if !probe.pop() {
                        return Err(WorkspaceError::Escape(format!(
                            "cannot confine path: {trimmed}"
                        )));
                    }
                }
            }
        };
        if !canonical.starts_with(&self.root) {
            return Err(WorkspaceError::Escape(format!(
                "resolved path {canonical:?} is outside the workspace"
            )));
        }
        let mut out = canonical;
        for seg in to_rebuild.iter().rev() {
            out.push(seg);
        }
        Ok(out)
    }

    /// For results sent back to the AI/UI: workspace-relative display path.
    pub fn display(&self, abs: &Path) -> String {
        abs.strip_prefix(&self.root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| abs.to_string_lossy().replace('\\', "/"))
    }
}

fn is_windows_device_name(name: &str) -> bool {
    let upper = name.to_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    matches!(
        stem,
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
            | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
            | "LPT7" | "LPT8" | "LPT9"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_ws(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neelima-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        dir
    }

    #[test]
    fn accepts_relative_paths_inside_root() {
        let ws = Workspace::open(&tmp_ws("ok")).unwrap();
        let p = ws.resolve("src/main.rs").unwrap();
        assert!(p.starts_with(ws.root()));
        assert!(p.ends_with("src/main.rs"));
        std::fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn rejects_traversal() {
        let ws = Workspace::open(&tmp_ws("trav")).unwrap();
        assert!(ws.resolve("../etc/passwd").is_err());
        assert!(ws.resolve("src/../../../etc").is_err());
        std::fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn rejects_symlink_escape() {
        let dir = tmp_ws("sym");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", dir.join("etc-link")).unwrap();
            let ws = Workspace::open(&dir).unwrap();
            assert!(ws.resolve("etc-link/passwd").is_err());
        }
        #[cfg(windows)]
        {
            // Windows requires privileges for dir symlinks; test an absolute path
            // that lexically points outside instead.
            let ws = Workspace::open(&dir).unwrap();
            assert!(ws.resolve("C:\\Windows\\System32\\drivers\\etc\\hosts").is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(windows)]
    fn rejects_absolute_outside_windows() {
        let ws = Workspace::open(&tmp_ws("abs")).unwrap();
        assert!(ws.resolve("C:\\Windows\\notepad.exe").is_err());
        std::fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    #[cfg(unix)]
    fn rejects_absolute_outside_unix() {
        let ws = Workspace::open(&tmp_ws("abs")).unwrap();
        assert!(ws.resolve("/etc/passwd").is_err());
        std::fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn allows_new_files_under_existing_dirs() {
        let ws = Workspace::open(&tmp_ws("new")).unwrap();
        let p = ws.resolve("src/new-file.rs").unwrap();
        assert!(p.starts_with(ws.root()));
        assert!(p.ends_with("new-file.rs"));
        std::fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn rejects_windows_device_names() {
        let ws = Workspace::open(&tmp_ws("dev")).unwrap();
        assert!(ws.resolve("NUL").is_err());
        assert!(ws.resolve("src/COM1").is_err());
        std::fs::remove_dir_all(ws.root()).ok();
    }
}
