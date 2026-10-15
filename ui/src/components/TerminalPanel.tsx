// Terminal drawer: xterm.js lazily imported on first open, backed by a Rust PTY.
import { useEffect, useRef } from "preact/hooks";
import { setState, useStore } from "../store";
import { cmd } from "../tauri";

export function TerminalPanel() {
  const s = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<any>({ term: null, fit: null, sessionId: null as number | null });

  useEffect(() => {
    let disposed = false;
    (async () => {
      // Lazy-load xterm only when the panel is first opened (bundle splitting).
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({ fontSize: 12, theme: { background: "#101114", foreground: "#d6d6dc" } });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      const sessionId = await cmd.termCreate();
      stateRef.current = { term, fit, sessionId };
      term.onData((data) => cmd.termWrite(sessionId, data).catch(() => {}));
      const onResize = () => {
        fit.fit();
        cmd.termResize(sessionId, term.rows, term.cols).catch(() => {});
      };
      window.addEventListener("resize", onResize);
      onResize();

      const onData = (ev: any) => { if (ev.detail?.session === sessionId) term.write(ev.detail.data); };
      const onExit = (ev: any) => { if (ev.detail?.session === sessionId) term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"); };
      window.addEventListener("term-data", onData);
      window.addEventListener("term-exit", onExit);
      (stateRef.current as any).cleanup = () => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("term-data", onData);
        window.removeEventListener("term-exit", onExit);
      };
    })();
    return () => {
      disposed = true;
      stateRef.current?.cleanup?.();
      if (stateRef.current?.sessionId != null) cmd.termKill(stateRef.current.sessionId).catch(() => {});
    };
  }, []);

  return (
    <div class="terminal-drawer">
      <div class="term-head">
        <span>Terminal</span>
        <button class="ghost" onClick={() => setState({ terminalOpen: false })}>✕</button>
      </div>
      <div class="term-host" ref={hostRef} />
    </div>
  );
}

export default TerminalPanel;
