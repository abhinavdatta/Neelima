# Neelima Browser Bridge 0.1.0

A Chrome/Edge Manifest V3 extension for connecting compatible browser AI chats to Neelima's local Rust/Tauri agent.

## Install (developer/unpacked mode)

1. Extract this folder somewhere permanent on your PC.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Microsoft Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted folder containing this `manifest.json`.
6. Open the extension popup. It will report that Neelima is not connected until the matching Native Messaging host and backend integration are installed.

This extension folder can be loaded directly. Node.js is not required to install or test the extension UI.

## What works in this first build

- Manifest V3 extension UI for Chrome and Edge.
- Popup with connection status, permission-mode display, pause/resume, generic-site injection, and manual request relay.
- Options page for enabling/disabling ChatGPT, Claude, Gemini, choosing a permission preference, and authorizing a custom HTTPS hostname one domain at a time.
- Provider adapters for ChatGPT, Claude, and Gemini.
- Generic adapter for a user-authorized HTTPS site.
- Explicit **Review in Neelima** action before forwarding detected tool-call blocks.
- Strict extension-side tool-name and request-shape checks.
- Native Messaging client for `com.neelima.browser_bridge`.
- Manual JSON relay through the active, enabled AI website when its DOM adapter does not detect a tool request.

## Important integration status

**The browser extension is built; the matching Neelima native host and Rust/Tauri backend changes are not included in this extension-only package.** Until those are implemented and registered, the extension will show a connection error and file operations will not run. It never accesses local files directly.

The local backend must independently enforce workspace grants, path confinement, the selected permission mode, approvals, idempotency, and audit history. The extension setting for automatic writes is only a preference until the backend implements and verifies it.

## Generic website setup

1. Open the extension's Options page.
2. Enter a hostname only, such as `example.com`.
3. Click **Authorize domain** and accept the browser's host-permission prompt.
4. Save settings.
5. Open that HTTPS website and click the extension icon.
6. Select **Enable on current tab**.
7. The generic adapter looks for a code block marked `neelima-tool` or a `<neelima-tool-call>` block. A user must click **Review in Neelima** before a detected request is forwarded.

This does not guarantee every AI website is compatible. Websites with unusual message structures or restrictive behavior may need a dedicated adapter or the manual relay.

## Tool-call format

A compatible AI should emit a block like:

```neelima-tool
{
  "version": 1,
  "operation": "tool.propose",
  "tool": "read_file",
  "args": { "path": "README.md" }
}
```

The extension generates the request ID and supplies the site ID, page origin, and activation marker. The webpage cannot choose a task or workspace ID; the native host/backend must bind the proposal to an explicitly armed desktop session and selected workspace. The Rust backend must validate everything again. The extension permission-mode preference is display-only and is never sent as authorization authority. Allowed initial tools are `list_dir`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `move_file`, and `delete_file`. Shell execution is intentionally unsupported.

## Source checks and packaging

From the repository root, run `node --test browser-extension/tests/*.test.js` and `Get-ChildItem browser-extension -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`. On Windows, `./scripts/package-browser-extension.ps1` creates the development ZIP and SHA-256 digest. This package still requires the missing native host and desktop integration before it can operate on local files.

## Permission modes

- **Approve every modification:** ask before each write/edit/move/delete.
- **Automatic edits in approved workspaces:** allow non-destructive writes only within a workspace selected in Neelima; destructive actions still require explicit confirmation.

The backend is authoritative. Selecting automatic mode in the extension does not enable it if Neelima does not implement that policy. File access is limited to folders selected inside Neelima; the extension does not select folders or grant itself filesystem access.

## Native host contract

See `docs/NATIVE-HOST-PROTOCOL.md`. The expected host name is `com.neelima.browser_bridge`. Its host manifest must allowlist the exact installed extension ID; do not use wildcard origins.

## Known limitations

- The extension cannot operate on files until the matching native host/backend integration exists.
- Provider website DOMs change. Selectors need maintenance and should fail closed.
- Result insertion into chat composers is not implemented as a general automatic feature; use the site's normal composer or manual relay to return results.
- Generic adapter requires a per-domain HTTPS permission.
- Automatic-write mode requires backend enforcement and end-to-end tests before production use.
