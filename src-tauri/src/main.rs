// E2: no console window on Windows — release AND dev builds alike. All
// diagnostics go to a log file in the app data dir (see lib::filelog) instead
// of a console the user never asked for.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    neelima_lib::run()
}
