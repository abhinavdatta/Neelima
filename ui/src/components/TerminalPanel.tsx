// Terminal drawer: xterm.js lazily imported on first open, backed by a Rust PTY.
// The panel is bound to the active workspace: switching workspaces disposes the
// old shell, and creation is refused without a workspace by the Rust command.
import { useEffect, useRef, useState } from "preact/hooks";
import "@xterm/xterm/css/xterm.css";
import { setState, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";
import {
  bufferTerminalEvent,
  terminalExitText,
  terminalStatusText,
  terminalWorkspaceName,
  type TerminalEvent,
  type TerminalStatus,
} from "../terminal";

export function TerminalPanel() {
  const s = useStore();
  const workspace = s.activeWorkspacePath;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>(
    workspace ? { kind: "connecting" } : { kind: "noworkspace" },
  );
  const hostRef = useRef<HTMLDivElement>(null);
  // Preact can flush the same effect twice when a state update is queued from
  // inside it (and StrictMode-style double invocation is possible in dev). A
  // terminal is a process, so one panel must never spawn two PTYs. The ref is
  // cleared by the real cleanup, so workspace/retry reruns still work.
  const effectRunning = useRef(false);

  useEffect(() => {
    if (effectRunning.current) return;
    effectRunning.current = true;
    if (!workspace) {
      setStatus({ kind: "noworkspace" });
      effectRunning.current = false;
      return;
    }
    setStatus({ kind: "connecting" });

    let disposed = false;
    let alive = false;
    let sessionId: number | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let pending: TerminalEvent[] = [];

    const writeData = (data: string) => {
      try {
        term?.write(data);
      } catch {
        /* the terminal was disposed while an event was in flight */
      }
    };
    const markExit = (code: number | null) => {
      alive = false;
      setStatus({ kind: "exited", code });
      try {
        term?.writeln(terminalExitText(code));
      } catch {
        /* disposed */
      }
    };

    // Register BEFORE termCreate: a short-lived shell can emit its prompt (or
    // exit) before the awaited command returns. Buffer those events by session
    // and replay only the id this panel owns.
    const onData = (ev: Event) => {
      if (disposed) return;
      const p = (ev as CustomEvent).detail;
      if (!p || p.kind !== "term-data" || typeof p.data !== "string") return;
      if (sessionId === null) {
        pending = bufferTerminalEvent(pending, {
          kind: "term-data",
          session: Number(p.session),
          data: p.data,
        });
        return;
      }
      if (p.session === sessionId) writeData(p.data);
    };
    const onExit = (ev: Event) => {
      if (disposed) return;
      const p = (ev as CustomEvent).detail;
      if (!p || p.kind !== "term-exit") return;
      if (sessionId === null) {
        pending = bufferTerminalEvent(pending, {
          kind: "term-exit",
          session: Number(p.session),
          code: typeof p.code === "number" ? p.code : null,
        });
        return;
      }
      if (p.session === sessionId) markExit(typeof p.code === "number" ? p.code : null);
    };
    window.addEventListener("term-data", onData);
    window.addEventListener("term-exit", onExit);

    (async () => {
      try {
        // Lazy-load xterm only when the panel is first opened (bundle splitting).
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed || !hostRef.current) return;
        const rootStyle = getComputedStyle(document.documentElement);
        const cssColor = (name: string, fallback: string) => rootStyle.getPropertyValue(name).trim() || fallback;
        term = new Terminal({
          fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          cursorBlink: true,
          // Bounded by design; xterm keeps at most this many scrollback lines.
          scrollback: 5000,
          theme: {
            background: cssColor("--theme-bg", "#101114"),
            foreground: cssColor("--theme-text", "#d6d6dc"),
            cursor: cssColor("--theme-accent", "#8490ff"),
            selectionBackground: "#6875d966",
          },
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(hostRef.current);
        try {
          fit.fit();
        } catch {
          /* the host can measure as zero during the drawer's first paint */
        }

        try {
          sessionId = await cmd.termCreate();
        } catch (error) {
          if (!disposed) {
            setStatus({ kind: "error", message: String(error) });
            term.writeln(`\x1b[31mUnable to start the OS terminal: ${String(error)}\x1b[0m`);
          }
          return;
        }
        if (disposed) {
          await cmd.termKill(sessionId).catch(() => {});
          return;
        }
        alive = true;

        // Replay events that arrived while the command was in flight, in order.
        const queued = pending;
        pending = [];
        for (const event of queued) {
          if (event.session !== sessionId) continue;
          if (event.kind === "term-data") writeData(event.data);
          else markExit(event.code ?? null);
        }

        inputDisposable = term.onData((data) => {
          if (disposed || !alive || sessionId === null) return;
          cmd.termWrite(sessionId, data).catch((error) => {
            if (disposed) return;
            alive = false;
            setStatus({ kind: "error", message: `Terminal input failed: ${String(error)}` });
            try {
              term?.writeln(`\r\n\x1b[31mTerminal input failed: ${String(error)}\x1b[0m`);
            } catch {
              /* disposed */
            }
          });
        });

        const onResize = () => {
          if (disposed || !term || !fit || sessionId === null) return;
          if (!hostRef.current?.clientWidth || !hostRef.current.clientHeight) return;
          try {
            fit.fit();
            cmd.termResize(sessionId, term.rows, term.cols).catch(() => {});
          } catch {
            /* The host can briefly measure as zero while the drawer animates. */
          }
        };
        window.addEventListener("resize", onResize);
        if (typeof ResizeObserver !== "undefined" && hostRef.current) {
          resizeObserver = new ResizeObserver(() => onResize());
          resizeObserver.observe(hostRef.current);
        }
        onResize();
        if (alive) {
          setStatus({ kind: "running" });
          term.focus();
        }
      } catch (error) {
        if (!disposed) {
          setStatus({ kind: "error", message: String(error) });
          try {
            term?.writeln(`\x1b[31mUnable to start the terminal: ${String(error)}\x1b[0m`);
          } catch {
            /* disposed */
          }
        }
      }
    })();

    return () => {
      effectRunning.current = false;
      disposed = true;
      window.removeEventListener("term-data", onData);
      window.removeEventListener("term-exit", onExit);
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      if (sessionId !== null) cmd.termKill(sessionId).catch(() => {});
      try {
        term?.dispose();
      } catch {
        /* already disposed */
      }
      term = null;
      fit = null;
    };
  }, [workspace, attempt]);

  const canRetry = status.kind === "error" || status.kind === "exited";
  return (
    <div class="terminal-drawer">
      <div class="term-head">
        <span class="term-title">
          Terminal{" "}
          <span class="term-platform" title={workspace ?? undefined}>
            interactive shell · {terminalWorkspaceName(workspace)}
          </span>
        </span>
        <span class={`term-status term-status-${status.kind}`} role="status" aria-live="polite" title={status.kind === "error" ? status.message : undefined}>
          {terminalStatusText(status)}
        </span>
        <div class="term-head-actions">
          {canRetry ? (
            <button class="term-retry" onClick={() => setAttempt((n) => n + 1)}>
              Restart
            </button>
          ) : null}
          <button class="ghost icon-button" aria-label="Close terminal" onClick={() => setState({ terminalOpen: false })}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
      <div class="term-host" ref={hostRef}>
        {!workspace ? <div class="term-empty-state">Open a project folder to use the terminal.</div> : null}
      </div>
    </div>
  );
}

export default TerminalPanel;
