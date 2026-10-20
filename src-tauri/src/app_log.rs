use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 1024 * 1024;

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

pub fn init(data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("could not create log directory: {e}"))?;
    let path = data_dir.join("neelima.log");
    let should_rotate = match fs::metadata(&path) {
        Ok(metadata) => metadata.len() > MAX_LOG_BYTES,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "could not inspect log file {}: {error}",
                path.display()
            ))
        }
    };
    if should_rotate {
        let previous = data_dir.join("neelima.log.1");
        if previous.exists() {
            fs::remove_file(&previous)
                .map_err(|e| format!("could not rotate previous log: {e}"))?;
        }
        fs::rename(&path, &previous).map_err(|e| format!("could not rotate log file: {e}"))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open log file {}: {e}", path.display()))?;
    LOG_FILE
        .set(Mutex::new(file))
        .map_err(|_| "file logging was already initialized".to_string())
}

pub fn write(area: &str, message: &str) -> Result<(), String> {
    let file = LOG_FILE
        .get()
        .ok_or_else(|| "file logging has not been initialized".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let mut file = file.lock().map_err(|e| format!("log lock poisoned: {e}"))?;
    writeln!(file, "{timestamp} [{area}] {message}").map_err(|e| format!("log write failed: {e}"))
}
