//! Tool executor. Every tool takes a `&Workspace` and is confined by it.
//! Results are capped (default 30 KB) with an "use offset/limit" hint; large
//! files are never loaded fully into memory.

use std::io::{BufRead, Read};
use std::path::Path;

use serde_json::Value;

use crate::workspace::{Workspace, WorkspaceError};

pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_LIST_ENTRIES: usize = 500;
pub const MAX_GLOB_RESULTS: usize = 500;
pub const MAX_GREP_MATCHES: usize = 200;
pub const MAX_GREP_LINE: usize = 500;

#[derive(Debug, Clone)]
pub struct ToolOutcome {
    pub ok: bool,
    pub output: String,
    /// (path, old_content, new_content) for diff display on writes/edits.
    pub diff: Option<(String, String, String)>,
}

fn ok_out(output: String) -> ToolOutcome {
    ToolOutcome { ok: true, output, diff: None }
}
fn err_out(output: String) -> ToolOutcome {
    ToolOutcome { ok: false, output, diff: None }
}

fn cap_note(cap: usize) -> String {
    format!("\n[output truncated at {cap} bytes — use offset/limit (read_file) or narrower patterns (grep/glob) to read more]")
}

fn cap_str(s: &str, cap: usize) -> (String, bool) {
    if s.len() <= cap {
        (s.to_string(), false)
    } else {
        let mut end = cap;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        (s[..end].to_string(), true)
    }
}

pub fn tool_names() -> Vec<(&'static str, &'static str)> {
    vec![
        ("read_file", "read_file(path, offset?, limit?) — read a text file, lines [offset, offset+limit)."),
        ("write_file", "write_file(path, content, append?) — create or overwrite (append:true to continue a chunked write)."),
        ("edit_file", "edit_file(path, old_string, new_string, replace_all?) — exact-match replace; errors if ambiguous or missing."),
        ("list_dir", "list_dir(path) — one directory level: [type] name."),
        ("glob", "glob(pattern) — workspace-relative glob, .gitignore respected."),
        ("grep", "grep(pattern, path?, include?) — regex search, .gitignore respected, returns path:line: text."),
        ("run_command", "run_command(command, timeout?) — run a shell command inside the workspace; output is streamed and capped."),
        ("delete_file", "delete_file(path) — remove a file (checkpoints can restore it)."),
        ("move_file", "move_file(from, to) — rename/move within the workspace."),
    ]
}

pub fn execute(
    ws: &Workspace,
    call: &crate::protocol::ToolCall,
    settings: &crate::settings::Settings,
) -> ToolOutcome {
    let args = &call.args;
    match call.tool.as_str() {
        "read_file" => read_file(ws, args, settings.result_cap_bytes),
        "write_file" => write_file(ws, args),
        "edit_file" => edit_file(ws, args),
        "list_dir" => list_dir(ws, args),
        "glob" => glob(ws, args),
        "grep" => grep(ws, args),
        "delete_file" => delete_file(ws, args),
        "move_file" => move_file(ws, args),
        // run_command is dispatched by the agent (needs streaming + kill handle).
        "run_command" => err_out("run_command must be executed by the agent loop".into()),
        other => err_out(format!("unknown tool '{other}'. Available: {}", tool_names().iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", "))),
    }
}

fn get_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string arg '{key}'"))
}
fn get_usize(args: &Value, key: &str) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_u64().map(|v| Some(v as usize)).ok_or(format!("arg '{key}' must be a non-negative number")),
        Some(_) => Err(format!("arg '{key}' must be a number")),
    }
}

