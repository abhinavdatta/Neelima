// The app ACL manifest is assembled from src-tauri/permissions/*.toml: turning
// it on enforces capability checks for EVERY invocation (local AND remote).
// The provider webview capability grants exactly ONE command (allow-lb-bridge).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new()).expect("failed to run tauri-build");

    // Test binaries import comctl32 v6-only symbols (TaskDialogIndirect via
    // wry/tauri), but tauri-build does not embed a manifest into test targets,
    // so the Windows loader binds the ancient comctl32 and aborts with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before main runs. Embed an SxS
    // manifest selecting comctl32 v6 into TEST targets only — production
    // binaries keep tauri-build's own manifest.
    // (The linker runs with the workspace root as cwd, so pass an absolute path.)
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/app.manifest");
    println!("cargo:rerun-if-changed=tests/app.manifest");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
    // NOTE: `rustc-link-arg-tests` reaches INTEGRATION test targets only —
    // cargo does not apply it to lib UNIT-test targets, and the plain
    // `rustc-link-arg` channel would also hit the production bin, whose
    // resource.lib already embeds a manifest (CVT1100 duplicate MANIFEST).
    // The lib unit-test exe is therefore made loadable by
    // `scripts/test-rust.mjs`, which writes this same manifest as an EXTERNAL
    // `<exe>.manifest` sibling after the build (the loader honours that when
    // the exe embeds none) and then runs the suite. Use `npm run test:rust`
    // for `cargo test`; a bare `cargo test --lib` still exits 0xc0000139 on
    // Windows for that loader reason, not because a test failed.
}
