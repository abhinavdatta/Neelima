// Execution-history view helpers. The source of truth is the existing
// per-task transcript (tool_calls entries), not a second history store: this
// module only flattens, dedupes, labels and bounds those persisted records.
import type { CallRecord, TranscriptEntry } from "./types";

export const EXECUTION_OUTPUT_LIMIT = 4000;
export const EXECUTION_HISTORY_LIMIT = 200;

export interface ExecutionContext {
  taskId?: string;
  taskTitle?: string;
  workspace?: string;
}

export interface ExecutionItem {
  key: string;
  entryId: number;
  taskId: string;
  taskTitle: string;
  workspace: string;
  callId: string;
  tool: string;
  status: string;
  args: unknown;
  output: string;
  path: string | null;
  started_ms: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  action_id: string | null;
}

export interface ExecutionSummary {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  rejected: number;
  refused: number;
  other: number;
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const stringOr = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "from", "to", "cwd"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 240);
  }
  return null;
}

/** Keep the tail of long command output: failures are usually at the end. */
export function boundedExecutionOutput(output: string, limit = EXECUTION_OUTPUT_LIMIT): string {
  if (output.length <= limit) return output;
  return `[output truncated; showing last ${limit.toLocaleString()} characters]\n${output.slice(-limit)}`;
}

export function executionStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "succeeded";
    case "error":
      return "failed";
    case "timed_out":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case "rejected":
      return "rejected";
    case "refused":
      return "refused";
    case "running":
      return "running";
    default:
      return status || "unknown";
  }
}

export function executionStatusTone(status: string): string {
  switch (status) {
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "rejected":
    case "refused":
      return "rejected";
    case "cancelled":
    case "timed_out":
      return "cancelled";
    case "running":
      return "running";
    default:
      return "";
  }
}

export function formatExecutionDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "" : `exit ${exitCode}`;
}

/**
 * Flatten the persisted tool_calls entries into one bounded execution list.
 * Dedupe is by (entry id, call id), so a replayed transcript event cannot
 * create a second row. Malformed calls are skipped rather than rendered as a
 * fake success. `entries` is never mutated.
 */
export function collectExecutions(
  entries: readonly TranscriptEntry[] | null | undefined,
  context: ExecutionContext = {},
): ExecutionItem[] {
  const seen = new Set<string>();
  const items: ExecutionItem[] = [];
  const taskId = context.taskId ?? "";
  const taskTitle = context.taskTitle ?? "";
  const workspace = context.workspace ?? "";

  for (const entry of entries ?? []) {
    if (!entry || entry.kind !== "tool_calls" || !Array.isArray(entry.calls)) continue;
    const entryId = finiteNumber(entry.id) ?? 0;
    for (const call of entry.calls as CallRecord[]) {
      if (!call || typeof call !== "object") continue;
      const callId = stringOr(call.id).trim();
      if (!callId) continue;
      const key = `${entryId}:${callId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tool = stringOr(call.tool).trim() || "unknown";
      const output = stringOr(call.output);
      items.push({
        key,
        entryId,
        taskId,
        taskTitle,
        workspace,
        callId,
        tool,
        status: stringOr(call.status).trim() || "unknown",
        args: call.args ?? null,
        output: boundedExecutionOutput(output),
        path: pathFromArgs(call.args),
        started_ms: finiteNumber(call.started_ms),
        duration_ms: finiteNumber(call.duration_ms),
        exit_code: finiteNumber(call.exit_code),
        action_id: stringOr(call.action_id).trim() || null,
      });
    }
  }

  return items.slice(-EXECUTION_HISTORY_LIMIT);
}

export function summarizeExecutions(items: readonly ExecutionItem[]): ExecutionSummary {
  const summary: ExecutionSummary = {
    total: items.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    rejected: 0,
    refused: 0,
    other: 0,
  };
  for (const item of items) {
    switch (item.status) {
      case "ok":
        summary.succeeded += 1;
        break;
      case "error":
        summary.failed += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      case "timed_out":
        summary.timedOut += 1;
        break;
      case "rejected":
        summary.rejected += 1;
        break;
      case "refused":
        summary.refused += 1;
        break;
      default:
        summary.other += 1;
    }
  }
  return summary;
}
