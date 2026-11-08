//! All UI-facing commands. EVERY command label-checks its caller: only the
//! "ui" webview may invoke these. (The provider webview's capability grants
//! exactly one command — lb_bridge — and the app ACL manifest denies it
//! everything else anyway. This guard is the second wall.)

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Position, Size, State, Webview};

use crate::adapters::{Adapter, AdaptersState};
use crate::agent::{ActiveAgent, AgentCommand, AgentInput, AgentShared, CallDecision};
use crate::bridge::BridgeHub;
use crate::history::{HistoryStore, TaskMeta, TranscriptEntry};
use crate::providers::{list_models, LocalKind, LocalProvider, ManualProvider, Provider};
use crate::settings::{Settings, SettingsStore};
use crate::terminal::TermState;
use crate::webprov::{self, InspectorSession, WebviewState};
use crate::workspace::Workspace;

fn guard(webview: &Webview) -> Result<(), String> {
    if webview.label() == "ui" {
        Ok(())
    } else {
        Err(format!(
            "command not allowed from webview '{}'",
            webview.label()
        ))
    }
}

fn ws_from(state: &WorkspaceSlot) -> Result<Workspace, String> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace open — pick a folder first".into())
}

#[derive(Default)]
pub struct WorkspaceSlot(pub std::sync::Mutex<Option<Workspace>>);

#[tauri::command]
pub fn ui_pick_workspace(app: AppHandle, webview: Webview) -> Result<Option<String>, String> {
    guard(&webview)?;
    // TEST-BUILD ONLY: the lib unit-test binary links this whole crate, and
    // the dialog plugin's rfd chain imports `TaskDialogIndirect` from
    // comctl32 v6. Cargo does not apply manifest workarounds to lib
    // UNIT-test targets (only integration tests), so the loader would bind
    // the ancient comctl32 and abort with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139) before main runs — while BINS cannot take a second
    // manifest either (tauri-build's resource.lib already embeds one,
    // CVT1100). Dialogs never execute inside unit tests, so compile the
    // dialog chain out of test builds; production builds are unchanged.
    #[cfg(test)]
    {
        let _ = &app;
        Err("workspace picking is unavailable in test builds".into())
    }
    #[cfg(not(test))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog().file().pick_folder(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(Some(p)) => Ok(Some(p)),
            Ok(None) => Ok(None),
            Err(_) => Ok(None),
        }
    }
}

#[tauri::command]
pub fn ui_workspace_add(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    path: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let ws = Workspace::open(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let name = ws.display_name();
    let display = ws.root().to_string_lossy().into_owned();
    let active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("workspace cannot be changed while a task is active".into());
    }
    let mut slot_guard = slot.0.lock().unwrap();
    let id = settings
        .get()
        .workspaces
        .into_iter()
        .find(|workspace| workspace.path == display)
        .map(|workspace| workspace.id)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    settings.patch(|s| {
        if !s.workspaces.iter().any(|w| w.path == display) {
            s.workspaces.push(crate::settings::WorkspaceEntry {
                id: id.clone(),
                name: name.clone(),
                path: display.clone(),
            });
        }
        s.active_workspace_id = Some(id.clone());
    })?;
    *slot_guard = Some(ws);
    Ok(json!({"name": name, "path": display}))
}

#[tauri::command]
pub fn ui_workspace_list(
    webview: Webview,
    settings: State<'_, SettingsStore>,
) -> Result<Value, String> {
    guard(&webview)?;
    let s = settings.get();
    Ok(json!({"workspaces": s.workspaces, "active": s.active_workspace_id}))
}

#[tauri::command]
pub fn ui_workspace_use(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    term: State<'_, TermState>,
    id: String,
) -> Result<(), String> {
    guard(&webview)?;
    let active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("workspace cannot be changed while a task is active".into());
    }
    let mut slot_guard = slot.0.lock().unwrap();
    let s = settings.get();
    let entry = s
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    let ws = Workspace::open(std::path::Path::new(&entry.path)).map_err(|e| e.to_string())?;
    // A PTY is bound to the workspace root it was spawned in. Never leave a
    // shell silently attached to the previous project after a switch. Only
    // kill when the root actually changes (re-selecting the active project
    // must not terminate a running terminal).
    let changed = slot_guard
        .as_ref()
        .map(|old| old.root() != ws.root())
        .unwrap_or(false);
    if changed {
        term.kill_all();
    }
    settings.patch(|st| st.active_workspace_id = Some(id))?;
    *slot_guard = Some(ws);
    Ok(())
}

#[tauri::command]
pub fn ui_workspace_remove(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    term: State<'_, TermState>,
    id: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("workspace cannot be changed while a task is active".into());
    }
    let mut slot_guard = slot.0.lock().unwrap();
    let s = settings.get();
    let entry = s
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .ok_or("workspace not found")?;
    settings.patch(|st| {
        st.workspaces.retain(|w| w.id != id);
        if st.active_workspace_id.as_deref() == Some(id.as_str()) {
            st.active_workspace_id = None;
        }
    })?;
    // If this workspace is open in the slot, close it first (tools require a
    // workspace, so a stale open slot would keep accepting AI calls).
    // Lock once and compare canonical paths to avoid stale aliases.
    let matches = slot_guard
        .as_ref()
        .map(|ws| ws.root() == std::path::Path::new(&entry.path))
        .unwrap_or(false);
    if matches {
        // Removing the active project must not leave its shell running with a
        // working directory that the UI can no longer display or switch away
        // from.
        term.kill_all();
        *slot_guard = None;
    }
    Ok(json!({"removed": id, "path": entry.path}))
}

#[tauri::command]
pub fn ui_workspace_rename(
    webview: Webview,
    settings: State<'_, SettingsStore>,
    id: String,
    name: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let clean = name.trim();
    if clean.is_empty() || clean.len() > 80 || clean.contains('\\') || clean.contains('/') {
        return Err("display name must be 1..=80 chars with no path separators".into());
    }
    settings.patch(|st| {
        if let Some(w) = st.workspaces.iter_mut().find(|w| w.id == id) {
            w.name = clean.to_string();
        }
    })?;
    let saved = settings.get();
    if saved.workspaces.iter().any(|w| w.id == id) {
        Ok(json!({"id": id, "name": clean}))
    } else {
        Err("workspace not found".into())
    }
}

