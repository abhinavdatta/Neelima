//! Git-based checkpoints. Decision (measured, see README): use the git CLI via
//! std::process instead of gitoxide — zero binary-size cost (~2-4 MB saved),
//! snapshot/restore on small worktrees runs in well under a second, and git is
//! universally installed on dev machines. Snapshots live in a bare repo at
//! <workspace>/.neelima/checkpoints.git; the user's own .git is never touched.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::workspace::Workspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub ts: u64,
    pub label: String,
}

fn git_dir(ws: &Workspace) -> std::path::PathBuf {
    ws.root().join(".neelima").join("checkpoints.git")
}

fn run_git(ws: &Workspace, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg(format!("--git-dir={}", git_dir(ws).display()))
        .arg(format!("--work-tree={}", ws.root().display()))
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Create the bare snapshot repo (idempotent) and exclude .neelima itself.
pub fn ensure_repo(ws: &Workspace) -> Result<(), String> {
    let gd = git_dir(ws);
    if !gd.exists() {
        std::fs::create_dir_all(gd.parent().unwrap()).map_err(|e| e.to_string())?;
        let out = Command::new("git").args(["init", "--bare", "--quiet"]).arg(&gd).output()
            .map_err(|e| format!("git not available ({e}); checkpoints disabled"))?;
        if !out.status.success() {
            return Err(format!("git init failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }
    let exclude = gd.join("info").join("exclude");
    if !exclude.exists() {
        let _ = std::fs::create_dir_all(exclude.parent().unwrap());
        let _ = std::fs::write(&exclude, "/.neelima\n");
    }
    Ok(())
}

pub fn snapshot(ws: &Workspace, label: &str) -> Result<Checkpoint, String> {
    ensure_repo(ws)?;
    run_git(ws, &["add", "-A", "--", "."])?;
    let msg = format!("neelima: {label}");
    let committed = run_git(ws, &[
        "-c", "user.name=Neelima", "-c", "user.email=neelima@localhost",
        "commit", "-m", &msg, "--allow-empty",
    ]);
    match committed {
        Ok(_) => {}
        Err(e) if e.contains("nothing to commit") => {}
        Err(e) => return Err(e),
    }
    let id = run_git(ws, &["rev-parse", "--short", "HEAD"])?;
    Ok(Checkpoint { id, ts: crate::history::now_ms(), label: label.to_string() })
}

pub fn list(ws: &Workspace) -> Result<Vec<Checkpoint>, String> {
    if !git_dir(ws).exists() {
        return Ok(Vec::new());
    }
    let log = run_git(ws, &["log", "--format=%h|%ct|%s", "--all"])?;
    Ok(log
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut parts = l.splitn(3, '|');
            let id = parts.next().unwrap_or("").to_string();
            let ts = parts.next().unwrap_or("0").parse().unwrap_or(0);
            let label = parts.next().unwrap_or("").trim_start_matches("neelima: ").to_string();
            Checkpoint { id, ts, label }
        })
        .collect())
}

/// Restore: write out the snapshot tree, then delete files that exist now but
/// not in the snapshot (except .git and .neelima). Returns file count.
pub fn restore(ws: &Workspace, id: &str) -> Result<usize, String> {
    ensure_repo(ws)?;
    let files = run_git(ws, &["ls-tree", "-r", "--name-only", id])?;
    if files.is_empty() {
        return Err(format!("checkpoint {id} not found"));
    }
    run_git(ws, &["read-tree", id])?;
    run_git(ws, &["checkout-index", "-a", "-f"])?;
    let keep: std::collections::HashSet<String> =
        files.lines().map(|l| l.replace('\\', "/")).collect();
    let mut removed = 0usize;
    remove_missing(ws.root(), ws.root(), &keep, &mut removed)?;
    Ok(keep.len())
}

fn remove_missing(
    root: &Path,
    dir: &Path,
    keep: &std::collections::HashSet<String>,
    removed: &mut usize,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name == ".git" || name == ".neelima" {
            continue;
        }
        if path.is_dir() {
            remove_missing(root, &path, keep, removed)?;
            let _ = std::fs::remove_dir(&path); // remove if now empty
        } else {
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if !keep.contains(&rel) {
                let _ = std::fs::remove_file(&path);
                *removed += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_restore_roundtrip() {
        if Command::new("git").arg("--version").output().is_err() {
            return; // git missing: checkpoints disabled by design
        }
        let dir = std::env::temp_dir().join(format!("neelima-ckpt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = crate::workspace::Workspace::open(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        let cp = snapshot(&ws, "baseline").unwrap();
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();
        let n = restore(&ws, &cp.id).unwrap();
        assert!(n >= 1);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1");
        assert!(!dir.join("b.txt").exists());
        assert!(list(&ws).unwrap().len() >= 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
