//! Per-task transcript persistence: append-only JSONL on disk, never held fully
//! in memory. Task metadata lives in a small meta.json per task directory.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallRecord {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value2,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub output: String,
}

// Wrapper so args can be any JSON value while staying Send-friendly for events.
#[derive(Debug, Clone)]
pub struct Value2(pub serde_json::Value);

impl<'de> Deserialize<'de> for Value2 {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Value2(serde_json::Value::deserialize(d)?))
    }
}
impl Serialize for Value2 {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}
impl Default for Value2 {
    fn default() -> Self {
        Value2(serde_json::Value::Null)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffInfo {
    pub path: String,
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub id: u64,
    pub ts: u64,
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub calls: Vec<CallRecord>,
    #[serde(default)]
    pub diff: Option<DiffInfo>,
    #[serde(default)]
    pub injection_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMeta {
    pub id: String,
    pub title: String,
    pub started_ms: u64,
    #[serde(default)]
    pub ended_ms: Option<u64>,
    pub workspace: String,
    pub provider: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub iterations: u32,
}

pub fn valid_task_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct HistoryStore {
    root: PathBuf,
    next_id: Mutex<u64>,
    transcript_lock: Mutex<()>,
}

impl HistoryStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let root = app_data_dir.join("tasks");
        let next_id = last_transcript_entry_id(&root);
        HistoryStore {
            root,
            next_id: Mutex::new(next_id),
            transcript_lock: Mutex::new(()),
        }
    }

    pub fn task_dir(&self, id: &str) -> PathBuf {
        // Task IDs are UUIDs in simple 32-hex format. Invalid IDs resolve to a
        // deliberately impossible child; public operations validate and return errors.
        if !valid_task_id(id) {
            return self.root.join("__invalid_task_id__");
        }
        self.root.join(id)
    }

    pub fn contains_task(&self, id: &str) -> bool {
        valid_task_id(id) && self.task_dir(id).join("meta.json").is_file()
    }

    pub fn create_task(
        &self,
        id: &str,
        title: &str,
        workspace: &str,
        provider: &str,
    ) -> Result<TaskMeta, String> {
        if !valid_task_id(id) {
            return Err("invalid task ID".into());
        }
        let id = id.to_string();
        let dir = self.task_dir(&id);
        if dir.exists() {
            return Err("task ID already exists".into());
        }
        let meta = TaskMeta {
            id: id.clone(),
            title: title.chars().take(80).collect(),
            started_ms: now_ms(),
            ended_ms: None,
            workspace: workspace.to_string(),
            provider: provider.to_string(),
            status: "running".into(),
            iterations: 0,
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(
            dir.join("meta.json"),
            serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(meta)
    }

    pub fn update_task(&self, meta: &TaskMeta) -> Result<(), String> {
        if !valid_task_id(&meta.id) {
            return Err("invalid task ID".into());
        }
        let dir = self.task_dir(&meta.id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(
            dir.join("meta.json"),
            serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    /// Close an interrupted task without overwriting a terminal status written
    /// by the normal completion path.
    pub fn fail_if_running(&self, task_id: &str) -> Result<bool, String> {
        if !valid_task_id(task_id) {
            return Err("invalid task ID".into());
        }
        let path = self.task_dir(task_id).join("meta.json");
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        let mut meta: TaskMeta = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if meta.status != "running" {
            return Ok(false);
        }
        meta.status = "error".into();
        meta.ended_ms = Some(now_ms());
        self.update_task(&meta)?;
        Ok(true)
    }

    pub fn append(&self, task_id: &str, entry: &TranscriptEntry) -> Result<(), String> {
        let _lock = self.transcript_lock.lock().unwrap();
        self.append_unlocked(task_id, entry)
    }

    /// Persist and report whether this entry was newly appended. The task ID
    /// plus entry ID form the idempotency key for provider/transcript events.
    pub fn append_once(&self, task_id: &str, entry: &TranscriptEntry) -> Result<bool, String> {
        if !valid_task_id(task_id) {
            return Err("invalid task ID".into());
        }
        let _lock = self.transcript_lock.lock().unwrap();
        let path = self.task_dir(task_id).join("transcript.jsonl");
        if let Ok(file) = std::fs::File::open(&path) {
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|e| e.to_string())?;
                if let Ok(existing) = serde_json::from_str::<TranscriptEntry>(&line) {
                    if existing.id == entry.id {
                        return Ok(false);
                    }
                }
            }
        }
        self.append_unlocked(task_id, entry)?;
        Ok(true)
    }

    fn append_unlocked(&self, task_id: &str, entry: &TranscriptEntry) -> Result<(), String> {
        if !valid_task_id(task_id) {
            return Err("invalid task ID".into());
        }
        let dir = self.task_dir(task_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("transcript.jsonl"))
            .map_err(|e| e.to_string())?;
        let mut line = serde_json::to_vec(entry).map_err(|e| e.to_string())?;
        line.push(b'\n');
        f.write_all(&line).map_err(|e| e.to_string())
    }

    /// List tasks, newest first, capped.
    pub fn list_tasks(&self, cap: usize) -> Vec<TaskMeta> {
        let mut metas = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.root) {
            for entry in rd.flatten() {
                let meta_path = entry.path().join("meta.json");
                if let Ok(bytes) = std::fs::read(&meta_path) {
                    if let Ok(meta) = serde_json::from_slice::<TaskMeta>(&bytes) {
                        metas.push(meta);
                    }
                }
            }
        }
        metas.sort_by_key(|meta| std::cmp::Reverse(meta.started_ms));
        metas.truncate(cap);
        metas
    }

    pub fn read_transcript(
        &self,
        task_id: &str,
        tail: usize,
    ) -> Result<Vec<TranscriptEntry>, String> {
        if !valid_task_id(task_id) {
            return Err("invalid task ID".into());
        }
        let path = self.task_dir(task_id).join("transcript.jsonl");
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let mut entries = Vec::new();
        for line in data.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            if let Ok(e) = serde_json::from_slice::<TranscriptEntry>(line) {
                entries.push(e);
            }
        }
        if entries.len() > tail {
            entries.drain(..entries.len() - tail);
        }
        Ok(entries)
    }

    /// Remove a task directory (transcript + meta) entirely. Files on disk are
    /// deleted — there is no undo.
    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        if !valid_task_id(id) {
            return Err("invalid task ID".into());
        }
        let dir = self.task_dir(id);
        if !dir.exists() {
            return Err("task not found".into());
        }
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn next_entry_id(&self) -> u64 {
        let mut n = self.next_id.lock().unwrap();
        *n += 1;
        *n
    }

    /// Aggregate stats for the "N files changed +X -Y" card.
    pub fn summarize_changes(entries: &[TranscriptEntry]) -> (usize, usize, usize) {
        let mut files = std::collections::HashSet::new();
        let mut added = 0usize;
        let mut removed = 0usize;
        for e in entries {
            if let Some(d) = &e.diff {
                files.insert(d.path.clone());
                let diff = similar::TextDiff::from_lines(&d.old, &d.new);
                for change in diff.iter_all_changes() {
                    match change.tag() {
                        similar::ChangeTag::Insert => added += 1,
                        similar::ChangeTag::Delete => removed += 1,
                        _ => {}
                    }
                }
            }
        }
        (files.len(), added, removed)
    }
}

fn last_transcript_entry_id(root: &std::path::Path) -> u64 {
    let Ok(tasks) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut max_id = 0;
    for task in tasks.flatten() {
        let name = task.file_name();
        if !valid_task_id(&name.to_string_lossy()) || !task.path().is_dir() {
            continue;
        }
        let file = match std::fs::File::open(task.path().join("transcript.jsonl")) {
            Ok(file) => file,
            Err(_) => continue,
        };
        for line in BufReader::new(file).lines().flatten() {
            if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(&line) {
                max_id = max_id.max(entry.id);
            }
        }
    }
    max_id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (HistoryStore, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("neelima-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        (HistoryStore::new(root.clone()), root)
    }

    #[test]
    fn history_rejects_invalid_ids_before_touching_paths() {
        let (history, root) = store("invalid-id");
        let non_hex = "g".repeat(32);
        for id in ["", "../escape", "..", "C:\\outside", "a/b", &non_hex] {
            assert!(!valid_task_id(id));
            assert!(history.read_transcript(id, 10).is_err());
            assert!(history.delete_task(id).is_err());
            let entry = TranscriptEntry {
                id: 1,
                ts: 0,
                kind: "test".into(),
                text: String::new(),
                calls: Vec::new(),
                diff: None,
                injection_warning: None,
            };
            assert!(history.append(id, &entry).is_err());
        }
        assert!(!root.join("__invalid_task_id__").exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn task_id_is_shared_by_metadata_and_transcript_paths() {
        let (history, root) = store("shared-id");
        let id = "0123456789abcdef0123456789abcdef";
        let meta = history
            .create_task(id, "title", "workspace", "manual")
            .unwrap();
        assert_eq!(meta.id, id);
        let entry = TranscriptEntry {
            id: 1,
            ts: 0,
            kind: "test".into(),
            text: "same task".into(),
            calls: Vec::new(),
            diff: None,
            injection_warning: None,
        };
        history.append(id, &entry).unwrap();
        assert_eq!(history.read_transcript(id, 10).unwrap().len(), 1);
        assert!(history
            .create_task(id, "again", "workspace", "manual")
            .is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn transcript_entry_is_persisted_at_most_once_by_entry_id() {
        let (history, root) = store("append-once");
        let task_id = "dddddddddddddddddddddddddddddddd";
        history
            .create_task(task_id, "title", "workspace", "manual")
            .unwrap();
        let entry = TranscriptEntry {
            id: 1,
            ts: 123,
            kind: "assistant".into(),
            text: "Captured provider response".into(),
            calls: Vec::new(),
            diff: None,
            injection_warning: None,
        };

        assert!(history.append_once(task_id, &entry).unwrap());
        assert!(!history.append_once(task_id, &entry).unwrap());
        let transcript = history.read_transcript(task_id, 10).unwrap();
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0].text, "Captured provider response");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn interrupted_task_is_failed_once_and_terminal_status_is_preserved() {
        let (history, root) = store("fail-interrupted");
        let interrupted = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut meta = history
            .create_task(interrupted, "interrupted", "workspace", "manual")
            .unwrap();

        assert!(history.fail_if_running(interrupted).unwrap());
        assert!(!history.fail_if_running(interrupted).unwrap());
        let failed = history.list_tasks(10).remove(0);
        assert_eq!(failed.status, "error");
        assert!(failed.ended_ms.is_some());

        let completed = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        meta.id = completed.into();
        meta.title = "completed".into();
        meta.status = "done".into();
        meta.ended_ms = Some(now_ms());
        history
            .create_task(completed, "completed", "workspace", "manual")
            .unwrap();
        history.update_task(&meta).unwrap();
        assert!(!history.fail_if_running(completed).unwrap());
        let tasks = history.list_tasks(10);
        assert_eq!(
            tasks.iter().find(|t| t.id == completed).unwrap().status,
            "done"
        );

        // A subsequent task can be recorded after the interrupted task closes.
        let next = "cccccccccccccccccccccccccccccccc";
        history
            .create_task(next, "retry", "workspace", "manual")
            .unwrap();
        assert_eq!(history.list_tasks(10).len(), 3);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn next_entry_id_continues_after_store_restart() {
        let (history, root) = store("entry-id-restart");
        let task_id = "fedcba9876543210fedcba9876543210";
        history
            .create_task(task_id, "title", "workspace", "manual")
            .unwrap();
        let entry = TranscriptEntry {
            id: 41,
            ts: 0,
            kind: "test".into(),
            text: "persisted".into(),
            calls: Vec::new(),
            diff: None,
            injection_warning: None,
        };
        history.append(task_id, &entry).unwrap();
        drop(history);
        let reopened = HistoryStore::new(root.clone());
        assert_eq!(reopened.next_entry_id(), 42);
        std::fs::remove_dir_all(root).ok();
    }
}