#[tauri::command]
pub fn ui_workspace_open_in_explorer(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    id: Option<String>,
) -> Result<(), String> {
    guard(&webview)?;
    let path = match id {
        Some(id) => settings
            .get()
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .ok_or("workspace not found")?
            .path
            .clone(),
        None => ws_from(&slot)?.root().to_string_lossy().into_owned(),
    };
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Upper bound on entries returned for one directory. The native explorer loads
/// children lazily, so a capped folder stays responsive; the cap is now applied
/// AFTER sorting (see `list_workspace_dir`) and reported to the UI.
const TREE_ENTRY_LIMIT: usize = 400;

/// List one workspace directory for the native explorer.
///
/// Previously this stopped reading after 400 entries in OS `read_dir` order and
/// only THEN sorted, so which entries disappeared from a large folder was
/// arbitrary. Sorting first makes the visible page deterministic (directories
/// first, then names). Per-entry read errors are counted instead of silently
/// dropped, and `truncated`/`limit`/`unreadable` let the UI state the truth
/// instead of implying the folder is complete.
fn list_workspace_dir(dir: &std::path::Path, rel_path: &str) -> Result<Value, String> {
    let mut listing: Vec<(String, bool, String)> = Vec::new();
    let mut unreadable = 0usize;
    for entry in std::fs::read_dir(dir)
        .map_err(|error| format!("Could not read directory: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // Fail closed for unknown types: only a confirmed directory is
        // expandable; anything else opens through the file-preview path.
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let child = if rel_path.is_empty() || rel_path == "." {
            name.clone()
        } else {
            format!("{}/{}", rel_path.trim_end_matches('/'), name)
        };
        listing.push((name, is_dir, child));
    }
    listing.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let truncated = listing.len() > TREE_ENTRY_LIMIT;
    listing.truncate(TREE_ENTRY_LIMIT);
    let entries: Vec<Value> = listing
        .into_iter()
        .map(|(name, dir, path)| json!({"name": name, "dir": dir, "path": path}))
        .collect();
    Ok(json!({
        "path": rel_path,
        "entries": entries,
        "truncated": truncated,
        "limit": TREE_ENTRY_LIMIT,
        "unreadable": unreadable,
    }))
}

#[tauri::command]
pub fn ui_tree(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    path: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    let dir = if path.is_empty() {
        ws.root().to_path_buf()
    } else {
        ws.resolve(&path).map_err(|e| e.to_string())?
    };
    list_workspace_dir(&dir, &path)
}

const FILE_PREVIEW_CAP_BYTES: usize = 30 * 1024;
const FILE_PREVIEW_LINE_LIMIT: usize = 300;
/// Manual edits from the native editor are text-only and bounded; larger
/// rewrites belong to the agent's chunked `write_file` tool.
const FILE_EDIT_MAX_BYTES: usize = 1024 * 1024;

/// Extensions the native viewer may read as text AND the editor may write.
/// One list keeps reading and writing in lock-step: anything the editor can
/// open it can save, and nothing else.
fn is_text_source_extension(extension: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "md"
            | "markdown"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "xml"
            | "csv"
            | "log"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "html"
            | "css"
            | "scss"
            | "sh"
            | "py"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "sql"
            | "ps1"
            | "bat"
            | "ini"
            | "conf"
            | "vue"
            | "svelte"
            | "mdx"
            | "graphql"
            | "proto"
            | "lock"
    )
}

fn read_workspace_file_preview(
    ws: &Workspace,
    rel_path: &str,
    offset: usize,
) -> Result<Value, String> {
    let path = ws
        .resolve(rel_path)
        .map_err(|_| "Path is outside the selected workspace or invalid".to_string())?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("Could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("Select a file, not a directory or special file".into());
    }
    let extension = path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_text_source_extension(extension.as_str()) {
        return Err(format!(
            "Preview supports text/source files; .{extension} is not a supported text type. Use Attach files for PDF/DOCX extraction."
        ));
    }
    let outcome = crate::tools::read_file(
        ws,
        &json!({"path": rel_path, "offset": offset, "limit": FILE_PREVIEW_LINE_LIMIT}),
        FILE_PREVIEW_CAP_BYTES,
    );
    if !outcome.ok {
        return Err(outcome.output);
    }
    let lines_read = outcome
        .output
        .rsplit_once('[')
        .and_then(|(_, note)| note.strip_suffix(']'))
        .and_then(|note| note.split_whitespace().next())
        .and_then(|count| count.parse::<usize>().ok())
        .unwrap_or(0);
    let next_offset = offset.saturating_add(FILE_PREVIEW_LINE_LIMIT);
    let has_more = if outcome.output.contains("output truncated") {
        true
    } else if lines_read == FILE_PREVIEW_LINE_LIMIT {
        let probe = crate::tools::read_file(
            ws,
            &json!({"path": rel_path, "offset": next_offset, "limit": 1}),
            1,
        );
        probe.ok
            && probe
                .output
                .rsplit_once('[')
                .and_then(|(_, note)| note.strip_suffix(']'))
                .and_then(|note| note.split_whitespace().next())
                .and_then(|count| count.parse::<usize>().ok())
                .unwrap_or(0)
                > 0
    } else {
        false
    };
    // The reader appends an AI-facing "[N lines read from line X]" trailer for
    // its tool results. The preview shows plain file content, so the trailer is
    // removed here and reported as structured fields instead.
    let content = match outcome.output.rsplit_once('[') {
        Some((body, note))
            if note.trim_end().ends_with(']') && note.contains("lines read from line") =>
        {
            body.trim_end().to_string()
        }
        _ => outcome.output.clone(),
    };
    Ok(json!({
        "path": ws.display(&path),
        "content": content,
        "offset": offset,
        "line_limit": FILE_PREVIEW_LINE_LIMIT,
        "size_bytes": metadata.len(),
        "has_more": has_more,
        "lines_read": lines_read,
        "start_line": offset + 1,
    }))
}

#[tauri::command]
pub fn ui_file_preview(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    path: String,
    offset: Option<usize>,
) -> Result<Value, String> {
    guard(&webview)?;
    read_workspace_file_preview(&ws_from(&slot)?, &path, offset.unwrap_or(0))
}

/// Exact on-disk text for the native editor.
///
/// The paged preview is lossy on purpose (it trims the trailing newline and
/// caps the page), so it must never be round-tripped back to disk. The editor
/// starts from this exact text, which makes "no changes" mean no changes and
/// keeps line endings intact on save.
fn read_workspace_file_text(ws: &Workspace, rel_path: &str) -> Result<Value, String> {
    let path = ws
        .resolve(rel_path)
        .map_err(|_| "Path is outside the selected workspace or invalid".to_string())?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("Could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("Select a file, not a directory or special file".into());
    }
    let extension = path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_text_source_extension(extension.as_str()) {
        return Err(format!(
            "The editor supports text/source files; .{extension} is not a supported text type."
        ));
    }
    if metadata.len() as usize > FILE_EDIT_MAX_BYTES {
        return Err(format!(
            "This file is larger than the {} KB editing limit. Read it in pages, or ask the agent to change it.",
            FILE_EDIT_MAX_BYTES / 1024
        ));
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("Could not read file: {error}"))?;
    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return Err("This file is binary on disk; the editor only writes text.".into());
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(json!({
        "path": ws.display(&path),
        "content": content,
        "bytes": metadata.len(),
    }))
}

#[tauri::command]
pub fn ui_file_text(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    path: String,
) -> Result<Value, String> {
    guard(&webview)?;
    read_workspace_file_text(&ws_from(&slot)?, &path)
}

/// Save an edit made in the native code view.
///
/// This is deliberately NOT a second filesystem permission system: the path
/// goes through the same `Workspace::resolve` confinement the agent tools use,
/// the same text-type allowlist as the viewer, and the UI shows the diff before
/// calling it. Only existing, text, complete files can be written here; new
/// files and large rewrites stay with the agent's approval-gated tools.
///
/// Checkpoint 4 (Phase 3P) — save integrity:
///   * optimistic concurrency: `expected_original` must byte-match the on-disk
///     file AT SAVE TIME. The frontend passes the exact baseline its reviewed
///     diff was computed against; if the file changed externally in the
///     meantime the save is refused and a `CONFLICT::` error is returned.
///   * the authoritative check and the replacement happen inside this single
///     backend operation: the baseline is rechecked immediately before the
///     atomic rename, as close to the replacement as std::fs permits (see the
///     TOCTOU note below).
///   * durability: the temp sibling is fully written and fsynced
///     (`File::sync_all`) BEFORE the rename, so a failed write cannot leave a
///     half-written destination; the original file is preserved on failure.
///     This is FILE-CONTENT synchronization only: it does not guarantee that
///     the directory entry (the rename) survives a sudden power loss — see the
///     durability note below.
///   * verification: after a successful replacement the file is read back and
///     the exact bytes are compared with the intended content; success is only
///     returned when that verification passes.
///   * temp-file safety: every operation creates its OWN temp sibling with a
///     per-operation unique name and `create_new` (exclusive create), so two
///     concurrent saves can never write into or delete each other's temp file,
///     and cleanup only ever removes the temp path this call created.
///
/// Baseline is mandatory (CP4 closeout): `expected_original` is not optional.
/// Every caller must supply the exact baseline its reviewed diff was computed
/// against — a baseline-free replacement would be an external-modification
/// bypass, so there is none.
///
/// Durability note (CP4 closeout, precise):
///   * ATOMIC REPLACEMENT: the destination is swapped as one rename; readers
///     see either the old file or the new file, never a partial file.
///   * FILE-CONTENT SYNCHRONIZATION: `sync_all()` on the temp file flushes its
///     data (and metadata) to the device before the swap, so the new bytes are
///     on stable storage before the old name stops pointing at the old file.
///   * DIRECTORY-ENTRY DURABILITY: NOT established. Making the rename itself
///     power-loss durable requires fsyncing the DIRECTORY, which std::fs cannot
///     do portably on Windows (no directory handle sync). After a sudden power
///     loss the rename may therefore be lost (the old file returns intact) even
///     though the new file's contents were synced. Neelima does not claim
///     guaranteed power-loss durability of the name swap.
///
/// TOCTOU note: without exclusive file locking (which would make Neelima hold
/// locks its workspace may share with agents/other editors), a file can change
/// between the last baseline recheck and the rename syscall. On Windows
/// `std::fs::rename` maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which
/// atomically replaces the destination, so no partial destination is possible;
/// the residual race window is only the instant between the pre-rename recheck
/// and that syscall. That race is NOT eliminated; it is bounded and documented.
/// The read-back verification after the rename is the honesty check for the
/// caller, not a lock.
const SAVE_CONFLICT_PREFIX: &str = "CONFLICT::";

/// Per-destination-path serialization for Neelima's OWN saves (CP4 final
/// concurrency verification).
///
/// The baseline recheck and the atomic replacement are separate syscalls: two
/// saves of the same file could both observe the same baseline and then both
/// replace the destination, so a save based on stale contents would succeed
/// silently. One mutex per CANONICAL destination path is held for the whole
/// read-baseline → replace → verify sequence, so a second save of the same file
/// waits and then sees the winner's bytes as its baseline (and conflicts).
///
/// This does NOT lock the file against external processes (no exclusive file
/// locking is taken), so the documented compare-to-rename race with outside
/// writers is unchanged.
///
/// The registry stores WEAK references, so it tracks LIVE saves instead of every
/// file ever saved. An entry is upgraded while it is alive; expired entries are
/// dropped on the next insertion while the registry mutex is held. The invariant
/// that prevents split locks: a save takes its `Arc` from this map BEFORE any
/// baseline work and keeps it until the function returns, so while any save is
/// in flight its `Weak` always upgrades to the same mutex. Expired entries can
/// only be removed when no operation holds that path's `Arc`.
static SAVE_PATH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

/// Keyed by the canonical destination identity, so different spellings or
/// symlinked paths to the same file serialize together. `Workspace::resolve`
/// still runs first: this can never expand what the workspace may write.
///
/// The registry guard is always released before the caller waits on the
/// per-path mutex; no lock is held across the actual save.
fn save_path_lock(path: &std::path::Path) -> Arc<Mutex<()>> {
    let identity = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let registry = SAVE_PATH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut entries = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(live) = entries.get(&identity).and_then(Weak::upgrade) {
        // Same mutex as every other in-flight save of this path.
        return live;
    }
    // No live lock for this path. Reclaim every expired entry while still
    // holding the registry mutex; entries with a live `Arc` are kept, so a
    // concurrent save can never be moved onto a different mutex.
    entries.retain(|_, weak| weak.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    entries.insert(identity, Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
fn save_lock_entry_is_live(path: &std::path::Path) -> Option<bool> {
    let identity = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let registry = SAVE_PATH_LOCKS.get()?;
    let entries = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries
        .get(&identity)
        .map(|weak| weak.strong_count() > 0)
}

// Test-only deterministic fault injection for the temp-write path (CP4
// closeout). Thread-local so parallel tests cannot influence each other; it is
// compiled out of production builds entirely.
//   0 = off
//   1 = fail BEFORE the temp file is created
//   2 = fail AFTER the temp file exists with partial bytes, so the cleanup path
//       has a real artifact to remove
#[cfg(test)]
thread_local! {
    static INJECT_TEMP_WRITE_FAILURE: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

fn write_workspace_file(
    ws: &Workspace,
    rel_path: &str,
    content: &str,
    expected_original: &str,
) -> Result<Value, String> {
    let path = ws
        .resolve(rel_path)
        .map_err(|_| "Path is outside the selected workspace or invalid".to_string())?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("Could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("Select a file, not a directory or special file".into());
    }
    let extension = path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_text_source_extension(extension.as_str()) {
        return Err(format!(
            "The editor saves text/source files only; .{extension} is not a supported text type."
        ));
    }
    if content.len() > FILE_EDIT_MAX_BYTES {
        return Err(format!(
            "Edits are limited to {} KB per save; split the change.",
            FILE_EDIT_MAX_BYTES / 1024
        ));
    }
    // Serialize Neelima's own saves of this destination for the whole
    // read-baseline → replace → verify sequence. A concurrent save of the same
    // file blocks here and, once this one completes, re-reads the WINNER's
    // bytes, so its stale baseline is refused instead of silently replacing
    // the first success. External writers are not serialized (see the
    // compare-to-rename note above). The guard is released on every return path.
    let destination_lock = save_path_lock(&path);
    let _save_guard = destination_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let original = std::fs::read(&path).map_err(|error| format!("Could not read file: {error}"))?;
    // Refuse to rewrite a file that is binary on disk even if the name looks
    // like text: the editor would replace real bytes with its lossy view.
    if original.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return Err("This file is binary on disk; the editor only writes text.".into());
    }
    if original == content.as_bytes() {
        return Err("No changes to save".into());
    }
    // Write to a sibling temp file, flush it to disk, and rename — a failed
    // write cannot leave a half-written source file behind. The pre-save
    // baseline recheck below happens against the file that is on disk RIGHT
    // NOW, immediately before the replacement.
    //
    // The temp name is UNIQUE PER OPERATION and created with `create_new`, so
    // two saves of the same file can never collide with (overwrite) or delete
    // each other's temp file; every cleanup below removes only `temp`.
    let file_name = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("edit");
    let temp = path.with_file_name(format!(
        ".{file_name}.{}.neelima-tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let temp_write = || -> std::io::Result<()> {
        #[cfg(test)]
        if INJECT_TEMP_WRITE_FAILURE.with(|flag| flag.get()) == 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected temp-create failure (test)",
            ));
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content.as_bytes())?;
        // A mid-write fault: the temp file exists with partial content and must
        // be removed by the caller without ever touching the destination.
        #[cfg(test)]
        if INJECT_TEMP_WRITE_FAILURE.with(|flag| flag.get()) == 2 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected temp-write failure (test)",
            ));
        }
        // Durability: the temp file must hold the COMPLETE content before it
        // is allowed to replace the original. (File-content sync; see the
        // directory-entry durability note on this function.)
        file.sync_all()?;
        Ok(())
    };
    if let Err(error) = temp_write() {
        std::fs::remove_file(&temp).ok();
        return Err(format!("Could not write file: {error}"));
    }
    // The authoritative external-modification check: re-read the destination
    // AFTER the temp write and immediately BEFORE the rename. Compare with the
    // exact reviewed baseline (mandatory). A separate frontend check followed
    // by an unchecked write would be a TOCTOU toy; this check is in the
    // backend, one syscall away from the atomic replacement.
    let baseline: &[u8] = expected_original.as_bytes();
    let unchanged = std::fs::read(&path)
        .map(|current| current == baseline)
        .unwrap_or(false);
    if !unchanged {
        std::fs::remove_file(&temp).ok();
        return Err(format!(
            "{SAVE_CONFLICT_PREFIX}{} changed on disk since it was opened, so applying the review would silently overwrite external changes. Reload the file and review again against the latest contents.",
            ws.display(&path)
        ));
    }
    // Windows: std::fs::rename = MoveFileExW with MOVEFILE_REPLACE_EXISTING —
    // an atomic same-volume replacement. It fails (no replacement) when the
    // destination has the read-only attribute or is locked, so the original is
    // preserved in those failure cases. Unix: rename(2) atomically replaces.
    if let Err(error) = std::fs::rename(&temp, &path) {
        std::fs::remove_file(&temp).ok();
        return Err(format!("Could not replace file: {error}"));
    }
    // Read-back verification: success is reported only when the bytes now on
    // disk are exactly the intended content. On a mismatch (rename succeeded
    // but the replacement is not what we wrote — storage fault territory) the
    // previous contents are restored atomically from memory and the caller
    // receives an honest failure.
    let written_back =
        std::fs::read(&path).map_err(|error| format!("Could not verify the saved file: {error}"));
    let verification_failed = match &written_back {
        Ok(bytes) => bytes.as_slice() != content.as_bytes(),
        Err(_) => true,
    };
    if verification_failed {
        let restore = || -> std::io::Result<()> {
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(original.as_slice())?;
            file.sync_all()?;
            std::fs::rename(&temp, &path)?;
            Ok(())
        };
        let restored = restore().is_ok();
        std::fs::remove_file(&temp).ok();
        let detail = match written_back {
            Ok(_) => "saved bytes differ from the reviewed content".to_string(),
            Err(error) => error,
        };
        return Err(format!(
            "The save did not verify against the disk ({detail}); {} — do not trust the file until re-opened.",
            if restored {
                "the previous contents were restored"
            } else {
                "the previous contents could NOT be restored"
            }
        ));
    }
    Ok(json!({
        "path": ws.display(&path),
        "bytes": content.len(),
        "lines": content.lines().count(),
    }))
}

#[tauri::command]
pub fn ui_file_save(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    path: String,
    content: String,
    // CP4 closeout: MANDATORY. This is the exact baseline the reviewed diff
    // was computed against. There is no baseline-free path: every existing-file
    // edit must prove it was reviewed against the current on-disk contents.
    expected_original: String,
) -> Result<Value, String> {
    guard(&webview)?;
    write_workspace_file(&ws_from(&slot)?, &path, &content, &expected_original)
}

#[tauri::command]
pub fn ui_settings_get(
    webview: Webview,
    settings: State<'_, SettingsStore>,
) -> Result<Settings, String> {
    guard(&webview)?;
    Ok(settings.get())
}

