//! Git-based checkpoints. Decision (measured, see README): use the git CLI via
//! std::process instead of gitoxide — zero binary-size cost (~2-4 MB saved),
//! snapshot/restore on small worktrees runs in well under a second, and git is
//! universally installed on dev machines. Snapshots live in a bare repo at
//! <workspace>/.neelima/checkpoints.git; the user's own .git is never touched.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

use crate::procspawn::hidden_std;
use crate::workspace::Workspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub ts: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestorePreview {
    pub checkpoint: String,
    pub checkpoint_files: usize,
    pub tracked_files_to_remove: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreResult {
    pub checkpoint: String,
    pub backup_checkpoint: String,
    pub restored_files: usize,
    pub removed_files: usize,
}

fn git_dir(ws: &Workspace) -> std::path::PathBuf {
    ws.root().join(".neelima").join("checkpoints.git")
}

fn is_internal_path(path: &str) -> bool {
    path == ".neelima"
        || path.starts_with(".neelima/")
        || path == ".git"
        || path.starts_with(".git/")
}

fn is_sensitive_path(path: &str) -> bool {
    path.split('/').map(str::to_ascii_lowercase).any(|name| {
        let safe_env_template = matches!(
            name.as_str(),
            ".env.example" | ".env.sample" | ".env.template"
        );
        if name == ".env" || (name.starts_with(".env.") && !safe_env_template) {
            return true;
        }
        matches!(
            name.as_str(),
            "id_rsa"
                | "id_ed25519"
                | "id_ecdsa"
                | "id_dsa"
                | "credentials"
                | "credentials.json"
                | "secrets.json"
        ) || name.starts_with("service-account") && name.ends_with(".json")
            || [".pem", ".key", ".p12", ".pfx", ".p7b", ".p7c", ".keystore"]
                .iter()
                .any(|extension| name.ends_with(extension))
    })
}

fn run_git(ws: &Workspace, args: &[&str]) -> Result<String, String> {
    let mut cmd = hidden_std("git");
    let out = cmd
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

/// Create the bare snapshot repo (idempotent) and exclude internal and common
/// secret-bearing paths from future snapshots.
pub fn ensure_repo(ws: &Workspace) -> Result<(), String> {
    let gd = git_dir(ws);
    if !gd.exists() {
        std::fs::create_dir_all(gd.parent().unwrap()).map_err(|e| e.to_string())?;
        let out = hidden_std("git")
            .args(["init", "--bare", "--quiet"])
            .arg(&gd)
            .output()
            .map_err(|e| format!("git not available ({e}); checkpoints disabled"))?;
        if !out.status.success() {
            return Err(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    let exclude = gd.join("info").join("exclude");
    std::fs::create_dir_all(exclude.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut exclude_contents = match std::fs::read_to_string(&exclude) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read checkpoint exclude file: {e}")),
    };
    const EXCLUDES: &[&str] = &[
        "/.neelima/",
        "/.env",
        "/.env.*",
        "!/.env.example",
        "!/.env.sample",
        "!/.env.template",
        "**/.env",
        "**/.env.*",
        "!**/.env.example",
        "!**/.env.sample",
        "!**/.env.template",
        "*.pem",
        "*.key",
        "*.p12",
        "*.pfx",
        "*.p7b",
        "*.p7c",
        "*.keystore",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "id_dsa",
        "credentials",
        "credentials.json",
        "secrets.json",
        "service-account*.json",
    ];
    let mut updated = false;
    for pattern in EXCLUDES {
        if !exclude_contents.lines().any(|line| line.trim() == *pattern) {
            if !exclude_contents.is_empty() && !exclude_contents.ends_with('\n') {
                exclude_contents.push('\n');
            }
            exclude_contents.push_str(pattern);
            exclude_contents.push('\n');
            updated = true;
        }
    }
    if updated {
        std::fs::write(&exclude, exclude_contents).map_err(|e| e.to_string())?;
    }
    let already_tracked = run_git(ws, &["ls-files", "--", ".neelima"])?;
    if !already_tracked.is_empty() {
        run_git(
            ws,
            &["rm", "-r", "--cached", "--ignore-unmatch", "--", ".neelima"],
        )?;
    }
    Ok(())
}

fn untrack_sensitive_files(ws: &Workspace) -> Result<(), String> {
    let tracked = run_git(ws, &["ls-files", "--cached"])?;
    for path in tracked.lines().filter(|path| is_sensitive_path(path)) {
        run_git(ws, &["rm", "--cached", "--ignore-unmatch", "--", path])?;
    }
    Ok(())
}

pub fn snapshot(ws: &Workspace, label: &str) -> Result<Checkpoint, String> {
    ensure_repo(ws)?;
    run_git(ws, &["add", "-A", "--", "."])?;
    untrack_sensitive_files(ws)?;
    let msg = format!("neelima: {label}");
    let committed = run_git(
        ws,
        &[
            "-c",
            "user.name=Neelima",
            "-c",
            "user.email=neelima@localhost",
            "commit",
            "-m",
            &msg,
            "--allow-empty",
        ],
    );
    match committed {
        Ok(_) => {}
        Err(e) if e.contains("nothing to commit") => {}
        Err(e) => return Err(e),
    }
    let id = run_git(ws, &["rev-parse", "--short", "HEAD"])?;
    Ok(Checkpoint {
        id,
        ts: crate::history::now_ms(),
        label: label.to_string(),
    })
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
            let label = parts
                .next()
                .unwrap_or("")
                .trim_start_matches("neelima: ")
                .to_string();
            Checkpoint { id, ts, label }
        })
        .collect())
}

fn checkpoint_files(ws: &Workspace, id: &str) -> Result<std::collections::HashSet<String>, String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("checkpoint id must be a hexadecimal Git object id".into());
    }
    ensure_repo(ws)?;
    run_git(ws, &["cat-file", "-e", &format!("{id}^{{commit}}")])
        .map_err(|_| format!("checkpoint {id} not found"))?;
    Ok(run_git(ws, &["ls-tree", "-r", "--name-only", id])?
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.replace('\\', "/"))
        .filter(|path| !is_internal_path(path))
        .collect())
}

