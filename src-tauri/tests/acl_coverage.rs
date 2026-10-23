// The app assembles its ACL from src-tauri/permissions/*.toml and enforces it
// for every invocation. A command that is registered in `invoke_handler` but
// missing from `allow-app-commands` is invisible at runtime: the frontend gets
// "ui_xxx not allowed. Command not found". That is exactly how "Capture current
// reply" and viewport syncing broke, so keep the two lists in lock-step here.

use std::collections::BTreeSet;

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// `ui_*` command names from the invoke_handler block of lib.rs.
fn registered_ui_commands() -> BTreeSet<String> {
    let src = read(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"));
    let start = src
        .find(".invoke_handler(")
        .expect("lib.rs registers an invoke_handler");
    let block = &src[start..];
    let end = block.find("])").expect("invoke_handler list ends");
    block[..end]
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
        .filter(|token| {
            token
                .strip_prefix("ui::")
                .map(|name| name.starts_with("ui_"))
                .unwrap_or(false)
        })
        .map(|token| token.trim_start_matches("ui::").to_string())
        .collect()
}

/// Command names granted by the `allow-app-commands` permission.
fn granted_ui_commands() -> BTreeSet<String> {
    let src = read(concat!(env!("CARGO_MANIFEST_DIR"), "/permissions/app.toml"));
    let start = src
        .find("identifier = \"allow-app-commands\"")
        .expect("allow-app-commands permission exists");
    let block = &src[start..];
    let end = block.find(']').expect("commands.allow list ends");
    block[..end]
        .split('"')
        .filter(|token| token.starts_with("ui_"))
        .map(str::to_string)
        .collect()
}

#[test]
fn every_registered_ui_command_is_granted() {
    let registered = registered_ui_commands();
    assert!(
        registered.len() > 40,
        "parsed only {} commands from lib.rs — the parser lost the list",
        registered.len()
    );
    let granted = granted_ui_commands();
    let missing: Vec<_> = registered.difference(&granted).cloned().collect();
    assert!(
        missing.is_empty(),
        "registered but not granted by permissions/app.toml (the UI would get \
         \"not allowed. Command not found\"): {missing:?}"
    );
}

#[test]
fn no_granted_ui_command_is_stale() {
    let registered = registered_ui_commands();
    let granted = granted_ui_commands();
    let stale: Vec<_> = granted.difference(&registered).cloned().collect();
    assert!(
        stale.is_empty(),
        "granted but not registered in invoke_handler: {stale:?}"
    );
}
