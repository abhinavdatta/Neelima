# Installing Neelima + the Browser Bridge (Windows)

This guide covers the browser-extension integration end to end: loading the
extension, registering the native messaging host, and connecting it to the
running Neelima desktop app. For other platforms, register the host manifest
under the browser's native-messaging directory (`/etc/opt/chrome/native-messaging-hosts/`
or `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` on
macOS) pointing at the Unix build of `neelima_native_host`.

## Prerequisites

- Windows 10/11 with Chrome or Edge installed.
- The Neelima desktop app (build with `cargo build --release -p neelima` from
  the repo root, or use a packaged build).
- No cloud accounts or API keys are required — Neelima runs local models only
  (Ollama / LM Studio) and, optionally, AI websites you sign into yourself.

## 1. Build / locate the artifacts

Run `scripts\package-windows.ps1`. It produces `dist\neelima-windows\` with:

| File | Purpose |
|---|---|
| `Neelima-Browser-Extension.zip` | unpacked-loadable extension (sha256 alongside) |
| `neelima_native_host.exe` | Native Messaging host (sha256 alongside) |
| `manifests\com.neelima.browser_bridge.json` | host manifest template |
| `register.ps1` | registers the host for Chrome + Edge (HKCU by default) |
| `INSTALL.md` | this guide |

## 2. Load the extension

1. Unzip `Neelima-Browser-Extension.zip` to a folder you will keep
   (e.g. `%LOCALAPPDATA%\Neelima\browser-extension`).
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer
   mode**, click **Load unpacked**, and select the unzipped folder.
3. Note the extension's **ID** on its card (32 lowercase letters).

## 3. Register the native messaging host

1. Copy `neelima_native_host.exe` into `%LOCALAPPDATA%\Neelima\`
   (`register.ps1` expects exactly that path).
2. From an elevated-or-not PowerShell prompt:
   ```powershell
   .\register.ps1 -ExtensionId <YOUR_EXTENSION_ID>
   ```
   This writes the manifest (with your real extension ID allowlisted — no
   wildcards) to `%LOCALAPPDATA%\Neelima\com.neelima.browser_bridge.json` and
   registers it under HKCU for Chrome and Edge. Add `-AllUsers` for an
   HKLM (per-machine) registration; that needs elevation.
3. Back in `chrome://extensions`, click **Reload** on the Neelima card.

If the extension ID is unknown yet, `register.ps1` can run without it, but the
bridge will refuse connections until you re-run registration with the real ID
— this is deliberate: the manifest must never allowlist wildcard origins.

## 4. Verify the connection

1. Start Neelima and open a workspace.
2. Open the extension popup → **Check connection**. It performs a read-only
   `bridge.status` round-trip through the native host into the desktop app and
   shows the real backend answer (workspace present, permission mode).
3. On any supported AI website (ChatGPT, Claude, Gemini — sign in with your
   normal browser session), ask the model to emit a `neelima-tool` block. A
   **Review in Neelima** button appears on the message; nothing is ever
   forwarded without your click. Read-only proposals execute in the selected
   workspace; write/delete proposals wait for an explicit approval card in the
   Neelima desktop app.

## Sign-in expectations

The extension uses **your normal browser session** for AI websites. Neelima's
own embedded provider pane signs in separately; signing into a browser window
does not authenticate the embedded webview, and vice versa. The extension
never extracts cookies or tokens, and never bypasses sign-in or CAPTCHA.

## Uninstalling

```powershell
.\register.ps1 -Unregister          # current user (add -AllUsers for HKLM)
```
Then remove the extension in `chrome://extensions` and delete
`%LOCALAPPDATA%\Neelima\` if you no longer need the host binary. Unregistering
never touches your workspaces, task history, or Neelima settings.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says the native host is not contacted | Is Neelima running? Is the host registered for **this** browser profile (HKCU vs HKLM)? |
| `Access to the specified native messaging host is forbidden` | The manifest's `allowed_origins` does not include your extension ID — re-run `register.ps1 -ExtensionId`. |
| Status times out but the app is running | Re-check step 3's copy location (`%LOCALAPPDATA%\Neelima\neelima_native_host.exe`); the registry points at the manifest, the manifest at the binary. |
| Requests show `outcome unknown` | The extension restarts or the pipe dropped before the decision arrived. Requests are never replayed automatically; re-propose only if you confirmed nothing executed. |
| Approval card never appears | Write/delete proposals under AskAll/AskWrites wait up to 2 minutes; check the Neelima window. |

## Version compatibility & upgrades

- Extension protocol version 1 ↔ host ↔ backend: all three ship together in
  one package; mixed old/new components surface as `UNSUPPORTED_VERSION`
  errors — upgrade all pieces at once.
- Upgrades preserve settings: registration and extension updates never modify
  the app's config/data directories.
- Publishing/signing is a separate explicit step; nothing here auto-updates or
  phones home.
