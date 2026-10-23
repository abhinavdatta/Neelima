// App shell: wires the event channel, restores the active workspace, and renders
// the rail / floating panel / home / composer layout.
import { useEffect } from "preact/hooks";
import { listen } from "./tauri";
import { cmd } from "./tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getState, setState, toast, useStore, resetTask } from "./store";
import Sidebar from "./components/Sidebar";
import FileTree from "./components/FileTree";
import TitleBar, { WindowMoveStrip } from "./components/TitleBar";
import Chat from "./components/Chat";
import Composer from "./components/Composer";
import ProviderPane from "./components/ProviderPane";
import AutomationsPane from "./components/AutomationsPane";
import MarketplacePane from "./components/MarketplacePane";
import SearchPane from "./components/SearchPane";
import SettingsModal from "./components/SettingsModal";
import TerminalPanel from "./components/TerminalPanel";
import DiffModal from "./components/DiffModal";
import { Icon } from "./components/Icon";
import { DEFAULT_CUSTOM_THEME, parseCustomTheme, THEME_TOKENS } from "./theme";
import { describePushRejection, reduceProviderRequestEvent, reduceStreamEvent } from "./providerStatus";
import { noteSecretClick } from "./easterEggs";
import "./styles.css";

let earlyTaskEvents: any[] = [];

export function App() {
  const s = useStore();

  useEffect(() => {
    const requested = s.settings?.theme ?? "dark";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const isPureDark = requested === "pure_dark";
      const isCustom = requested === "custom";
      const resolved = requested === "system" ? (media.matches ? "dark" : "light")
        : isPureDark ? "dark" : isCustom ? "custom" : requested;
      const root = document.documentElement;
      root.dataset.theme = resolved;
      root.dataset.themeVariant = isPureDark ? "pure-dark" : "";
      root.style.colorScheme = resolved === "light" ? "light" : "dark";
      for (const token of THEME_TOKENS) root.style.removeProperty(token);
      if (isCustom) {
        const custom = parseCustomTheme(s.settings?.custom_theme || DEFAULT_CUSTOM_THEME);
        if (!custom.error) {
          for (const [token, color] of Object.entries(custom.colors)) root.style.setProperty(token, color);
        } else {
          root.dataset.theme = "dark";
        }
      }
    };
    apply();
    if (requested === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [s.settings?.theme, s.settings?.custom_theme]);

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
        resetTask();
      }
    };
    window.addEventListener("keydown", onKey);
    // Independent viewport-fit path: the Rust resize handler re-fits the UI
    // webview, but a missed window-resize event leaves the webview stale and
    // oversized, which pushed centered modals past the visible window edge.
    // The webview's own window-resize event is a second, independent trigger.
    const unResize = getCurrentWindow().onResized(() => {
      cmd.syncViewport().catch(() => {});
    });
    cmd.syncViewport().catch(() => {});
    return () => {
      window.removeEventListener("keydown", onKey);
      unResize.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const mode = s.view === "provider" && s.providerAuthOpen && !s.settingsOpen ? "provider" : "chat";
    cmd.webviewMode(mode).catch((e) => toast("error", `Could not update the provider view: ${String(e)}`));
  }, [s.view, s.settingsOpen]);

  const showWelcome = s.view === "chat" && s.entries.length === 0;
  // Route-aware shell: the persistent composer belongs to chat surfaces only
  // (home + active conversation). Settings, provider, marketplace,
  // automations, files and search are not chat sessions. The draft lives in
  // the store (composerText), so hiding the composer never discards input.
  const showComposer = (s.view === "chat" || s.view === "task") && !s.settingsOpen;

  return (
    <div id="app">
      <Sidebar />
      <div class="window-shell">
        <WindowMoveStrip />
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
          {showComposer ? <Composer /> : null}
          {s.terminalOpen ? <TerminalPanel /> : null}
        </main>
      </div>
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
          {/* 🥚 seven quick clicks tell you a secret (easterEggs.ts) */}
          <h1 onClick={noteSecretClick}>Hi there, Ready to Achieve Great Things?</h1>
          <p title={s.activeWorkspacePath ?? undefined}>{s.activeWorkspacePath ? `Working in ${s.activeWorkspacePath}` : "Choose a project folder to give your assistant a place to work."}</p>
        </div>
      </div>
      <div class="feature-grid">
        <button class="feature-card" onClick={() => setState({ composerText: "Review this workspace, summarize the project, and suggest a short prioritized task list." })}>
          <span class="feature-icon"><Icon name="layers" size={24} /></span>
          <span class="feature-copy">Ask Neelima to inspect the open workspace and summarize the project.</span>
          <span class="feature-label">Review this project</span>
        </button>
        <button class="feature-card" onClick={() => setState({ composerText: "Explain the main files and architecture in this workspace in clear, beginner-friendly language." })}>
          <span class="feature-icon"><Icon name="code" size={23} /></span>
          <span class="feature-copy">Get a guided explanation based on files in the selected workspace.</span>
          <span class="feature-label">Explain this codebase</span>
        </button>
        <button class="feature-card" onClick={() => setState({ composerText: "Inspect this workspace and identify the three most useful next engineering tasks, with reasons." })}>
          <span class="feature-icon"><Icon name="arrow-up-right" size={22} /></span>
          <span class="feature-copy">Get practical next steps grounded in the project's current files.</span>
          <span class="feature-label">Plan next steps</span>
        </button>
      </div>
    </section>
  );
}

