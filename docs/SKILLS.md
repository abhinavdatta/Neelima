# Skills marketplace

Neelima imports directory-based skills that contain a `SKILL.md` file. Cursor
`.mdc` rules and other agent-specific formats are shown for discovery but are
not converted or installed as skills.

## Import and storage

Import starts only after you request a preview or install. Neelima contacts the
public GitHub API and raw content servers; public repositories do not need a
token. Private repositories are not supported. A skill can be installed into
Neelima's app-data skills directory or the active workspace's
`.neelima/skills` directory. Imports are bounded by file-count and byte limits,
reject unsafe paths and source symlinks, stage before activation, and do not
execute scripts or hooks.

The source repository, branch, skill subdirectory, and reported SPDX license
are stored with the installed skill. A missing license is recorded as
`unknown`; installation does not mean the skill is approved or safe.

## Trust and task use

Imported files remain local. Skill text is untrusted instruction content. It
cannot change workspace boundaries, permission mode, secret handling, or the
existing tool approval and checkpoint rules. Commands and file operations it
suggests still go through Neelima's normal tool path and approvals.

Skills are never added to every task automatically. Select enabled skills in
the task composer; the selected content is bounded by the task token budget and
ordered deterministically by skill ID. The task view shows active skills. When
using a web provider, Neelima asks before sending selected skill text to that
provider. Local model use does not send it to a cloud provider.

Updates compare the current `SKILL.md` with GitHub and require confirmation.
Neelima preserves files edited since the previous import and reports those
edits for review. Uninstall requires confirmation. Installed skills should be
reviewed before use because imported instructions can be malicious.

GitHub links may be opened in the system browser from the marketplace. This
opens GitHub only; it does not import or install a skill.
