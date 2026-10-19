// App shell: wires the event channel, loads settings/providers/tasks, renders
// the ZCode-style layout (sidebar / titlebar / content / composer).
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

  const showTree = !!s.activeWorkspacePath && (s.view === "chat" || s.view === "task");

  return (
    <div id="app">
      <Sidebar />
      {showTree ? <FileTree /> : null}
      <main class="main">
        <TitleBar />
        <section class="content">
          {s.view === "chat" || s.view === "task" ? <Chat /> : null}
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
      setState({ view: "provider" });
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
      setState({ providerMounted: true });
      break;
    case "provider-unmounted":
      setState({ providerMounted: false });
      break;
    case "provider-login-waiting":
      setState({ providerLoginWaiting: true, view: "provider" });
      break;
    case "provider-bridge-unreachable":
      // The chip would keep lying "Waiting for login…" — say what's actually wrong.
      toast("warn", `Can't reach the embedded ${p.adapter} page (bridge). Reopen the provider view; if it persists, restart Neelima.`);
      break;
    case "provider-login-complete":
      setState({ providerLoginWaiting: false, providerMounted: true });
      break;
    case "adapters-reloaded":
      cmd.adaptersList().then((a) => setState({ adapters: a })).catch(() => {});
      break;
  }
}

export default App;