#[tauri::command]
pub fn ui_settings_set(
    webview: Webview,
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    next: Settings,
) -> Result<Settings, String> {
    guard(&webview)?;
    let previous = settings.get();
    let saved = settings.set(next)?;
    if let Err(register_error) = crate::register_hotkey(&app, &saved.hotkey) {
        let settings_restore = settings.set(previous.clone()).err();
        let hotkey_restore = crate::register_hotkey(&app, &previous.hotkey).err();
        let mut error = format!("could not register emergency-stop hotkey: {register_error}");
        if let Some(restore_error) = settings_restore {
            error.push_str(&format!(
                "; could not restore previous settings: {restore_error}"
            ));
        }
        if let Some(restore_error) = hotkey_restore {
            error.push_str(&format!(
                "; could not restore previous hotkey: {restore_error}"
            ));
        }
        return Err(error);
    }
    Ok(saved)
}

#[tauri::command]
pub fn ui_adapters_list(
    webview: Webview,
    adapters: State<'_, AdaptersState>,
) -> Result<Vec<Adapter>, String> {
    guard(&webview)?;
    Ok(adapters.list.lock().unwrap().clone())
}

#[tauri::command]
pub fn ui_adapters_open_folder(app: AppHandle, webview: Webview) -> Result<(), String> {
    guard(&webview)?;
    let dir =
        crate::adapters::adapters_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("could not open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("could not open Finder: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("could not open file manager: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ui_adapter_start_inspector(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    name: String,
    url: String,
) -> Result<(), String> {
    guard(&webview)?;
    let adapter = Adapter {
        id: "inspector-draft".into(),
        name: name.clone(),
        url: url.clone(),
        ..Adapter::default()
    };
    *state.inspector.lock().unwrap() = Some(InspectorSession {
        req_id: String::new(),
        kind: String::new(),
        selectors: Vec::new(),
        name,
        url,
    });
    let profile = "inspector";
    webprov::mount(&app, profile, &adapter, &state).await?;
    webprov::set_visible(&app, &state, true);
    Ok(())
}

#[tauri::command]
pub async fn ui_adapter_capture(
    webview: Webview,
    hub: State<'_, Arc<BridgeHub>>,
    state: State<'_, Arc<WebviewState>>,
    kind: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let app = webview.app_handle().clone();
    let wv = app
        .get_webview(webprov::PROVIDER_LABEL)
        .ok_or("inspector webview not open")?;
    let (req_id, _nonce, rx) = hub.begin();
    {
        let mut ins = state.inspector.lock().unwrap();
        if let Some(i) = ins.as_mut() {
            i.req_id = req_id.clone();
            i.kind = kind.clone();
        }
    }
    let js = format!(
        "window.__LB__ && window.__LB__.call('inspector_start', {:?}, {:?})",
        kind, req_id
    );
    wv.eval(js).map_err(|e| e.to_string())?;
    let v = crate::bridge::BridgeHub::wait(rx, 120_000).await?;
    let selector = v["value"]["selector"].as_str().unwrap_or("").to_string();
    if let Some(i) = state.inspector.lock().unwrap().as_mut() {
        i.selectors.push((kind.clone(), selector.clone()));
    }
    Ok(json!({"kind": kind, "selector": selector}))
}

#[tauri::command]
pub fn ui_adapter_finish_inspector(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    adapters: State<'_, AdaptersState>,
) -> Result<Adapter, String> {
    guard(&webview)?;
    if *state.task_active.lock().unwrap() {
        return Err("cannot replace the provider webview while an agent task is active".into());
    }
    let ins = state
        .inspector
        .lock()
        .unwrap()
        .take()
        .ok_or("no inspector session")?;
    let ins_url = ins.url.clone();
    let selector = |kind: &str| -> String {
        ins.selectors
            .iter()
            .find(|(k, _)| k == kind)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let adapter = Adapter {
        id: format!("user-{}", uuid::Uuid::new_v4().simple()),
        name: ins.name,
        url: ins_url.clone(),
        selectors: crate::adapters::Selectors {
            input: selector("input"),
            send_button: selector("send"),
            stop_button: None,
            messages: selector("assistant")
                .rsplit(' ')
                .next()
                .unwrap_or("main")
                .to_string(),
            new_chat: None,
            logged_in: None,
            logged_out: None,
            user_message: None,
        },
        input: crate::adapters::InputSpec::default(),
        quiet_ms: 2000,
        response_timeout_ms: 300_000,
        built_in: false,
        allowed_domain: crate::webprov::host_of(&ins_url),
        auth_domains: Vec::new(),
        login_url_patterns: Vec::new(),
    };
    let dir =
        crate::adapters::adapters_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", adapter.id));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&adapter).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Hot reload happens via the watcher; also refresh immediately.
    if let Ok(list) = crate::adapters::load_all(&dir) {
        *adapters.list.lock().unwrap() = list;
    }
    webprov::unmount_if_any(&app, &state);
    Ok(adapter)
}

#[tauri::command]
pub async fn ui_providers_login(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    adapters: State<'_, AdaptersState>,
    settings: State<'_, SettingsStore>,
    profile_id: String,
) -> Result<(), String> {
    guard(&webview)?;
    let profiles = settings.get().providers.web;
    let profile = profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or("profile not found")?;
    let adapter = adapters
        .list
        .lock()
        .unwrap()
        .iter()
        .find(|a| a.id == profile.adapter_id)
        .cloned()
        .ok_or("adapter missing for profile")?;
    webprov::mount(&app, &profile_id, &adapter, &state).await?;
    // The user explicitly opened provider sign-in, so reveal the isolated
    // authentication view. Agent sends only mount/use it while hidden.
    webprov::set_visible(&app, &state, true);
    Ok(())
}

#[tauri::command]
pub fn ui_providers_close(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
) -> Result<(), String> {
    guard(&webview)?;
    if *state.task_active.lock().unwrap() {
        return Err("cannot close the provider webview while an agent task is active".into());
    }
    webprov::unmount_if_any(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn ui_provider_clear_session(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    settings: State<'_, SettingsStore>,
    profile_id: String,
) -> Result<(), String> {
    guard(&webview)?;
    if !settings
        .get()
        .providers
        .web
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err("provider profile not found".into());
    }
    webprov::clear_profile_session(&app, &state, &profile_id)
}

/// Step 2 (I): metadata-only snapshot of recent request lifecycles across ALL
/// providers (browser web chats, local runtimes, manual relay): request ID,
/// provider, task/conversation identity, state, timing and coarse error
/// category. There is no field in here that can hold prompt or reply text.
#[tauri::command]
pub fn ui_request_log(
    webview: Webview,
    registry: State<'_, Arc<crate::request::RequestRegistry>>,
) -> Result<Value, String> {
    guard(&webview)?;
    Ok(Value::Array(registry.snapshot()))
}

/// A11: diagnostics for the "can't reach the page" flow in ProviderPane.
#[tauri::command]
pub async fn ui_provider_diagnose(
    webview: Webview,
    app: AppHandle,
    hub: State<'_, Arc<BridgeHub>>,
    state: State<'_, Arc<WebviewState>>,
    adapters: State<'_, AdaptersState>,
    settings: State<'_, SettingsStore>,
) -> Result<Value, String> {
    guard(&webview)?;
    let mounted = {
        let m = state.mounted.lock().unwrap();
        m.as_ref()
            .map(|p| (p.profile_id.clone(), p.adapter_id.clone()))
    };
    if mounted.is_none() {
        return Ok(json!({"mounted": false}));
    }
    let (profile_id, adapter_id) = mounted.unwrap();
    let adapter = adapters
        .list
        .lock()
        .unwrap()
        .iter()
        .find(|a| a.id == adapter_id)
        .cloned();

    // Don't turn a page-load race into two long, silent RPC timeouts. A real
    // connection test requires the injected runtime to have announced ready.
    if !state.page_ready.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(json!({
            "mounted": true,
            "connected": false,
            "status": "loading",
            "message": "The provider page has not finished loading yet. Keep the sign-in window open and test again in a moment.",
            "login_state": "loading",
            "reason": "provider runtime has not reported ready",
            "input_found": false,
            "send_button_found": false,
            "messages_found": false,
        }));
    }

    // Ping the page: a bridge ping alone does NOT mean chat is usable.
    *state.last_bridge_error.lock().unwrap() = None;
    let started = std::time::Instant::now();
    let (req_id, nonce, rx) = hub.begin();
    let ping = {
        let wv = app.get_webview(webprov::PROVIDER_LABEL);
        match wv {
            Some(wv) => {
                let js = format!(
                    "window.__LB__ && window.__LB__.call('ping', null, {:?}, {:?})",
                    req_id, nonce
                );
                match wv.eval(js) {
                    Ok(()) => match crate::bridge::BridgeHub::wait(rx, 8_000).await {
                        Ok(reply)
                            if reply["ok"] == true
                                && reply["value"]
                                    .as_str()
                                    .is_some_and(|value| value.starts_with("pong:")) =>
                        {
                            Some(started.elapsed().as_millis() as u64)
                        }
                        Ok(reply) => {
                            let error = reply["error"]
                                .as_str()
                                .unwrap_or("provider bridge returned an invalid ping response")
                                .to_string();
                            *state.last_bridge_error.lock().unwrap() = Some(error);
                            None
                        }
                        Err(e) => {
                            hub.cancel(&req_id);
                            *state.last_bridge_error.lock().unwrap() = Some(format!("ping: {e}"));
                            None
                        }
                    },
                    Err(e) => {
                        hub.cancel(&req_id);
                        *state.last_bridge_error.lock().unwrap() = Some(format!("ping eval: {e}"));
                        None
                    }
                }
            }
            None => {
                hub.cancel(&req_id);
                None
            }
        }
    };

    if ping.is_none() {
        let reason = state
            .last_bridge_error
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "provider page did not answer the bridge ping".into());
        return Ok(json!({
            "mounted": true,
            "connected": false,
            "status": "unreachable",
            "message": format!("Neelima cannot reach the provider page: {reason}. Reopen the sign-in window and try again."),
            "login_state": "unknown",
            "reason": reason,
            "ping_ms": null,
            "input_found": null,
            "send_button_found": null,
            "messages_found": null,
        }));
    }

    // Deep info from the page (selectors state).
    let (req_id2, nonce2, rx2) = hub.begin();
    let mut input_found = None;
    let mut send_found = None;
    let mut messages_found = None;
    let mut page_login = None;
    let mut page_reason = None;
    let mut page_info_error = None;
    let mut page_info_vis: Option<String> = None;
    let mut page_info_watch: Option<Value> = None;
    let mut page_info_turns: Option<Value> = None;
    let mut page_info_last_len: Option<u64> = None;
    let mut page_info_ms_since_send: Option<u64> = None;
    let mut page_info_layout: Option<String> = None;
    let mut page_info_dom: Option<Value> = None;
    let mut matched_markers: Vec<String> = Vec::new();
    if let Some(wv) = app.get_webview(webprov::PROVIDER_LABEL) {
        let js = format!(
            "window.__LB__ && window.__LB__.call('page_info', null, {:?}, {:?})",
            req_id2, nonce2
        );
        if let Err(e) = wv.eval(js) {
            hub.cancel(&req_id2);
            page_info_error = Some(format!("page_info eval: {e}"));
        } else {
            match crate::bridge::BridgeHub::wait(rx2, 8_000).await {
                Ok(v) if v["ok"] == true => {
                    input_found = v["value"]["input_found"].as_bool();
                    send_found = v["value"]["send_button_found"].as_bool();
                    messages_found = v["value"]["messages_found"].as_bool();
                    page_login = v["value"]["login"]["state"].as_str().map(str::to_owned);
                    page_reason = v["value"]["login"]["reason"].as_str().map(str::to_owned);
                    page_info_vis = v["value"]["visibility_state"].as_str().map(str::to_owned);
                    page_info_watch = Some(v["value"]["watch"].clone());
                    page_info_turns = Some(v["value"]["turns"].clone());
                    page_info_last_len = v["value"]["last_assistant_len"].as_u64();
                    page_info_ms_since_send = v["value"]["ms_since_send"].as_u64();
                    page_info_layout = v["value"]["reply_layout"].as_str().map(str::to_owned);
                    page_info_dom = Some(v["value"]["reply_dom"].clone());
                    matched_markers = v["value"]["markers"]
                        .as_object()
                        .map(|m| {
                            m.iter()
                                .filter(|(_, v)| {
                                    v.as_bool() == Some(true) || v.as_u64().unwrap_or(0) > 0
                                })
                                .map(|(k, _)| k.clone())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                }
                Ok(v) => {
                    hub.cancel(&req_id2);
                    page_info_error = Some(
                        v["error"]
                            .as_str()
                            .unwrap_or("provider bridge returned an invalid page-info response")
                            .to_string(),
                    );
                }
                Err(e) => {
                    hub.cancel(&req_id2);
                    page_info_error = Some(format!("page_info: {e}"));
                }
            }
        }
    } else {
        hub.cancel(&req_id2);
        page_info_error = Some("provider webview disappeared during the test".into());
    }
    let (login, url, reason): (String, String, String) = match &*state.login.lock().unwrap() {
        crate::webprov::LoginState::LoggedIn { url } => {
            ("logged_in".into(), url.clone(), String::new())
        }
        crate::webprov::LoginState::LoggedOut { url } => {
            ("logged_out".into(), url.clone(), String::new())
        }
        crate::webprov::LoginState::Unknown { reason, url } => {
            ("unknown".into(), url.clone(), reason.clone())
        }
        crate::webprov::LoginState::Loading { reason, url } => {
            ("loading".into(), url.clone(), reason.clone())
        }
        crate::webprov::LoginState::Challenge { reason, url } => {
            ("challenge".into(), url.clone(), reason.clone())
        }
    };
    // Prefer page_info's fresh posture; the pushed state can lag during SPA
    // transitions. A ping plus a visible editable composer is the connection
    // criterion. We intentionally don't require a Send button on an empty chat.
    let effective_login = page_login.as_deref().unwrap_or(&login);
    let (status, message, connected): (&str, String, bool) = if let Some(error) =
        page_info_error.as_deref()
    {
        ("unreachable", format!("Neelima reached the provider bridge but could not inspect chat readiness: {error}. Reopen the sign-in window and try again."), false)
    } else if input_found == Some(true) && effective_login == "logged_in" {
        (
            "ready",
            "Connection works. Neelima reached the provider chat and found its message composer."
                .into(),
            true,
        )
    } else if effective_login == "logged_out" {
        ("sign_in_required", "The provider page is reachable, but you need to sign in there before Neelima can use chat.".into(), false)
    } else if effective_login == "challenge" {
        ("verification_required", "The provider requires verification. Complete it in the sign-in window, then test again.".into(), false)
    } else if input_found == Some(false) {
        ("composer_missing", "The provider page is reachable, but its chat composer was not found. Refresh the sign-in window; if this persists, the website adapter may need an update. No prompt was sent.".into(), false)
    } else if input_found == Some(true) {
        // Composer exists but authentication could not be confirmed either way.
        // Surface the page's own reason (e.g. "no authenticated account marker
        // was detected") so the user knows the session is unverified, not ready.
        (
            "unknown",
            format!(
                "The provider page shows a message composer, but Neelima could not confirm a signed-in session. {}. If chat does not work, reopen the sign-in window, complete sign-in there, then test again.",
                page_reason.as_deref().unwrap_or("the page did not report why")
            ),
            false,
        )
    } else {
        ("unknown", "The provider page answered, but Neelima could not confirm a usable signed-in chat. Reopen the sign-in window and test again.".into(), false)
    };
    let report = json!({
        "mounted": true,
        "connected": connected,
        "status": status,
        "message": message,
        "profile": profile_id,
        "adapter": adapter_id,
        "adapter_name": adapter.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        "url": url,
        "auth_domains": adapter.as_ref().map(|a| a.auth_domains.clone()).unwrap_or_default(),
        "login_url_patterns": adapter.as_ref().map(|a| a.login_url_patterns.clone()).unwrap_or_default(),
        "ping_ms": ping,
        "login_state": effective_login,
        "reason": page_info_error.or(page_reason).unwrap_or(reason),
        "input_found": input_found,
        "send_button_found": send_found,
        "messages_found": messages_found,
        "visibility_state": page_info_vis,
        "watch": page_info_watch,
        "turns": page_info_turns,
        "last_assistant_len": page_info_last_len,
        "ms_since_send": page_info_ms_since_send,
        "reply_layout": page_info_layout,
        "reply_dom": page_info_dom,
        "matched_markers": matched_markers,
        "last_bridge_error": *state.last_bridge_error.lock().unwrap(),
        "bridge_log_path": hub.log_path().map(|p| p.display().to_string()),
        "bridge_log_write_error": hub.log_write_error(),
        "bridge_log": hub.events().iter().rev().take(30).rev().cloned().collect::<Vec<_>>(),
        "settings_sample": {
            "adapter_domains": adapter.as_ref().map(|a| a.allowed_domain.clone()).unwrap_or_default(),
            "profile": settings.get().providers.web.iter().find(|p| p.id == profile_id).map(|p| p.name.clone()).unwrap_or_default(),
        },
    });
    log_provider_diagnostic(&report);
    Ok(report)
}

/// Persist sanitized connection diagnostics to the app log (item 6): metadata
/// only — counts, states, timings. Never page text, prompts, or tool args.
pub fn log_provider_diagnostic(report: &Value) {
    let summary = format!(
        "status={} login={} input={} send={} vis={} layout={} watch_target={:?} watch_callbacks={} users={} assistants={} ms_since_send={:?}",
        report["status"].as_str().unwrap_or("?"),
        report["login_state"].as_str().unwrap_or("?"),
        report["input_found"].as_bool().unwrap_or(false),
        report["send_button_found"].as_bool().unwrap_or(false),
        report["visibility_state"].as_str().unwrap_or("?"),
        report["reply_layout"].as_str().unwrap_or("?"),
        report["watch"]["attached_target"].as_str(),
        report["watch"]["callbacks"].as_u64().unwrap_or(0),
        report["turns"]["users"].as_u64().unwrap_or(0),
        report["turns"]["assistants"].as_u64().unwrap_or(0),
        report["ms_since_send"].as_u64(),
    );
    let _ = crate::app_log::write("provider-diagnose", &summary);
}

/// Manual "I'm signed in" override (item 4): the user asserts the embedded
/// session is authenticated after completing sign-in; recorded as LoggedIn.
#[tauri::command]
pub fn ui_provider_mark_signed_in(
    webview: Webview,
    state: State<'_, Arc<WebviewState>>,
) -> Result<(), String> {
    guard(&webview)?;
    let url = match &*state.login.lock().unwrap() {
        crate::webprov::LoginState::LoggedIn { url } => url.clone(),
        crate::webprov::LoginState::LoggedOut { url }
        | crate::webprov::LoginState::Unknown { url, .. }
        | crate::webprov::LoginState::Loading { url, .. }
        | crate::webprov::LoginState::Challenge { url, .. } => url.clone(),
    };
    *state.login.lock().unwrap() = crate::webprov::LoginState::LoggedIn { url };
    state.login_changed.notify_waiters();
    Ok(())
}

/// "Capture current reply" (item 7): one-shot read of the provider page's
/// current reply candidate; delivers it into the reply pipeline if present.
#[tauri::command]
pub async fn ui_capture_reply(
    webview: Webview,
    app: AppHandle,
    hub: State<'_, Arc<BridgeHub>>,
    state: State<'_, Arc<WebviewState>>,
) -> Result<Value, String> {
    guard(&webview)?;
    if !state.page_ready.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(json!({"delivered": false, "reason": "provider page is not ready"}));
    }
    let baseline = state
        .response_baseline
        .load(std::sync::atomic::Ordering::Acquire);
    match crate::webprov::capture_reply_detail(&app, &hub, 8_000).await {
        Ok(Some(detail)) => {
            let text = detail["text"].as_str().unwrap_or("").trim().to_string();
            if detail["has_reply"].as_bool() != Some(true) || text.is_empty() {
                // Persist the structural outline (tags/attribute names/lengths
                // only) so an unrecognised live layout can be fixed from the
                // log instead of another round of selector guessing.
                let outline = serde_json::to_string(&detail["dom"]).unwrap_or_default();
                let _ = crate::app_log::write(
                    "capture-miss",
                    &format!("{} | dom={}", capture_reason(&detail), outline),
                );
                return Ok(json!({
                    "delivered": false,
                    "reason": capture_reason(&detail),
                    "dom": detail["dom"].clone()
                }));
            }
            {
                let mut last = state.last_message.lock().unwrap();
                let seq = last.0.max(baseline) + 1;
                *last = (seq, text.clone());
            }
            state.message_notify.notify_one();
            let _ = app.emit(
                "evt",
                json!({"kind": "assistant-captured", "at_ms": 0, "len": text.len()}),
            );
            Ok(json!({"delivered": true, "len": text.len()}))
        }
        Ok(None) => Ok(json!(
            {"delivered": false, "reason": "the provider page did not answer the capture request — open the provider window and check that the conversation is still open"}
        )),
        Err(e) => Ok(json!({"delivered": false, "reason": e})),
    }
}

/// Why the last capture produced no reply. METADATA ONLY (layout family, turn
/// counts, streaming state) — never page text — so a live "the answer is right
/// there" failure is diagnosable instead of a bare "no reply yet".
fn capture_reason(detail: &Value) -> String {
    let layout = detail["layout"].as_str().unwrap_or("unknown");
    let assistants = detail["assistant_count"].as_u64().unwrap_or(0);
    let users = detail["user_count"].as_u64().unwrap_or(0);
    let streaming = detail["stop_visible"].as_bool() == Some(true);
    let hint = if layout == "none" {
        "; the provider page layout was not recognised at all — this is a markup change, not a missing reply"
    } else if assistants == 0 {
        "; no assistant turn was found in the page DOM"
    } else if streaming {
        "; the provider is still generating"
    } else {
        "; the assistant turn was found but carried no text"
    };
    // Compact structural evidence (tag/attribute NAMES only, never page text):
    // this is what makes the next report actionable instead of another guess.
    let shape = dom_shape(detail);
    format!(
        "no complete reply is visible on the provider page yet (layout: {layout}, assistant turns: {assistants}, user turns: {users}){hint}{shape}"
    )
}

/// ` — newest block: div.markdown.prose (len 0); ancestors: main > div.flex`
fn dom_shape(detail: &Value) -> String {
    let block = detail["dom"]["blocks"]
        .as_array()
        .and_then(|b| b.last())
        .cloned()
        .unwrap_or(Value::Null);
    if block.is_null() {
        return String::new();
    }
    let tag = block["tag"].as_str().unwrap_or("?");
    let len = block["text_len"].as_u64().unwrap_or(0);
    let mut label = tag.to_string();
    if let Some(attrs) = block["attrs"].as_array() {
        for attr in attrs {
            let attr = attr.as_str().unwrap_or("");
            // Keep only the class hint: identifiers can carry account or chat
            // names, so data-* values stay in the log, not the chat card.
            if let Some(classes) = attr.strip_prefix("class=") {
                label.push('.');
                label.push_str(classes);
                break;
            }
        }
    }
    let chain = detail["dom"]["chain"]
        .as_array()
        .map(|levels| {
            levels
                .iter()
                .take(4)
                .map(|l| l["tag"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
                .join(" > ")
        })
        .unwrap_or_default();
    if chain.is_empty() {
        format!(" — newest block: {label} (len {len})")
    } else {
        format!(" — newest block: {label} (len {len}); ancestors: {chain}")
    }
}

/// The harmless prompt used by the one-click READY check (Phase I).
pub const PROVIDER_READY_PROMPT: &str =
    "For this connectivity check, reply with exactly READY. Do not use tools.";

/// One-click connectivity check for a browser provider: sends the harmless
/// READY prompt through the REAL send/watch pipeline and returns the captured
/// reply, so live verification is evidence from the app instead of a guess.
/// It does not start an agent task, touch the workspace, or resend on failure.
#[tauri::command]
pub async fn ui_provider_probe(
    webview: Webview,
    app: AppHandle,
    provider_id: String,
) -> Result<Value, String> {
    guard(&webview)?;
    // Resolve managed state here instead of taking nine command arguments.
    let active: State<'_, ActiveAgent> = app.state();
    let settings: State<'_, SettingsStore> = app.state();
    let adapters: State<'_, AdaptersState> = app.state();
    let state: State<'_, Arc<WebviewState>> = app.state();
    let hub: State<'_, Arc<BridgeHub>> = app.state();
    let relay: State<'_, Arc<crate::providers::RelaySlot>> = app.state();
    if active.get().is_some() {
        return Err("a task is running — stop it before running the READY check".into());
    }
    if !provider_id.starts_with("web:") {
        return Err("the READY check is available for browser providers only".into());
    }
    let settings = settings.get();
    let mut provider = build_provider(
        &app,
        &settings,
        &adapters,
        state.inner(),
        hub.inner(),
        relay.inner(),
        &provider_id,
    )?;
    let Provider::Web(w) = &mut provider else {
        return Err("the READY check is available for browser providers only".into());
    };
    // Bound the probe: a silent page must not hold the check for the full
    // provider deadline (default 7 minutes).
    w.adapter.response_timeout_ms = w.adapter.response_timeout_ms.min(90_000);
    // Keep the provider webview alive for the duration of the check.
    *state.task_active.lock().unwrap() = true;
    let started = std::time::Instant::now();
    let outcome = async {
        w.send(
            "neelima-ready-check",
            "neelima-ready-check",
            PROVIDER_READY_PROMPT,
            false,
        )
        .await
        .map_err(|e| e.message())?;
        w.wait_reply(Arc::new(tokio::sync::Notify::new())).await
    }
    .await;
    *state.task_active.lock().unwrap() = false;
    match outcome {
        Ok(reply) => {
            let request_id = w.state.active_request.lock().unwrap().clone();
            Ok(json!({
                "ok": true,
                "ready": reply.trim().eq_ignore_ascii_case("READY"),
                "reply": reply,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "request_id": request_id,
            }))
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn ui_providers_list(
    webview: Webview,
    settings: State<'_, SettingsStore>,
    adapters: State<'_, AdaptersState>,
) -> Result<Value, String> {
    guard(&webview)?;
    let s = settings.get();
    let list = adapters.list.lock().unwrap().clone();
    Ok(json!({
        "web": s.providers.web,
        "ollama": s.providers.ollama,
        "lmstudio": s.providers.lmstudio,
        "adapters": list,
    }))
}

#[tauri::command]
pub async fn ui_models_local(
    webview: Webview,
    settings: State<'_, SettingsStore>,
    kind: String,
) -> Result<Vec<String>, String> {
    guard(&webview)?;
    let s = settings.get();
    match kind.as_str() {
        "ollama" => {
            let url = s
                .providers
                .ollama
                .as_ref()
                .map(|o| o.url.clone())
                .unwrap_or_else(|| "http://localhost:11434".into());
            list_models(LocalKind::Ollama, &url).await
        }
        "lmstudio" => {
            let url = s
                .providers
                .lmstudio
                .as_ref()
                .map(|o| o.url.clone())
                .unwrap_or_else(|| "http://localhost:1234".into());
            list_models(LocalKind::LmStudio, &url).await
        }
        _ => Err("unknown local provider".into()),
    }
}

/// Step 3 preview: run the exact selection the send path would run, so the list
/// the user inspects and vetoes is the list that is attached to the prompt.
/// Returns metadata only (paths, line ranges, sizes) — never file contents.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ui_context_preview(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    history: State<'_, Arc<HistoryStore>>,
    prompt: String,
    provider_id: String,
    exclude: Vec<String>,
    task_id: Option<String>,
) -> Result<Value, String> {
    guard(&webview)?;
    let settings = settings.get();
    let ws = ws_from(&slot)?;
    let kind = context_kind_for(&settings, &provider_id)?;
    let prior_prompts: Vec<String> = match task_id.as_deref() {
        Some(task_id) => history
            .read_transcript(task_id, 100)?
            .into_iter()
            .filter(|e| e.kind == "user_prompt")
            .map(|e| e.text)
            .collect(),
        None => Vec::new(),
    };
    let prompt: String = prompt.chars().take(20_000).collect();
    let query = crate::context::query_for(&prompt, &prior_prompts);
    let sel = crate::context::select_for(
        &ws,
        &query,
        &settings,
        kind,
        &crate::context::Options::sanitized(true, exclude),
    );
    Ok(json!({
        "enabled": settings.context.enabled,
        "budget_bytes": sel.budget_bytes,
        "bytes": sel.bytes,
        "considered": sel.considered,
        "truncated": sel.truncated,
        "scan_capped": sel.scan_capped,
        "omitted": sel.omitted,
        "excluded_by_user": sel.excluded_by_user,
        "skipped": sel.skipped,
        "files": sel.files,
    }))
}

fn context_kind_for(
    settings: &Settings,
    provider_id: &str,
) -> Result<crate::context::Kind, String> {
    if let Some(profile_id) = provider_id.strip_prefix("web:") {
        return if settings.providers.web.iter().any(|p| p.id == profile_id) {
            Ok(crate::context::Kind::Web)
        } else {
            Err("profile not found".into())
        };
    }
    match provider_id {
        "ollama" | "lmstudio" => Ok(crate::context::Kind::Local),
        "manual" => Ok(crate::context::Kind::Manual),
        other => Err(format!("unknown provider '{other}'")),
    }
}

/// Tauri commands must take their State/params as individual arguments, so
/// >7 args is normal here; the clippy gate exempts command entry points.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ui_task_start(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    adapters: State<'_, AdaptersState>,
    history: State<'_, Arc<HistoryStore>>,
    webview_state: State<'_, Arc<WebviewState>>,
    hub: State<'_, Arc<BridgeHub>>,
    relay: State<'_, Arc<crate::providers::RelaySlot>>,
    active: State<'_, ActiveAgent>,
    prompt: String,
    provider_id: String,
    skill_ids: Vec<String>,
    skill_budget: usize,
    request_id: String,
    context: Option<crate::context::Options>,
) -> Result<String, String> {
    guard(&webview)?;
    if request_id.len() != 32 || !request_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid task start request ID".into());
    }
    let mut active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("a task is already running — stop it first".into());
    }
    // Step 3: the composer may disable context or veto individual files. The
    // list can only remove files; the backend still decides what is read.
    let context_options = context
        .map(|c| crate::context::Options::sanitized(c.enabled, c.exclude))
        .unwrap_or_default();
    let ws = ws_from(&slot)?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let app_skills = config_dir.join("skills");
    let workspace_skills = ws.root().join(".neelima").join("skills");
    crate::skills::validate_root_under(&config_dir, &app_skills)?;
    crate::skills::validate_root_under(ws.root(), &workspace_skills)?;
    let skill_context = crate::skills::task_context(
        &app_skills,
        Some(&workspace_skills),
        &skill_ids,
        skill_budget,
    )?;
    let settings_snapshot = settings.get();
    let provider = build_provider(
        &app,
        &settings_snapshot,
        &adapters,
        webview_state.inner(),
        hub.inner(),
        relay.inner(),
        &provider_id,
    )?;

    let task_id = uuid::Uuid::new_v4().simple().to_string();
    let response_task_id = task_id.clone();
    let conversation_id = task_id.clone();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(AgentShared {
        cmd_tx,
        cmd_rx: std::sync::Mutex::new(Some(cmd_rx)),
        state: std::sync::Mutex::new(crate::agent::AgentState::Idle),
        task_id: std::sync::Mutex::new(Some(task_id.clone())),
    });
    *active_guard = Some(shared.clone());

    let input = AgentInput {
        app: app.clone(),
        task_id,
        conversation_id,
        prompt,
        skill_context,
        context: context_options,
        provider,
        ws,
        settings: settings_snapshot,
        history: history.inner().clone(),
        webview_state: webview_state.inner().clone(),
        shared,
        prior_entries: Vec::new(),
    };
    let _ = app.emit(
        crate::agent::EVT,
        json!({"kind":"task-started", "task_id":response_task_id, "request_id":request_id}),
    );
    tauri::async_runtime::spawn(crate::agent::run(input));
    drop(active_guard);
    Ok(response_task_id)
}

fn build_provider(
    app: &AppHandle,
    settings: &Settings,
    adapters: &State<'_, AdaptersState>,
    webview_state: &Arc<WebviewState>,
    hub: &Arc<BridgeHub>,
    relay: &Arc<crate::providers::RelaySlot>,
    provider_id: &str,
) -> Result<Provider, String> {
    if let Some(profile_id) = provider_id.strip_prefix("web:") {
        let profile = settings
            .providers
            .web
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or("profile not found")?;
        let mut adapter = adapters
            .list
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == profile.adapter_id)
            .cloned()
            .ok_or("adapter missing")?;
        if let Some(url) = profile.url.as_deref() {
            crate::adapters::validate_profile_url(url, &adapter.allowed_domain)?;
            adapter.url = url.to_string();
        }
        return Ok(Provider::Web(Box::new(crate::webprov::WebProvider {
            app: app.clone(),
            profile_id: profile_id.to_string(),
            adapter,
            hub: hub.clone(),
            state: webview_state.clone(),
        })));
    }
    match provider_id {
        "ollama" => {
            let cfg = settings
                .providers
                .ollama
                .clone()
                .ok_or("Ollama not configured — open Settings")?;
            Ok(Provider::Local(LocalProvider::new(
                app.clone(),
                LocalKind::Ollama,
                cfg,
            )))
        }
        "lmstudio" => {
            let cfg = settings
                .providers
                .lmstudio
                .clone()
                .ok_or("LM Studio not configured — open Settings")?;
            Ok(Provider::Local(LocalProvider::new(
                app.clone(),
                LocalKind::LmStudio,
                cfg,
            )))
        }
        "manual" => Ok(Provider::Manual(ManualProvider::new(
            app.clone(),
            relay.clone(),
        ))),
        other => Err(format!("unknown provider '{other}'")),
    }
}

#[tauri::command]
pub fn ui_task_stop(webview: Webview, active: State<'_, ActiveAgent>) -> Result<(), String> {
    guard(&webview)?;
    if let Some(shared) = active.get() {
        let _ = shared.cmd_tx.send(AgentCommand::Stop);
    }
    // E4: do NOT kill the user's interactive terminal sessions here — this is
    // the per-task Stop button. The emergency hotkey (lib::emergency_stop)
    // still kills everything, by design.
    Ok(())
}

/// Same argument-shape rationale as ui_task_start.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ui_task_continue(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    settings: State<'_, SettingsStore>,
    adapters: State<'_, AdaptersState>,
    history: State<'_, Arc<HistoryStore>>,
    webview_state: State<'_, Arc<WebviewState>>,
    hub: State<'_, Arc<BridgeHub>>,
    relay: State<'_, Arc<crate::providers::RelaySlot>>,
    active: State<'_, ActiveAgent>,
    task_id: String,
    provider_id: String,
    prompt: String,
    request_id: String,
    context: Option<crate::context::Options>,
) -> Result<String, String> {
    guard(&webview)?;
    if request_id.len() != 32 || !request_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid task start request ID".into());
    }
    let mut active_guard = active.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("a task is already running — stop it first".into());
    }
    if prompt.trim().is_empty() {
        return Err("enter a message to continue this task".into());
    }
    let prior = history.read_transcript(&task_id, 100)?;
    if prior.iter().all(|e| e.kind != "user_prompt") {
        return Err("task has no prompt to continue".into());
    }
    let ws = ws_from(&slot)?;
    let source_task = history.read_task_meta(&task_id)?;
    let conversation_id = if source_task.conversation_id.is_empty() {
        source_task.id.clone()
    } else {
        source_task.conversation_id.clone()
    };
    if source_task.workspace != ws.display_name() {
        return Err("select the workspace used by this task before continuing it".into());
    }
    let settings_snapshot = settings.get();
    let provider = build_provider(
        &app,
        &settings_snapshot,
        &adapters,
        webview_state.inner(),
        hub.inner(),
        relay.inner(),
        &provider_id,
    )?;
    let new_task_id = uuid::Uuid::new_v4().simple().to_string();
    let response_task_id = new_task_id.clone();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(AgentShared {
        cmd_tx,
        cmd_rx: std::sync::Mutex::new(Some(cmd_rx)),
        state: std::sync::Mutex::new(crate::agent::AgentState::Idle),
        task_id: std::sync::Mutex::new(Some(new_task_id.clone())),
    });
    *active_guard = Some(shared.clone());
    let input = AgentInput {
        app: app.clone(),
        task_id: new_task_id,
        conversation_id,
        prompt,
        skill_context: String::new(),
        context: context
            .map(|c| crate::context::Options::sanitized(c.enabled, c.exclude))
            .unwrap_or_default(),
        provider,
        ws,
        settings: settings_snapshot,
        history: history.inner().clone(),
        webview_state: webview_state.inner().clone(),
        shared,
        prior_entries: prior,
    };
    let _ = app.emit(
        crate::agent::EVT,
        json!({"kind":"task-started", "task_id":response_task_id, "request_id":request_id}),
    );
    tauri::async_runtime::spawn(crate::agent::run(input));
    drop(active_guard);
    Ok(response_task_id)
}

