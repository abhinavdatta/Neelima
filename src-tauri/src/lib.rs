//! Neelima — local-first agentic coding app.
//!
//! Network policy (enforced by construction): the only destinations this Rust
//! binary ever contacts are localhost model servers (Ollama/LM Studio) and the
//! pages the user loads inside the provider webview. No telemetry, no accounts,
//! no update pings.

use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewBuilder, LogicalPosition, LogicalSize, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub mod adapters;
pub mod agent;
pub mod bridge;
pub mod checkpoints;
pub mod exec;
pub mod history;
pub mod protocol;
pub mod providers;
pub mod sec;
pub mod settings;
pub mod terminal;
pub mod tools;
pub mod ui;
pub mod webprov;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            ui::ui_settings_get,
            ui::ui_settings_set,
            ui::ui_adapters_list,
            ui::ui_adapters_open_folder,
            ui::ui_adapter_start_inspector,
            ui::ui_adapter_capture,
            ui::ui_adapter_finish_inspector,
            ui::ui_providers_login,
            ui::ui_providers_close,
            ui::ui_providers_list,
            ui::ui_models_local,
            ui::ui_task_start,
            ui::ui_task_stop,
            ui::ui_task_continue,
            ui::ui_approve,
            ui::ui_relay_reply,
            ui::ui_webview_mode,
            ui::ui_webview_rect,
            ui::ui_terminal_create,
            ui::ui_terminal_write,
            ui::ui_terminal_resize,
            ui::ui_terminal_kill,
            ui::ui_checkpoint_list,
            ui::ui_checkpoint_create,
            ui::ui_checkpoint_restore,
            ui::ui_history_tasks,
            ui::ui_history_open,
            ui::ui_search_tasks,
            ui::ui_diff_get,
            ui::ui_app_info,
            bridge::lb_bridge,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // ---- config / data dirs ----
            let config_dir = handle.path().app_config_dir().map_err(|e| e.to_string())?;
            let data_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

            // ---- managed state (Arc-shared with the agent task) ----
            let settings = settings::SettingsStore::load(&config_dir)?;
            let hotkey = settings.get().hotkey.clone();
            app.manage(settings);
            app.manage(ui::WorkspaceSlot::default());
            app.manage(Arc::new(bridge::BridgeHub::default()));
            app.manage(Arc::new(webprov::WebviewState::default()));
            app.manage(Arc::new(history::HistoryStore::new(data_dir.clone())));
            app.manage(Arc::new(providers::RelaySlot::default()));
            app.manage(agent::ActiveAgent::default());
            app.manage(terminal::TermState::default());

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
            register_hotkey(&handle, &hotkey)?;

            // Kill leftover state on window close.
            let handle2 = handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(term) = handle2.try_state::<terminal::TermState>() {
                        term.kill_all();
                    }
                }
                // Keep the UI child webview filling the window when maximised /
                // fullscreened; it is added at a fixed 1280x800 in setup.
                if let tauri::WindowEvent::Resized(size) = event {
                    if let Some(webview) = handle2.get_webview("ui") {
                        let _ = webview.set_size(*size);
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
    if let Some(term) = app.try_state::<terminal::TermState>() {
        term.kill_all();
    }
    if let Some(active) = app.try_state::<agent::ActiveAgent>() {
        if let Some(shared) = active.get() {
            let _ = shared.cmd_tx.send(agent::AgentCommand::Stop);
        }
    }
    let _ = app.emit(agent::EVT, serde_json::json!({"kind": "notify", "level": "warn", "text": "Emergency stop: commands killed, agent halted."}));
}

pub fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let sc: Shortcut = hotkey.parse().map_err(|e| format!("bad hotkey '{hotkey}': {e}"))?;
    gs.register(sc).map_err(|e| format!("failed to register hotkey '{hotkey}': {e}"))?;
    Ok(())
}
