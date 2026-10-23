// Small, on-demand sign-in surface. Provider websites are never the workspace
// chat; normal prompts, responses, and tool approvals stay in Neelima.
import { useEffect, useRef, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { providerStateLabel } from "../providerStatus";
import { Icon } from "./Icon";

export function ProviderPane() {
  const s = useStore();
  const host = useRef<HTMLDivElement>(null);
  const [diagnostic, setDiagnostic] = useState<any>(null);
  const [checking, setChecking] = useState(false);
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
    if (checking) return;
    setChecking(true);
    setDiagnostic(null);
    try {
      const result = await cmd.providerDiagnose();
      if (!result.mounted) {
        setDiagnostic({ status: "closed", connected: false, message: "The provider session is closed. Open the sign-in window first, then test again." });
        return;
      }
      setDiagnostic(result);
    } catch (error) {
      setDiagnostic({ status: "error", connected: false, message: `Connection test failed: ${String(error)}` });
    } finally {
      setChecking(false);
    }
  };

  const [probe, setProbe] = useState<any>(null);
  const [probing, setProbing] = useState(false);
  const runReadyCheck = async () => {
    if (!selectedProfileId || probing) return;
    setProbing(true);
    setProbe(null);
    try {
      const result = await cmd.providerProbe(`web:${selectedProfileId}`);
      setProbe(result);
      toast(
        result.ready ? "info" : "warn",
        result.ready
          ? "READY check passed — the assistant reply reached Neelima."
          : "The provider replied, but not with READY. The captured reply is shown below.",
      );
    } catch (error) {
      setProbe({ ok: false, error: String(error) });
      toast("error", `READY check failed: ${String(error)}`);
    } finally {
      setProbing(false);
    }
  };

  const matchedMarkers = (diagnostic?.matched_markers ?? []) as string[];
  const composerReady = diagnostic?.input_found === true;
  const connectionLooksUsable = diagnostic?.connected === true
    || (composerReady && (matchedMarkers.length > 0 || s.providerLoginState === "logged_in"));

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
            {s.providerLoginReason && s.providerLoginState !== "logged_in" ? <p class="dim">{s.providerLoginReason}</p> : null}
            {s.providerRequest ? <p class="dim">Last provider request: {providerStateLabel(s.providerRequest.state)}{s.providerEventNote ? ` · ${s.providerEventNote}` : ""}</p> : null}
            <button class="provider-primary" onClick={openLogin}>
              {selectedProfile ? (s.providerMounted ? "Manage sign-in" : "Open sign-in window") : "Open Settings"}
              {selectedProfile ? <Icon name="arrow-up-right" size={15} /> : <Icon name="settings" size={15} />}
            </button>
            {s.providerMounted ? <button class="provider-test" disabled={checking} onClick={() => void testConnection()}>{checking ? "Checking provider…" : "Test connection"}</button> : null}
            {selectedProfile ? <button class="provider-test" disabled={probing} onClick={() => void runReadyCheck()}>{probing ? "Running READY check…" : "Send READY check"}</button> : null}
            {probe ? (
              <div class={`provider-diagnostic ${probe.ready ? "success" : "failure"}`} role="status" aria-live="polite">
                <strong>{probe.ok ? (probe.ready ? "READY check passed" : "Reply captured (not READY)") : "READY check failed"}</strong>
                {probe.error ? <span>{probe.error}</span> : <span>Captured after {probe.elapsed_ms} ms. This is the reply Neelima received through its normal pipeline.</span>}
                {probe.reply ? <pre class="tool-out">{String(probe.reply).slice(0, 2000)}</pre> : null}
                {probe.request_id ? <small>request {probe.request_id}</small> : null}
              </div>
            ) : null}
            {s.providerMounted && s.providerLoginState !== "logged_in" ? (
              <button class="provider-test" onClick={() => { cmd.providerMarkSignedIn().catch(() => {}); setState({ providerLoginState: "logged_in", providerBridgeError: null }); toast("info", "Marked as signed in. Continue in Neelima chat."); }}>I'm signed in</button>
            ) : null}
            <details class="provider-advanced">
              <summary>Connection options</summary>
              <div>
                {s.providerMounted ? <button class="danger" onClick={() => cmd.providersClose().catch((error) => toast("error", String(error)))}>Close provider session</button> : <span>Browser sign-in is isolated from Neelima's workspace and chat.</span>}
              </div>
            </details>
            {diagnostic ? (
              <div class={`provider-diagnostic ${diagnostic.connected || connectionLooksUsable ? "success" : "failure"}`} role="status" aria-live="polite">
                <strong>{diagnostic.connected || connectionLooksUsable ? "Connection ready" : diagnostic.status === "loading" ? "Still loading" : "Connection not ready"}</strong>
                <span>{diagnostic.message}</span>
                {diagnostic.ping_ms != null ? <small>Bridge responded in {diagnostic.ping_ms} ms · sign-in: {diagnostic.login_state ?? "unknown"} · composer: {diagnostic.input_found ? "found" : "missing"}{diagnostic.visibility_state ? ` · page: ${diagnostic.visibility_state}` : ""}</small> : null}
                {matchedMarkers.length ? <small>Signed-in evidence: {matchedMarkers.slice(0, 6).join(", ")}</small> : null}
                <div class="approval-actions">
                  <button class="link" onClick={() => void (async () => {
                    // Step 2 (I): attach the backend's metadata-only request
                    // lifecycle log (all providers) to the copied report.
                    const requestLog = await cmd.requestLog().catch(() => [] as any[]);
                    navigator.clipboard.writeText(JSON.stringify({ ...diagnostic, provider_events: s.providerEvents, request_log: requestLog }, null, 2))
                      .then(() => toast("info", "Diagnostics copied to the clipboard."))
                      .catch(() => toast("error", "Could not copy diagnostics."));
                  })()}>Copy diagnostics</button>
                </div>
              </div>
            ) : null}
            <p class="provider-disclaimer">Website adapters can change when providers update their sites. Signing in does not grant API access.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default ProviderPane;
