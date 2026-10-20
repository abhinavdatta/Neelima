// Small, on-demand sign-in surface. Provider websites are never the workspace
// chat; normal prompts, responses, and tool approvals stay in Neelima.
import { useEffect, useRef } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";

export function ProviderPane() {
  const s = useStore();
  const host = useRef<HTMLDivElement>(null);
  const webProfiles: any[] = s.providers?.web ?? [];
  const selectedProfileId = s.providerSelected.startsWith("web:") ? s.providerSelected.slice(4) : null;
  const selectedProfile = webProfiles.find((p) => p.id === selectedProfileId);

  const reportRect = () => {
    const el = host.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const dpr = window.devicePixelRatio || 1;
    cmd.webviewRect(
      Math.round(r.left * dpr),
      Math.round((r.top + window.scrollY) * dpr),
      Math.round(r.width * dpr),
      Math.round(r.height * dpr),
    ).catch(() => {});
  };

  useEffect(() => {
    reportRect();
    const ro = new ResizeObserver(reportRect);
    if (host.current) ro.observe(host.current);
    window.addEventListener("resize", reportRect);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reportRect);
      setState({ providerAuthOpen: false });
      cmd.webviewMode("chat").catch(() => {});
    };
  }, []);

  const openLogin = async () => {
    if (!selectedProfileId) {
      setState({ settingsOpen: true });
      return;
    }
    setState({ providerAuthOpen: true });
    try {
      reportRect();
      await new Promise((resolve) => setTimeout(resolve, 60));
      reportRect();
      await cmd.providersLogin(selectedProfileId);
    } catch (error) {
      setState({ providerAuthOpen: false });
      toast("error", String(error));
    }
  };

  const hideLogin = () => {
    setState({ providerAuthOpen: false });
    cmd.webviewMode("chat").catch((error) => toast("error", String(error)));
  };

  const testConnection = async () => {
    try {
      const result = await cmd.providerDiagnose();
      if (!result.mounted) {
        toast("warn", "Sign-in window is closed. Open it before testing.");
        return;
      }
      toast(result.ping_ms == null ? "warn" : "info", [
        `login: ${result.login_state ?? "unknown"}`,
        `bridge: ${result.ping_ms == null ? "unavailable" : `${result.ping_ms} ms`}`,
        `input: ${result.input_found == null ? "unknown" : result.input_found ? "found" : "missing"}`,
        `send: ${result.send_button_found == null ? "unknown" : result.send_button_found ? "found" : "missing"}`,
        `messages: ${result.messages_found == null ? "unknown" : result.messages_found ? "found" : "missing"}`,
      ].join(" · "));
      if (result.ping_ms == null && result.last_bridge_error) toast("error", result.last_bridge_error);
    } catch (error) {
      toast("error", `Provider diagnostics failed: ${String(error)}`);
    }
  };

  const status = s.providerLoginState === "logged_in"
    ? "Session ready"
    : s.providerLoginState === "logged_out"
      ? "Sign-in needed"
      : s.providerLoginState === "challenge"
        ? "Verification required"
        : s.providerLoginState === "loading"
          ? "Provider page loading"
      : s.providerMounted
        ? "Session status unknown"
        : "Not signed in";

  return (
    <section class="provider-pane" aria-label="Provider sign-in">
      <header class="provider-auth-header">
        <div class="provider-auth-title">
          <span class="provider-auth-icon"><Icon name="spark" size={17} /></span>
          <span>{s.providerAuthOpen ? "Sign-in window" : "Provider sign-in"}</span>
        </div>
        <button class="provider-return" onClick={s.providerAuthOpen ? hideLogin : () => setState({ view: "chat", providerAuthOpen: false })}>
          {s.providerAuthOpen ? "Hide window" : <><Icon name="arrow-left" size={14} /> Back to chat</>}
        </button>
      </header>
      <div class="provider-host" ref={host}>
        {!s.providerAuthOpen ? (
          <div class="provider-auth-card">
            <div class="provider-auth-mark"><Icon name="spark" size={22} /></div>
            <div class="provider-status-line">{selectedProfile?.name ?? "No provider selected"}<span>{status}</span><span class={`provider-status-dot ${s.providerLoginState === "logged_in" ? "ready" : ""}`} /></div>
            <h2>{selectedProfile ? `Sign in to ${selectedProfile.name}` : "Choose a provider in Settings"}</h2>
            <p>Sign in here, then continue in Neelima chat.</p>
            <button class="provider-primary" onClick={openLogin}>
              {selectedProfile ? (s.providerMounted ? "Manage sign-in" : "Open sign-in window") : "Open Settings"}
              {selectedProfile ? <Icon name="arrow-up-right" size={15} /> : <Icon name="settings" size={15} />}
            </button>
            <details class="provider-advanced">
              <summary>Connection options</summary>
              <div>
                {s.providerMounted ? <button onClick={() => void testConnection()}>Test connection</button> : null}
                {s.providerMounted ? <button class="danger" onClick={() => cmd.providersClose().catch((error) => toast("error", String(error)))}>Close provider session</button> : <span>Browser sign-in is isolated from Neelima's workspace and chat.</span>}
              </div>
            </details>
            <p class="provider-disclaimer">Website adapters can change when providers update their sites. Signing in does not grant API access.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default ProviderPane;