fn currently_tracked_files(ws: &Workspace) -> Result<std::collections::HashSet<String>, String> {
    Ok(run_git(ws, &["ls-files", "--cached"])?
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.replace('\\', "/"))
        .filter(|path| !is_internal_path(path))
        .collect())
}

fn tracked_path(ws: &Workspace, rel: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rel);
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("checkpoint contains unsafe path {rel:?}"));
    }
    let path = ws.root().join(relative);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(path),
        Err(e) => return Err(format!("could not inspect tracked path {rel:?}: {e}")),
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("checkpoint path has no parent: {rel:?}"))?;
    let canonical_parent =
        dunce::canonicalize(parent).map_err(|e| format!("invalid checkpoint path {rel:?}: {e}"))?;
    if !canonical_parent.starts_with(ws.root()) {
        return Err(format!("checkpoint path escapes workspace: {rel:?}"));
    }
    Ok(canonical_parent.join(
        path.file_name()
            .ok_or_else(|| format!("checkpoint path has no filename: {rel:?}"))?,
    ))
}

pub fn restore_preview(ws: &Workspace, id: &str) -> Result<RestorePreview, String> {
    let target = checkpoint_files(ws, id)?;
    let tracked = currently_tracked_files(ws)?;
    let tracked_files_to_remove = tracked.difference(&target).try_fold(0usize, |count, rel| {
        let path = tracked_path(ws, rel)?;
        Ok::<_, String>(count + usize::from(path.is_file() || path.is_symlink()))
    })?;
    Ok(RestorePreview {
        checkpoint: id.to_string(),
        checkpoint_files: target.len(),
        tracked_files_to_remove,
    })
}

