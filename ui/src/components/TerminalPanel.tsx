// Terminal drawer: xterm.js lazily imported on first open, backed by a Rust PTY.
import { useEffect, useRef } from "preact/hooks";
import "@xterm/xterm/css/xterm.css";
import { setState, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";

export function TerminalPanel() {
  const s = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<any>({ term: null, fit: null, sessionId: null as number | null });

  useEffect(() => {
    let disposed = false;
    let sessionId: number | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    (async () => {
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
      requestAnimationFrame(() => fit?.fit());

      try {
        sessionId = await cmd.termCreate();
      } catch (error) {
        if (!disposed) term.writeln(`\x1b[31mUnable to start the OS terminal: ${String(error)}\x1b[0m`);
        return;
      }
      if (disposed) {
        await cmd.termKill(sessionId).catch(() => {});
        return;
      }
      stateRef.current = { term, fit, sessionId };
      term.onData((data) => cmd.termWrite(sessionId!, data).catch((error) => {
        term?.writeln(`\r\n\x1b[31mTerminal input failed: ${String(error)}\x1b[0m`);
      }));
      const onResize = () => {
        if (!term || !fit || !sessionId || !hostRef.current?.clientWidth || !hostRef.current.clientHeight) return;
        try {
          fit.fit();
          cmd.termResize(sessionId, term.rows, term.cols).catch(() => {});
        } catch { /* The host can briefly measure as zero while the drawer animates. */ }
      };
      window.addEventListener("resize", onResize);
      onResize();
      resizeObserver = new ResizeObserver(() => onResize?.());
      resizeObserver.observe(hostRef.current);

      const onData = (ev: any) => { if (ev.detail?.session === sessionId) term?.write(ev.detail.data); };
      const onExit = (ev: any) => { if (ev.detail?.session === sessionId) term?.writeln("\r\n\x1b[90m[terminal process exited]\x1b[0m"); };
      window.addEventListener("term-data", onData);
      window.addEventListener("term-exit", onExit);
      (stateRef.current as any).cleanup = () => {
        window.removeEventListener("resize", onResize);
        resizeObserver?.disconnect();
        window.removeEventListener("term-data", onData);
        window.removeEventListener("term-exit", onExit);
      };
      fit.fit();
      cmd.termResize(sessionId, term.rows, term.cols).catch(() => {});
    })();
    return () => {
      disposed = true;
      stateRef.current?.cleanup?.();
      resizeObserver?.disconnect();
      if (sessionId != null) cmd.termKill(sessionId).catch(() => {});
      term?.dispose();
    };
  }, []);

  return (
    <div class="terminal-drawer">
      <div class="term-head">
        <span>Terminal <span class="term-platform">interactive shell · workspace directory</span></span>
        <button class="ghost icon-button" aria-label="Close terminal" onClick={() => setState({ terminalOpen: false })}><Icon name="close" size={16} /></button>
      </div>
      <div class="term-host" ref={hostRef} />
    </div>
  );
}

export default TerminalPanel;
