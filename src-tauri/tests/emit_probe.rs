use tauri::Listener;

// Temporary probe: does emit/listen work on a built (never-run) Wry app?
#[test]
fn emit_listen_probe() {
    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::generate_context!())
        .expect("build");
    let handle = app.handle().clone();
    let got = std::sync::Arc::new(std::sync::Mutex::new(false));
    let g2 = got.clone();
    handle.listen("evt", move |_e| {
        *g2.lock().unwrap() = true;
    });
    use tauri::Emitter;
    handle
        .emit("evt", serde_json::json!({"kind": "probe"}))
        .expect("emit");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(*got.lock().unwrap(), "listener never fired");
}