pub fn read_file(ws: &Workspace, args: &Value, cap: usize) -> ToolOutcome {
    let path = match get_str(args, "path").and_then(|p| ws.resolve(&p).map_err(|e| e.to_string())) {
        Ok(p) => p,
        Err(e) => return err_out(e),
    };
    let offset = get_usize(args, "offset").unwrap_or(None).unwrap_or(0);
    let limit = get_usize(args, "limit").unwrap_or(None);

    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return err_out(format!("read_file: {e}")),
    };
    if meta.is_dir() {
        return err_out(format!("read_file: '{}' is a directory (use list_dir)", ws.display(&path)));
    }
    // Binary sniff on the first 8 KB.
    if let Ok(mut f) = std::fs::File::open(&path) {
        let mut head = [0u8; 8192];
        let n = f.read(&mut head).unwrap_or(0);
        if head[..n].contains(&0) {
            return err_out(format!("read_file: '{}' looks binary (NUL bytes); refusing to dump", ws.display(&path)));
        }
    }

    match std::fs::File::open(&path) {
        Ok(f) => {
            let mut reader = std::io::BufReader::with_capacity(64 * 1024, f);
            let mut collected = String::new();
            let mut line_no = 0usize;
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        line_no += 1;
                        if line_no > offset {
                            collected.push_str(&buf);
                            if let Some(l) = limit {
                                if line_no - offset >= l { break; }
                            }
                            if collected.len() > cap { break; }
                        }
                    }
                    Err(e) => return err_out(format!("read_file: {e}")),
                }
            }
            let (body, was_capped) = cap_str(&collected, cap);
            let mut out = body.trim_end().to_string();
            if was_capped {
                out.push_str(&cap_note(cap));
            }
            if offset > 0 || limit.is_some() {
                out.push_str(&format!("
[{line_no} lines total, showing from line {}]", offset + 1));
            }
            ok_out(out)
        }
        Err(e) => err_out(format!("read_file: {e}")),
    }
}

pub fn write_file(ws: &Workspace, args: &Value) -> ToolOutcome {
    let rel = match get_str(args, "path") {
        Ok(p) => p,
        Err(e) => return err_out(e),
    };
    let content = match args.get("content").and_then(Value::as_str) {
        Some(c) => c,
        None => return err_out("missing string arg 'content'".into()),
    };
    if content.len() > MAX_WRITE_BYTES {
        return err_out(format!("write_file: content too large ({} bytes > {MAX_WRITE_BYTES}); split into chunks with append:true", content.len()));
    }
    let path = match ws.resolve(&rel).map_err(|e| e.to_string()) {
        Ok(p) => p,
        Err(e) => return err_out(format!("write_file: {e}")),
    };
    let append = args.get("append").and_then(Value::as_bool).unwrap_or(false);
    let old = std::fs::read_to_string(&path).unwrap_or_default();
    if append {
        use std::io::Write;
        match std::fs::OpenOptions::new().create(true).append(true).open(&path)
            .and_then(|mut f| f.write_all(content.as_bytes()))
        {
            Ok(()) => {}
            Err(e) => return err_out(format!("write_file: {e}")),
        }
    } else if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return err_out(format!("write_file: {e}"));
        }
        if let Err(e) = std::fs::write(&path, content) {
            return err_out(format!("write_file: {e}"));
        }
    }
    let new = std::fs::read_to_string(&path).unwrap_or_default();
    let diff = if old != new { Some((ws.display(&path), old, new)) } else { None };
    ok_out(format!("wrote {} bytes to {}", content.len(), ws.display(&path)))
        .with_diff(diff)
}

pub fn edit_file(ws: &Workspace, args: &Value) -> ToolOutcome {
    let rel = match get_str(args, "path") {
        Ok(p) => p,
        Err(e) => return err_out(e),
    };
    let old_string = match args.get("old_string").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return err_out("missing string arg 'old_string'".into()),
    };
    let new_string = match args.get("new_string").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return err_out("missing string arg 'new_string'".into()),
    };
    if old_string.is_empty() {
        return err_out("edit_file: old_string must not be empty (use write_file to create files)".into());
    }
    let replace_all = args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
    let path = match ws.resolve(&rel).map_err(|e| e.to_string()) {
        Ok(p) => p,
        Err(e) => return err_out(format!("edit_file: {e}")),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => return err_out(format!("edit_file: cannot read {}: {e}", ws.display(&path))),
    };
    let count = content.matches(&old_string).count();
    if count == 0 {
        return err_out(format!(
            "edit_file: old_string not found in {}. It must match EXACTLY (whitespace included). Read the file again and copy the exact text.",
            ws.display(&path)
        ));
    }
    if count > 1 && !replace_all {
        return err_out(format!(
            "edit_file: old_string matches {count} locations in {} — make it unique or pass replace_all:true",
            ws.display(&path)
        ));
    }
    let updated = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };
    if let Err(e) = std::fs::write(&path, &updated) {
        return err_out(format!("edit_file: {e}"));
    }
    let diff = Some((ws.display(&path), content.clone(), updated.clone()));
    ok_out(format!("edited {}", ws.display(&path))).with_diff(diff)
}