function inferPreferredProvider(settings: any, providers: any): string {
  if (providers?.web?.length) return `web:${providers.web[0].id}`;
  if (settings?.providers?.ollama?.model) return "ollama";
  if (settings?.providers?.lmstudio?.model) return "lmstudio";
  // Manual copy/paste relay is an explicit fallback, never the default path.
  return "ollama";
}

function handleEvent(p: any) {
  if (!p || !p.kind) return;
  const st = getState();
  if (p.kind === "task-started") {
    if (typeof p.task_id !== "string") return;
    const matchesPendingRequest = st.taskStartPending && st.taskStartRequestId === p.request_id;
    const matchesAcceptedTask = st.taskId === p.task_id;
    if (matchesPendingRequest || matchesAcceptedTask) {
      setState((current) => ({
        taskId: p.task_id,
        agentState: current.agentState === "idle" ? "waiting_for_ai" : current.agentState,
        streamText: "",
        taskStartedAt: current.taskStartedAt ?? Date.now(),
      }));
      if (matchesPendingRequest) {
        const queued = earlyTaskEvents;
        earlyTaskEvents = [];
        queued.filter((event) => event.task_id === p.task_id).forEach(handleEvent);
      }
    }
    return;
  }
  const taskScopedKinds = new Set([
    "agent-state", "transcript", "approval-request", "command-output", "relay-outbound",
  ]);
  if (taskScopedKinds.has(p.kind)) {
    if (typeof p.task_id !== "string") return;
    if (st.taskId && st.taskId !== p.task_id) return;
    if (!st.taskId) {
      // Buffer events until the task-start request ID confirms which task is
      // ours. This prevents late events from an older task being adopted.
      if (st.taskStartPending && st.view !== "task") {
        earlyTaskEvents.push(p);
        if (earlyTaskEvents.length > 128) earlyTaskEvents.shift();
      }
      return;
    }
  }
  switch (p.kind) {
    case "bridge-approval-request":
      // Browser-extension write request waiting for the user's decision.
      // Shown as its own card (separate from agent-flow pendingCalls) so the
      // two approval lifecycles never mix.
      setState({
        bridgeApproval: {
          request_id: p.request_id,
          tool: p.tool ?? "unknown",
          args: p.args ?? null,
          site: p.site ?? "generic",
          risk: p.risk ?? "high",
        },
      });
      break;
    case "agent-state":
      setState({
        agentState: p.state,
        agentText: p.text ?? null,
        // The live preview belongs only to the model-wait phase; drop it as
        // soon as the loop moves on (the final reply arrives as a transcript).
        ...(p.state === "waiting_for_ai" ? {} : { streamText: "" }),
        taskStartedAt: st.taskStartedAt ?? (p.state === "waiting_for_ai" ? Date.now() : st.taskStartedAt),
      });
      if (p.text) toast(p.state === "error" ? "error" : "info", p.text);
      break;
    case "assistant-stream": {
      // Local model chunks (append). Step 2: chunks carry their request ID —
      // a late chunk from a cancelled/finished request, or one belonging to a
      // different provider/request, is dropped instead of polluting the
      // current preview.
      const chunk = reduceStreamEvent(st.providerRequest, p, "assistant-stream");
      if (chunk && st.agentState === "waiting_for_ai") {
        setState((s2) => ({ streamText: (s2.streamText + chunk.text).slice(-12000) }));
      }
      break;
    }
    case "assistant-partial": {
      // Web provider preview: the page sends the accumulated tail, not a chunk.
      const partial = reduceStreamEvent(st.providerRequest, p, "assistant-partial");
      if (partial && st.agentState === "waiting_for_ai") {
        setState({ streamText: partial.text });
      }
      break;
    }
    case "transcript":
      if (p.entry) setState((s2) => s2.entries.some((entry) => entry.id === p.entry.id && entry.ts === p.entry.ts)
        ? {} : { entries: [...s2.entries, p.entry], ...(p.entry.kind === "assistant" ? { streamText: "" } : {}) });
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
    case "provider-login-required":
      toast("warn", p.reason ?? `Please sign into ${p.adapter} in its provider window, then return to Neelima chat.`);
      setState({ view: "provider", providerAuthOpen: true, providerLoginWaiting: true, providerLoginState: p.reason?.toLowerCase().includes("challenge") || p.reason?.toLowerCase().includes("verification") ? "challenge" : "logged_out" });
      cmd.webviewMode("provider").catch((error) => toast("error", `Could not open provider sign-in: ${String(error)}`));
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
      setState({ providerMounted: true, providerLoginState: "unknown", providerBridgeError: null, providerLoginReason: null, providerRequest: null, providerEventNote: null, providerEvents: [] });
      break;
    case "provider-unmounted":
      setState({ providerMounted: false, providerLoginState: "unknown", providerBridgeError: null, providerLoginReason: null, providerRequest: null, providerEventNote: null, providerEvents: [] });
      break;
    case "provider-request-state": {
      const patch = reduceProviderRequestEvent(st.providerRequest, p);
      if (!patch) break;
      setState((s2) => ({
        providerRequest: patch.providerRequest,
        providerEventNote: null,
        // Bounded UI-side diagnostic trail: proves which transitions actually
        // reached the frontend. Metadata only.
        providerEvents: [...s2.providerEvents, { state: patch.providerRequest.state, at: patch.providerRequest.at, requestId: patch.providerRequest.requestId }].slice(-20),
        ...(patch.clearStream ? { streamText: "" } : {}),
      }));
      if (patch.toast) toast(patch.toast.level, patch.toast.text);
      break;
    }
    case "assistant-push-rejected":
      // Metadata only: the page's text was dropped by Rust. Record why so the
      // wait card can explain a missing reply instead of silently spinning.
      setState({ providerEventNote: describePushRejection(p) });
      break;
    case "provider-login-unverified":
      setState({ providerLoginReason: p.reason ?? "Provider sign-in could not be verified; a send is still attempted." });
      break;
    case "provider-login-waiting":
      setState({ providerLoginWaiting: true, providerAuthOpen: true, view: "provider" });
      break;
    case "provider-login-state": {
      const returnedToChat = p.state === "logged_in" && getState().view === "provider";
      setState({
        providerLoginState: p.state ?? "unknown",
        providerLoginWaiting: p.state === "logged_out",
        providerBridgeError: p.state === "unknown" ? (p.reason ?? "Page state is unknown") : null,
        providerLoginReason: p.state === "logged_in" ? null : (p.reason ?? null),
        ...(returnedToChat ? { view: "chat" as const, providerAuthOpen: false } : {}),
      });
      if (returnedToChat) toast("info", "Provider session ready. Continue in Neelima chat.");
      break;
    }
    case "provider-bridge-unreachable":
      // The chip would keep lying "Waiting for login…" — say what's actually wrong.
      toast("error", `${p.reason ?? `Can't reach ${p.adapter}'s chat`}. Neelima did not submit the prompt. Refresh the provider sign-in window or choose a configured API/local model.`);
      setState({
        providerLoginWaiting: false,
        providerBridgeError: p.reason ?? "Can't reach the embedded provider page",
      });
      break;
    case "provider-login-complete":
      // Keep the persistent provider webview mounted in Rust, but return to
      // Neelima's own conversation as the single workspace interface.
      setState({ providerLoginWaiting: false, providerMounted: true, providerLoginState: "logged_in", providerBridgeError: null, providerAuthOpen: false, view: "chat" });
      toast("info", "Provider session ready. Continue in Neelima chat.");
      break;
    case "adapters-reloaded":
      cmd.adaptersList().then((a) => setState({ adapters: a })).catch(() => {});
      break;
  }
}

export default App;
