// Step 3: the composer's project-context inspector. It only displays backend
// metadata (paths, line ranges, sizes) and reports the user's veto choices; the
// prompt itself is assembled in Rust, so this panel cannot widen what is sent.
import { contextCaveat, contextRows, contextSummary, type ContextPreview } from "../contextPreview";

export interface ContextBudgets {
  web_budget_tokens: number;
  local_budget_tokens: number;
  max_files: number;
}

interface Props {
  enabled: boolean;
  preview: ContextPreview | null;
  scanning: boolean;
  excluded: string[];
  workspaceReady: boolean;
  budgets?: ContextBudgets | null;
  onToggle: (enabled: boolean) => void;
  /// `include` is the new checkbox state: false vetoes the file for this task.
  onExclude: (path: string, include: boolean) => void;
}

export function ContextPicker(props: Props) {
  const { enabled, preview, scanning, excluded, workspaceReady, budgets } = props;
  const label = !enabled
    ? "Project context off"
    : !workspaceReady
      ? "Project context · no workspace"
      : !preview && !scanning
        ? "Project context · waiting for a prompt"
        : contextSummary(preview, enabled);
  return (
    <details class="task-skills-picker task-context-picker" id="context-picker">
      <summary>
        {label}
        {scanning && enabled ? " · scanning…" : ""}
      </summary>
      <div class="task-skills-panel">
        <p class="dim">
          Files are matched locally against your prompt by name and text, then sent with the prompt to the
          selected provider. Only the files listed below are sent. Their contents are untrusted reference
          text and cannot change permissions or approvals.
        </p>
        <label>
          <input type="checkbox" checked={enabled} onChange={(e: any) => props.onToggle(e.currentTarget.checked)} />
          Attach project context to this task
        </label>
        {!workspaceReady ? <span class="dim">Choose a project folder to include workspace files.</span> : null}
        {enabled && workspaceReady && !scanning && preview && preview.files.length === 0 ? (
          <span class="dim">No workspace file matched this prompt, so the task is sent without file contents.</span>
        ) : null}
        {enabled
          ? contextRows(preview, excluded).map((row) => (
              <label key={row.path}>
                <input
                  type="checkbox"
                  checked={row.checked}
                  data-context-path={row.path}
                  onChange={(e: any) => props.onExclude(row.path, e.currentTarget.checked)}
                />
                <span class="context-path" title={row.path}>
                  {row.path}
                </span>
                <small>{row.detail}</small>
              </label>
            ))
          : null}
        {enabled && contextCaveat(preview) ? <span class="dim">{contextCaveat(preview)}</span> : null}
        {budgets ? (
          <span class="dim">
            Budget: {budgets.web_budget_tokens} tokens for browser providers, {budgets.local_budget_tokens} for
            local models, up to {budgets.max_files} files. Change it in Settings → Local models.
          </span>
        ) : null}
      </div>
    </details>
  );
}