pub fn list_dir(ws: &Workspace, args: &Value) -> ToolOutcome {
    let rel = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let path = match ws.resolve(rel).map_err(|e| e.to_string()) {
        Ok(p) => p,
        Err(e) => return err_out(format!("list_dir: {e}")),
    };
    let rd = match std::fs::read_dir(&path) {
        Ok(rd) => rd,
        Err(e) => return err_out(format!("list_dir: {e}")),
    };
    let mut entries: Vec<(bool, String)> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push((is_dir, name));
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let truncated = entries.len() >= MAX_LIST_ENTRIES;
    let mut out = entries
        .iter()
        .map(|(d, n)| format!("[{}] {}", if *d { "dir" } else { "file" }, n))
        .collect::<Vec<_>>()
        .join("\n");
    if truncated {
        out.push_str(&format!("\n[listing capped at {MAX_LIST_ENTRIES} entries]"));
    }
    if out.is_empty() {
        out = "(empty directory)".into();
    }
    ok_out(out)
}

pub fn glob(ws: &Workspace, args: &Value) -> ToolOutcome {
    let pattern = match get_str(args, "pattern") {
        Ok(p) => p,
        Err(e) => return err_out(e),
    };
    let full = format!("**/{}", pattern.trim_start_matches("./"));
    let matcher = match globset::GlobBuilder::new(&full)
        .literal_separator(false)
        .build()
        .map_err(|e| format!("glob: bad pattern: {e}"))
    {
        Ok(g) => g.compile_matcher(),
        Err(e) => return err_out(e),
    };
    let mut results = Vec::new();
    let walker = ignore::WalkBuilder::new(ws.root())
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();
    for entry in walker.flatten() {
        if results.len() >= MAX_GLOB_RESULTS {
            break;
        }
        let p = entry.path();
        if p == ws.root() {
            continue;
        }
        let rel = ws.display(p);
        if matcher.is_match(p) || matcher.is_match(Path::new(&rel)) {
            results.push(rel);
        }
    }
    if results.is_empty() {
        return ok_out("(no matches)".into());
    }
    results.sort();
    let mut out = results.join("\n");
    if results.len() >= MAX_GLOB_RESULTS {
        out.push_str(&format!("\n[capped at {MAX_GLOB_RESULTS} results]"));
    }
    ok_out(out)
}

