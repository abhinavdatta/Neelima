// Automations pane: live agent activity, running-command output, emergency stop.
import { useStore } from "../store";
import { cmd } from "../tauri";

export function AutomationsPane() {
  const s = useStore();
  const running = s.agentState !== "idle" && s.agentState !== "done" && s.agentState !== "error";
  return (
    <div class="pane">
      <h2>Automations</h2>
      <p class="dim">Live agent activity and the global emergency stop. Neelima never runs anything in the background by itself — no polling, no watchers unless a task is executing.</p>
      <div class="card">
        <div class="row-item">
          <span>Agent state:</span> <b>{s.agentState}</b>
          {running ? <button class="btn-no" onClick={() => cmd.taskStop()}>Emergency stop</button> : null}
        </div>
        {s.agentText ? <div class="row-item dim">{s.agentText}</div> : null}
      </div>
      <div class="card">
        <h3>Command output (live)</h3>
        {Object.keys(s.commandChunks).length === 0 ? <p class="dim">No commands have run in this session.</p> : null}
        {Object.entries(s.commandChunks).map(([id, out]) => (
          <pre class="tool-out" key={id}>[{id}] {out.slice(-3000)}</pre>
        ))}
      </div>
      <div class="card">
        <h3>Checkpoints</h3>
        <button class="ghost" onClick={async () => { try { await cmd.checkpointCreate("manual"); } catch (e) { console.error(e); } }}>Create checkpoint now</button>
      </div>
    </div>
  );
}

export default AutomationsPane;