/// Restore only removes paths tracked by the checkpoint index before restore.
/// New untracked files survive; a pre-restore snapshot protects all current data.
pub fn restore(ws: &Workspace, id: &str) -> Result<RestoreResult, String> {
    let target = checkpoint_files(ws, id)?;
    let previously_tracked = currently_tracked_files(ws)?;
    let backup_checkpoint = snapshot(ws, "pre-restore backup")?;
    run_git(ws, &["read-tree", id])?;
    run_git(
        ws,
        &["rm", "-r", "--cached", "--ignore-unmatch", "--", ".neelima"],
    )?;
    run_git(ws, &["checkout-index", "-a", "-f"])?;

    let mut removed_files = 0usize;
    for rel in previously_tracked.difference(&target) {
        let path = tracked_path(ws, rel)?;
        if path.is_file() || path.is_symlink() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("could not remove tracked file {}: {e}", path.display()))?;
            removed_files += 1;
        }
    }
    Ok(RestoreResult {
        checkpoint: id.to_string(),
        backup_checkpoint: backup_checkpoint.id,
        restored_files: target.len(),
        removed_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_restore_roundtrip() {
        if hidden_std("git").arg("--version").output().is_err() {
            return; // git missing: checkpoints disabled by design
        }
        let dir = std::env::temp_dir().join(format!("neelima-ckpt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = crate::workspace::Workspace::open(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        let cp = snapshot(&ws, "baseline").unwrap();
        assert!(currently_tracked_files(&ws)
            .unwrap()
            .iter()
            .all(|path| !is_internal_path(path)));
        std::fs::write(dir.join("a.txt"), "v2").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();
        snapshot(&ws, "tracks b").unwrap();
        std::fs::write(dir.join("c.txt"), "untracked after snapshot").unwrap();
        let preview = restore_preview(&ws, &cp.id).unwrap();
        assert_eq!(preview.checkpoint_files, 1);
        assert_eq!(preview.tracked_files_to_remove, 1);
        let restored = restore(&ws, &cp.id).unwrap();
        assert_eq!(restored.restored_files, 1);
        assert_eq!(restored.removed_files, 1);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1");
        assert!(!dir.join("b.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("c.txt")).unwrap(),
            "untracked after snapshot"
        );
        assert!(list(&ws)
            .unwrap()
            .iter()
            .any(|checkpoint| checkpoint.label == "pre-restore backup"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_rejects_non_hex_ids() {
        let dir = std::env::temp_dir().join(format!("neelima-ckpt-invalid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ws = crate::workspace::Workspace::open(&dir).unwrap();
        assert!(restore_preview(&ws, "../HEAD").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshots_skip_common_secret_files_and_keep_templates() {
        if hidden_std("git").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "neelima-ckpt-secrets-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let ws = crate::workspace::Workspace::open(&dir).unwrap();
        for name in [
            ".env",
            ".env.production",
            ".env.example",
            "id_ed25519",
            "nested/private.pem",
            "nested/credentials.json",
            "nested/main.rs",
        ] {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "sample").unwrap();
        }

        let checkpoint = snapshot(&ws, "secret filter");
        assert!(checkpoint.is_ok(), "{checkpoint:?}");
        let files = checkpoint_files(&ws, &checkpoint.unwrap().id).unwrap();
        assert!(files.contains(".env.example"));
        assert!(files.contains("nested/main.rs"));
        for secret in [
            ".env",
            ".env.production",
            "id_ed25519",
            "nested/private.pem",
            "nested/credentials.json",
        ] {
            assert!(!files.contains(secret), "snapshot included {secret}");
            assert!(dir.join(secret).exists(), "worktree secret was deleted");
        }

        run_git(&ws, &["add", "-f", "--", ".env.production"]).unwrap();
        run_git(
            &ws,
            &[
                "-c",
                "user.name=Neelima",
                "-c",
                "user.email=neelima@localhost",
                "commit",
                "-m",
                "legacy secret snapshot",
                "--allow-empty",
            ],
        )
        .unwrap();
        let legacy_id = run_git(&ws, &["rev-parse", "--short", "HEAD"]).unwrap();
        assert!(checkpoint_files(&ws, &legacy_id)
            .unwrap()
            .contains(".env.production"));
        let sanitized = snapshot(&ws, "remove tracked secret from future snapshots").unwrap();
        assert!(!checkpoint_files(&ws, &sanitized.id)
            .unwrap()
            .contains(".env.production"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
