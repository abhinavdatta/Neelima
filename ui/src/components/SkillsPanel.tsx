// Skills manager, shared by Settings → Skills. Import from a public GitHub
// directory containing SKILL.md, preview it, then install/enable/disable.
// Same safety model as Marketplace: skills are untrusted text, never permissions.
import { useEffect, useMemo, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { Icon } from "./Icon";

type Skill = { id: string; name: string; description: string; source_repo: string; branch: string; source_path: string; license: string; enabled: boolean; location: string; modified_files: string[] };
type Preview = { repo: string; branch: string; path: string; id: string; name: string; description: string; license: string; files: { path: string; size: number }[]; skill_md: string; installed: boolean };

export function SkillsPanel() {
  const s = useStore();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [subdir, setSubdir] = useState("");
  const [location, setLocation] = useState<"app" | "workspace">("app");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState<{ skill: Skill; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const refresh = async () => { try { setSkills(await cmd.skillsList()); } catch (e) { toast("error", String(e)); } };
  useEffect(() => { void refresh(); }, []);

  const visible = useMemo(() => skills.filter((k) => !filter || `${k.name} ${k.description} ${k.id}`.toLowerCase().includes(filter.toLowerCase())), [skills, filter]);

  const fetchPreview = async () => {
    if (!repoUrl.trim()) { toast("warn", "Enter a public GitHub repository URL."); return; }
    setLoading(true); setPreview(null); setReviewed(null);
    try { setPreview(await cmd.skillPreview(repoUrl.trim(), branch.trim() || "main", subdir.trim(), location)); }
    catch (e) { toast("error", String(e)); }
    finally { setLoading(false); }
  };

  const install = async () => {
    if (!preview) return;
    if (preview.installed && !reviewed) { toast("warn", "Review the installed SKILL.md before replacing it (Check update on the installed list)."); return; }
    const updating = preview.installed;
    const licenseNotice = preview.license === "unknown" ? "License: unknown — review the repository before use." : `License: ${preview.license}.`;
    if (!window.confirm(`${updating ? "Update" : "Install"} skill '${preview.name}' into ${location === "app" ? "Neelima's skill library" : "this workspace's .neelima/skills"}?\n\n${licenseNotice}`)) return;
    setLoading(true);
    try { await cmd.skillInstall(preview, location, updating); setPreview(null); setReviewed(null); await refresh(); toast("info", "Skill ready. It is only used for tasks you explicitly select it for."); }
    catch (e) { toast("error", String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div class="skills-panel">
      <div class="card skills-import">
        <h3>Add a skill from GitHub</h3>
        <p class="skill-safety-note">Skills are plain instructions — nothing runs from them. Nothing is fetched until you click Preview. Public repositories only.</p>
        <div class="skill-import-fields">
          <input aria-label="GitHub repository URL" placeholder="https://github.com/owner/repository" value={repoUrl} onInput={(e: any) => setRepoUrl(e.currentTarget.value)} />
          <input aria-label="Branch" placeholder="Branch" value={branch} onInput={(e: any) => setBranch(e.currentTarget.value)} />
          <input aria-label="Skill subdirectory" placeholder="Skill subdirectory (optional)" value={subdir} onInput={(e: any) => setSubdir(e.currentTarget.value)} />
          <select aria-label="Install location" value={location} onChange={(e: any) => setLocation(e.currentTarget.value)}>
            <option value="app">Neelima skill library</option>
            <option value="workspace" disabled={!s.activeWorkspacePath}>Current workspace (.neelima/skills)</option>
          </select>
          <button class="btn-ok" disabled={loading} onClick={() => void fetchPreview()}>{loading ? "Working…" : "Preview skill"}</button>
        </div>
        {preview ? (
          <div class="skill-preview">
            <h4>{preview.name} {preview.installed ? <span class="chip">already installed</span> : null}</h4>
            <p>{preview.description || "No description in SKILL.md frontmatter."}</p>
            <p><b>Source:</b> {preview.repo} / {preview.branch}{preview.path ? ` / ${preview.path}` : ""} · <b>License:</b> {preview.license}</p>
            <p><b>Files ({preview.files.length}):</b> {preview.files.map((f) => f.path).join(", ")}</p>
            {reviewed ? <div class="skill-diff"><h4>Installed vs GitHub preview</h4><div class="skill-diff-columns"><pre><b>Installed{reviewed.skill.modified_files.includes("SKILL.md") ? " (locally edited; will be preserved)" : ""}</b>{reviewed.text}</pre><pre><b>GitHub preview</b>{preview.skill_md}</pre></div></div> : null}
            <details><summary>Preview SKILL.md</summary><pre class="skill-markdown-preview">{preview.skill_md}</pre></details>
            <button class="btn-ok" disabled={loading || (preview.installed && !reviewed)} onClick={() => void install()}>{preview.installed ? "Confirm update" : "Install skill"}</button>
          </div>
        ) : null}
      </div>

      <div class="card">
        <div class="skills-list-head"><h3>Installed skills</h3><button class="ghost" onClick={() => void refresh()}>Refresh</button></div>
        <div class="skills-filters"><input aria-label="Filter skills" placeholder="Filter by name or description" value={filter} onInput={(e: any) => setFilter(e.currentTarget.value)} /></div>
        {visible.length === 0 ? <p class="dim">No installed skills yet. Preview one above to add it.</p> : null}
        {visible.map((skill) => (
          <div class="installed-skill" key={`${skill.location}:${skill.id}`}>
            <div class="installed-skill-info"><b>{skill.name}</b><span>{skill.description || "No description"}</span><small>{skill.source_repo} · {skill.location} · license: {skill.license}</small></div>
            <div class="installed-skill-actions">
              <label><input type="checkbox" checked={skill.enabled} onChange={async (e: any) => { try { await cmd.skillSetEnabled(skill.location, skill.id, e.currentTarget.checked); await refresh(); } catch (err) { toast("error", String(err)); } }} /> Enabled</label>
              <button class="ghost" onClick={async () => { try { setReviewed({ skill, text: await cmd.skillRead(skill.location, skill.id) }); } catch (e) { toast("error", String(e)); } }}>Inspect</button>
              <button class="ghost" onClick={async () => {
                setLoading(true); setReviewed(null); setPreview(null);
                try { const [remote, local] = await Promise.all([cmd.skillUpdatePreview(skill.location, skill.id), cmd.skillRead(skill.location, skill.id)]); setPreview(remote); setReviewed({ skill, text: local }); setLocation(skill.location as "app" | "workspace"); }
                catch (e) { toast("error", String(e)); }
                finally { setLoading(false); }
              }}>Check update</button>
              <button class="ghost danger" onClick={async () => { if (!window.confirm(`Uninstall ${skill.name}?`)) return; try { await cmd.skillUninstall(skill.location, skill.id); setReviewed(null); await refresh(); } catch (e) { toast("error", String(e)); } }}>Uninstall</button>
            </div>
            {reviewed?.skill.id === skill.id && !preview ? <div class="skill-inspect"><b>SKILL.md</b><pre>{reviewed.text}</pre></div> : null}
          </div>
        ))}
        <button class="ghost inline-icon-button" onClick={() => { setState({ settingsOpen: false, view: "marketplace" }); }}><Icon name="arrow-up-right" size={14} /> More skill sources in Marketplace</button>
      </div>
    </div>
  );
}

export default SkillsPanel;