pub fn grep(ws: &Workspace, args: &Value) -> ToolOutcome {
    let pattern = match get_str(args, "pattern") {
        Ok(p) => p,
        Err(e) => return err_out(e),
    };
    let base = match args.get("path").and_then(Value::as_str) {
        Some(p) => match ws.resolve(p).map_err(|e| e.to_string()) {
            Ok(b) => b,
            Err(e) => return err_out(format!("grep: {e}")),
        },
        None => ws.root().to_path_buf(),
    };
    let include = args.get("include").and_then(Value::as_str);
    let re = match regex::RegexBuilder::new(&pattern)
        .size_limit(4 * 1024 * 1024)
        .build()
    {
        Ok(r) => r,
        Err(e) => return err_out(format!("grep: bad pattern: {e}")),
    };
    let inc_matcher = match include {
        Some(g) => match globset::GlobBuilder::new(g).build().map(|g| g.compile_matcher()) {
            Ok(m) => Some(m),
            Err(e) => return err_out(format!("grep: bad include: {e}")),
        },
        None => None,
    };
    let mut lines = Vec::new();
    let mut matches = 0usize;
    let walker = ignore::WalkBuilder::new(&base).hidden(true).git_ignore(true).require_git(false).build();
    'outer: for entry in walker.flatten() {
        let p = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if let Some(m) = &inc_matcher {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !m.is_match(&name) {
                continue;
            }
        }
        if let Ok(mut f) = std::fs::File::open(p) {
            let mut buf = String::new();
            let mut reader = std::io::BufReader::with_capacity(64 * 1024, f);
            let mut line_no = 0usize;
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        line_no += 1;
                        if re.is_match(&buf) {
                            let (text, _) = cap_str(buf.trim_end(), MAX_GREP_LINE);
                            lines.push(format!("{}:{}: {}", ws.display(p), line_no, text));
                            matches += 1;
                            if matches >= MAX_GREP_MATCHES {
                                lines.push(format!("[capped at {MAX_GREP_MATCHES} matches]"));
                                break 'outer;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }
    if lines.is_empty() {
        return ok_out("(no matches)".into());
    }
    ok_out(lines.join("\n"))
}

pub fn delete_file(ws: &Workspace, args: &Value) -> ToolOutcome {
    let rel = match get_str(args, "path") {
        Ok(p) => p,
        Err(e) => return err_out(e),
    };
    let path = match ws.resolve(&rel).map_err(|e| e.to_string()) {
        Ok(p) => p,
        Err(e) => return err_out(format!("delete_file: {e}")),
    };
    if path.is_dir() {
        return err_out("delete_file: refusing to delete a directory (delete files individually)".into());
    }
    match std::fs::remove_file(&path) {
        Ok(()) => ok_out(format!("deleted {}", ws.display(&path))),
        Err(e) => err_out(format!("delete_file: {e}")),
    }
}

pub fn move_file(ws: &Workspace, args: &Value) -> ToolOutcome {
    let from = match get_str(args, "from").and_then(|p| ws.resolve(&p).map_err(|e| e.to_string())) {
        Ok(p) => p,
        Err(e) => return err_out(format!("move_file: {e}")),
    };
    let to = match get_str(args, "to").and_then(|p| ws.resolve(&p).map_err(|e| e.to_string())) {
        Ok(p) => p,
        Err(e) => return err_out(format!("move_file: {e}")),
    };
    if to.exists() {
        return err_out(format!("move_file: destination {} already exists", ws.display(&to)));
    }
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(&from, &to) {
        Ok(()) => ok_out(format!("moved {} -> {}", ws.display(&from), ws.display(&to))),
        Err(_) => match std::fs::copy(&from, &to).and_then(|_| std::fs::remove_file(&from)) {
            Ok(_) => ok_out(format!("moved {} -> {}", ws.display(&from), ws.display(&to))),
            Err(e) => err_out(format!("move_file: {e}")),
        },
    }
}

impl ToolOutcome {
    fn with_diff(mut self, diff: Option<(String, String, String)>) -> ToolOutcome {
        self.diff = diff;
        self
    }
}

/// Unified diff text for approval UIs.
pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let diff = similar::TextDiff::from_lines(old, new);
    let mut out = String::new();
    out.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        out.push_str(&format!("{}", hunk));
    }
    out
}

/// Streamed execution context for run_command, managed by the agent loop.
pub struct CommandResult {
    pub ok: bool,
    pub output: String,
    pub killed: bool,
}

impl From<WorkspaceError> for ToolOutcome {
    fn from(e: WorkspaceError) -> Self {
        err_out(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ToolCall;
    use serde_json::json;

    fn ws(name: &str) -> Workspace {
        let dir = std::env::temp_dir().join(format!("neelima-tools-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Workspace::open(&dir).unwrap()
    }
    fn call(id: &str, tool: &str, args: Value) -> ToolCall {
        ToolCall { id: id.into(), tool: tool.into(), args }
    }

    #[test]
    fn write_then_read_roundtrip() {
        let w = ws("rw");
        let out = execute(&w, &call("1", "write_file", json!({"path":"a.txt","content":"hello"})), &crate::settings::Settings::default());
        assert!(out.ok, "{}", out.output);
        let out = execute(&w, &call("2", "read_file", json!({"path":"a.txt"})), &crate::settings::Settings::default());
        assert_eq!(out.output.trim(), "hello");
        std::fs::remove_dir_all(w.root()).ok();
    }

    #[test]
    fn chunked_append_write() {
        let w = ws("append");
        let s = crate::settings::Settings::default();
        execute(&w, &call("1", "write_file", json!({"path":"big.txt","content":"part1"})), &s);
        let out = execute(&w, &call("2", "write_file", json!({"path":"big.txt","content":"part2","append":true})), &s);
        assert!(out.ok);
        assert_eq!(std::fs::read_to_string(w.root().join("big.txt")).unwrap(), "part1part2");
        std::fs::remove_dir_all(w.root()).ok();
    }

    #[test]
    fn edit_requires_exact_unique_match() {
        let w = ws("edit");
        let s = crate::settings::Settings::default();
        std::fs::write(w.root().join("c.rs"), "fn a() {}\nfn a() {}\n").unwrap();
        let out = execute(&w, &call("1", "edit_file", json!({"path":"c.rs","old_string":"fn a() {}","new_string":"fn b() {}"})), &s);
        assert!(!out.ok);
        assert!(out.output.contains("2 locations"));
        let out = execute(&w, &call("2", "edit_file", json!({"path":"c.rs","old_string":"fn a() {}\nfn a() {}","new_string":"fn b() {}"})), &s);
        assert!(out.ok, "{}", out.output);
        assert!(out.diff.is_some());
        std::fs::remove_dir_all(w.root()).ok();
    }

    #[test]
    fn read_file_caps_output() {
        let w = ws("cap");
        let mut big = String::new();
        for i in 0..5000 { big.push_str(&format!("line {i}\n")); }
        std::fs::write(w.root().join("big.txt"), &big).unwrap();
        let mut s = crate::settings::Settings::default();
        s.result_cap_bytes = 1024;
        let out = execute(&w, &call("1", "read_file", json!({"path":"big.txt"})), &s);
        assert!(out.output.contains("truncated"));
        let out = execute(&w, &call("2", "read_file", json!({"path":"big.txt","offset":4998,"limit":2})), &s);
        assert!(out.output.contains("line 4999"));
        std::fs::remove_dir_all(w.root()).ok();
    }

    #[test]
    fn grep_respects_gitignore() {
        let w = ws("grep");
        std::fs::write(w.root().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(w.root().join("kept.txt"), "needle here\n").unwrap();
        std::fs::write(w.root().join("ignored.txt"), "needle there\n").unwrap();
        let s = crate::settings::Settings::default();
        let out = execute(&w, &call("1", "grep", json!({"pattern":"needle"})), &s);
        assert!(out.output.contains("kept.txt:1"));
        assert!(!out.output.contains("ignored.txt:1"));
        std::fs::remove_dir_all(w.root()).ok();
    }

    #[test]
    fn tools_confined_to_workspace() {
        let w = ws("conf");
        let s = crate::settings::Settings::default();
        let out = execute(&w, &call("1", "read_file", json!({"path":"../secrets.txt"})), &s);
        assert!(!out.ok);
        let out = execute(&w, &call("2", "delete_file", json!({"path":"/etc/passwd"})), &s);
        assert!(!out.ok);
        std::fs::remove_dir_all(w.root()).ok();
    }

    #[test]
    fn unified_diff_format() {
        let d = unified_diff("a.txt", "one\ntwo\n", "one\nTWO\nthree\n");
        assert!(d.contains("--- a/a.txt"));
        assert!(d.contains("+++ b/a.txt"));
        assert!(d.contains("-two"));
        assert!(d.contains("+TWO"));
    }
}
