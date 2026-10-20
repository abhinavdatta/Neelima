import { useRef, useState } from "preact/hooks";
import { getState, resetTask, setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { addWorkspace } from "./Sidebar";

const MODE_LABEL: Record<string, string> = {
  ask_all: "Ask every time",
  ask_writes: "Auto-approve reads",
  full_access: "Full access",
};

const PROMPTS: Record<string, string> = {
  "Deep Research": "Research this project thoroughly, inspect the relevant files, and give me a concise evidence-based summary with next steps.",
  "Make an Image": "Help me create an image for this project. First clarify the intended use and visual direction, then prepare a detailed image prompt.",
  Search: "Search this project for ",
  "Create music": "Help me draft a creative music brief for this project, including mood, genre, tempo, and instrumentation.",
};

export function Composer() {
  const s = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<null | "provider" | "mode">(null);
  const readOnly = s.view === "task";
  const hasText = !!s.composerText.trim();

  const send = async () => {
    const text = getState().composerText.trim();
    if (!text) return;
    const current = getState();
    if (current.agentState !== "idle" && current.agentState !== "done" && current.agentState !== "error") {
      toast("warn", "A task is already running.");
      return;
    }
    if (!current.activeWorkspacePath) {
      toast("warn", "Choose a project folder with the + button before sending a task.");
      return;
    }
    resetTask();
    setState({ composerText: "" });
    try {
      await cmd.taskStart(text, current.providerSelected);
      setState({ view: "chat" });
    } catch (e) {
      toast("error", String(e));
    }
  };

  const label = providerLabel(s);

  return (
    <footer class="composer">
      <div class="composer-box">
        <div class="composer-meta">
          <div class="composer-meta-group">
            <span class="composer-sparkle" aria-hidden="true">✦</span>
            <span>{s.activeWorkspacePath ? "Private workspace · ready when you are" : "Add a project folder to get started"}</span>
            <div class="composer-menu-anchor">
              <button class="micro-action" title="Change permission mode" onClick={() => setMenu(menu === "mode" ? null : "mode")}>
                {s.settings ? MODE_LABEL[s.settings.permission_mode] : "Ask every time"} <span>⌄</span>
              </button>
              {menu === "mode" ? <ModeMenu onPick={async (mode) => { setMenu(null); await applyMode(mode); }} /> : null}
            </div>
          </div>
          <div class="composer-menu-anchor">
            <button class="composer-provider" onClick={async () => { setMenu(menu === "provider" ? null : "provider"); await loadProviderMenu(); }}>
              <span aria-hidden="true">⚙</span> Powered by {label} <span>⌄</span>
            </button>
            {menu === "provider" ? <ProviderMenu onPick={(provider) => { setMenu(null); setState({ providerSelected: provider }); }} /> : null}
          </div>
        </div>
        <div class="composer-input-row">
          <button class="composer-plus" title="Add a project folder" aria-label="Add a project folder" onClick={() => void addWorkspace()}>
            <svg viewBox="0 0 20 20"><path d="M10 3v14M3 10h14" /></svg>
          </button>
          <textarea
            ref={ref}
            rows={1}
            value={s.composerText}
            placeholder={readOnly ? "Viewing a past task — start a new task to continue" : 'Example: "Explain this project in simple terms"'}
            disabled={readOnly}
            onInput={(event: any) => setState({ composerText: event.currentTarget.value })}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
          />
          <button class="composer-mic" title="Voice input is not available yet" aria-label="Voice input unavailable" disabled>
            <svg viewBox="0 0 20 20"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7 18h6" /></svg>
          </button>
          <button class="send-btn" title="Send task" aria-label="Send task" onClick={() => void send()} disabled={!hasText || readOnly}>
            <svg viewBox="0 0 20 20"><path d="m3 9 14-6-5.5 14-2.2-6.3L3 9Z" /><path d="m9.3 10.7 3.5-3.5" /></svg>
          </button>
        </div>
        <div class="prompt-chips" aria-label="Prompt starters">
          <button onClick={() => setState({ composerText: PROMPTS["Deep Research"] })}><span>⚛</span> Deep Research</button>
          <button onClick={() => setState({ composerText: PROMPTS["Make an Image"] })}><span>▧</span> Make an Image</button>
          <button onClick={() => { setState({ composerText: PROMPTS.Search }); ref.current?.focus(); }}><span>⌕</span> Search</button>
          <button onClick={() => setState({ composerText: PROMPTS["Create music"] })}><span>♫</span> Create music</button>
          <button class="prompt-more" title="Open tools and files" onClick={() => setState({ view: "files" })}>…</button>
        </div>
      </div>
    </footer>
  );
}

async function applyMode(mode: string) {
  const s = getState();
  if (!s.settings) return;
  if (mode === "full_access" && s.settings.permission_mode !== "full_access" &&
      !window.confirm("Full access lets the agent run workspace reads, edits, and commands without per-action approval. Destructive commands and built-in safety checks still require approval. Continue?")) {
    return;
  }
  try {
    const next = await cmd.settingsSet({ ...s.settings, permission_mode: mode as any });
    setState({ settings: next });
  } catch (e) { toast("error", String(e)); }
}

async function loadProviderMenu() {
  try {
    const [providers, settings] = await Promise.all([cmd.providersList(), cmd.settingsGet()]);
    setState({ providers, settings });
  } catch (e) { toast("error", `Could not load providers: ${String(e)}`); }
}

function providerLabel(s: any): string {
  const id = s.providerSelected as string;
  if (id.startsWith("web:")) {
    const p = s.providers?.web?.find((w: any) => w.id === id.slice(4));
    return p ? p.name : "Web provider";
  }
  if (id === "ollama") return `Ollama${s.settings?.providers?.ollama?.model ? ` · ${s.settings.providers.ollama.model}` : ""}`;
  if (id === "lmstudio") return `LM Studio${s.settings?.providers?.lmstudio?.model ? ` · ${s.settings.providers.lmstudio.model}` : ""}`;
  return "Manual relay";
}

function ModeMenu({ onPick }: { onPick: (mode: string) => void }) {
  return (
    <div class="menu">
      <button onClick={() => onPick("ask_all")}>Ask every time (safest)</button>
      <button onClick={() => onPick("ask_writes")}>Auto-approve reads, ask for writes</button>
      <button onClick={() => onPick("full_access")}>Full access inside workspace</button>
    </div>
  );
}

function ProviderMenu({ onPick }: { onPick: (provider: string) => void }) {
  const s = useStore();
  const webs: any[] = s.providers?.web ?? [];
  return (
    <div class="menu wide">
      <div class="menu-head">Embedded web chats (your login)</div>
      {webs.length === 0 ? <div class="menu-note">None yet — add one in Settings.</div> : null}
      {webs.map((provider) => <button key={provider.id} onClick={() => onPick(`web:${provider.id}`)}>{provider.name}</button>)}
      <div class="menu-head">Local models</div>
      <button onClick={() => onPick("ollama")}>Ollama {s.settings?.providers?.ollama ? "" : "(not configured)"}</button>
      <button onClick={() => onPick("lmstudio")}>LM Studio {s.settings?.providers?.lmstudio ? "" : "(not configured)"}</button>
      <div class="menu-head">Fallback</div>
      <button onClick={() => onPick("manual")}>Manual relay (copy/paste)</button>
      <button class="menu-cta" onClick={() => setState({ settingsOpen: true })}>Open Settings…</button>
    </div>
  );
}

export default Composer;
