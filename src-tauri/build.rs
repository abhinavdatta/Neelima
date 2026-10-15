// The app ACL manifest is assembled from src-tauri/permissions/*.toml: turning
// it on enforces capability checks for EVERY invocation (local AND remote).
// The provider webview capability grants exactly ONE command (allow-lb-bridge).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new()).expect("failed to run tauri-build");
}