#[tauri::command]
pub fn ui_approve(
    webview: Webview,
    active: State<'_, ActiveAgent>,
    decisions: Vec<CallDecision>,
) -> Result<(), String> {
    guard(&webview)?;
    let shared = active.get().ok_or("no running task")?;
    let _ = shared.cmd_tx.send(AgentCommand::Approve(decisions));
    Ok(())
}

#[tauri::command]
pub fn ui_relay_reply(
    webview: Webview,
    relay: State<'_, Arc<crate::providers::RelaySlot>>,
    text: String,
) -> Result<(), String> {
    guard(&webview)?;
    if !relay.deliver(text) {
        return Err("no manual relay is waiting for a reply right now".into());
    }
    Ok(())
}

#[tauri::command]
pub fn ui_webview_mode(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    mode: String,
) -> Result<(), String> {
    guard(&webview)?;
    match mode.as_str() {
        "provider" => webprov::set_visible(&app, &state, true),
        "chat" => {
            // A7: HIDE the webview, never destroy it — the page must not
            // reload when the user flips between Chat and Provider. It is
            // destroyed later only by explicit Close, profile change, or the
            // >10 min idle sweep (never while an agent task runs).
            webprov::hide_if_any(&app, &state);
        }
        other => return Err(format!("unknown mode {other}")),
    }
    Ok(())
}

