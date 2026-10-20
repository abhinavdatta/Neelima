//! Provider adapters: config-driven JSON files (hot-reloaded) that describe how
//! to drive a provider's web chat UI. DOM selectors break often, so adapters are
//! user-editable data, not code — and the Adapter Inspector can record them.

use std::path::{Path, PathBuf};
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
    /// Selector for a marker that only exists while SIGNED OUT (e.g. a
    /// "Log in" button). Its absence is the most reliable logged-in signal:
    /// several sites hide or replace the send button when the composer is
    /// empty, which makes an input+send check false-negative forever.
    pub logged_out: Option<String>,
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
            logged_out: None,
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
    /// B1: the ONLY host (suffix match, e.g. "claude.ai") the provider webview
    /// may load. Required per the spec; deliberately not Option.
    #[serde(default)]
    pub allowed_domain: String,
    /// B1/A12: extra hosts allowed ONLY for login flows (OAuth consent, SSO)
    /// — accounts.google.com, auth0, login.microsoftonline.com etc.
    #[serde(default)]
    pub auth_domains: Vec<String>,
    /// A5/A12: URL substrings that mark a login/signup page; matching these
    /// forces logged_out, and drives the email-link tip in the UI.
    #[serde(default)]
    pub login_url_patterns: Vec<String>,
}

/// Validate a per-profile start URL without widening the adapter's navigation
/// boundary. The URL must be HTTPS and on the adapter's primary host or a
/// subdomain of it; auth domains remain login-only.
pub fn validate_profile_url(url: &str, allowed_domain: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid provider URL".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "provider URL has no host".to_string())?
        .to_ascii_lowercase();
    let allowed = allowed_domain.trim_start_matches('.').to_ascii_lowercase();
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
        || allowed.is_empty()
        || !(host == allowed || host.ends_with(&format!(".{allowed}")))
    {
        return Err(
            "provider URL must be HTTPS and remain within the selected adapter's allowed domain"
                .into(),
        );
    }
    Ok(parsed)
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
            allowed_domain: String::new(),
            auth_domains: Vec::new(),
            login_url_patterns: Vec::new(),
        }
    }
}

#[derive(Default)]
pub struct AdaptersState {
    pub list: Mutex<Vec<Adapter>>,
    pub dir: Mutex<PathBuf>,
}

pub fn adapters_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("adapters")
}

/// Previous bundled defaults, kept so we can migrate a user's UN-CUSTOMIZED
/// copy (byte-identical to a shipped default) to the current default. A file
/// the user has edited never matches and is left alone.
const CHATGPT_LEGACY: &str = r#"{
  "id": "chatgpt",
  "name": "ChatGPT",
  "url": "https://chatgpt.com/",
  "selectors": {
    "input": "div#prompt-textarea[contenteditable=\"true\"], #prompt-textarea, div[contenteditable=\"true\"]",
    "send_button": "button[data-testid=\"send-button\"], button[aria-label=\"Send prompt\"]",
    "stop_button": "button[data-testid=\"stop-button\"], button[aria-label=\"Stop streaming\"]",
    "messages": "main [data-message-author-role=\"assistant\"], div[data-message-author-role=\"assistant\"]",
    "new_chat": "a[aria-label=\"New chat\"], button[aria-label=\"New chat\"]",
    "logged_in": null
  },
  "input": { "kind": "contenteditable", "max_chars": 20000 },
  "quiet_ms": 2000,
  "response_timeout_ms": 420000,
  "built_in": true
}"#;

