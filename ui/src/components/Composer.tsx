import { useEffect, useRef, useState } from "preact/hooks";
import { getState, resetTask, setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";
import type { ContextPreview } from "../contextPreview";
import { ContextPicker } from "./ContextPicker";
import { extractAttachmentText, validateAttachment, type AttachmentFile } from "../attachments";
import { isAgentRunning } from "../agentState";
import type { DocRec } from "../editorTabs";
import { docDir, docDirty, docName } from "../editorTabs";
import {
  MAX_EDITOR_CONTEXT_ITEMS, addEditorContext, buildEditorContext, contextsForWorkspace,
  editorContextDetail, formatEditorContext, removeEditorContext,
} from "../editorContext";

type LocalAttachment = { id: string; file: File; status: string; promptText: string };

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
  const [menu, setMenu] = useState<null | "provider" | "mode" | "editor">(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillBudget, setSkillBudget] = useState(8192);
  // Step 3: project context. `contextToggle` is null until the user decides,
  // so the saved settings value is the default without overriding a choice.
  const [contextToggle, setContextToggle] = useState<boolean | null>(null);
  const [contextExclude, setContextExclude] = useState<string[]>([]);
  const [contextPreview, setContextPreview] = useState<ContextPreview | null>(null);
  const [contextScanning, setContextScanning] = useState(false);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const taskBusy = s.taskStartPending || isAgentRunning(s.agentState);
  const continuationTaskId = s.openTask?.id ?? (!taskBusy ? s.taskId : null);
  const continuationLabel = s.openTask?.title ?? (continuationTaskId ? "this conversation" : null);
  const readOnly = false;
  // CP9: only the current workspace's explicit editor context is visible and
  // sendable. This filter is the last line of defence if a workspace switch
  // races the store's cleanup effect.
  const editorContexts = contextsForWorkspace(s.editorContexts ?? [], s.activeWorkspacePath);
  // Automatic project context must not re-read those exact paths from disk:
  // the user explicitly chose the live draft/range, and a stale disk copy
  // would be a second, contradictory version of the same file.
  const previewExclude = Array.from(new Set([...contextExclude, ...editorContexts.map((item) => item.path)]));
  const hasText = !!s.composerText.trim() || editorContexts.length > 0 ||
    attachments.some((attachment) => attachment.status.startsWith("Ready"));

  const addAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    const chosen = Array.from(files);
    const existingBytes = attachments.reduce((total, item) => total + item.file.size, 0);
    let reservedBytes = existingBytes;
    const next: LocalAttachment[] = [];
    for (const file of chosen) {
      const validation = validateAttachment(file, reservedBytes);
      if (!validation.kind) { toast("warn", `${file.name}: ${validation.error}`); continue; }
      const isImage = validation.kind === "image";
      reservedBytes += file.size;
      const item: LocalAttachment = { id: `${Date.now()}-${next.length}-${file.name}`, file, status: isImage ? "Checking local image…" : "Extracting locally…", promptText: "" };
      next.push(item);
      setAttachments((current) => [...current, item]);
      if (isImage) {
        setAttachments((current) => current.map((attachment) => attachment.id === item.id
          ? { ...attachment, status: "Ready · local image only; no OCR/vision", promptText: `[Image attachment: ${file.name} (${file.type}, ${file.size} bytes). Image is preserved locally but its pixels are not included in this text prompt.]` }
          : attachment));
      } else {
        try {
          const extracted = await extractAttachmentText(file as AttachmentFile);
          const text = extracted.trim();
          const status = text ? "Ready · text extracted locally" : "Ready · no embedded text found (scanned/OCR PDF not supported)";
          setAttachments((current) => current.map((attachment) => attachment.id === item.id
            ? { ...attachment, status, promptText: text ? `[Local attachment: ${file.name}]\n${text}\n[/Local attachment]` : `[Attachment: ${file.name}; no text could be extracted locally. OCR is not available.]` }
            : attachment));
        } catch (error) {
          const status = `Extraction failed: ${String(error).slice(0, 240)}`;
          setAttachments((current) => current.map((attachment) => attachment.id === item.id ? { ...attachment, status, promptText: `[Attachment ${file.name} could not be extracted locally: ${status}]` } : attachment));
        }
      }
    }
  };
  const removeAttachment = (id: string) => setAttachments((current) => current.filter((attachment) => attachment.id !== id));

  useEffect(() => { void cmd.skillsList().then(setSkills).catch(() => setSkills([])); }, []);

  const contextEnabled = contextToggle ?? s.settings?.context?.enabled ?? true;
  // Preview is advisory and debounced: the backend re-runs the same selection
  // when the task starts, and the transcript records the authoritative list.
  useEffect(() => {
    const text = s.composerText.trim();
    if (!text || !s.activeWorkspacePath || !contextEnabled) {
      setContextPreview(null);
      setContextScanning(false);
      return;
    }
    let cancelled = false;
    setContextScanning(true);
    const timer = setTimeout(() => {
      cmd.contextPreview(text, s.providerSelected, previewExclude, continuationTaskId)
        .then((preview) => { if (!cancelled) { setContextPreview(preview); setContextScanning(false); } })
        .catch(() => { if (!cancelled) { setContextPreview(null); setContextScanning(false); } });
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [s.composerText, s.activeWorkspacePath, s.providerSelected, contextEnabled, previewExclude.join("|"), continuationTaskId]);

  const addEditorDoc = (doc: DocRec) => {
    const current = getState();
    if (!current.activeWorkspacePath) {
      toast("warn", "Choose a project folder before sharing editor context.");
      return;
    }
    const built = buildEditorContext({
      workspace: current.activeWorkspacePath,
      path: doc.path,
      draft: doc.draft,
      original: doc.original,
    });
    if ("error" in built) { toast("warn", built.error); return; }
    const result = addEditorContext(current.editorContexts ?? [], built.item);
    if (result.error) { toast("warn", result.error); return; }
    setState({ editorContexts: result.items });
    setMenu(null);
    toast("info", `${result.replaced ? "Updated" : "Added"} ${doc.path} to this prompt's editor context. Review or remove it before sending.`);
  };
  const removeEditorAttachment = (key: string) => {
    setState((current) => ({ editorContexts: removeEditorContext(current.editorContexts ?? [], key) }));
  };

  const send = async () => {
    const current = getState();
    const currentText = current.composerText.trim();
    const selectedAttachments = attachments.filter((attachment) => attachment.status.startsWith("Ready"));
    const selectedEditorContexts = contextsForWorkspace(current.editorContexts ?? [], current.activeWorkspacePath);
    const text = currentText;
    if (!text && selectedAttachments.length === 0 && selectedEditorContexts.length === 0) return;
    const editorBlock = formatEditorContext(selectedEditorContexts);
    const message = [text, editorBlock, ...selectedAttachments.map((attachment) => attachment.promptText)].filter(Boolean).join("\n\n");
    // Capture before resetTask(): a failed start must restore the same
    // explicit attachments, not silently drop them with the prompt text.
    const retainedEditorContexts = current.editorContexts ?? [];
    if (current.taskStartPending) return;
    if (isAgentRunning(current.agentState)) {
      toast("warn", "A task is already running.");
      return;
    }
    if (!current.activeWorkspacePath) {
      toast("warn", "Choose a project folder with the + button before sending a task.");
      return;
    }
    if (selectedSkills.length && current.providerSelected.startsWith("web:") &&
        !window.confirm("Selected SKILL.md contents will be included in the first task message sent to the selected web AI provider. Continue?")) return;
    if (selectedAttachments.length && current.providerSelected.startsWith("web:") &&
        !window.confirm("Extracted document text and image filenames/status notes will be sent to the selected web provider as part of your prompt. Original files stay local; image pixels are not uploaded. Continue?")) return;
    if (selectedEditorContexts.length && current.providerSelected.startsWith("web:") &&
        !window.confirm("The shared editor context (including any unsaved changes) will be sent to the selected web provider as part of your prompt. Original files stay local. Continue?")) return;
    const currentBusy = current.taskStartPending || isAgentRunning(current.agentState);
    const sourceTaskId = current.openTask?.id ?? (!currentBusy ? current.taskId : null);
    if (!sourceTaskId) resetTask();
    setState({ activeTaskSkills: selectedSkills.map((key) => skills.find((skill) => `${skill.location}:${skill.id}` === key)?.name ?? key) });
    // Preserve the prompt while the backend starts. A failed start must not eat user input.
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const context = {
      enabled: contextEnabled,
      exclude: Array.from(new Set([...contextExclude, ...selectedEditorContexts.map((item) => item.path)])),
    };
    setState({ composerText: message, taskStartPending: true, taskStartRequestId: requestId });
    try {
      const taskId = sourceTaskId
        ? await cmd.taskContinue(sourceTaskId, current.providerSelected, message, requestId, context)
        : await cmd.taskStart(message, current.providerSelected, requestId, selectedSkills, skillBudget, context);
      setState((s2) => ({
        taskId,
        openTask: null,
        taskStartPending: false,
        taskStartRequestId: null,
        view: "chat",
        composerText: "",
        editorContexts: [],
        // The invoke can resolve before the first agent-state event arrives.
        // Keep the composer locked for the accepted task during that gap.
        agentState: s2.agentState === "idle" ? "waiting_for_ai" : s2.agentState,
        taskStartedAt: s2.taskStartedAt ?? Date.now(),
      }));
      // The next task starts with a clean veto list; the toggle keeps the user's
      // preference. The transcript entry is the authoritative included list.
      setContextExclude([]);
      setContextPreview(null);
      setAttachments([]);
    } catch (e) {
      // Restore the USER'S text and attachments. The formatted block is
      // regenerated from the retained items on the next send, so the textarea
      // never fills with a copy of the context payload.
      setState({
        taskId: sourceTaskId ?? current.taskId,
        taskStartPending: false,
        taskStartRequestId: null,
        composerText: currentText,
        editorContexts: retainedEditorContexts,
        activeTaskSkills: [],
      });
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
          <button class="composer-plus" title="Attach local files" aria-label="Attach local files" onClick={() => fileInput.current?.click()}>
            <svg viewBox="0 0 20 20"><path d="M10 3v14M3 10h14" /></svg>
          </button>
          <div class="composer-menu-anchor">
            <button class="composer-plus" title="Add editor context" aria-label="Add editor context" aria-haspopup="menu"
              aria-expanded={menu === "editor"} onClick={() => setMenu(menu === "editor" ? null : "editor")}>
              <Icon name="code" size={17} />
            </button>
            {menu === "editor" ? (
              <EditorContextMenu
                docs={s.editorDocs ?? []}
                workspaceReady={!!s.activeWorkspacePath}
                onAdd={addEditorDoc}
              />
            ) : null}
          </div>
          <input ref={fileInput} class="attachment-input" type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.log,image/png,image/jpeg,image/gif,image/webp" aria-label="Choose files to attach" onChange={(event: any) => { void addAttachments(event.currentTarget.files); event.currentTarget.value = ""; }} />
          <textarea
            ref={ref}
            rows={1}
            value={s.composerText}
            placeholder={continuationLabel ? `Continue ${continuationLabel}…` : 'Example: "Explain this project in simple terms"'}
            disabled={readOnly}
            onInput={(event: any) => setState({ composerText: event.currentTarget.value })}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
          />
          <button class="send-btn" title={taskBusy ? "A task is running" : "Send task"} aria-label="Send task" onClick={() => void send()} disabled={!hasText || readOnly || taskBusy}>
            <svg viewBox="0 0 20 20"><path d="m3 9 14-6-5.5 14-2.2-6.3L3 9Z" /><path d="m9.3 10.7 3.5-3.5" /></svg>
          </button>
        </div>
        {editorContexts.length || attachments.length ? <div class="attachment-list" aria-label="Attached context">
          {editorContexts.map((item) => <div class="attachment-item editor-context-item" key={item.key} data-editor-context={item.key}>
            <span class="attachment-file" title={item.path}>{item.path}</span><small>{editorContextDetail(item)}</small>
            <button class="ghost" aria-label={`Remove editor context ${item.path}`} onClick={() => removeEditorAttachment(item.key)}>Remove</button>
          </div>)}
          {attachments.map((attachment) => <div class="attachment-item" key={attachment.id}>
            <span class="attachment-file" title={attachment.file.name}>{attachment.file.name}</span><small>{attachment.status}</small>
            <button class="ghost" aria-label={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)}>Remove</button>
          </div>)}
        </div> : null}
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
        <ContextPicker
          enabled={contextEnabled}
          preview={contextPreview}
          scanning={contextScanning}
          excluded={contextExclude}
          workspaceReady={!!s.activeWorkspacePath}
          budgets={s.settings?.context ?? null}
          onToggle={(next) => setContextToggle(next)}
          onExclude={(path, include) => setContextExclude((current) => include ? current.filter((p) => p !== path) : [...current, path])}
        />
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

function EditorContextMenu(props: { docs: DocRec[]; workspaceReady: boolean; onAdd: (doc: DocRec) => void }) {
  return (
    <div class="menu editor-context-menu" role="menu" aria-label="Open editor files">
      <div class="menu-head">Share editor context</div>
      {!props.workspaceReady ? <div class="menu-note">Choose a project folder first.</div> : null}
      {props.workspaceReady && props.docs.length === 0
        ? <div class="menu-note">No editor documents open. Open a file in Files first.</div>
        : null}
      {props.docs.map((doc) => (
        <button role="menuitem" key={doc.path} title={doc.path} onClick={() => props.onAdd(doc)}>
          <span class="editor-context-name">{docName(doc.path)}{docDirty(doc) ? " • unsaved" : ""}</span>
          <small class="editor-context-dir">{docDir(doc.path) || "workspace root"}</small>
        </button>
      ))}
      {props.docs.length > 0 ? (
        <div class="menu-note">Shares a snapshot of the current editor buffer, including unsaved changes at share time. To send only a selected range, select it in Files and use the share button there. At most {MAX_EDITOR_CONTEXT_ITEMS} files.</div>
      ) : null}
    </div>
  );
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
