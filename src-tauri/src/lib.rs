//! Neelima — local-first agentic coding app.
//!
//! Network policy (enforced by construction): the only destinations this Rust
//! binary ever contacts are localhost model servers (Ollama/LM Studio) and the
//! pages the user loads inside the provider webview. No telemetry, no accounts,
//! no update pings.

use std::sync::Arc;

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub mod action;
pub mod adapters;
pub mod agent;
pub mod app_log;
pub mod bridge;
pub mod browser_bridge;
pub mod checkpoints;
pub mod context;
pub mod exec;
pub mod history;
pub mod native_host;
pub mod procspawn;
pub mod protocol;
pub mod providers;
pub mod request;
pub mod sec;
pub mod settings;
pub mod skills;
pub mod terminal;
pub mod tools;
pub mod ui;
pub mod webprov;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The folder-picker dialog plugin. TEST BUILDS ONLY get a no-op stand-in:
/// the lib unit-test binary links this whole crate, and the dialog plugin's
/// rfd chain imports `TaskDialogIndirect` from comctl32 v6. Cargo does not
/// apply manifest workarounds to lib UNIT-test targets (only integration
/// tests), so the test exe would abort at load with 0xc0000139 — while a
/// manifest could not be added to BINS either (tauri-build's resource.lib
/// already embeds one → CVT1100). Dialogs never execute inside unit tests;
/// production builds are completely unchanged.
#[cfg(not(test))]
fn dialog_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_dialog::init()
}

#[cfg(test)]
fn dialog_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("dialog").build()
}

pub fn run() {
    tauri::Builder::default()
        // F2: a second instance must not fight over the global hotkey — make
        // single-instance the FIRST plugin so it wins the race.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(dialog_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        emergency_stop(app);
                    }
                    let _ = shortcut;
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            ui::ui_pick_workspace,
            ui::ui_workspace_add,
            ui::ui_workspace_list,            ui::ui_workspace_use,
            ui::ui_workspace_remove,
            ui::ui_workspace_rename,
            ui::ui_workspace_open_in_explorer,
            ui::ui_tree,
            ui::ui_file_preview,
            ui::ui_file_text,
            ui::ui_file_save,
            ui::ui_settings_get,
            ui::ui_settings_set,
            ui::ui_adapters_list,
            ui::ui_adapters_open_folder,
            ui::ui_adapter_start_inspector,
            ui::ui_adapter_capture,
            ui::ui_adapter_finish_inspector,
            ui::ui_providers_login,
            ui::ui_providers_close,
            ui::ui_provider_clear_session,
            ui::ui_providers_list,
            ui::ui_models_local,
            ui::ui_context_preview,
            ui::ui_task_start,
            ui::ui_task_stop,
            ui::ui_task_continue,
            ui::ui_approve,
            ui::ui_relay_reply,
            ui::ui_webview_mode,
            ui::ui_webview_rect,
            ui::ui_sync_viewport,
            ui::ui_terminal_create,
            ui::ui_terminal_write,
            ui::ui_terminal_resize,
            ui::ui_terminal_kill,
            ui::ui_checkpoint_list,
            ui::ui_checkpoint_create,
            ui::ui_checkpoint_restore_preview,
            ui::ui_checkpoint_restore,
            ui::ui_history_tasks,
            ui::ui_history_open,
            ui::ui_search_tasks,
            ui::ui_diff_get,
            ui::ui_task_rename,
            ui::ui_task_delete,
            ui::ui_app_info,
            ui::ui_skills_list,
            ui::ui_skill_preview,
            ui::ui_skill_install,
            ui::ui_skill_set_enabled,
            ui::ui_skill_uninstall,
            ui::ui_skill_reveal,
            ui::ui_skill_update_preview,
            ui::ui_skill_read,
            ui::ui_open_github,
            ui::ui_provider_diagnose,
            ui::ui_request_log,
            ui::ui_provider_mark_signed_in,
            ui::ui_capture_reply,
            ui::ui_provider_probe,
            bridge::lb_bridge,
            browser_bridge::browser_bridge_propose,
            browser_bridge::browser_bridge_decide,
            native_host::native_host_pipe_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // ---- config / data dirs ----
            let config_dir = handle.path().app_config_dir().map_err(|e| e.to_string())?;
            let data_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            app_log::init(&data_dir)?;

            // ---- managed state (Arc-shared with the agent task) ----
            let settings = settings::SettingsStore::load(&config_dir)?;
            let hotkey = settings.get().hotkey.clone();
            app.manage(settings);
            app.manage(ui::WorkspaceSlot::default());
            app.manage(Arc::new(bridge::BridgeHub::default()));
            app.manage(Arc::new(browser_bridge::BrowserBridgeHub::default()));
            app.manage(Arc::new(webprov::WebviewState::default()));
            // Step 2: canonical request lifecycle registry (provider-independent,
            // metadata only) shared by web, local and manual providers.
            app.manage(Arc::new(request::RequestRegistry::default()));
            // Phase A: unified action ledger — observes tool actions from the
            // agent loop and the browser bridge. Bounded, metadata-only,
            // in-memory; never an authorization input.
            app.manage(Arc::new(action::ActionLedger::default()));
            app.manage(Arc::new(history::HistoryStore::new(data_dir.clone())));
            app.manage(Arc::new(providers::RelaySlot::default()));
            app.manage(agent::ActiveAgent::default());
            app.manage(terminal::TermState::default());

            // ---- native host IPC server (for browser extension native messaging) ----
            native_host::start_native_host_server(handle.clone());

            // ---- adapters (bundled defaults copied on first run) ----
            let adapter_dir = adapters::adapters_dir(&config_dir);
            let list = adapters::load_all(&adapter_dir).unwrap_or_default();
            app.manage(adapters::AdaptersState { list: std::sync::Mutex::new(list), dir: std::sync::Mutex::new(adapter_dir.clone()) });
            adapters::spawn_watcher(adapter_dir, handle.clone());

            // ---- main window: bare window + two child webviews ----
            let window = tauri::window::WindowBuilder::new(&handle, "main")
                .title("Neelima")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 560.0)
                .decorations(false)
                .build()
                .map_err(|e| e.to_string())?;

            // UI webview fills the window; the provider webview is added later,
            // positioned exactly over the provider pane reported by the UI.
            window
                .add_child(
                    WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(1280.0, 800.0),
                )
                .map_err(|e| e.to_string())?;

            // Emergency-stop hotkey (default Ctrl+Alt+Shift+X, user-editable).
            // F2: never fatal — a busy global shortcut must not kill the app.
            if let Err(e) = register_hotkey(&handle, &hotkey) {
                let log_error = app_log::write("hotkey", &e).err();
                let text = if let Some(log_error) = log_error {
                    format!("Emergency-stop hotkey could not be registered: {e}; file log failed: {log_error}")
                } else {
                    format!("Emergency-stop hotkey could not be registered: {e}")
                };
                let _ = handle.emit(agent::EVT, serde_json::json!({"kind": "notify", "level": "warn", "text": text }));
            }

            // Kill leftover state on window close.
            let handle2 = handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(term) = handle2.try_state::<terminal::TermState>() {
                        term.kill_all();
                    }
                }
                // Keep the UI child webview filling the window when maximised /
                // fullscreened; it is added at a fixed 1280x800 in setup. The
                // sync command also re-pins the position so a stale larger
                // webview can never leave centered UI (modals) overflowing the
                // visible window edge.
                if let tauri::WindowEvent::Resized(size) = event {
                    if let Some(webview) = handle2.get_webview("ui") {
                        let _ = webview.set_size(*size);
                        let _ = webview.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition::new(0, 0),
                        ));
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Neelima");
}

