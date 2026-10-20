// App shell: wires the event channel, restores the active workspace, and renders
// the rail / floating panel / home / composer layout.
import { useEffect } from "preact/hooks";
import { listen } from "./tauri";
import { cmd } from "./tauri";
import { getState, setState, toast, useStore } from "./store";
import Sidebar from "./components/Sidebar";
import FileTree from "./components/FileTree";
import TitleBar from "./components/TitleBar";
import Chat from "./components/Chat";
import Composer from "./components/Composer";
import ProviderPane from "./components/ProviderPane";
import AutomationsPane from "./components/AutomationsPane";
import MarketplacePane from "./components/MarketplacePane";
import SearchPane from "./components/SearchPane";
import SettingsModal from "./components/SettingsModal";
import TerminalPanel from "./components/TerminalPanel";
import DiffModal from "./components/DiffModal";
import "./styles.css";

export function App() {
  const s = useStore();

  useEffect(() => {
    (async () => {
      try {
        const settings = await cmd.settingsGet();
        setState({ settings });
        const wl = await cmd.workspaceList();
        const active = wl.workspaces.find((w: any) => w.id === wl.active);
        setState({ workspaces: wl.workspaces, activeWorkspace: wl.active, activeWorkspacePath: active?.path ?? null });
        if (active) {
          try {
            await cmd.workspaceUse(active.id);
          } catch (e) {
            setState({ activeWorkspace: null, activeWorkspacePath: null });
            toast("warn", `Saved project folder is unavailable: ${String(e)}`);
          }
        }
        const [adapters, providers, tasks] = await Promise.all([cmd.adaptersList(), cmd.providersList(), cmd.historyTasks()]);
        setState({ adapters, providers, tasks });
        const preferred = inferPreferredProvider(settings, providers);
        setState({ providerSelected: preferred });
      } catch (e) {
        toast("error", String(e));
      }

      await listen("evt", (e: any) => handleEvent(e.payload));
    })();

    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey && ev.key.toLowerCase() === "n") {
        ev.preventDefault();
        import("./store").then((m) => m.resetTask());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (s.view !== "provider") {
      cmd.webviewMode("chat").catch((e) => toast("error", `Could not hide the provider view: ${String(e)}`));
    }
  }, [s.view]);

  const showWelcome = s.view === "chat" && s.entries.length === 0;

  return (
    <div id="app">
      <Sidebar />
      <main class="main-panel">
        <TitleBar />
        {showWelcome ? <Welcome /> : null}
        <section class="content">
          {s.view === "chat" || s.view === "task" ? <Chat /> : null}
          {s.view === "files" ? <FileTree /> : null}
          {s.view === "provider" ? <ProviderPane /> : null}
          {s.view === "automations" ? <AutomationsPane /> : null}
          {s.view === "marketplace" ? <MarketplacePane /> : null}
          {s.view === "search" ? <SearchPane /> : null}
        </section>
        <Composer />
        {s.terminalOpen ? <TerminalPanel /> : null}
      </main>
      <SettingsModal />
      <DiffModal />
      <div class="toasts">
        {s.toasts.map((t) => (
          <div class={`toast toast-${t.level}`} key={t.id}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function Welcome() {
  const s = useStore();
  return (
    <section class="welcome">
      <div class="welcome-hero">
        <div>
          <h1>Hi there, Ready to Achieve Great Things?</h1>
          <p>{s.activeWorkspacePath ? `Working in ${s.activeWorkspacePath}` : "Choose a project folder to give your assistant a place to work."}</p>
        </div>
        <div class="mascot-scene" aria-hidden="true">
          <div class="mascot-bubble">Hey there! <span>👋</span><br />Need a boost?</div>
          <div class="mascot">
            <div class="robot-antenna" />
            <div class="robot-head"><div class="robot-visor"><i /><i /></div></div>
            <div class="robot-neck" />
            <div class="robot-body"><span /></div>
            <div class="robot-arm arm-left" /><div class="robot-arm arm-right" />
          </div>
        </div>
      </div>
      <div class="feature-grid">
        <button class="feature-card" onClick={() => setState({ composerText: "Help me contribute ideas and organize the work in this project." })}>
          <span class="feature-icon layers-icon" aria-hidden="true"><i /><i /><i /></span>
          <span class="feature-copy">Contribute ideas, offer feedback, and manage tasks — all in sync.</span>
          <span class="feature-label">Fast Start</span>
        </button>
        <button class="feature-card" onClick={() => setState({ composerText: "Help me collaborate on this project: summarize the context, suggest next steps, and identify what needs alignment." })}>
          <span class="feature-icon team-icon" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <span class="feature-copy">Stay connected, share ideas, and align goals effortlessly. Boost your productivity with AI.</span>
          <span class="feature-label">Collaborate with Team</span>
        </button>
        <button class="feature-card" onClick={() => setState({ composerText: "Help me plan my next steps for this project and prioritize the work." })}>
          <span class="feature-icon calendar-icon" aria-hidden="true"><b>31</b></span>
          <span class="feature-copy">Organize your time efficiently, set clear priorities, and stay focused.</span>
          <span class="feature-label">Planning</span>
        </button>
      </div>
    </section>
  );
}

function inferPreferredProvider(settings: any, providers: any): string {
  if (providers?.web?.length) return `web:${providers.web[0].id}`;
  if (settings?.providers?.ollama?.model) return "ollama";
  if (settings?.providers?.lmstudio?.model) return "lmstudio";
  return "manual";
}

function handleEvent(p: any) {
  if (!p || !p.kind) return;
  const st = getState();
  switch (p.kind) {
    case "agent-state":
      setState({ agentState: p.state, agentText: p.text ?? null, taskStartedAt: st.taskStartedAt ?? (p.state === "waiting_for_ai" ? Date.now() : st.taskStartedAt) });
      if (p.text) toast(p.state === "error" ? "error" : "info", p.text);
      break;
    case "transcript":
      if (p.entry) setState((s2) => ({ entries: [...s2.entries, p.entry] }));
      break;
    case "approval-request":
      setState({ pendingCalls: p.pending_calls ?? [] });
      break;
    case "command-output": {
      const key = p.call_id;
      setState((s2) => ({ commandChunks: { ...s2.commandChunks, [key]: (s2.commandChunks[key] ?? "") + p.chunk } }));
      break;
    }
    case "relay-outbound":
      setState({ relayOutbound: p.text });
      break;
    case "manual-fallback":
      toast("warn", "Provider needs login — switched to manual relay.");
      break;
    case "provider-login-required":
      toast("warn", `Please log into ${p.adapter} inside the provider view.`);
      setState({ view: "provider", providerLoginWaiting: true, providerLoginState: "logged_out" });
      break;
    case "term-data":
      window.dispatchEvent(new CustomEvent("term-data", { detail: p }));
      break;
    case "term-exit":
      window.dispatchEvent(new CustomEvent("term-exit", { detail: p }));
      break;
    case "notify":
      toast(p.level ?? "info", p.text ?? "");
      break;
    case "provider-mounted":
      setState({ providerMounted: true, providerLoginState: "unknown", providerBridgeError: null });
      break;
    case "provider-unmounted":
      setState({ providerMounted: false, providerLoginState: "unknown", providerBridgeError: null });
      break;
    case "provider-login-waiting":
      setState({ providerLoginWaiting: true, view: "provider" });
      break;
    case "provider-login-state":
      setState({
        providerLoginState: p.state ?? "unknown",
        providerLoginWaiting: p.state === "logged_out",
        providerBridgeError: p.state === "unknown" ? (p.reason ?? "Page state is unknown") : null,
      });
      break;
    case "provider-bridge-unreachable":
      // The chip would keep lying "Waiting for login…" — say what's actually wrong.
      toast("warn", `Can't reach the embedded ${p.adapter} page (bridge). Reopen the provider view; if it persists, restart Neelima.`);
      setState({
        providerLoginWaiting: false,
        providerBridgeError: p.reason ?? "Can't reach the embedded provider page",
      });
      break;
    case "provider-login-complete":
      setState({ providerLoginWaiting: false, providerMounted: true, providerLoginState: "logged_in", providerBridgeError: null });
      break;
    case "adapters-reloaded":
      cmd.adaptersList().then((a) => setState({ adapters: a })).catch(() => {});
      break;
  }
}

export default App;
