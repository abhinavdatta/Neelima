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
pub enum Theme {
    Light,
    #[default]
    Dark,
    PureDark,
    System,
    Custom,
}

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
    /// Optional user-selected start URL. The adapter's built-in URL is used
    /// when absent; ui::build_provider checks overrides against its host policy.
    #[serde(default)]
    pub url: Option<String>,
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
    /// UI color theme preference; defaults to Dark to preserve the current appearance.
    pub theme: Theme,
    /// User-edited JSON token map or CSS :root variable block for Custom theme.
    pub custom_theme: String,
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
            theme: Theme::Dark,
            custom_theme: String::new(),
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
                    let backup = config_dir.join(format!(
                        "settings.corrupt-{}.json",
                        uuid::Uuid::new_v4().simple()
                    ));
                    std::fs::rename(&path, &backup).map_err(|backup_err| {
                        format!(
                            "settings.json is invalid ({e}) and could not be backed up to {}: {backup_err}",
                            backup.display()
                        )
                    })?;
                    if let Err(log_error) = crate::app_log::write(
                        "settings",
                        &format!(
                            "settings.json invalid ({e}); backed up to {} and loaded defaults",
                            backup.display()
                        ),
                    ) {
                        eprintln!(
                            "[settings] settings were backed up, but file logging failed: {log_error}"
                        );
                    }
                    Settings::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
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
        validate_settings(&next)?;
        let mut current = self.inner.lock().unwrap();
        self.save(&next)?;
        *current = next;
        Ok(current.clone())
    }

    pub fn patch<F: FnOnce(&mut Settings)>(&self, f: F) -> Result<Settings, String> {
        let mut current = self.inner.lock().unwrap();
        let mut next = current.clone();
        f(&mut next);
        validate_settings(&next)?;
        self.save(&next)?;
        *current = next;
        Ok(current.clone())
    }

    fn save(&self, settings: &Settings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
}

fn validate_settings(next: &Settings) -> Result<(), String> {
    if next.custom_theme.len() > 16 * 1024 {
        return Err("custom_theme must be 16 KiB or smaller".into());
    }
    if next.max_iterations == 0 || next.max_iterations > 200 {
        return Err("max_iterations must be 1..=200".into());
    }
    if next.result_cap_bytes < 1024 || next.result_cap_bytes > 1024 * 1024 {
        return Err("result_cap_bytes must be 1KB..1MB".into());
    }
    for (name, provider) in [
        ("Ollama", next.providers.ollama.as_ref()),
        ("LM Studio", next.providers.lmstudio.as_ref()),
    ] {
        if let Some(provider) = provider {
            if provider
                .num_ctx
                .is_some_and(|n| !(1..=1_048_576).contains(&n))
            {
                return Err(format!("{name} context window must be 1..=1048576"));
            }
            if provider
                .temperature
                .is_some_and(|t| !t.is_finite() || !(0.0..=2.0).contains(&t))
            {
                return Err(format!("{name} temperature must be 0..=2"));
            }
        }
    }
    for profile in &next.providers.web {
        if let Some(url) = profile.url.as_deref() {
            let parsed = tauri::Url::parse(url)
                .map_err(|_| format!("web provider '{}' has an invalid URL", profile.name))?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.port().is_some_and(|port| port != 443)
            {
                return Err(format!(
                    "web provider '{}' URL must be HTTPS without credentials or a custom port",
                    profile.name
                ));
            }
        }
    }
    Ok(())
}

