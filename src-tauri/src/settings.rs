//! Settings — plain JSON file in the app config dir, validated by serde.
//! No telemetry, no accounts, no auto-update pings. `update_check` exists only
//! as an explicit opt-in placeholder that nothing acts on.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Alt+Shift+X";
pub const DEFAULT_RESULT_CAP: usize = 30 * 1024;
pub const DEFAULT_MAX_ITERATIONS: u32 = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Ask every time (default).
    #[default]
    AskAll,
    /// Auto-approve reads; ask for writes and commands.
    AskWrites,
    /// Auto-approve everything inside the workspace.
    FullAccess,
}

impl PermissionMode {
    pub fn auto_approve_read(&self) -> bool {
        matches!(self, PermissionMode::AskWrites | PermissionMode::FullAccess)
    }
    pub fn auto_approve_write(&self) -> bool {
        matches!(self, PermissionMode::FullAccess)
    }
    pub fn auto_approve_command(&self) -> bool {
        matches!(self, PermissionMode::FullAccess)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebProfile {
    pub id: String,
    pub adapter_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalProvider {
    pub url: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub context_chars: Option<usize>,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// C3: Ollama context window for num_ctx (Ollama's small default silently
    /// truncates the preamble). Default 8192.
    #[serde(default)]
    pub num_ctx: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Providers {
    #[serde(default)]
    pub web: Vec<WebProfile>,
    #[serde(default)]
    pub ollama: Option<LocalProvider>,
    #[serde(default)]
    pub lmstudio: Option<LocalProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// B3: default AskAll — every risky action needs explicit approval.
    pub permission_mode: PermissionMode,
    pub max_iterations: u32,
    pub result_cap_bytes: usize,
    pub command_timeout_secs: u64,
    /// Overrides the default login shell for the integrated terminal.
    pub shell: Option<String>,
    /// Global emergency-stop hotkey. Kills running commands and halts the loop.
    pub hotkey: String,
    pub workspaces: Vec<WorkspaceEntry>,
    pub active_workspace_id: Option<String>,
    pub providers: Providers,
    /// User-editable allowlist applied to run_command (regex, case-insensitive).
    pub command_allow: Vec<String>,
    /// User-editable denylist applied to run_command (regex, case-insensitive),
    /// ON TOP of the built-in destructive patterns that cannot be removed.
    pub command_deny: Vec<String>,
    /// Explicit opt-in placeholder. Neelima ships with no update checker; this
    /// flag changes nothing unless a future opt-in build implements one.
    pub update_check_opt_in: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            permission_mode: PermissionMode::AskAll,
            max_iterations: DEFAULT_MAX_ITERATIONS,
            result_cap_bytes: DEFAULT_RESULT_CAP,
            command_timeout_secs: 120,
            shell: None,
            hotkey: DEFAULT_HOTKEY.into(),
            workspaces: Vec::new(),
            active_workspace_id: None,
            providers: Providers::default(),
            command_allow: Vec::new(),
            command_deny: Vec::new(),
            update_check_opt_in: false,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        let path = config_dir.join("settings.json");
        let settings = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    // F2: a corrupt settings.json must not abort startup with a
                    // message that lies about "defaults loaded". Back the bad
                    // file up, load real defaults, keep going.
                    let backup = config_dir.join(format!(
                        "settings.corrupt-{}.json",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0)
                    ));
                    let _ = std::fs::rename(&path, &backup);
                    eprintln!("[settings] settings.json invalid ({e}); backed up to {} and loaded defaults", backup.display());
                    Settings::default()
                }
            },
            Err(_) => Settings::default(),
        };
        Ok(SettingsStore {
            path,
            inner: Mutex::new(settings),
        })
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }

    pub fn set(&self, next: Settings) -> Result<Settings, String> {
        // serde validation happened during deserialization of `next` at the
        // command boundary; re-validate invariants here.
        if next.max_iterations == 0 || next.max_iterations > 200 {
            return Err("max_iterations must be 1..=200".into());
        }
        if next.result_cap_bytes < 1024 || next.result_cap_bytes > 1024 * 1024 {
            return Err("result_cap_bytes must be 1KB..1MB".into());
        }
        {
            let mut cur = self.inner.lock().unwrap();
            *cur = next;
        }
        self.save()?;
        Ok(self.get())
    }

    pub fn patch<F: FnOnce(&mut Settings)>(&self, f: F) -> Result<Settings, String> {
        let next = {
            let mut cur = self.inner.lock().unwrap();
            f(&mut cur);
            cur.clone()
        };
        self.set(next)
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.get()).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
}

