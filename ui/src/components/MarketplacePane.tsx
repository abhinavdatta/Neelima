// Marketplace keeps adapter inspection and adds a local, user-reviewed SKILL.md importer.
import { useEffect, useMemo, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";

type Skill = { id: string; name: string; description: string; source_repo: string; branch: string; source_path: string; license: string; enabled: boolean; location: string; modified_files: string[] };
type Preview = { repo: string; branch: string; path: string; id: string; name: string; description: string; license: string; files: { path: string; size: number }[]; skill_md: string; installed: boolean };

export function MarketplacePane() {
  const s = useStore();
  const [tab, setTab] = useState<"skills" | "adapters">("skills");
  const [inspName, setInspName] = useState("");
  const [inspUrl, setInspUrl] = useState("");
  const [captured, setCaptured] = useState<{ kind: string; selector: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [subdir, setSubdir] = useState("");
  const [location, setLocation] = useState<"app" | "workspace">("app");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState<{ skill: Skill; text: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const refreshSkills = async () => { try { setSkills(await cmd.skillsList()); } catch (e) { toast("error", `Could not load installed skills: ${String(e)}`); } };
  useEffect(() => { void refreshSkills(); }, []);
  const visibleSkills = useMemo(() => skills.filter((k) =>
    (!filter || `${k.name} ${k.description} ${k.id}`.toLowerCase().includes(filter.toLowerCase())) &&
    (!sourceFilter || k.source_repo.toLowerCase().includes(sourceFilter.toLowerCase())) &&
    (statusFilter === "all" || (statusFilter === "enabled" ? k.enabled : !k.enabled))), [skills, filter, sourceFilter, statusFilter]);

  const fetchPreview = async () => {
    if (!repoUrl.trim()) { toast("warn", "Enter the public GitHub repository URL."); return; }
    setLoading(true); setPreview(null); setReviewed(null);
    try { setPreview(await cmd.skillPreview(repoUrl.trim(), branch.trim() || "main", subdir.trim(), location)); }
    catch (e) { toast("error", String(e)); }
    finally { setLoading(false); }
  };

  const inspect = async (skill: Skill) => {
    try { setReviewed({ skill, text: await cmd.skillRead(skill.location, skill.id) }); }
    catch (e) { toast("error", String(e)); }
  };

  const checkUpdate = async (skill: Skill) => {
    setLoading(true); setReviewed(null); setPreview(null);
    try {
      const [remote, local] = await Promise.all([cmd.skillUpdatePreview(skill.location, skill.id), cmd.skillRead(skill.location, skill.id)]);
      setPreview(remote); setReviewed({ skill, text: local }); setLocation(skill.location as "app" | "workspace");
    } catch (e) { toast("error", `Update check failed: ${String(e)}`); }
    finally { setLoading(false); }
  };

  const install = async () => {
    if (!preview) return;
    if (preview.installed && !reviewed) { toast("warn", "Review the installed and remote SKILL.md before replacing it."); return; }
    const updating = preview.installed;
    const licenseNotice = preview.license === "unknown" ? "License: unknown. Review the repository license and permissions before use." : `License: ${preview.license}. Review its terms before use.`;
    const action = updating ? "Update" : "Install";
    if (!window.confirm(`${action} skill '${preview.name}' into ${location === "app" ? "Neelima's local skill library" : "this workspace's .neelima/skills"}?\n\n${licenseNotice}\n\nUser-edited files will be preserved.`)) return;
    setLoading(true);
    try { await cmd.skillInstall(preview, location, updating); setPreview(null); setReviewed(null); await refreshSkills(); toast("info", `${action} complete. Skill content remains local until you explicitly select it for a task.`); }
    catch (e) { toast("error", String(e)); }
    finally { setLoading(false); }
  };

  const startInspector = async () => {
    if (!inspName.trim() || !inspUrl.trim()) { toast("warn", "Give the provider a name and a chat URL."); return; }
    setCaptured([]);
    try { await cmd.inspectorStart(inspName.trim(), inspUrl.trim()); setState({ view: "provider", providerAuthOpen: true }); toast("info", "Use the on-demand provider window to inspect this site, then return to Marketplace."); setBusy("ready"); }
    catch (e) { toast("error", String(e)); }
  };
  const capture = async (kind: string) => { try { const r = await cmd.inspectorCapture(kind); setCaptured((c) => [...c.filter((x) => x.kind !== kind), r]); toast("info", `${kind}: ${r.selector}`); } catch (e) { toast("error", String(e)); } };

  return <div class="pane marketplace-pane">
    <h2>Marketplace</h2>
    <div class="marketplace-tabs" role="tablist" aria-label="Marketplace sections">
      <button role="tab" aria-selected={tab === "skills"} class={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>Skills</button>
      <button role="tab" aria-selected={tab === "adapters"} class={tab === "adapters" ? "active" : ""} onClick={() => setTab("adapters")}>Provider adapters</button>
    </div>
    {tab === "skills" ? <>
      <p class="dim">Import directory-based skills with <code>SKILL.md</code>. Skills are untrusted instructions, not permissions. Cursor <code>.mdc</code> rules and other formats are not automatically interchangeable and are not imported.</p>
      <div class="card skills-import">
        <h3>Browse and preview a public GitHub skill</h3>
        <p class="skill-safety-note">Browsing contacts GitHub. Imported instructions may be malicious. Nothing is fetched until you click Preview. Neelima never runs scripts or hooks from an imported skill.</p>
        <div class="skill-import-fields">
          <input aria-label="GitHub repository URL" placeholder="https://github.com/owner/repository" value={repoUrl} onInput={(e: any) => setRepoUrl(e.currentTarget.value)} />
          <input aria-label="Branch" placeholder="Branch" value={branch} onInput={(e: any) => setBranch(e.currentTarget.value)} />
          <input aria-label="Skill subdirectory" placeholder="Skill subdirectory (e.g. skills/review)" value={subdir} onInput={(e: any) => setSubdir(e.currentTarget.value)} />
          <select aria-label="Install location" value={location} onChange={(e: any) => setLocation(e.currentTarget.value)}>
            <option value="app">Neelima skill library</option>
            <option value="workspace" disabled={!s.activeWorkspacePath}>Current workspace (.neelima/skills)</option>
          </select>
          <button class="btn-ok" disabled={loading} onClick={() => void fetchPreview()}>{loading ? "Working…" : "Preview skill"}</button>
        </div>
        <small class="dim">Public repositories only; no GitHub token is sent. API limits apply. Private repository import is not supported.</small>
        {preview ? <div class="skill-preview">
          <h4>{preview.name} {preview.installed ? <span class="chip">already installed</span> : null}</h4>
          <p>{preview.description || "No description in SKILL.md frontmatter."}</p>
          <p><b>Source:</b> {preview.repo} / {preview.branch}{preview.path ? ` / ${preview.path}` : ""} · <b>License:</b> {preview.license === "unknown" ? "Unknown — review repository terms; not approved for use." : preview.license}</p>
          <p><b>Files ({preview.files.length}):</b> {preview.files.map((f) => f.path).join(", ")}</p>
          {reviewed ? <div class="skill-diff"><h4>Installed SKILL.md versus GitHub preview</h4><div class="skill-diff-columns"><pre><b>Installed{reviewed.skill.modified_files.includes("SKILL.md") ? " (locally edited; will be preserved)" : ""}</b>{reviewed.text}</pre><pre><b>GitHub preview</b>{preview.skill_md}</pre></div></div> : null}
          <details><summary>Preview SKILL.md</summary><pre class="skill-markdown-preview">{preview.skill_md}</pre></details>
          <button class="btn-ok" disabled={loading || (preview.installed && !reviewed)} onClick={() => void install()}>{preview.installed ? "Confirm update" : "Install skill"}</button>
        </div> : null}
      </div>

      <div class="card">
        <div class="skills-list-head"><h3>Installed skills</h3><button class="ghost" onClick={() => void refreshSkills()}>Refresh</button></div>
        <div class="skills-filters"><input aria-label="Filter skills" placeholder="Filter by name or description" value={filter} onInput={(e: any) => setFilter(e.currentTarget.value)} /><input aria-label="Filter source repository" placeholder="Filter source repository" value={sourceFilter} onInput={(e: any) => setSourceFilter(e.currentTarget.value)} /><select aria-label="Filter enabled status" value={statusFilter} onChange={(e: any) => setStatusFilter(e.currentTarget.value)}><option value="all">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></div>
        {visibleSkills.length === 0 ? <p class="dim">No installed skills match. Choose a compatible repository above to preview and install.</p> : null}
        {visibleSkills.map((skill) => <div class="installed-skill" key={`${skill.location}:${skill.id}`}>
          <div class="installed-skill-info"><b>{skill.name}</b><span>{skill.description || "No description"}</span><small>{skill.source_repo} · {skill.branch} · {skill.location} · license: {skill.license}{skill.license === "unknown" ? " (unknown; review before use)" : ""}</small>{skill.modified_files.length ? <small class="modified-warning">Locally edited files preserved during updates: {skill.modified_files.join(", ")}</small> : null}</div>
          <div class="installed-skill-actions"><label><input type="checkbox" checked={skill.enabled} onChange={async (e: any) => { try { await cmd.skillSetEnabled(skill.location, skill.id, e.currentTarget.checked); await refreshSkills(); } catch (err) { toast("error", String(err)); } }} /> Enabled</label><button class="ghost" onClick={() => void inspect(skill)}>Inspect</button><button class="ghost" onClick={() => void checkUpdate(skill)}>Check update</button><button class="ghost" onClick={async () => { try { await cmd.skillReveal(skill.location, skill.id); } catch (e) { toast("error", String(e)); } }}>Reveal</button><button class="ghost danger" onClick={async () => { if (!window.confirm(`Uninstall ${skill.name}? This removes its installed folder, including any edits inside it.`)) return; try { await cmd.skillUninstall(skill.location, skill.id); setReviewed(null); await refreshSkills(); } catch (e) { toast("error", String(e)); } }}>Uninstall</button></div>
          {reviewed?.skill.id === skill.id && !preview ? <div class="skill-inspect"><b>SKILL.md</b><pre>{reviewed.text}</pre></div> : null}
        </div>)}
      </div>
      <div class="card skill-formats"><h3>Supported formats</h3><p>Neelima imports a skill directory containing <code>SKILL.md</code> plus bounded regular supporting files. Cursor <code>.mdc</code> rules and agent-specific formats require manual review and conversion; they are not silently treated as Neelima skills.</p><div class="skills-market-grid">
        <button class="skill-source" onClick={() => void cmd.openGitHub("https://github.com/search?q=SKILL.md+agent+skills&type=code").catch((e) => toast("error", String(e)))}><b>Find SKILL.md files</b><span>GitHub public code search</span><small>Browse GitHub <Icon name="arrow-up-right" size={13} /></small></button>
        <button class="skill-source" onClick={() => void cmd.openGitHub("https://github.com/search?q=agent+skills&type=repositories").catch((e) => toast("error", String(e)))}><b>Skill collections</b><span>Inspect repository contents and license</span><small>Browse GitHub <Icon name="arrow-up-right" size={13} /></small></button>
      </div></div>
    </> : <>
      <p class="dim">Provider adapters are plain JSON files, hot-reloaded on save. The Inspector records selectors by clicking the elements in the real provider page.</p>
      <div class="card"><h3>Installed adapters</h3>{s.adapters.map((a) => <div class="row-item" key={a.id}><b>{a.name}</b> <span class="dim">{a.url}</span> {a.built_in ? <span class="chip">built-in</span> : null}</div>)}<div class="row-item"><button class="ghost" onClick={() => cmd.adaptersOpenFolder()}>Open adapters folder</button></div></div>
      <div class="card"><h3>Create with the Adapter Inspector</h3><div class="add-form"><input placeholder="Provider name" value={inspName} onInput={(e: any) => setInspName(e.currentTarget.value)} /><input placeholder="https://chat.example.com/" value={inspUrl} onInput={(e: any) => setInspUrl(e.currentTarget.value)} /><button class="btn-ok" onClick={startInspector}>Open page with Inspector</button></div>{busy === "ready" ? <><p class="hint">In the provider view: log in, open a chat, then capture matching elements.</p><div class="row-item"><button class="ghost" onClick={() => capture("input")}>1. Capture input box</button><button class="ghost" onClick={() => capture("send")}>2. Capture send button</button><button class="ghost" onClick={() => capture("assistant")}>3. Capture last assistant message</button></div>{captured.map((c) => <div class="row-item" key={c.kind}><code>{c.kind}</code> → <code>{c.selector}</code></div>)}{captured.length >= 3 ? <button class="btn-ok" onClick={async () => { try { const a = await cmd.inspectorFinish(); const adapters = await cmd.adaptersList(); setState({ adapters }); toast("info", `Adapter "${a.name}" saved — it hot-reloaded.`); setBusy(null); } catch (e) { toast("error", String(e)); } }}>Save adapter</button> : null}</> : null}</div>
    </>}
  </div>;
}

export default MarketplacePane;
