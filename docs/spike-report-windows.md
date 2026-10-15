# LocalBridge/Neelima Phase-0 spike self-test report

- date: unix timestamp 1792097339
- OS: windows x86_64
- tauri: 2.12.4 (unstable multiwebview)
- run: 1 (run 1 seeds the storage marker; run 2 verifies restart persistence)

| # | test | status | ms | detail |
|---|------|--------|----|--------|
| 1 | T1 one window hosts ui + provider webviews (multiwebview, unstable) | PASS | 0 | ui present: true, provider present: true, webviews on 'main': 2 |
| 2 | T2 init script + hello via narrow lb_bridge (ui webview) | PASS | 0 | {"has_global_tauri":true,"has_ipc":true,"phase":"dom-ready","t":"hello","url":"http://tauri.localhost/"} |
| 3 | T2b init script + hello via narrow lb_bridge (provider webview) | PASS | 122 | {"has_global_tauri":true,"has_ipc":true,"phase":"dom-ready","t":"hello","url":"http://tauri.localhost/demo-chat.html"} |
| 4 | T3 eval round-trip: ping provider page | PASS | 2 | pong:tauri.localhost |
| 5 | T4a ACL blocks spike_action from the provider webview | PASS | 5 | blocked-as-expected: spike_action not allowed on window "main", webview "provider", URL: local

allowed on: [webviews: "ui", URL: local]

referenced by: capability: spike-ui, permission: allow-app-commands |
| 6 | T4b ui webview IS allowed to call spike_action (positive control) | PASS | 6 | allowed: {"caller":"ui","echo":"hi"} |
| 7 | T5a DOM automation: controlled textarea + send + observer completion + extraction | PASS | 1619 | extracted: Got it. I will inspect the workspace.
```tool
{"id":"1","tool":"read_file","args":{"path":"spike-ta-1"}}
```

Copy |
| 8 | T5b DOM automation: contenteditable path | PASS | 1611 | Got it. I will inspect the workspace.
```tool
{"id":"1","tool":"read_file","args":{"path":"spike-ce-1"}}
```

Copy |
| 9 | T6 per-profile data directory: storage marker persists across destroy/remount | PASS | 984 | marker after remount: "lb-spike-run1"; from previous app run: "\"lb-spike-run2\"" |
| 10 | T7 webview lifecycle: hide/show/resize/move then ping | PASS | 24 | post-lifecycle ping: pong:tauri.localhost |
| 11 | T8 remote https page loads with init script + capability-gated IPC | PASS | 561 | hello: {"has_global_tauri":true,"has_ipc":true,"phase":"dom-ready","t":"hello","url":"https://example.com/"}; ping: pong:example.com |

Overall: **ALL PASS**