/// Global emergency stop: kills every running command + terminal and halts the
/// agent loop. Wired to the user-configurable hotkey.
pub fn emergency_stop(app: &tauri::AppHandle) {
    // Lock order `ActiveAgent` -> terminal matches workspace switch/removal.
    // Taking the terminal lock first could deadlock with a switch that is
    // already holding the active-task slot while waiting to kill terminals.
    if let Some(active) = app.try_state::<agent::ActiveAgent>() {
        if let Some(shared) = active.get() {
            let _ = shared.cmd_tx.send(agent::AgentCommand::Stop);
        }
    }
    if let Some(term) = app.try_state::<terminal::TermState>() {
        term.kill_all();
    }
    let _ = app.emit(agent::EVT, serde_json::json!({"kind": "notify", "level": "warn", "text": "Emergency stop: commands killed, agent halted."}));
}

/// A1 self-check: report the state types the app manages. A command whose
/// `State<T>` does not match a managed type is silently rejected by Tauri for
/// EVERY call (that is how every RPC timed out once). `managed_types_expected`
/// is kept in sync with this list by a unit test in bridge.rs.
pub fn run_checks() -> String {
    format!("managed: {}", bridge::managed_types_expected().join(", "))
}

pub fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Result<(), String> {
    let sc: Shortcut = hotkey
        .parse()
        .map_err(|e| format!("bad hotkey '{hotkey}': {e}"))?;
    let gs = app.global_shortcut();
    gs.unregister_all()
        .map_err(|e| format!("could not clear existing hotkey registrations: {e}"))?;
    gs.register(sc)
        .map_err(|e| format!("failed to register hotkey '{hotkey}': {e}"))?;
    Ok(())
}