#[tauri::command]
pub fn ui_webview_rect(
    webview: Webview,
    app: AppHandle,
    state: State<'_, Arc<WebviewState>>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    guard(&webview)?;
    webprov::apply_rect(&app, &state, webprov::Rect { x, y, w, h });
    Ok(())
}

/// Re-fit the UI webview to the actual window (physical pixels). The webview
/// must track window resizes exactly: a stale, larger webview makes viewport
/// units (vw/vh) oversized, which pushed centered modals past the visible
/// window edge. Invoked from the Rust resize handler AND from the frontend's
/// own window-resize listener as an independent safety path.
#[tauri::command]
pub fn ui_sync_viewport(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_window("main") else {
        return Err("main window missing".into());
    };
    let size = window.inner_size().map_err(|e| e.to_string())?;
    if let Some(wv) = app.get_webview("ui") {
        let _ = wv.set_size(Size::Physical(tauri::PhysicalSize::new(
            size.width.max(1),
            size.height.max(1),
        )));
        let _ = wv.set_position(Position::Physical(tauri::PhysicalPosition::new(0, 0)));
    }
    Ok(())
}

#[tauri::command]
pub fn ui_terminal_create(
    webview: Webview,
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    slot: State<'_, WorkspaceSlot>,
) -> Result<u32, String> {
    guard(&webview)?;
    // Hold the slot lock across spawn+registration. A workspace switch either
    // happens entirely before this terminal starts (new cwd) or entirely after
    // it is registered (the switch then kills it); it can never register a
    // session whose cwd belongs to a workspace the UI has already left.
    let slot_guard = slot.0.lock().unwrap();
    let ws = slot_guard
        .as_ref()
        .ok_or("open a workspace before starting the terminal")?;
    let cwd = ws.root().to_path_buf();
    crate::terminal::create(app, settings.get().shell, Some(cwd))
}