pub fn always_ask_patterns() -> &'static [&'static str] {
    &[
        // D6: deletes targeting home / parents / outside the workspace /
        // drive roots. Matched case-insensitively.
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE)([/\\\s]|$)",
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+\.\.(\s|/|$)",
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+(/\*|[a-z]:[/\\]?)(\s|$)",
        r"\brm\s+(-[a-z]+\s+)*(-[a-z]+\s+)+(/[a-z]|~?/|\$HOME|\%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]?|\.\.)",
        r"\b(rmdir|rd)\s+(/[sq]\s*)+.*(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]|[a-z]:\s*$|\.\.)",
        r"\b(rmdir|rd)\b[^|;]*(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]|\.\.)[^|;]*(/s|/q|-recurse|-force)",
        r"\bdel\s+(/[qfs]\s*)+.*(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]|\.\.)",
        r"\bdel\b[^|;]*(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]|\.\.)[^|;]*(/s|/q|/f)",
        r"\bremove-item\b.*(-recurse|-force).*(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]|\.\.)",
        r"\bremove-item\b.*(~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|[a-z]:[/\\]|\.\.).*(-recurse|-force)",
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
        r"\breg(es?edit)?\s+(add|delete|edit|import|restore)\b",
        r"\bregedit\b",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissions_default_to_ask_all() {
        let settings = Settings::default();
        assert_eq!(settings.permission_mode, PermissionMode::AskAll);
        assert!(!settings.permission_mode.auto_approve_read());
        assert!(!settings.permission_mode.auto_approve_write());
        assert!(!settings.permission_mode.auto_approve_command());
    }

    #[test]
    fn theme_defaults_for_existing_settings_files() {
        let old_settings = serde_json::json!({ "permission_mode": "ask_all" });
        let settings: Settings = serde_json::from_value(old_settings).unwrap();
        assert_eq!(settings.theme, Theme::Dark);
        assert!(settings.custom_theme.is_empty());
        assert_eq!(Settings::default().theme, Theme::Dark);
        assert_eq!(
            serde_json::from_value::<Theme>(serde_json::json!("pure_dark")).unwrap(),
            Theme::PureDark
        );
        assert_eq!(
            serde_json::from_value::<Theme>(serde_json::json!("custom")).unwrap(),
            Theme::Custom
        );
    }

    #[test]
    fn local_model_context_and_temperature_are_validated() {
        let dir = std::env::temp_dir().join(format!("neelima-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir).unwrap();
        let mut settings = Settings::default();
        settings.providers.ollama = Some(LocalProvider {
            url: "http://localhost:11434".into(),
            model: None,
            context_chars: None,
            temperature: Some(0.7),
            num_ctx: Some(0),
        });
        assert!(store.set(settings.clone()).is_err());
        settings.providers.ollama.as_mut().unwrap().num_ctx = Some(8192);
        settings.providers.ollama.as_mut().unwrap().temperature = Some(2.1);
        assert!(store.set(settings.clone()).is_err());
        settings.providers.ollama.as_mut().unwrap().temperature = Some(0.7);
        assert!(store.set(settings).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_settings_are_backed_up_before_defaults_load() {
        let dir =
            std::env::temp_dir().join(format!("neelima-settings-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings_path = dir.join("settings.json");
        std::fs::write(&settings_path, b"{invalid json").unwrap();

        let store = SettingsStore::load(&dir).unwrap();
        assert_eq!(store.get().hotkey, DEFAULT_HOTKEY);
        assert!(!settings_path.exists());
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings.corrupt-")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_patch_does_not_mutate_in_memory_settings() {
        let dir =
            std::env::temp_dir().join(format!("neelima-settings-patch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir).unwrap();

        assert!(store.patch(|settings| settings.max_iterations = 0).is_err());
        assert_eq!(store.get().max_iterations, DEFAULT_MAX_ITERATIONS);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settings_can_be_replaced_repeatedly() {
        let dir =
            std::env::temp_dir().join(format!("neelima-settings-repeat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir).unwrap();

        let first = Settings {
            max_iterations: 30,
            ..Default::default()
        };
        store.set(first).unwrap();
        let second = Settings {
            max_iterations: 40,
            ..Default::default()
        };
        store.set(second).unwrap();

        let persisted: Settings =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(persisted.max_iterations, 40);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_save_does_not_publish_new_settings_in_memory() {
        let dir =
            std::env::temp_dir().join(format!("neelima-settings-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocked_path = dir.join("settings.json");
        std::fs::create_dir(&blocked_path).unwrap();
        let store = SettingsStore {
            path: blocked_path,
            inner: Mutex::new(Settings::default()),
        };
        let next = Settings {
            max_iterations: 99,
            ..Default::default()
        };

        assert!(store.set(next).is_err());
        assert_eq!(store.get().max_iterations, DEFAULT_MAX_ITERATIONS);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
