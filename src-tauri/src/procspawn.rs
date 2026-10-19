//! Process spawn helpers: EVERY new process in Neelima (cmd, git, taskkill,
//! explorer, PowerShell) is created hidden on Windows. E1: console windows
//! were popping when the user merely clicked Chat — the cause was cmd/git
//! spawned without CREATE_NO_WINDOW. This module is the single choke point.

/// Windows creation flag: CREATE_NO_WINDOW.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// std Command, hidden on Windows. On Unix it is a plain Command (exec.rs
/// applies its own setsid process groups for agent-run commands).
pub fn hidden_std(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// tokio Command, hidden on Windows.
pub fn hidden_tokio(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run a std::process::Command for git (etc.) and MUST NOT open a console.
/// checkpoints.rs goes through here; everything else is exec.rs / terminal.rs.
pub fn hidden_output(mut cmd: std::process::Command) -> Result<std::process::Output, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output().map_err(|e| e.to_string())
}
