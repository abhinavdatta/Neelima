import { useEffect, useRef, useState } from "preact/hooks";
import { getState, resetTask, setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { addWorkspace } from "./Sidebar";
import { Icon } from "./Icon";

const MODE_LABEL: Record<string, string> = {
  ask_all: "Ask every time",
  ask_writes: "Auto-approve reads",
  full_access: "Full access",
};

const PROMPTS: Record<string, string> = {
  "Project review": "Review this project thoroughly, inspect relevant files, and give me a concise evidence-based summary with next steps.",
  "Image brief": "Help me create an image brief for this project. First clarify the intended use and visual direction, then prepare a detailed image prompt.",
  "Search project": "Search this project for ",
  "Music brief": "Help me draft a creative music brief for this project, including mood, genre, tempo, and instrumentation.",
};

export function Composer() {
  const s = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<null | "provider" | "mode">(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillBudget, setSkillBudget] = useState(8192);
  const readOnly = s.view === "task";
  const hasText = !!s.composerText.trim();
  const taskBusy = s.taskStartPending || (s.agentState !== "idle" && s.agentState !== "done" && s.agentState !== "error" && s.agentState !== "cancelled");

  useEffect(() => { void cmd.skillsList().then(setSkills).catch(() => setSkills([])); }, []);

  const send = async () => {
    const text = getState().composerText.trim();
    if (!text) return;
    const current = getState();
    if (current.taskStartPending) return;
    if (current.agentState !== "idle" && current.agentState !== "done" && current.agentState !== "error" && current.agentState !== "cancelled") {
      toast("warn", "A task is already running.");
      return;
    }
    if (!current.activeWorkspacePath) {
      toast("warn", "Choose a project folder with the + button before sending a task.");
      return;
    }
    if (selectedSkills.length && current.providerSelected.startsWith("web:") &&
        !window.confirm("Selected SKILL.md contents will be included in the first task message sent to the selected web AI provider. Continue?")) return;
    resetTask();
    setState({ activeTaskSkills: selectedSkills.map((key) => skills.find((skill) => `${skill.location}:${skill.id}` === key)?.name ?? key) });
    // Preserve the prompt while the backend starts. A failed start must not eat user input.
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    setState({ composerText: text, taskStartPending: true, taskStartRequestId: requestId });
    try {
      const taskId = await cmd.taskStart(text, current.providerSelected, requestId, selectedSkills, skillBudget);
      setState((s2) => ({
        taskId,
        taskStartPending: false,
        taskStartRequestId: null,
        view: "chat",
        composerText: "",
        // The invoke can resolve before the first agent-state event arrives.
        // Keep the composer locked for the accepted task during that gap.
        agentState: s2.agentState === "idle" ? "waiting_for_ai" : s2.agentState,
        taskStartedAt: s2.taskStartedAt ?? Date.now(),
      }));
    } catch (e) {
      setState({ taskId: null, taskStartPending: false, taskStartRequestId: null, composerText: text, activeTaskSkills: [] });
      toast("error", String(e));
    }
  };

  const label = providerLabel(s);

  return (
    <footer class="composer">
      <div class="composer-box">
        <div class="composer-meta">
          <div class="composer-meta-group">
            <span class="composer-sparkle"><Icon name="spark" size={14} /></span>
            <span>{s.activeWorkspacePath ? "Private workspace · ready when you are" : "Add a project folder to get started"}</span>
            <div class="composer-menu-anchor">
              <button class="micro-action" title="Change permission mode" onClick={() => setMenu(menu === "mode" ? null : "mode")}>
                {s.settings ? MODE_LABEL[s.settings.permission_mode] : "Ask every time"} <Icon name="chevron" class="select-chevron" size={13} />
              </button>
              {menu === "mode" ? <ModeMenu onPick={async (mode) => { setMenu(null); await applyMode(mode); }} /> : null}
            </div>
          </div>
          <div class="composer-menu-anchor">
            <button class="composer-provider" onClick={async () => { setMenu(menu === "provider" ? null : "provider"); await loadProviderMenu(); }}>
              <Icon name="settings" size={13} /> Powered by {label} <Icon name="chevron" class="select-chevron" size={13} />
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
          <button class="send-btn" title={taskBusy ? "A task is running" : "Send task"} aria-label="Send task" onClick={() => void send()} disabled={!hasText || readOnly || taskBusy}>
            <svg viewBox="0 0 20 20"><path d="m3 9 14-6-5.5 14-2.2-6.3L3 9Z" /><path d="m9.3 10.7 3.5-3.5" /></svg>
          </button>
        </div>
        <div class="prompt-chips" aria-label="Prompt starters">
          <button onClick={() => setState({ composerText: PROMPTS["Project review"] })}><Icon name="layers" size={14} /> Project review</button>
          <button onClick={() => setState({ composerText: PROMPTS["Image brief"] })}><Icon name="spark" size={14} /> Image brief</button>
          <button onClick={() => { setState({ composerText: PROMPTS["Search project"] }); ref.current?.focus(); }}><Icon name="search" size={14} /> Search project</button>
          <button onClick={() => setState({ composerText: PROMPTS["Music brief"] })}><Icon name="spark" size={14} /> Music brief</button>
          <button class="prompt-more" title="Open tools and files" aria-label="Open tools and files" onClick={() => setState({ view: "files" })}><Icon name="more" size={16} /></button>
        </div>
        <details class="task-skills-picker">
          <summary>Task skills{selectedSkills.length ? ` · ${selectedSkills.length} selected` : " · none"}</summary>
          <div class="task-skills-panel">
            <p class="dim">Only selected skills are included in this task. Their text is untrusted guidance and cannot change permissions or approvals.</p>
            {skills.filter((skill) => skill.enabled).map((skill) => {
              const key = `${skill.location}:${skill.id}`;
              return <label key={key}><input type="checkbox" checked={selectedSkills.includes(key)} onChange={(e: any) => { const checked = e.currentTarget.checked; setSelectedSkills((current) => checked ? [...current, key] : current.filter((id) => id !== key)); }} /> {skill.name} <small>{skill.location}</small></label>;
            })}
            {!skills.some((skill) => skill.enabled) ? <span class="dim">No enabled skills. Install or enable them in Marketplace.</span> : null}
            <label class="task-skill-budget">Skill token budget (estimated)<input type="number" min="64" max="12000" step="256" value={skillBudget} onInput={(e: any) => setSkillBudget(Math.max(64, Math.min(12000, Number(e.currentTarget.value) || 64)))} /></label>
          </div>
        </details>
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
      <div class="menu-head">Browser sign-in adapters</div>
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
