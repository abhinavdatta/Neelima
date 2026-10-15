// Chat transcript: user bubbles, assistant replies, tool-call cards with
// status + live output, diff buttons, approval queue, relay card, "worked for"
// divider, and read-only history view (view === "task").
import { useEffect, useRef } from "preact/hooks";
import { setState, useStore } from "../store";
import { cmd } from "../tauri";
import type { TranscriptEntry } from "../types";

export function Chat() {
  const s = useStore();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [s.entries.length, s.pendingCalls.length]);

  const readOnly = s.view === "task";

  return (
    <div class="chat">
      {s.entries.length === 0 && !readOnly ? <EmptyState /> : null}
      {s.entries.map((e) => <Entry key={`${e.ts}-${e.id}`} e={e} taskId={s.taskId ?? s.openTask?.id ?? ""} readOnly={readOnly} />)}

      {s.pendingCalls.length > 0 ? <ApprovalCard /> : null}
      {s.relayOutbound && s.agentState === "waiting_for_ai" ? <RelayCard /> : null}
      <div ref={bottom} />
    </div>
  );
}

function EmptyState() {
  const s = useStore();
  return (
    <div class="empty">
      <div class="empty-logo">N</div>
      <h2>Neelima</h2>
      <p>A local-first agentic coding assistant. It embeds the AI provider's own web chat (your account, your login) or local models — no API keys, no cloud calls, no telemetry.</p>
      {!s.activeWorkspacePath ? (
        <p class="hint">Pick a project folder first — use <b>+ Add folder</b> in the sidebar.</p>
      ) : (
        <p class="hint">Workspace: <code>{s.activeWorkspacePath}</code></p>
      )}
      <p class="hint dim">Try it instantly with the built-in <b>Demo chat</b> provider — no login needed.</p>
    </div>
  );
}

function Entry({ e, taskId, readOnly }: { e: TranscriptEntry; taskId: string; readOnly: boolean }) {
  if (e.kind === "user_prompt") {
    return <div class="bubble-user"><div>{e.text}</div></div>;
  }
  if (e.kind === "assistant") {
    return (
      <div class="msg-block">
        <div class="msg-text">{e.text}</div>
        {e.injection_warning ? <div class="inj-warn">⚠ Untrusted content warning: {e.injection_warning}</div> : null}
      </div>
    );
  }
  if (e.kind === "tool_calls") {
    return (
      <div class="msg-block">
        {e.calls.map((c) => (
          <div class={`tool-card status-${c.status}`} key={c.id}>
            <div class="tool-head">
              <span class={`dot ${c.status}`} />
              <span class="tool-name">{c.tool}</span>
              <span class="tool-id">#{c.id}</span>
              <span class={`risk risk-${c.tool === "read_file" || c.tool === "list_dir" || c.tool === "glob" || c.tool === "grep" ? "read" : c.tool === "run_command" ? "command" : "write"}`}>
                {c.tool === "run_command" ? "command" : c.tool.startsWith("read") || ["list_dir", "glob", "grep"].includes(c.tool) ? "read" : "write"}
              </span>
              {e.diff ? (
                readOnly || !taskId ? null : (
                  <button class="link" onClick={() => setState({ diffEntry: { taskId, entryId: e.id } })}>View diff</button>
                )
              ) : null}
            </div>
            <pre class="tool-args">{JSON.stringify(c.args, null, 1)?.slice(0, 400)}</pre>
            {c.output ? <pre class="tool-out">{c.output.slice(0, 4000)}</pre> : null}
            {e.injection_warning ? <div class="inj-warn">⚠ {e.injection_warning}</div> : null}
          </div>
        ))}
      </div>
    );
  }
  if (e.kind === "checkpoint") {
    return <div class="sys-row">◷ {e.text}</div>;
  }
  if (e.kind === "done") {
    return <div class="done-row">✔ {e.text}</div>;
  }
  if (e.kind === "error") {
    return <div class="err-row">✖ {e.text}</div>;
  }
  // system
  return <div class="sys-row">{e.text}</div>;
}

function ApprovalCard() {
  const s = useStore();
  const decide = async (decisions: { id: string; approved: boolean }[]) => {
    setState({ pendingCalls: [] });
    try { await cmd.approve(decisions); } catch (e) { console.error(e); }
  };
  return (
    <div class="approval-card">
      <div class="approval-head">🔒 Approval required — {s.pendingCalls.length} tool call(s)</div>
      {s.pendingCalls.map((c) => (
        <div class="approval-item" key={c.id}>
          <span class={`risk risk-${c.risk}`}>{c.risk}</span>
          <span class="tool-name">{c.tool}</span>
          <pre class="tool-args">{JSON.stringify(c.args)?.slice(0, 300)}</pre>
          {c.diff ? <button class="link" onClick={() => setState({ diffEntry: { taskId: s.taskId ?? "", entryId: -1, preview: c.diff } as any })}>Preview diff</button> : null}
          <div class="approval-actions">
            <button class="btn-ok" onClick={() => decide([{ id: c.id, approved: true }])}>Approve</button>
            <button class="btn-no" onClick={() => decide([{ id: c.id, approved: false }])}>Reject</button>
          </div>
        </div>
      ))}
      <div class="approval-actions all">
        <button class="btn-ok" onClick={() => decide(s.pendingCalls.map((c) => ({ id: c.id, approved: true })))}>Approve all</button>
        <button class="btn-no" onClick={() => decide(s.pendingCalls.map((c) => ({ id: c.id, approved: false })))}>Reject all</button>
      </div>
    </div>
  );
}

function RelayCard() {
  const s = useStore();
  const [text, setText] = [s.relayOutbound, (v: string) => setState({ relayOutbound: v })];
  return (
    <div class="relay-card">
      <div class="relay-head">📨 Manual relay — copy this into your chat, then paste the reply back</div>
      <pre class="relay-text">{text}</pre>
      <div class="approval-actions">
        <button class="btn-ok" onClick={() => text && navigator.clipboard.writeText(text)}>Copy prompt</button>
      </div>
      <textarea
        class="relay-input"
        placeholder="Paste the assistant's reply here…"
        onKeyDown={(ev: KeyboardEvent) => {
          if ((ev.target as HTMLTextAreaElement).value.trim()) {
            if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
              const v = (ev.target as HTMLTextAreaElement).value;
              cmd.relayReply(v).catch((e) => console.error(e));
              setState({ relayOutbound: null });
            }
          }
        }}
      />
      <button
        class="btn-ok"
        onClick={(ev: any) => {
          const ta = (ev.target as HTMLElement).closest(".relay-card")!.querySelector("textarea") as HTMLTextAreaElement;
          cmd.relayReply(ta.value).catch((e) => console.error(e));
          setState({ relayOutbound: null });
        }}
      >
        Submit reply (Ctrl+Enter also works)
      </button>
    </div>
  );
}

export default Chat;