pub fn always_ask_patterns() -> &'static [&'static str] {
    &[
        // D6: deletes targeting home / parents / outside the workspace /
        // drive roots. Matched case-insensitively.
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+(~|\$HOME|%USERPROFILE%)([/\\\s]|$)",
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+\.\.(\s|/|$)",
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+(/\*|[a-z]:\\)(\s|$)",
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+(/[a-z]|~?/|\$HOME|\%USERPROFILE%|[a-z]:\\|\.\.)",
        r"\b(rmdir|rd)\s+(/[sq]\s*)+.*(~|\$HOME|%USERPROFILE%|[a-z]:\\|[a-z]:\s*$|\.\.)",
        r"\bdel\s+(/[qfs]\s*)+.*(~|\$HOME|%USERPROFILE%|[a-z]:\\|\.\.)",
        r"\bremove-item\b.*(-recurse|-force).*([a-z]:\\|\.\.|~|\$HOME|%USERPROFILE%)",
        r"\brm\s+-[^ ]*r[^ ]*\s+/\*",
        r#"\bshutil\.rmtree\b\s*\(\s*(['"])~?[\w.]*/[a-z]"#,
        // Destructive git
        r"\bgit\s+(push|pull)\b[^|;]*--force\b",
        r"\bgit\s+push\b[^|;]*\s-f(\s|$)",
        r"\bgit\s+reset\s+--hard\b",
        r"\bgit\s+clean\b[^|;]*-f",
        r"\bgit\s+checkout\s+--\s+\.",
        r"\bgit\s+branch\s+-[a-z]*D",
        // Publishing / irreversible installs
        r"\bnpm\s+publish\b",
        r"\bcargo\s+publish\b",
        r"\bpip\s+install\b[^|;]*--(system|break-system-packages)",
        r"\bdocker\s+(system\s+prune|volume\s+rm)\b",
        // Remote auth / secrets
        r"\bssh\b[^|;]*\b(rm|mv)\b",
        r"\bchmod\s+(-R\s+)?777\b",
    ]
}

pub fn default_deny_patterns() -> &'static [&'static str] {
    &[
        r"\brm\s+(-[a-z]*[rf][a-z]*\s+)+/(\s|$)",
        r"\bdel\s+(/[sqf]\s*)+.*[a-z]:\\",
        r"\bformat\s+[a-z]:",
        r"\b(shutdown|reboot|halt|poweroff)\b",
        r"\breg(es?edit)?\s+(add|delete|edit|import|restore)\b", r"\bregedit\b",
        r"\bdiskpart\b|\bbcdedit\b|\bmkfs\b",
        r"\bdd\s+if=.*of=/dev/",
        r"(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b",
        r"(iex|invoke-expression)\b",
        r"(powershell|pwsh)\b.*\s-enc(odedcommand)?(\s|$)",
        r":\(\)\s*\{.*\}\s*;\s*:",
        r"\bchmod\s+-R\s+777\s+/(\s|$)",
        r"\bRemove-Item\b.*-Recurse.*-Force\s+[a-z]:\\(\s|$)",
        r"\btaskkill\s+/f\s+/im\s+(explorer|csrss|wininit|svchost)",
        r"\bmv\b\s+.*\s+/dev/null",
    ]
}