#[tauri::command]
pub fn ui_terminal_write(
    webview: Webview,
    term: State<'_, TermState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::write(&term, id, &data)
}

#[tauri::command]
pub fn ui_terminal_resize(
    webview: Webview,
    term: State<'_, TermState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::resize(&term, id, rows, cols)
}

#[tauri::command]
pub fn ui_terminal_kill(
    webview: Webview,
    term: State<'_, TermState>,
    id: u32,
) -> Result<(), String> {
    guard(&webview)?;
    crate::terminal::kill(&term, id)
}

#[tauri::command]
pub fn ui_checkpoint_list(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
) -> Result<Vec<crate::checkpoints::Checkpoint>, String> {
    guard(&webview)?;
    let ws = ws_from(&slot)?;
    crate::checkpoints::list(&ws)
}

#[tauri::command]
pub fn ui_checkpoint_create(
    webview: Webview,
    agent: State<'_, crate::agent::ActiveAgent>,
    slot: State<'_, WorkspaceSlot>,
    label: String,
) -> Result<crate::checkpoints::Checkpoint, String> {
    guard(&webview)?;
    let active_guard = agent.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("cannot create a manual checkpoint while a task is active".into());
    }
    let ws = ws_from(&slot)?;
    crate::checkpoints::snapshot(&ws, &label)
}

#[tauri::command]
pub fn ui_checkpoint_restore_preview(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    agent: State<'_, crate::agent::ActiveAgent>,
    id: String,
) -> Result<crate::checkpoints::RestorePreview, String> {
    guard(&webview)?;
    let active_guard = agent.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("stop the active task before restoring a checkpoint".into());
    }
    let ws = ws_from(&slot)?;
    crate::checkpoints::restore_preview(&ws, &id)
}

#[tauri::command]
pub fn ui_checkpoint_restore(
    webview: Webview,
    slot: State<'_, WorkspaceSlot>,
    agent: State<'_, crate::agent::ActiveAgent>,
    id: String,
) -> Result<crate::checkpoints::RestoreResult, String> {
    guard(&webview)?;
    let active_guard = agent.0.lock().unwrap();
    if active_guard.is_some() {
        return Err("stop the active task before restoring a checkpoint".into());
    }
    let ws = ws_from(&slot)?;
    crate::checkpoints::restore(&ws, &id)
}

#[tauri::command]
pub fn ui_history_tasks(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
) -> Result<Value, String> {
    guard(&webview)?;
    Ok(json!(history.list_tasks(100)))
}

#[tauri::command]
pub fn ui_history_open(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    task_id: String,
) -> Result<Vec<TranscriptEntry>, String> {
    guard(&webview)?;
    history.read_transcript(&task_id, 400)
}

#[tauri::command]
pub fn ui_search_tasks(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    q: String,
) -> Result<Value, String> {
    guard(&webview)?;
    let ql = q.to_lowercase();
    let matches: Vec<_> = history
        .list_tasks(500)
        .into_iter()
        .filter(|m| {
            m.title.to_lowercase().contains(&ql) || m.workspace.to_lowercase().contains(&ql)
        })
        .collect();
    Ok(json!(matches))
}

#[tauri::command]
pub fn ui_task_rename(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    id: String,
    title: String,
) -> Result<Value, String> {
    guard(&webview)?;
    if !crate::history::valid_task_id(&id) {
        return Err("invalid task ID".into());
    }
    let clean = title.trim();
    if clean.is_empty() || clean.len() > 80 {
        return Err("title must be 1..=80 chars".into());
    }
    let dir = history.task_dir(&id);
    if !dir.exists() {
        return Err("task not found".into());
    }
    let meta_path = dir.join("meta.json");
    let bytes = std::fs::read(&meta_path).map_err(|e| e.to_string())?;
    let mut meta: TaskMeta =
        serde_json::from_slice(&bytes).map_err(|e| format!("failed to read task meta: {e}"))?;
    meta.title = clean.to_string();
    history.update_task(&meta).map_err(|e| e.to_string())?;
    Ok(json!({"id": id, "title": clean}))
}

#[tauri::command]
pub fn ui_task_delete(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    id: String,
) -> Result<Value, String> {
    guard(&webview)?;
    history.delete_task(&id)?;
    Ok(json!({"removed": id}))
}

#[tauri::command]
pub fn ui_diff_get(
    webview: Webview,
    history: State<'_, Arc<HistoryStore>>,
    task_id: String,
    entry_id: u64,
) -> Result<Value, String> {
    guard(&webview)?;
    let entries = history.read_transcript(&task_id, 1000)?;
    let entry = entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or("entry not found")?;
    if let Some(d) = &entry.diff {
        return Ok(json!({"path": d.path, "old": d.old, "new": d.new}));
    }
    Err("entry has no diff".into())
}

fn skill_root(
    app: &AppHandle,
    slot: &WorkspaceSlot,
    location: &str,
) -> Result<std::path::PathBuf, String> {
    match location {
        "app" => {
            let base = app.path().app_config_dir().map_err(|e| e.to_string())?;
            let root = base.join("skills");
            crate::skills::validate_root_under(&base, &root)?;
            Ok(root)
        }
        "workspace" => {
            let base = ws_from(slot)?.root().to_path_buf();
            let root = base.join(".neelima").join("skills");
            crate::skills::validate_root_under(&base, &root)?;
            Ok(root)
        }
        _ => Err("skill location must be app or workspace".into()),
    }
}

#[tauri::command]
pub fn ui_skills_list(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
) -> Result<Vec<crate::skills::InstalledSkill>, String> {
    guard(&webview)?;
    let mut skills = crate::skills::installed(&skill_root(&app, &slot, "app")?, "app")?;
    if slot.0.lock().unwrap().is_some() {
        skills.extend(crate::skills::installed(
            &skill_root(&app, &slot, "workspace")?,
            "workspace",
        )?);
    }
    Ok(skills)
}

#[tauri::command]
pub async fn ui_skill_preview(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    repo_url: String,
    branch: String,
    path: String,
    location: String,
) -> Result<crate::skills::SkillPreview, String> {
    guard(&webview)?;
    let root = skill_root(&app, &slot, &location)?;
    crate::skills::preview(&repo_url, &branch, &path, &root).await
}

#[tauri::command]
pub async fn ui_skill_install(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    preview: crate::skills::SkillPreview,
    location: String,
    replace_existing: bool,
) -> Result<crate::skills::InstalledSkill, String> {
    guard(&webview)?;
    let root = skill_root(&app, &slot, &location)?;
    let mut result = crate::skills::install(&preview, &root, replace_existing).await?;
    result.location = location;
    Ok(result)
}

#[tauri::command]
pub fn ui_skill_set_enabled(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    guard(&webview)?;
    crate::skills::set_enabled(&skill_root(&app, &slot, &location)?, &id, enabled)
}

