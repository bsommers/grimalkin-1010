// The desktop shell: one window showing the game's own index.html in the
// operating system's web view. All game code is the plain JavaScript in js/.
//
// Self-test: run with GRIMALKIN_SELFTEST=<file> to start a game, switch
// renderers, write a JSON report to <file> and exit (0 = ok, 1 = failed,
// 2 = no report within 40 s). Used to check builds on each platform.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, fs, thread, time::Duration};
use tauri::Manager;

const SELFTEST_VAR: &str = "GRIMALKIN_SELFTEST";

#[tauri::command]
fn selftest_report(app: tauri::AppHandle, report: String) {
    let Ok(path) = env::var(SELFTEST_VAR) else { return };
    let _ = fs::write(path, &report);
    app.exit(if report.contains("\"ok\":true") { 0 } else { 1 });
}

#[tauri::command]
fn selftest_log(message: String) {
    if env::var(SELFTEST_VAR).is_ok() {
        eprintln!("selftest: {message}");
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![selftest_report, selftest_log])
        .setup(|app| {
            if let Ok(path) = env::var(SELFTEST_VAR) {
                let window = app.get_webview_window("main").expect("main window");
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(4));
                    if let Err(e) = window.eval(include_str!("selftest.js")) {
                        eprintln!("selftest: eval failed: {e}");
                    }
                    thread::sleep(Duration::from_secs(36));
                    let _ = fs::write(path, r#"{"ok":false,"errors":["no report within 40 s"]}"#);
                    handle.exit(2);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start GRIMALKIN 1010");
}
