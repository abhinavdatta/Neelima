// Chat transcript: user bubbles, assistant replies, tool-call cards with
// status + live output, diff buttons, approval queue, relay card, "worked for"
// divider, and read-only history view (view === "task").
import { useEffect, useRef, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";
import type { TranscriptEntry } from "../types";

export function Chat() {
  const s = useStore();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [s.entries.length, s.pendingCalls.length]);

  const readOnly = s.view === "task";

  return (
    <div class="chat">
      {s.activeTaskSkills.length > 0 ? <div class="active-skills-note"><b>Active task skills:</b> {s.activeTaskSkills.join(", ")} <span>· untrusted guidance</span></div> : null}
      {s.entries.map((e) => <Entry key={`${e.ts}-${e.id}`} e={e} taskId={s.taskId ?? s.openTask?.id ?? ""} readOnly={readOnly} />)}

      {s.pendingCalls.length > 0 ? <ApprovalCard /> : null}
      {s.relayOutbound && s.agentState === "waiting_for_ai" ? <RelayCard /> : null}
      <div ref={bottom} />
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
      {e.injection_warning ? <div class="inj-warn"><Icon name="alert" size={15} /> Untrusted content warning: {e.injection_warning}</div> : null}
      </div>
    );
  }
  if (e.kind === "tool_calls") {
    return (
      <div class="msg-block">
        {e.calls.map((c) => (
          <details class={`tool-card status-${c.status}`} key={c.id}>
            <summary class="tool-head">
              <span class={`dot ${c.status}`} />
              <span class="tool-name">{c.tool}</span>
              <span class="tool-id">#{c.id}</span>
              <span class={`risk risk-${c.tool === "read_file" || c.tool === "list_dir" || c.tool === "glob" || c.tool === "grep" ? "read" : c.tool === "run_command" ? "command" : "write"}`}>
                {c.tool === "run_command" ? "command" : c.tool.startsWith("read") || ["list_dir", "glob", "grep"].includes(c.tool) ? "read" : "write"}
              </span>
              <span class="tool-status-label">{c.status}</span>
            </summary>
            <div class="tool-detail">
              {e.diff ? (
                readOnly || !taskId ? null : (
                  <button class="link" onClick={() => setState({ diffEntry: { taskId, entryId: e.id } })}>View diff</button>
                )
              ) : null}
            <pre class="tool-args">{JSON.stringify(c.args, null, 1)?.slice(0, 400)}</pre>
            {c.output ? <pre class="tool-out">{c.output.slice(0, 4000)}</pre> : null}
            {e.injection_warning ? <div class="inj-warn"><Icon name="alert" size={15} /> {e.injection_warning}</div> : null}
            </div>
          </details>
        ))}
      </div>
    );
  }
  if (e.kind === "checkpoint") {
    return <div class="sys-row"><Icon name="clock" size={14} /> {e.text}</div>;
  }
  if (e.kind === "done") {
    return <div class="done-row"><Icon name="check" size={14} /> {e.text}</div>;
  }
  if (e.kind === "error") {
    return <div class="err-row"><Icon name="close" size={14} /> {e.text}</div>;
  }
  // system
  return <div class="sys-row">{e.text}</div>;
}

function ApprovalCard() {
  const s = useStore();
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  // A new approval batch must not inherit decisions from a previous batch.
  const batchKey = s.pendingCalls.map((c) => c.id).join("|");
  useEffect(() => { setChoices({}); setSubmitting(false); }, [batchKey]);

  const choose = (id: string, approved: boolean) => setChoices((current) => ({ ...current, [id]: approved }));
  const submit = async (decisions: { id: string; approved: boolean }[]) => {
    if (submitting || decisions.length !== s.pendingCalls.length) return;
    setSubmitting(true);
    try {
      await cmd.approve(decisions);
      setState({ pendingCalls: [] });
    } catch (e) {
      setSubmitting(false);
      console.error(e);
      toast("error", `Could not submit approval decisions: ${String(e)}`);
    }
  };
  const allChosen = s.pendingCalls.length > 0 && s.pendingCalls.every((c) => choices[c.id] !== undefined);
  const allDecisions = s.pendingCalls.map((c) => ({ id: c.id, approved: choices[c.id] === true }));
  return (
    <div class="approval-card">
      <div class="approval-head">Approval required — {s.pendingCalls.length} tool call(s)</div>
      {s.pendingCalls.map((c) => (
        <div class="approval-item" key={c.id}>
          <span class={`risk risk-${c.risk}`}>{c.risk}</span>
          <span class="tool-name">{c.tool}</span>
          <pre class="tool-args">{JSON.stringify(c.args)?.slice(0, 300)}</pre>
          {c.diff ? <button class="link" onClick={() => setState({ diffEntry: { taskId: s.taskId ?? "", entryId: -1, preview: c.diff } as any })}>Preview diff</button> : null}
          <div class="approval-actions">
            <button class={choices[c.id] === true ? "btn-ok selected" : "btn-ok"} disabled={submitting} aria-pressed={choices[c.id] === true} onClick={() => choose(c.id, true)}>Approve</button>
            <button class={choices[c.id] === false ? "btn-no selected" : "btn-no"} disabled={submitting} aria-pressed={choices[c.id] === false} onClick={() => choose(c.id, false)}>Reject</button>
            {choices[c.id] !== undefined ? <span class="dim">{choices[c.id] ? "Approved" : "Rejected"} — pending submit</span> : null}
          </div>
        </div>
      ))}
      <div class="approval-actions all">
        <button class="btn-ok" disabled={submitting} onClick={() => setChoices(Object.fromEntries(s.pendingCalls.map((c) => [c.id, true])))}>Approve all</button>
        <button class="btn-no" disabled={submitting} onClick={() => setChoices(Object.fromEntries(s.pendingCalls.map((c) => [c.id, false])))}>Reject all</button>
        <button class="btn-ok" disabled={!allChosen || submitting} onClick={() => void submit(allDecisions)}>{submitting ? "Submitting…" : "Submit decisions"}</button>
      </div>
      {!allChosen ? <div class="dim">Choose Approve or Reject for every item before submitting. Unselected items are never implicitly rejected.</div> : null}
    </div>
  );
}

function RelayCard() {
  const s = useStore();
  const [text, setText] = [s.relayOutbound, (v: string) => setState({ relayOutbound: v })];
  return (
    <div class="relay-card">
      <div class="relay-head"><Icon name="mail" size={16} /> Manual relay — copy this into your chat, then paste the reply back</div>
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
