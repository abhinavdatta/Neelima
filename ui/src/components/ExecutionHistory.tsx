// Persisted execution/test history for the open task. Reuses the transcript's
// existing tool_calls records; no second history store or execution engine.
import { useStore } from "../store";
import {
  collectExecutions,
  executionStatusLabel,
  executionStatusTone,
  formatExecutionDuration,
  formatExitCode,
  summarizeExecutions,
} from "../executionHistory";

export function ExecutionHistory() {
  const s = useStore();
  const task = s.openTask;
  const context = {
    taskId: task?.id ?? s.taskId ?? "",
    taskTitle: task?.title ?? (s.taskId ? "Current task" : ""),
    workspace: task?.workspace ?? s.activeWorkspacePath ?? "",
  };
  const items = collectExecutions(s.entries, context);
  const summary = summarizeExecutions(items);
  const scope = task
    ? `${task.title} · ${task.workspace}`
    : s.activeWorkspacePath
      ? `Current session · ${s.activeWorkspacePath}`
      : "No task open";

  return (
    <div class="exec-history" data-testid="execution-history">
      <div class="exec-head">
        <h3>Execution &amp; test history</h3>
        <span class="dim exec-scope" title={scope}>{scope}</span>
      </div>
      <p class="dim">
        Tool and command results persisted with this task. Expand a row to read its bounded output;
        a command's exit code is the process status, not a parsed test-count claim.
      </p>
      {items.length === 0 ? (
        <p class="dim">No tool or command executions recorded for this task yet.</p>
      ) : (
        <>
          <div class="exec-summary" aria-label="Execution summary">
            <span class="exec-count">{summary.total} total</span>
            {summary.succeeded ? <span class="exec-count ok">{summary.succeeded} succeeded</span> : null}
            {summary.failed ? <span class="exec-count error">{summary.failed} failed</span> : null}
            {summary.timedOut ? <span class="exec-count warn">{summary.timedOut} timed out</span> : null}
            {summary.cancelled ? <span class="exec-count warn">{summary.cancelled} cancelled</span> : null}
            {summary.rejected ? <span class="exec-count warn">{summary.rejected} rejected</span> : null}
            {summary.refused ? <span class="exec-count warn">{summary.refused} refused</span> : null}
            {summary.other ? <span class="exec-count">{summary.other} other</span> : null}
          </div>
          <div class="exec-list">
            {items.map((item) => {
              const tone = executionStatusTone(item.status);
              const duration = formatExecutionDuration(item.duration_ms);
              const exit = formatExitCode(item.exit_code);
              const started = item.started_ms === null ? "" : new Date(item.started_ms).toLocaleString();
              return (
                <details
                  class={`exec-row status-${tone || "other"}`}
                  key={item.key}
                  title={started ? `Started ${started}` : undefined}
                >
                  <summary class="exec-row-head">
                    <span class={`dot ${tone}`} />
                    <span class="exec-tool">{item.tool}</span>
                    <span class="exec-id">#{item.callId}</span>
                    {item.path ? <span class="exec-path">{item.path}</span> : null}
                    <span class="exec-status">{executionStatusLabel(item.status)}</span>
                    {duration ? <span class="exec-meta-value">{duration}</span> : null}
                    {exit ? <span class="exec-meta-value">{exit}</span> : null}
                  </summary>
                  <div class="exec-detail">
                    <div class="exec-meta">
                      {item.taskTitle ? <span>Task: {item.taskTitle}</span> : null}
                      {item.workspace ? <span>Workspace: {item.workspace}</span> : null}
                      {item.action_id ? <span>Action: {item.action_id}</span> : null}
                      {started ? <span>Started: {started}</span> : null}
                    </div>
                    <pre class="tool-args">{JSON.stringify(item.args, null, 1)?.slice(0, 1200) ?? "null"}</pre>
                    <pre class="tool-out">{item.output || "(no output recorded)"}</pre>
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default ExecutionHistory;
