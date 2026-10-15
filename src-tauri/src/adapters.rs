//! Provider adapters: config-driven JSON files (hot-reloaded) that describe how
//! to drive a provider's web chat UI. DOM selectors break often, so adapters are
//! user-editable data, not code — and the Adapter Inspector can record them.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Selectors {
    pub input: String,
    pub send_button: String,
    pub stop_button: Option<String>,
    pub messages: String,
    pub new_chat: Option<String>,
    pub logged_in: Option<String>,
}

impl Default for Selectors {
    fn default() -> Self {
        Selectors {
            input: "textarea".into(),
            send_button: "button[type=submit]".into(),
            stop_button: None,
            messages: "main".into(),
            new_chat: None,
            logged_in: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    #[default]
    Textarea,
    Contenteditable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct InputSpec {
    pub kind: InputKind,
    /// Prompts longer than this are pasted in chunks (then sent once).
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Adapter {
    pub id: String,
    pub name: String,
    pub url: String,
    pub selectors: Selectors,
    pub input: InputSpec,
    pub quiet_ms: u64,
    pub response_timeout_ms: u64,
    #[serde(default)]
    pub built_in: bool,
}

impl Default for Adapter {
    fn default() -> Self {
        Adapter {
            id: "generic".into(),
            name: "Generic".into(),
            url: "https://".into(),
            selectors: Selectors::default(),
            input: InputSpec::default(),
            quiet_ms: 2000,
            response_timeout_ms: 300_000,
            built_in: false,
        }
    }
}

#[derive(Default)]
pub struct AdaptersState {
    pub list: Mutex<Vec<Adapter>>,
    pub dir: Mutex<PathBuf>,
}

pub fn adapters_dir(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("adapters")
}

/// Copy bundled defaults into the user's adapters dir on first run, then load
/// everything. Returns the loaded list.
pub fn load_all(dir: &PathBuf) -> Result<Vec<Adapter>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let demo = include_str!("../assets/adapter-demo.json");
    let generic = include_str!("../assets/adapter-generic.json");
    ensure_file(&dir.join("demo.json"), demo)?;
    ensure_file(&dir.join("generic-template.json"), generic)?;

    let mut list = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        match std::fs::read(&path).map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Adapter>(&b).map_err(|e| format!("{}: {e}", path.display())))
        {
            Ok(a) => list.push(a),
            Err(e) => {
                // Don't kill the whole app over one bad adapter file.
                eprintln!("[adapters] skipping invalid file: {e}");
            }
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

fn ensure_file(path: &PathBuf, contents: &str) -> Result<(), String> {
    if !path.exists() {
        std::fs::write(path, contents).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Spawn a hot-reload watcher for the adapters dir (a single tiny directory —
/// workspace watching, by contrast, only ever runs while a task is executing).
pub fn spawn_watcher(
    dir: PathBuf,
    state: tauri::AppHandle,
) {
    use notify::{Watcher, RecursiveMode};
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    // Hold the watcher alive for the process lifetime.
    std::thread::spawn(move || {
        let _watcher = watcher;
        loop {
            match rx.recv() {
                Ok(_) => {
                    if let Ok(list) = load_all(&dir) {
                        let st: tauri::State<AdaptersState> = state.state();
                        *st.list.lock().unwrap() = list;
                        let _ = state.emit("evt", serde_json::json!({"kind": "adapters-reloaded"}));
                    }
                }
                Err(_) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_demo_adapter() {
        let a: Adapter = serde_json::from_str(include_str!("../assets/adapter-demo.json")).unwrap();
        assert_eq!(a.id, "demo");
        assert_eq!(a.selectors.input, "#ta");
    }

    #[test]
    fn tolerant_of_missing_optional_fields() {
        let a: Adapter = serde_json::from_str(r#"{"id":"x","name":"X","url":"https://a.example"}"#).unwrap();
        assert_eq!(a.quiet_ms, 2000);
        assert_eq!(a.input.kind, InputKind::Textarea);
    }
}