#[tauri::command]
pub fn ui_skill_uninstall(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<(), String> {
    guard(&webview)?;
    crate::skills::uninstall(&skill_root(&app, &slot, &location)?, &id)
}

#[tauri::command]
pub fn ui_skill_reveal(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<(), String> {
    guard(&webview)?;
    crate::skills::safe_skill_id(&id)?;
    let dir = skill_root(&app, &slot, &location)?.join(&id);
    if !dir.join(".neelima-skill.json").is_file() {
        return Err("installed skill not found".into());
    }
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ui_skill_update_preview(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<crate::skills::SkillPreview, String> {
    guard(&webview)?;
    crate::skills::safe_skill_id(&id)?;
    let root = skill_root(&app, &slot, &location)?;
    let list = crate::skills::installed(&root, &location)?;
    let skill = list
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("installed skill not found")?;
    crate::skills::preview(
        &format!("https://github.com/{}", skill.source_repo),
        &skill.branch,
        &skill.source_path,
        &root,
    )
    .await
}

#[tauri::command]
pub fn ui_skill_read(
    webview: Webview,
    app: AppHandle,
    slot: State<'_, WorkspaceSlot>,
    location: String,
    id: String,
) -> Result<String, String> {
    guard(&webview)?;
    crate::skills::read_skill(&skill_root(&app, &slot, &location)?, &id)
}

#[tauri::command]
pub fn ui_open_github(webview: Webview, url: String) -> Result<(), String> {
    guard(&webview)?;
    let parsed = validate_github_url(&url)?;
    #[cfg(windows)]
    {
        crate::procspawn::hidden_std("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::procspawn::hidden_std("open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::procspawn::hidden_std("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_github_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid GitHub URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !matches!(parsed.port(), None | Some(443))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only HTTPS github.com links on the default port can be opened".into());
    }
    Ok(parsed)
}

#[tauri::command]
pub fn ui_app_info(webview: Webview, settings: State<'_, SettingsStore>) -> Result<Value, String> {
    guard(&webview)?;
    Ok(json!({
        "name": "Neelima",
        "version": env!("CARGO_PKG_VERSION"),
        "tauri": tauri::VERSION,
        "settings_path": settings.path().to_string_lossy(),
        "os": std::env::consts::OS,
    }))
}

#[cfg(test)]
mod file_preview_tests {
    use super::{
        read_workspace_file_preview, read_workspace_file_text, write_workspace_file,
        FILE_EDIT_MAX_BYTES,
    };
    use crate::workspace::Workspace;
    use serde_json::Value;
    use std::fs;

    fn workspace(name: &str) -> Workspace {
        let path =
            std::env::temp_dir().join(format!("neelima-preview-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Workspace::open(&path).unwrap()
    }

    #[test]
    fn preview_returns_only_relative_path_and_bounded_text() {
        let ws = workspace("bounded");
        let file = ws.root().join("notes.txt");
        fs::write(
            &file,
            (0..700)
                .map(|line| format!("line {line:03}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let preview = read_workspace_file_preview(&ws, "notes.txt", 0).unwrap();
        assert_eq!(preview["path"], "notes.txt");
        assert!(!preview["path"]
            .as_str()
            .unwrap()
            .contains(&ws.root().to_string_lossy().to_string()));
        assert!(preview["content"].as_str().unwrap().len() <= 32 * 1024);
        assert!(preview["content"].as_str().unwrap().contains("line 000"));
        assert_eq!(preview["has_more"], true);
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn preview_reads_requested_line_window_and_rejects_unsupported_or_escaping_paths() {
        let ws = workspace("window");
        fs::write(ws.root().join("notes.md"), "zero\none\ntwo\n").unwrap();
        let page = read_workspace_file_preview(&ws, "notes.md", 1).unwrap();
        assert!(page["content"].as_str().unwrap().contains("one"));
        assert!(!page["content"].as_str().unwrap().contains("zero"));
        assert!(read_workspace_file_preview(&ws, "../outside.txt", 0).is_err());
        fs::write(ws.root().join("archive.pdf"), b"%PDF-1.7\0binary").unwrap();
        let error = read_workspace_file_preview(&ws, "archive.pdf", 0).unwrap_err();
        assert!(error.contains("Attach files"));
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn preview_refuses_binary_text_extension_and_directories() {
        let ws = workspace("binary");
        fs::write(ws.root().join("bad.txt"), b"not text\0secret").unwrap();
        assert!(read_workspace_file_preview(&ws, "bad.txt", 0).is_err());
        fs::create_dir_all(ws.root().join("folder")).unwrap();
        let error = read_workspace_file_preview(&ws, "folder", 0).unwrap_err();
        assert!(error.contains("Select a file"));
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn exact_page_boundary_reports_more_only_when_a_next_line_exists() {
        let ws = workspace("boundary");
        let exactly = (0..300)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        fs::write(ws.root().join("exact.txt"), &exactly).unwrap();
        fs::write(ws.root().join("more.txt"), format!("{exactly}extra\n")).unwrap();
        assert_eq!(
            read_workspace_file_preview(&ws, "exact.txt", 0).unwrap()["has_more"],
            false
        );
        assert_eq!(
            read_workspace_file_preview(&ws, "more.txt", 0).unwrap()["has_more"],
            true
        );
        assert_eq!(
            read_workspace_file_preview(&ws, "more.txt", 300).unwrap()["has_more"],
            false
        );
        fs::remove_dir_all(ws.root()).ok();
    }

    /// Phase 3M live defect: the reader's AI-facing "[N lines read from line X]"
    /// trailer was rendered inside the user-facing preview body.
    #[test]
    fn preview_body_excludes_the_reader_trailer() {
        let ws = workspace("trailer");
        fs::write(ws.root().join("note.md"), "one\ntwo\n").unwrap();
        fs::write(ws.root().join("with-brackets.md"), "array[0] = 1;\n").unwrap();
        let page = read_workspace_file_preview(&ws, "note.md", 0).unwrap();
        let body = page["content"].as_str().unwrap();
        assert!(
            !body.contains("lines read from line"),
            "trailer leaked: {body:?}"
        );
        assert_eq!(body, "one\ntwo");
        assert_eq!(page["lines_read"], 2);
        let brackets = read_workspace_file_preview(&ws, "with-brackets.md", 0).unwrap();
        assert!(brackets["content"]
            .as_str()
            .unwrap()
            .contains("array[0] = 1;"));
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn preview_result_is_a_small_json_object() {
        let ws = workspace("shape");
        fs::write(ws.root().join("x.rs"), "fn main() {}\n").unwrap();
        let result: Value = read_workspace_file_preview(&ws, "x.rs", 0).unwrap();
        assert!(result["content"].as_str().unwrap().contains("fn main"));
        assert_eq!(result["line_limit"], 300);
        assert_eq!(result["has_more"], false);
        assert_eq!(result["start_line"], 1);
        fs::remove_dir_all(ws.root()).ok();
    }

    /// Phase 3N: the native code view saves through the same confinement the
    /// agent tools use, and reports a workspace-relative path only.
    #[test]
    fn save_writes_text_and_reports_a_relative_path() {
        let ws = workspace("save-ok");
        fs::write(ws.root().join("app.py"), "print('old')\n").unwrap();
        let saved = write_workspace_file(
            &ws,
            "app.py",
            "print('new')\nprint(2)\n",
            "print('old')\n",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(ws.root().join("app.py")).unwrap(),
            "print('new')\nprint(2)\n"
        );
        assert_eq!(saved["path"], "app.py");
        assert_eq!(saved["lines"], 2);
        assert!(!saved["path"]
            .as_str()
            .unwrap()
            .contains(&ws.root().to_string_lossy().to_string()));
        // The atomic temp sibling must not survive a successful save.
        assert!(!ws.root().join(".app.py.neelima-tmp").exists());
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn save_refuses_escapes_directories_binary_and_unsupported_types() {
        let ws = workspace("save-reject");
        let outside = ws.root().parent().unwrap().join("outside-save.txt");
        fs::write(&outside, "sentinel").unwrap();
        assert!(write_workspace_file(&ws, "../outside-save.txt", "pwned", "sentinel").is_err());
        assert!(write_workspace_file(&ws, "/etc/passwd", "pwned", "").is_err());

        fs::create_dir_all(ws.root().join("src")).unwrap();
        assert!(write_workspace_file(&ws, "src", "pwned", "").is_err());

        fs::write(ws.root().join("blob.txt"), b"head\0tail").unwrap();
        let binary = write_workspace_file(&ws, "blob.txt", "text", "head\0tail").unwrap_err();
        assert!(binary.contains("binary"), "got: {binary}");

        fs::write(ws.root().join("doc.pdf"), b"%PDF-1.7").unwrap();
        let pdf = write_workspace_file(&ws, "doc.pdf", "text", "%PDF-1.7").unwrap_err();
        assert!(pdf.contains("not a supported text type"), "got: {pdf}");
        fs::remove_file(&outside).ok();
        fs::remove_dir_all(ws.root()).ok();
    }

    /// The editor must start from exact bytes: a trimmed preview that was
    /// saved straight back would silently delete the file's trailing newline.
    #[test]
    fn exact_text_preserves_trailing_newlines_that_the_preview_trims() {
        let ws = workspace("exact-text");
        fs::write(ws.root().join("keep.py"), "a = 1\n\n").unwrap();
        let exact = read_workspace_file_text(&ws, "keep.py").unwrap();
        assert_eq!(exact["content"], "a = 1\n\n");
        let preview = read_workspace_file_preview(&ws, "keep.py", 0).unwrap();
        assert_ne!(preview["content"], exact["content"]);
        // Re-saving the exact text is a no-op, so nothing gets rewritten.
        assert!(write_workspace_file(&ws, "keep.py", "a = 1\n\n", "a = 1\n\n").is_err());
        assert_eq!(
            fs::read_to_string(ws.root().join("keep.py")).unwrap(),
            "a = 1\n\n"
        );
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn exact_text_refuses_escapes_binary_and_oversized_files() {
        let ws = workspace("exact-limits");
        assert!(read_workspace_file_text(&ws, "../escape.txt").is_err());
        fs::write(ws.root().join("blob.bin"), b"\0\0").unwrap();
        assert!(read_workspace_file_text(&ws, "blob.bin").is_err());
        fs::write(ws.root().join("blob.txt"), b"head\0tail").unwrap();
        assert!(read_workspace_file_text(&ws, "blob.txt").is_err());
        fs::write(
            ws.root().join("big.txt"),
            "x".repeat(FILE_EDIT_MAX_BYTES + 1),
        )
        .unwrap();
        let error = read_workspace_file_text(&ws, "big.txt").unwrap_err();
        assert!(error.contains("editing limit"), "got: {error}");
        fs::remove_dir_all(ws.root()).ok();
    }

    #[test]
    fn save_refuses_a_no_op_and_an_oversized_edit() {
        let ws = workspace("save-limits");
        fs::write(ws.root().join("same.md"), "unchanged\n").unwrap();
        assert!(write_workspace_file(&ws, "same.md", "unchanged\n", "unchanged\n").is_err());
        let huge = "x".repeat(FILE_EDIT_MAX_BYTES + 1);
        let error = write_workspace_file(&ws, "same.md", &huge, "unchanged\n").unwrap_err();
        assert!(error.contains("limited to"), "got: {error}");
        assert_eq!(
            fs::read_to_string(ws.root().join("same.md")).unwrap(),
            "unchanged\n"
        );
        fs::remove_dir_all(ws.root()).ok();
    }

    /// Checkpoint 4: a save matches the reviewed baseline end to end — the
    /// destination is replaced atomically and the bytes are read back for
    /// verification before success is reported.
    #[test]
    fn save_with_a_matching_baseline_succeeds_and_verifies_the_written_bytes() {
        let ws = workspace("save-baseline-ok");
        fs::write(ws.root().join("conf.md"), "v1\n").unwrap();
        let saved = write_workspace_file(&ws, "conf.md", "v2-draft\n", "v1\n").unwrap();
        assert_eq!(fs::read_to_string(ws.root().join("conf.md")).unwrap(), "v2-draft\n");
        assert_eq!(saved["bytes"], "v2-draft\n".len());
        assert!(!ws.root().join(".conf.md.neelima-tmp").exists());
        fs::remove_dir_all(ws.root()).ok();
    }

    /// THE CP4 acceptance case: an external modification between opening the
    /// file and applying the review must be refused, must keep the external
    /// version fully intact, must not leave a temp file behind, and must be
    /// clearable by rebasing the baseline onto the newest disk contents.
    #[test]
    fn save_rejects_an_externally_modified_file_and_preserves_both_versions() {
        let ws = workspace("save-conflict");
        fs::write(ws.root().join("conf.md"), "v1\n").unwrap();
        // The editor holds v1 as `original`; an external process moves the
        // disk content to v2 while the review is open.
        fs::write(ws.root().join("conf.md"), "v2-external\n").unwrap();
        let conflict =
            write_workspace_file(&ws, "conf.md", "v3-draft\n", "v1\n").unwrap_err();
        assert!(
            conflict.starts_with(super::SAVE_CONFLICT_PREFIX),
            "got: {conflict}"
        );
        assert!(conflict.contains("changed on disk"), "got: {conflict}");
        // The external version is untouched, and no temp file survived.
        assert_eq!(
            fs::read_to_string(ws.root().join("conf.md")).unwrap(),
            "v2-external\n"
        );
        assert!(!ws.root().join(".conf.md.neelima-tmp").exists());
        // Rebase: once the user reloads (v2 becomes the baseline) the same
        // draft saves cleanly.
        write_workspace_file(&ws, "conf.md", "v3-draft\n", "v2-external\n").unwrap();
        assert_eq!(fs::read_to_string(ws.root().join("conf.md")).unwrap(), "v3-draft\n");
        fs::remove_dir_all(ws.root()).ok();
    }

    /// A vanished destination is a hard save error, not a silent no-op: the
    /// editor's stale document must never resurrect a deleted file.
    #[test]
    fn save_rejects_a_missing_destination() {
        let ws = workspace("save-missing");
        let error = write_workspace_file(&ws, "gone.md", "v2\n", "v1\n").unwrap_err();
        assert!(error.contains("Could not inspect"), "got: {error}");
        assert!(!ws.root().join("gone.md").exists());
        fs::remove_dir_all(ws.root()).ok();
    }

    /// Windows replacement semantics (verified on Windows): MoveFileEx alias
    /// rename refuses a read-only destination instead of clobbering it, so a
    /// genuinely unwritable destination preserves the original and reports a
    /// replace failure; once writable, the same draft saves and verifies.
    #[cfg(windows)]
    #[test]
    fn save_refuses_a_readonly_destination_and_preserves_the_original() {
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY,
        };
        // windows_sys takes a UTF-16 path buffer; no extra dependency needed.
        let set_readonly = |path: &std::path::Path, readonly: bool| {
            let wide: Vec<u16> = path
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain([0])
                .collect();
            let attribute = if readonly {
                FILE_ATTRIBUTE_READONLY
            } else {
                FILE_ATTRIBUTE_NORMAL
            };
            unsafe { SetFileAttributesW(wide.as_ptr(), attribute) };
        };
        let ws = workspace("save-readonly");
        let target = ws.root().join("locked.md");
        fs::write(&target, "original\n").unwrap();
        set_readonly(&target, true);
        let denied =
            write_workspace_file(&ws, "locked.md", "edited\n", "original\n").unwrap_err();
        assert!(denied.contains("Could not replace"), "got: {denied}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "original\n");
        assert!(!ws.root().join(".locked.md.neelima-tmp").exists());
        // Restore writability: the retry follows the ordinary success path.
        set_readonly(&target, false);
        let saved = write_workspace_file(&ws, "locked.md", "edited\n", "original\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "edited\n");
        assert_eq!(saved["bytes"], "edited\n".len());
        fs::remove_dir_all(ws.root()).ok();
    }

    fn temp_artifacts(ws: &Workspace) -> Vec<String> {
        fs::read_dir(ws.root())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".neelima-tmp"))
            .collect()
    }

    /// CP4 closeout: controlled temp-file creation and mid-WRITE failures must
    /// leave the destination byte-identical, leave no temp artifact, and return
    /// an honest error with no success payload. Failure is injected
    /// deterministically (thread-local test hook), not by relying on
    /// environmental conditions.
    #[test]
    fn save_temp_write_failure_preserves_the_destination_and_leaves_no_artifact() {
        for mode in [1u8, 2u8] {
            let ws = workspace(&format!("save-temp-fail-{mode}"));
            let target = ws.root().join("keep.md");
            let original_bytes = b"original\n";
            fs::write(&target, original_bytes).unwrap();
            super::INJECT_TEMP_WRITE_FAILURE.with(|flag| flag.set(mode));
            let result = write_workspace_file(&ws, "keep.md", "edited\n", "original\n");
            let error = result.expect_err("an injected temp-write failure must not report success");
            super::INJECT_TEMP_WRITE_FAILURE.with(|flag| flag.set(0));
            assert!(error.contains("Could not write file"), "mode {mode}: {error}");
            assert!(
                !error.contains("bytes") && !error.contains("Saved"),
                "mode {mode}: a failed temp write must not carry a success-shaped payload: {error}"
            );
            // The destination is byte-identical and no temp artifact survives
            // (mode 2 proved the partial temp file was actually removed).
            assert_eq!(fs::read(&target).unwrap(), original_bytes, "mode {mode}");
            assert!(
                temp_artifacts(&ws).is_empty(),
                "mode {mode}: temp artifact left: {:?}",
                temp_artifacts(&ws)
            );
            // The destination is still fully usable afterwards (hook cleared).
            write_workspace_file(&ws, "keep.md", "edited\n", "original\n").unwrap();
            assert_eq!(fs::read_to_string(&target).unwrap(), "edited\n", "mode {mode}");
            fs::remove_dir_all(ws.root()).ok();
        }
    }

    /// CP4 final concurrency verification: concurrent saves of the SAME file
    /// with the SAME baseline are serialized per canonical destination path.
    /// EXACTLY ONE may succeed; every other attempt must fail as a baseline
    /// conflict (never a silent last-writer-wins). Temp files stay per-operation
    /// and exclusive, so no attempt can overwrite or delete another's; the final
    /// bytes are exactly the winning draft and no temp artifact remains.
    #[test]
    fn concurrent_saves_of_the_same_file_never_corrupt_or_leak_temp_files() {
        use std::sync::Barrier;
        let ws = workspace("save-concurrent");
        let target = ws.root().join("race.md");
        fs::write(&target, "base\n").unwrap();
        let drafts: Vec<String> = (0..8).map(|index| format!("draft {index}\n")).collect();
        // Release every thread at once to maximise real overlap; the serialized
        // save path makes the OUTCOME deterministic whatever the interleaving.
        let start = Barrier::new(drafts.len());
        let results: Vec<Result<Value, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = drafts
                .iter()
                .map(|draft| {
                    let ws = &ws;
                    let start = &start;
                    scope.spawn(move || {
                        start.wait();
                        // Every operation reviewed the same baseline.
                        write_workspace_file(ws, "race.md", draft, "base\n")
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect()
        });
        let winners: Vec<usize> = results
            .iter()
            .enumerate()
            .filter(|(_, result)| result.is_ok())
            .map(|(index, _)| index)
            .collect();
        assert_eq!(
            winners.len(),
            1,
            "exactly one save may succeed against the same baseline; results: {results:?}"
        );
        for result in &results {
            if let Err(error) = result {
                assert!(
                    error.starts_with(super::SAVE_CONFLICT_PREFIX),
                    "only baseline conflicts are acceptable losers, got: {error}"
                );
            }
        }
        let final_text = fs::read_to_string(&target).unwrap();
        assert_eq!(
            final_text, drafts[winners[0]],
            "final file must be exactly the winning reviewed draft"
        );
        assert!(temp_artifacts(&ws).is_empty(), "temp artifact left: {:?}", temp_artifacts(&ws));
        fs::remove_dir_all(ws.root()).ok();
    }

    /// CP4 final concurrency: the losing side of a same-file race must be
    /// refused, not silently applied. This is the deterministic form of the
    /// outcome the per-path lock guarantees: after one save has replaced the
    /// destination, a second save still carrying the old baseline conflicts and
    /// leaves the winner's bytes untouched.
    #[test]
    fn a_stale_save_cannot_overwrite_the_first_successful_save() {
        let ws = workspace("save-stale");
        let target = ws.root().join("stale.md");
        fs::write(&target, "base\n").unwrap();
        write_workspace_file(&ws, "stale.md", "first\n", "base\n").unwrap();
        // Exactly the state a concurrently-started second save reaches after
        // waiting on the lock: its reviewed baseline is now stale.
        let conflict = write_workspace_file(&ws, "stale.md", "stale\n", "base\n").unwrap_err();
        assert!(
            conflict.starts_with(super::SAVE_CONFLICT_PREFIX),
            "got: {conflict}"
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "first\n",
            "the stale draft must never replace the first successful save"
        );
        assert!(temp_artifacts(&ws).is_empty());
        // Rebasing onto the new baseline makes the same draft legitimate.
        write_workspace_file(&ws, "stale.md", "stale\n", "first\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "stale\n");
        fs::remove_dir_all(ws.root()).ok();
    }

    /// CP4 final lifecycle: the registry stores weak entries, so a completed
    /// save must not pin a permanent lock allocation; the next insertion
    /// reclaims expired entries instead of accumulating one per saved file.
    #[test]
    fn expired_save_path_locks_are_reclaimed() {
        let ws = workspace("save-lock-reclaim");
        let first = ws.root().join("first.md");
        fs::write(&first, "base\n").unwrap();
        write_workspace_file(&ws, "first.md", "v2\n", "base\n").unwrap();
        // The save has returned, so nothing holds this Arc. A surviving entry
        // may exist, but it must be expired — never live.
        assert_ne!(
            super::save_lock_entry_is_live(&first),
            Some(true),
            "a completed save must not leave a live registry entry"
        );
        // Creating a lock for a NEW path performs the reclamation pass.
        fs::write(ws.root().join("second.md"), "base\n").unwrap();
        write_workspace_file(&ws, "second.md", "v2\n", "base\n").unwrap();
        assert_eq!(
            super::save_lock_entry_is_live(&first),
            None,
            "the expired entry must be reclaimed instead of accumulating"
        );
        fs::remove_dir_all(ws.root()).ok();
    }

    /// CP4 final lifecycle: reclamation must never split simultaneous
    /// operations onto different mutexes. While one `Arc` is held, repeated
    /// acquisitions — including one that prunes expired entries — must return
    /// the SAME lock, so concurrent saves stay serialized.
    #[test]
    fn reclamation_never_splits_a_live_lock() {
        let ws = workspace("save-lock-split");
        let target = ws.root().join("shared.md");
        fs::write(&target, "base\n").unwrap();
        let live = super::save_path_lock(&target);
        // Another path's lock forces a reclamation pass while `live` is held.
        let other = ws.root().join("other.md");
        fs::write(&other, "base\n").unwrap();
        let other_lock = super::save_path_lock(&other);
        let same = super::save_path_lock(&target);
        assert!(
            std::sync::Arc::ptr_eq(&live, &same),
            "a live path lock must never be replaced by a different mutex"
        );
        assert_eq!(super::save_lock_entry_is_live(&target), Some(true));
        drop(live);
        drop(same);
        drop(other_lock);
        fs::remove_dir_all(ws.root()).ok();
    }
}

#[cfg(test)]
mod tree_listing_tests {
    use super::{list_workspace_dir, TREE_ENTRY_LIMIT};
    use std::fs;

    fn dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "neelima-tree-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// CP5: a folder larger than the cap must expose a DETERMINISTIC first page
    /// (sorted before capping), report truncation, and still hide dotfiles.
    #[test]
    fn listing_is_sorted_directories_first_and_capped_deterministically() {
        let root = dir("cap");
        fs::create_dir_all(root.join("zdir")).unwrap();
        for index in 0..405 {
            fs::write(root.join(format!("f{index:03}.txt")), "x").unwrap();
        }
        fs::write(root.join(".hidden"), "x").unwrap();

        let listing = list_workspace_dir(&root, "").unwrap();
        assert_eq!(listing["truncated"], true);
        assert_eq!(listing["limit"], TREE_ENTRY_LIMIT);
        assert_eq!(listing["unreadable"], 0);
        let entries = listing["entries"].as_array().unwrap();
        assert_eq!(entries.len(), TREE_ENTRY_LIMIT);
        assert_eq!(entries[0]["name"], "zdir");
        assert_eq!(entries[0]["dir"], true);
        assert_eq!(entries[1]["name"], "f000.txt");
        assert_eq!(entries.last().unwrap()["name"], "f398.txt");
        assert!(entries.iter().all(|entry| entry["name"] != ".hidden"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn empty_and_uncapped_listings_report_accurate_metadata() {
        let root = dir("meta");
        let empty = list_workspace_dir(&root, "").unwrap();
        assert_eq!(empty["entries"].as_array().unwrap().len(), 0);
        assert_eq!(empty["truncated"], false);

        fs::write(root.join("b.txt"), "x").unwrap();
        fs::write(root.join("a.txt"), "x").unwrap();
        let two = list_workspace_dir(&root, "sub").unwrap();
        let entries = two["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], "a.txt");
        assert_eq!(entries[0]["path"], "sub/a.txt");
        assert_eq!(entries[1]["name"], "b.txt");
        assert_eq!(two["path"], "sub");
        assert_eq!(two["truncated"], false);
        fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod ready_check_tests {
    use super::PROVIDER_READY_PROMPT;

    /// The Phase I connectivity check must stay harmless and exact; a probe
    /// that asks the model for more could trigger tools or mutate a workspace.
    #[test]
    fn ready_check_prompt_is_exact_and_read_only() {
        assert_eq!(
            PROVIDER_READY_PROMPT,
            "For this connectivity check, reply with exactly READY. Do not use tools."
        );
        assert!(!PROVIDER_READY_PROMPT.contains("write"));
    }
}

#[cfg(test)]
mod github_url_tests {
    use super::validate_github_url;

    #[test]
    fn accepts_https_github_links() {
        assert!(validate_github_url("https://github.com/search?q=SKILL.md").is_ok());
        assert!(validate_github_url("https://github.com:443/org/repo").is_ok());
    }

    #[test]
    fn rejects_non_github_or_unsafe_urls() {
        for url in [
            "http://github.com/org/repo",
            "https://github.com.evil.example/org/repo",
            "https://user@github.com/org/repo",
            "https://github.com:8443/org/repo",
            "javascript:alert(1)",
        ] {
            assert!(validate_github_url(url).is_err(), "accepted {url}");
        }
    }
}

#[cfg(test)]
mod capture_diagnostics_tests {
    use super::capture_reason;
    use serde_json::json;

    /// "The answer is right there but Neelima says there is none" must explain
    /// WHICH detection family matched, without leaking any page text.
    #[test]
    fn an_unrecognised_layout_is_named_as_a_markup_change() {
        let reason = capture_reason(&json!({
            "has_reply": false,
            "text": "secret answer text",
            "layout": "none",
            "assistant_count": 0,
            "user_count": 2,
            "stop_visible": false
        }));
        assert!(reason.contains("layout: none"));
        assert!(reason.contains("markup change"), "got: {reason}");
        assert!(!reason.contains("secret answer text"), "metadata only");
    }

    #[test]
    fn a_still_streaming_or_textless_turn_is_distinguished() {
        let streaming = capture_reason(&json!({
            "layout": "role", "assistant_count": 1, "user_count": 1, "stop_visible": true
        }));
        assert!(streaming.contains("still generating"), "got: {streaming}");
        let textless = capture_reason(&json!({
            "layout": "turns", "assistant_count": 1, "user_count": 1, "stop_visible": false
        }));
        assert!(textless.contains("carried no text"), "got: {textless}");
        let no_turn = capture_reason(&json!({
            "layout": "adapter", "assistant_count": 0, "user_count": 1, "stop_visible": false
        }));
        assert!(no_turn.contains("no assistant turn"), "got: {no_turn}");
    }

    /// The card must carry enough STRUCTURE to fix an unknown layout, and no
    /// page text whatsoever.
    #[test]
    fn the_failure_reason_reports_the_dom_shape_without_text() {
        let reason = capture_reason(&json!({
            "layout": "content",
            "assistant_count": 1,
            "user_count": 1,
            "stop_visible": false,
            "text": "",
            "dom": {
                "blocks": [{ "tag": "div", "attrs": ["class=markdown.prose", "data-message-id=abc"], "text_len": 0 }],
                "chain": [{ "tag": "main" }, { "tag": "div" }, { "tag": "section" }]
            }
        }));
        assert!(
            reason.contains("newest block: div.markdown.prose"),
            "got: {reason}"
        );
        assert!(reason.contains("len 0"), "got: {reason}");
        assert!(
            reason.contains("ancestors: main > div > section"),
            "got: {reason}"
        );
        assert!(
            !reason.contains("abc"),
            "data-* values stay out of the card"
        );
    }
}
