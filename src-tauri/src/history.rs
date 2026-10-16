//! Per-task transcript persistence: append-only JSONL on disk, never held fully
//! in memory. Task metadata lives in a small meta.json per task directory.

use std::io::Write;
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

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct HistoryStore {
    root: PathBuf,
    next_id: Mutex<u64>,
}

impl HistoryStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        HistoryStore { root: app_data_dir.join("tasks"), next_id: Mutex::new(1) }
    }

    pub fn task_dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    pub fn create_task(&self, title: &str, workspace: &str, provider: &str) -> Result<TaskMeta, String> {
        let id = format!("{}", uuid::Uuid::new_v4().simple());
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
        let dir = self.task_dir(&id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(meta)
    }

    pub fn update_task(&self, meta: &TaskMeta) -> Result<(), String> {
        let dir = self.task_dir(&meta.id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }

    pub fn append(&self, task_id: &str, entry: &TranscriptEntry) -> Result<(), String> {
        let dir = self.task_dir(task_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("transcript.jsonl"))
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
        metas.sort_by(|a, b| b.started_ms.cmp(&a.started_ms));
        metas.truncate(cap);
        metas
    }

    pub fn read_transcript(&self, task_id: &str, tail: usize) -> Result<Vec<TranscriptEntry>, String> {
        let path = self.task_dir(task_id).join("transcript.jsonl");
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for line in data.split(|b| *b == b'\n') {
            if line.is_empty() { continue; }
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
