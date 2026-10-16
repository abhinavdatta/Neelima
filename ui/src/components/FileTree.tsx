// Left file tree (lazy directory loading, virtualized-ish via capped children).
// Spec: virtualized tree that loads directories lazily — we cap children and
// load expansion on demand so huge workspaces stay responsive.
import { useEffect, useState } from "preact/hooks";
import { toast, useStore } from "../store";
import { cmd } from "../tauri";

interface TreeNode {
  name: string;
  dir: boolean;
  path: string;
  loaded?: boolean;
  children?: TreeNode[];
  open?: boolean;
}

export function FileTree() {
  const s = useStore();
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [show, setShow] = useState(true);

  useEffect(() => {
    if (!s.activeWorkspacePath) { setRoots([]); return; }
    let alive = true;
    (async () => {
      try {
        const r = await cmd.tree("");
        const nodes: TreeNode[] = r.entries.map((e) => ({ ...e, children: e.dir ? undefined : [] }));
        if (alive) setRoots(nodes);
      } catch (e) { /* no workspace yet */ }
    })();
    return () => { alive = false; };
  }, [s.activeWorkspacePath]);

  const toggle = async (node: TreeNode) => {
    if (!node.dir) return;
    const mut = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => {
        if (n.path !== node.path) return n;
        if (!n.open && (n.children === undefined)) {
          n.children = undefined; // placeholder for lazy load below
        }
        return n;
      });
    // Load children lazily on first expand.
    if (node.children === undefined) {
      try {
        const r = await cmd.tree(node.path);
        const kids: TreeNode[] = r.entries.map((e) => ({ ...e, children: e.dir ? undefined : [] }));
        setRoots((prev) => replaceNode(prev, node.path, { ...node, children: kids, open: true }));
      } catch (e) { toast("error", String(e)); }
      return;
    }
    setRoots((prev) => replaceNode(prev, node.path, { ...node, open: !node.open }));
    void mut;
  };

  return (
    <div class={`filetree ${show ? "" : "collapsed"}`}>
      <div class="ft-head">
        <span>Files</span>
        <button class="ghost" title="Refresh" onClick={async () => {
          try { const r = await cmd.tree(""); setRoots(r.entries.map((e: any) => ({ ...e }))); } catch { /* ignore */ }
        }}>↻</button>
        <button class="ghost" title="Collapse" onClick={() => setShow(!show)}>{show ? "‹" : "›"}</button>
      </div>
      {show ? (
        <div class="ft-body">
          {roots.length === 0 ? <div class="ft-empty">No workspace open</div> : null}
          {roots.map((n) => <NodeView node={n} depth={0} onToggle={toggle} />)}
        </div>
      ) : null}
    </div>
  );
}

function replaceNode(nodes: TreeNode[], path: string, next: TreeNode): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return next;
    if (n.children?.length) return { ...n, children: replaceNode(n.children, path, next) };
    return n;
  });
}

function NodeView({ node, depth, onToggle }: { node: TreeNode; depth: number; onToggle: (n: TreeNode) => void }) {
  const open = !!node.open && !!node.children;
  return (
    <>
      <div class="ft-row" style={`padding-left: ${depth * 14 + 6}px`} onClick={() => onToggle(node)}>
        <span class="ft-caret">{node.dir ? (open ? "▾" : "▸") : ""}</span>
        <span class={`ft-name ${node.dir ? "ft-dir" : "ft-file"}`}>{node.name}</span>
      </div>
      {open && node.children ? node.children.map((c) => <NodeView node={c} depth={depth + 1} onToggle={onToggle} />) : null}
    </>
  );
}

export default FileTree;
