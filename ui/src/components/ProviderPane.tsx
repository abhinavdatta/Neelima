// The provider pane: hosts the embedded web chat webview. The webview is a
// real child webview positioned EXACTLY over this div (rect reported to Rust in
// physical px on every layout change). Entering the view mounts the selected
// profile automatically; leaving destroys it — the profile's data dir persists,
// so logins survive the destroy.
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
      // Leaving the provider view destroys the webview (RAM budget).
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

  return (
    <div class="provider-pane">
      <div class="provider-toolbar">
        {selectedProfile ? (
          <>
            <span class="provider-name">{selectedProfile.name}</span>
            {s.providerMounted
              ? <span class="provider-badge ok">live</span>
              : <button class="tb-btn" onClick={openLogin}>Open / log in</button>}
            <span class="provider-note">
              {s.providerMounted
                ? "Runs in an isolated webview — with its own login. Close it any time."
                : "Credentials stay inside the webview's own profile — Neelima never reads them."}
            </span>
          </>
        ) : (
          <>
            <span class="provider-note">No web provider selected — pick one in the composer below or connect one in Settings.</span>
            <button class="tb-btn" onClick={() => addWorkspace()}>+ Add folder</button>
          </>
        )}
        {selectedProfile ? <button class="tb-danger" onClick={() => cmd.providersClose()}>Close</button> : null}
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