/// Copy bundled defaults into the user's adapters dir on first run, then load
/// everything. Returns the loaded list.
pub fn load_all(dir: &PathBuf) -> Result<Vec<Adapter>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let demo = include_str!("../assets/adapter-demo.json");
    let generic = include_str!("../assets/adapter-generic.json");
    let chatgpt = include_str!("../assets/adapter-chatgpt.json");
    let claude = include_str!("../assets/adapter-claude.json");
    let gemini = include_str!("../assets/adapter-gemini.json");
    ensure_file(&dir.join("demo.json"), demo, &[])?;
    ensure_file(&dir.join("generic-template.json"), generic, &[])?;
    ensure_file(&dir.join("chatgpt.json"), chatgpt, &[CHATGPT_LEGACY])?;
    ensure_file(&dir.join("claude.json"), claude, &[])?;
    ensure_file(&dir.join("gemini.json"), gemini, &[])?;

    let mut list = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        match std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| {
                serde_json::from_slice::<Adapter>(&b)
                    .map_err(|e| format!("{}: {e}", path.display()))
            }) {
            Ok(a) => list.push(a),
            Err(e) => {
                // Don't kill the whole app over one bad adapter file.
                if let Err(log_error) =
                    crate::app_log::write("adapters", &format!("skipping invalid file: {e}"))
                {
                    eprintln!(
                        "[adapters] skipping invalid file: {e}; file log failed: {log_error}"
                    );
                }
            }
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

fn ensure_file(path: &PathBuf, contents: &str, previous_defaults: &[&str]) -> Result<(), String> {
    if !path.exists() {
        std::fs::write(path, contents).map_err(|e| e.to_string())?;
        return Ok(());
    }
    // Migrate a copy that is byte-identical to an older bundled default; keep
    // anything the user has customized.
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if previous_defaults.contains(&trimmed) {
            std::fs::write(path, contents).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Spawn a hot-reload watcher for the adapters dir (a single tiny directory —
/// workspace watching, by contrast, only ever runs while a task is executing).
pub fn spawn_watcher(dir: PathBuf, state: tauri::AppHandle) {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    } // Hold the watcher alive for the process lifetime.
    std::thread::spawn(move || {
        let _watcher = watcher;
        while rx.recv().is_ok() {
            if let Ok(list) = load_all(&dir) {
                let st: tauri::State<AdaptersState> = state.state();
                *st.list.lock().unwrap() = list;
                let _ = state.emit("evt", serde_json::json!({"kind": "adapters-reloaded"}));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_url_cannot_expand_adapter_origin_policy() {
        assert!(validate_profile_url("https://chatgpt.com/custom", "chatgpt.com").is_ok());
        assert!(validate_profile_url("https://sub.chatgpt.com/custom", "chatgpt.com").is_ok());
        for url in [
            "http://chatgpt.com/",
            "https://chatgpt.com.evil.example/",
            "https://user@chatgpt.com/",
            "https://chatgpt.com:8443/",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(
                validate_profile_url(url, "chatgpt.com").is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn migrates_uncustomized_chatgpt_copy() {
        let dir =
            std::env::temp_dir().join(format!("neelima-adapters-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A user file that is exactly the OLD bundled default.
        std::fs::write(dir.join("chatgpt.json"), CHATGPT_LEGACY).unwrap();
        // A user-customized file must never be touched.
        let custom =
            r#"{"id":"chatgpt-custom","name":"My ChatGPT","url":"https://chatgpt.com/custom"}"#;
        std::fs::write(dir.join("custom.json"), custom).unwrap();
        let list = load_all(&dir).unwrap();
        let migrated = std::fs::read_to_string(dir.join("chatgpt.json")).unwrap();
        assert!(
            migrated.contains("logged_out"),
            "legacy copy must be migrated"
        );
        let custom_read = std::fs::read_to_string(dir.join("custom.json")).unwrap();
        assert_eq!(custom_read, custom, "customized copy must be preserved");
        let cg = list.iter().find(|a| a.id == "chatgpt").unwrap();
        assert!(cg.selectors.logged_out.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_builtin_real_adapters() {
        for (id, json) in [
            ("chatgpt", include_str!("../assets/adapter-chatgpt.json")),
            ("claude", include_str!("../assets/adapter-claude.json")),
            ("gemini", include_str!("../assets/adapter-gemini.json")),
        ] {
            let a: Adapter = serde_json::from_str(json).unwrap();
            assert_eq!(a.id, id);
            assert!(a.url.starts_with("https://"), "{}", a.url);
        }
    }

    #[test]
    fn parses_demo_adapter() {
        let a: Adapter = serde_json::from_str(include_str!("../assets/adapter-demo.json")).unwrap();
        assert_eq!(a.id, "demo");
        assert!(
            a.selectors.input.contains("#ta"),
            "input selector must target the demo textarea"
        );
        assert_eq!(a.selectors.send_button, "#send");
        // B1: every bundled adapter carries a domain guard.
        for f in [
            include_str!("../assets/adapter-demo.json"),
            include_str!("../assets/adapter-chatgpt.json"),
            include_str!("../assets/adapter-claude.json"),
            include_str!("../assets/adapter-gemini.json"),
            include_str!("../assets/adapter-generic.json"),
        ] {
            let a: Adapter = serde_json::from_str(f).unwrap();
            assert!(
                a.allowed_domain.is_empty() || !a.allowed_domain.contains("/"),
                "domain field must be a bare host"
            );
        }
        let chatgpt: Adapter =
            serde_json::from_str(include_str!("../assets/adapter-chatgpt.json")).unwrap();
        assert_eq!(chatgpt.allowed_domain, "chatgpt.com");
        assert!(chatgpt
            .auth_domains
            .contains(&"auth.openai.com".to_string()));
        assert!(chatgpt
            .login_url_patterns
            .iter()
            .any(|p| p.contains("/auth/login")));
    }

    #[test]
    fn builtin_adapter_login_and_domain_rules_are_configured() {
        for json in [
            include_str!("../assets/adapter-chatgpt.json"),
            include_str!("../assets/adapter-claude.json"),
            include_str!("../assets/adapter-gemini.json"),
            include_str!("../assets/adapter-generic.json"),
        ] {
            let adapter: Adapter = serde_json::from_str(json).unwrap();
            assert!(!adapter.allowed_domain.is_empty(), "{}", adapter.id);
            assert!(!adapter.login_url_patterns.is_empty(), "{}", adapter.id);
            assert!(
                adapter.selectors.logged_out.is_some(),
                "{} needs a logged-out marker selector",
                adapter.id
            );
        }
        let chatgpt: Adapter =
            serde_json::from_str(include_str!("../assets/adapter-chatgpt.json")).unwrap();
        assert!(
            chatgpt
                .selectors
                .logged_in
                .as_deref()
                .unwrap()
                .contains("prompt"),
            "ChatGPT requires the composer selector to detect the logged-in state"
        );
    }

    #[test]
    fn tolerant_of_missing_optional_fields() {
        let a: Adapter =
            serde_json::from_str(r#"{"id":"x","name":"X","url":"https://a.example"}"#).unwrap();
        assert_eq!(a.quiet_ms, 2000);
        assert_eq!(a.input.kind, InputKind::Textarea);
    }
}
