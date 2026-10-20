// The provider pane: hosts the embedded web chat webview. The webview is a
// real child webview positioned EXACTLY over this div (rect reported to Rust in
// physical px on every layout change). Entering the view mounts the selected
// profile automatically; leaving hides it so the page and login session stay alive.
import { useEffect, useRef } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { addWorkspace } from "./Sidebar";

export function ProviderPane() {
  const s = useStore();
  const host = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  const reportRect = () => {
    const el = host.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return; // pane not laid out yet
    const dpr = window.devicePixelRatio || 1;
    cmd.webviewRect(
      Math.round(r.left * dpr),
      Math.round((r.top + window.scrollY) * dpr),
      Math.round(r.width * dpr),
      Math.round(r.height * dpr),
    ).catch(() => {});
  };

  const mountSelected = async () => {
    const webProfiles: any[] = s.providers?.web ?? [];
    const selectedProfileId = s.providerSelected.startsWith("web:") ? s.providerSelected.slice(4) : null;
    const selectedProfile = webProfiles.find((p) => p.id === selectedProfileId);
    if (!selectedProfile || mountedRef.current) return;
    reportRect();
    await new Promise((r) => setTimeout(r, 80)); // let the rect land in Rust
    reportRect();
    try {
      await cmd.providersLogin(selectedProfile.id);
      mountedRef.current = true;
    } catch (e) {
      toast("error", String(e));
    }
  };

  useEffect(() => {
    reportRect();
    const ro = new ResizeObserver(reportRect);
    if (host.current) ro.observe(host.current);
    window.addEventListener("resize", reportRect);
    // Auto-mount the selected profile when entering the provider view.
    const t = setTimeout(() => { mountSelected(); }, 120);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reportRect);
      clearTimeout(t);
      // Leaving the provider view hides the webview without reloading the page.
      mountedRef.current = false;
      cmd.webviewMode("chat").catch(() => {});
    };
  }, []);

  const webProfiles: any[] = s.providers?.web ?? [];
  const selectedProfileId = s.providerSelected.startsWith("web:") ? s.providerSelected.slice(4) : null;
  const selectedProfile = webProfiles.find((p) => p.id === selectedProfileId);

  const openLogin = async () => {
    if (!selectedProfileId) { toast("warn", "Select a web provider in the composer first."); return; }
    try {
      reportRect();
      await new Promise((r) => setTimeout(r, 60));
      reportRect();
      await cmd.providersLogin(selectedProfileId);
      mountedRef.current = true;
      toast("info", "Log in inside the embedded chat. Your credentials never touch Neelima.");
    } catch (e) { toast("error", String(e)); }
  };

  const testConnection = async () => {
    try {
      const result = await cmd.providerDiagnose();
      if (!result.mounted) {
        toast("warn", "Provider webview is not mounted.");
        return;
      }
      const status = [
        `login: ${result.login_state ?? "unknown"}`,
        `ping: ${result.ping_ms == null ? "failed" : `${result.ping_ms} ms`}`,
        `input: ${result.input_found == null ? "unknown" : result.input_found ? "found" : "missing"}`,
        `send: ${result.send_button_found == null ? "unknown" : result.send_button_found ? "found" : "missing"}`,
        `messages: ${result.messages_found == null ? "unknown" : result.messages_found ? "found" : "missing"}`,
      ].join(" · ");
      toast(result.ping_ms == null ? "warn" : "info", status);
      if (result.ping_ms == null && result.last_bridge_error) {
        toast("error", result.last_bridge_error);
      }
    } catch (e) {
      toast("error", `Provider diagnostics failed: ${String(e)}`);
    }
  };

  const continueAsLoggedIn = async () => {
    try {
      await cmd.providerLoginOverride();
      toast("warn", "Continuing with the manual login-state override.");
    } catch (e) {
      toast("error", String(e));
    }
  };

  return (
    <div class="provider-pane">
      <div class="provider-toolbar">
        {selectedProfile ? (
          <>
            <span class="provider-name">{selectedProfile.name}</span>
            {s.providerLoginWaiting
              ? <span class="provider-badge wait">Waiting for login…</span>
              : s.providerMounted
                ? <span class="provider-badge ok">live</span>
                : <button class="tb-btn" onClick={openLogin}>Open / log in</button>}
            <span class="provider-note">
              {s.providerLoginWaiting
                ? "Log in inside the embedded chat. Your session persists — you only need to do this once per provider."
                : s.providerMounted
                  ? s.providerLoginState === "unknown"
                    ? `Can't reach the page state${s.providerBridgeError ? `: ${s.providerBridgeError}` : ""}. Test the bridge connection before trying again.`
                    : "Runs in an isolated webview — with its own login. Close it any time."
                  : "Credentials stay inside the webview's own profile — Neelima never reads them."}
            </span>
            <span class="provider-note hint">
              Email or magic-link sign-in may open in your system browser, whose cookies are separate. If possible, paste the link into the embedded provider view; otherwise use manual relay.
            </span>
            {s.providerMounted ? <button class="tb-btn" onClick={testConnection}>Test connection</button> : null}
            {s.providerMounted && s.providerLoginState !== "logged_in"
              ? <button class="tb-btn" onClick={continueAsLoggedIn}>I'm logged in, continue</button>
              : null}
          </>
        ) : (
          <>
            <span class="provider-note">No web provider selected — pick one in the composer below or connect one in Settings.</span>
            <button class="tb-btn" onClick={() => addWorkspace()}>+ Add folder</button>
          </>
        )}
        {selectedProfile ? <button class="tb-danger" onClick={async () => {
          try { await cmd.providersClose(); mountedRef.current = false; }
          catch (e) { toast("error", String(e)); }
        }}>Close</button> : null}
      </div>
      <div class="provider-host" ref={host}>
        {!s.providerMounted ? (
          <div class="provider-placeholder">
            <div class="ph-logo">N</div>
            <h3>{selectedProfile ? `${selectedProfile.name} chat opens here` : "Provider chat appears here"}</h3>
            <p>The provider's own web UI runs in an isolated webview with its own login. Neelima drives it via the bridge protocol — it never sees your password, cookies or tokens.</p>
            {!s.activeWorkspacePath ? <p class="hint">Pick a workspace folder first (<button class="link" onClick={() => addWorkspace()}>+ Add folder</button>).</p> : null}
            <div class="ph-actions">
              {selectedProfile ? <button class="btn-ok" onClick={openLogin}>Open {selectedProfile.name}</button> : null}
              <button class="ghost" onClick={() => setState({ settingsOpen: true })}>Connect a provider…</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default ProviderPane;
